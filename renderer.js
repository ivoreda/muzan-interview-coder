/* global marked, DOMPurify, hljs */
(() => {
  const api = window.muzan;

  const $ = (id) => document.getElementById(id);
  const banner = $('instruction-banner');
  const overlay = $('response-overlay');
  const responseBox = $('response-box');
  const statusEl = $('response-status');
  const contentEl = $('response-content');
  const transcriptPanel = $('transcript-preview');
  const transcriptText = $('transcript-text');
  const micMeter = $('mic-meter-fill');

  marked.use({ breaks: true, gfm: true });
  hljs.configure({ ignoreUnescapedHTML: true });

  // ---------- Rendering ----------

  const RENDER_INTERVAL_MS = 80;
  let answerText = '';
  let renderTimer = null;
  let lastRenderAt = 0;

  function renderMarkdown() {
    renderTimer = null;
    lastRenderAt = performance.now();
    const html = marked.parse(answerText || '');
    // Model output may echo text from screenshots/transcripts, so never trust it as HTML.
    contentEl.innerHTML = DOMPurify.sanitize(html, {
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
      FORBID_ATTR: ['style']
    });
    contentEl.querySelectorAll('pre code').forEach((block) => {
      try { hljs.highlightElement(block); } catch (_) {}
      addCopyButton(block);
    });
  }

  function scheduleRender(immediate = false) {
    if (immediate) {
      clearTimeout(renderTimer);
      renderMarkdown();
      return;
    }
    if (renderTimer) return;
    const wait = Math.max(0, RENDER_INTERVAL_MS - (performance.now() - lastRenderAt));
    renderTimer = setTimeout(renderMarkdown, wait);
  }

  function addCopyButton(codeEl) {
    const pre = codeEl.parentElement;
    if (!pre || pre.querySelector('.copy-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      api.copyText(codeEl.textContent);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    pre.appendChild(btn);
  }

  // ---------- Status / timer ----------

  let timerInterval = null;
  let timerStart = 0;
  let timerLabel = '';

  function formatSeconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function startTimer(label) {
    stopTimer();
    timerStart = performance.now();
    timerLabel = label;
    statusEl.classList.add('busy');
    const tick = () => {
      statusEl.textContent = `${timerLabel} ${formatSeconds(performance.now() - timerStart)}`;
    };
    tick();
    timerInterval = setInterval(tick, 100);
  }

  function stopTimer(finalText) {
    clearInterval(timerInterval);
    timerInterval = null;
    statusEl.classList.remove('busy');
    if (finalText !== undefined) statusEl.textContent = finalText;
  }

  // ---------- Overlay / banner ----------

  const showOverlay = () => overlay.classList.add('visible');
  const hideOverlay = () => overlay.classList.remove('visible');

  function updateBanner(text, show = true) {
    banner.style.opacity = show ? '1' : '0';
    if (text) banner.textContent = text;
  }

  function setTranscriptPreview(text, listening) {
    if (!listening) {
      transcriptPanel.classList.remove('visible');
      transcriptText.textContent = '';
      transcriptText.classList.add('empty');
      micMeter.style.width = '0%';
      return;
    }

    transcriptPanel.classList.add('visible');
    const trimmed = (text || '').trim();
    if (trimmed) {
      transcriptText.textContent = trimmed;
      transcriptText.classList.remove('empty');
    } else {
      transcriptText.textContent = 'Listening for speech…';
      transcriptText.classList.add('empty');
    }
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  }

  // ---------- Audio capture ----------

  let mediaStream = null;
  let audioContext = null;
  let captureNode = null;
  let sinkGain = null;

  function floatTo16BitPCM(float32Array) {
    const pcm = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm;
  }

  // Linear resample to 24 kHz (AudioContext sometimes ignores the requested rate).
  function resampleTo24k(float32Array, inputRate) {
    if (inputRate === 24000) return float32Array;
    const ratio = inputRate / 24000;
    const outLength = Math.max(1, Math.floor(float32Array.length / ratio));
    const output = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcIndex = i * ratio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, float32Array.length - 1);
      const frac = srcIndex - i0;
      output[i] = float32Array[i0] * (1 - frac) + float32Array[i1] * frac;
    }
    return output;
  }

  let smoothedLevel = 0;
  function updateMicMeter(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    // Map roughly -60dB..0dB to 0..100%.
    const db = 20 * Math.log10(rms || 1e-6);
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    smoothedLevel = level > smoothedLevel ? level : smoothedLevel * 0.85 + level * 0.15;
    micMeter.style.width = `${Math.round(smoothedLevel * 100)}%`;
  }

  function handleSamples(samples) {
    if (!audioContext) return;
    updateMicMeter(samples);
    const pcm = floatTo16BitPCM(resampleTo24k(samples, audioContext.sampleRate));
    api.sendAudio(pcm.buffer);
  }

  function stopAudioCapture() {
    if (captureNode) {
      try { captureNode.disconnect(); } catch (_) {}
      if (captureNode.port) captureNode.port.onmessage = null;
      captureNode.onaudioprocess = null;
      captureNode = null;
    }
    if (sinkGain) {
      try { sinkGain.disconnect(); } catch (_) {}
      sinkGain = null;
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
  }

  async function startAudioCapture({ echoCancellation = false } = {}) {
    stopAudioCapture();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation,
        noiseSuppression: true
      }
    });

    audioContext = new AudioContext({ sampleRate: 24000 });
    const source = audioContext.createMediaStreamSource(mediaStream);
    sinkGain = audioContext.createGain();
    sinkGain.gain.value = 0;

    try {
      await audioContext.audioWorklet.addModule('audio-worklet.js');
      captureNode = new AudioWorkletNode(audioContext, 'pcm-batch');
      captureNode.port.onmessage = (event) => handleSamples(event.data);
    } catch (err) {
      // Fallback for environments where worklets can't load.
      console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
      captureNode = audioContext.createScriptProcessor(4096, 1, 1);
      captureNode.onaudioprocess = (event) => {
        handleSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
    }

    source.connect(captureNode);
    captureNode.connect(sinkGain);
    sinkGain.connect(audioContext.destination);

    if (audioContext.state === 'suspended') await audioContext.resume();
  }

  // ---------- IPC handlers ----------

  let answering = false;

  api.on('answer-start', ({ label } = {}) => {
    answering = true;
    answerText = '';
    contentEl.innerHTML = '';
    responseBox.scrollTop = 0;
    showOverlay();
    startTimer(label || 'Thinking…');
  });

  api.on('answer-delta', (delta) => {
    if (!answering) return; // late chunk after a cancel/reset
    if (!answerText) timerLabel = 'Answering…';
    answerText += delta;
    scheduleRender();
  });

  api.on('answer-done', ({ text, elapsedMs, note } = {}) => {
    answering = false;
    if (typeof text === 'string') answerText = text;
    scheduleRender(true);
    const parts = [`Done in ${formatSeconds(elapsedMs || 0)}`];
    if (note) parts.push(note);
    stopTimer(parts.join(' · '));
  });

  api.on('error', (payload) => {
    const { message, hint } = typeof payload === 'string' ? { message: payload } : (payload || {});
    answering = false;
    clearTimeout(renderTimer);
    renderTimer = null;
    stopTimer('');
    showOverlay();
    const box = document.createElement('div');
    box.className = 'error-message';
    const strong = document.createElement('strong');
    strong.textContent = 'Error: ';
    box.append(strong, document.createTextNode(message || 'Unknown error'));
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      box.append(document.createElement('br'), small);
    }
    contentEl.replaceChildren(box);
  });

  api.on('update-instruction', (text) => updateBanner(text, true));
  api.on('hide-instruction', () => updateBanner('', false));

  api.on('hide-app', () => {
    updateBanner('', false);
    hideOverlay();
    transcriptPanel.classList.remove('visible');
  });

  api.on('show-app', ({ showResponse } = {}) => {
    updateBanner('', true);
    if (showResponse) showOverlay();
  });

  api.on('clear-result', () => {
    answering = false;
    clearTimeout(renderTimer);
    renderTimer = null;
    answerText = '';
    contentEl.innerHTML = '';
    stopTimer('');
    hideOverlay();
  });

  api.on('transcript-update', (payload) => {
    setTranscriptPreview(payload?.text, !!payload?.listening);
  });

  api.on('start-listening', async (options) => {
    try {
      await startAudioCapture(options);
      setTranscriptPreview('', true);
    } catch (err) {
      stopAudioCapture();
      updateBanner('Microphone access denied: ' + err.message, true);
      api.listenFailed(err.message);
    }
  });

  api.on('stop-listening', () => {
    stopAudioCapture();
    setTranscriptPreview('', false);
  });

  api.on('scroll-response', (direction) => {
    responseBox.scrollBy({ top: direction * responseBox.clientHeight * 0.6, behavior: 'smooth' });
  });

  window.addEventListener('unload', stopAudioCapture);
})();
