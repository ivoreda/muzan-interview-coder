const WebSocket = require('ws');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_RETRIES = 2;
// Audio captured before the socket is ready (initial connect / reconnect) is queued
// instead of dropped, so the first words of a question aren't lost. ~15s cap.
const MAX_QUEUED_CHUNKS = 150;
const CREATED_READY_FALLBACK_MS = 1500;

class RealtimeSttSession {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.model]
   * @param {string} [options.language]
   * @param {(text: string, itemId: string) => void} options.onTranscript
   * @param {(itemId: string, partial: string) => void} [options.onPartial]
   * @param {(err: Error) => void} [options.onError]
   * @param {() => void} [options.onClose]
   */
  constructor({ apiKey, model = 'gpt-4o-mini-transcribe', language = 'en', onTranscript, onPartial, onError, onClose }) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.onTranscript = onTranscript;
    this.onPartial = onPartial || (() => {});
    this.onError = onError || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.closedByUser = false;
    this.retryCount = 0;
    this.ready = false;
    this.readyFallbackTimer = null;
    this.partialByItem = new Map();
    this.queue = [];
    // Flush bookkeeping: lets "Answer" wait for in-flight speech to finish transcribing.
    this.speechActive = false;
    this.awaitingManualCommit = false;
    this.pendingItems = new Set();
    this.flushWaiters = [];
  }

  start() {
    this.closedByUser = false;
    this.retryCount = 0;
    this._connect();
  }

  stop() {
    this.closedByUser = true;
    this.ready = false;
    clearTimeout(this.readyFallbackTimer);
    this.partialByItem.clear();
    this.queue = [];
    this.speechActive = false;
    this.awaitingManualCommit = false;
    this.pendingItems.clear();
    this._resolveFlushWaiters();
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }

  appendAudio(base64Pcm16) {
    if (this.closedByUser) return;
    if (!this._isOpen()) {
      this.queue.push(base64Pcm16);
      if (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift();
      return;
    }
    this._send({ type: 'input_audio_buffer.append', audio: base64Pcm16 });
  }

  /**
   * Force-finish the utterance in progress and wait (up to timeoutMs) for every
   * pending transcription to complete. Resolves immediately if nothing is pending.
   */
  flush(timeoutMs = 1500) {
    if (!this._isOpen()) return Promise.resolve();

    if (this.speechActive) {
      this.speechActive = false;
      this.awaitingManualCommit = true;
      this._send({ type: 'input_audio_buffer.commit' });
    }

    if (!this._hasPendingWork()) return Promise.resolve();

    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.flushWaiters = this.flushWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.flushWaiters.push(done);
    });
  }

  _isOpen() {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && this.ready);
  }

  _hasPendingWork() {
    return this.awaitingManualCommit || this.pendingItems.size > 0;
  }

  _resolveFlushWaiters() {
    for (const waiter of [...this.flushWaiters]) waiter();
  }

  _checkFlushWaiters() {
    if (!this._hasPendingWork()) this._resolveFlushWaiters();
  }

  _send(payload) {
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      this.onError(err);
    }
  }

  _markReady() {
    if (this.ready) return;
    clearTimeout(this.readyFallbackTimer);
    this.ready = true;
    this.retryCount = 0;
    console.log('[stt] session ready');
    const queued = this.queue;
    this.queue = [];
    for (const chunk of queued) this._send({ type: 'input_audio_buffer.append', audio: chunk });
  }

  _connect() {
    if (this.closedByUser) return;

    const ws = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    });

    this.ws = ws;
    this.ready = false;
    this.speechActive = false;
    this.awaitingManualCommit = false;
    this.pendingItems.clear();
    this._resolveFlushWaiters();

    ws.on('open', () => {
      console.log('[stt] websocket open');
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: {
                type: 'audio/pcm',
                rate: 24000
              },
              transcription: {
                model: this.model,
                language: this.language
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700
              }
            }
          }
        }
      }));
    });

    ws.on('message', (raw) => {
      let event;
      try {
        event = JSON.parse(raw.toString());
      } catch (_) {
        return;
      }

      switch (event.type) {
        case 'session.updated':
        case 'transcription_session.updated':
          this._markReady();
          return;

        case 'session.created':
        case 'transcription_session.created':
          // Prefer waiting for session.updated (so audio uses our format), but fall
          // back to created in case a deployment never emits updated.
          clearTimeout(this.readyFallbackTimer);
          this.readyFallbackTimer = setTimeout(() => this._markReady(), CREATED_READY_FALLBACK_MS);
          return;

        case 'input_audio_buffer.speech_started':
          this.speechActive = true;
          return;

        case 'input_audio_buffer.speech_stopped':
          this.speechActive = false;
          return;

        case 'input_audio_buffer.committed':
          if (event.item_id) this.pendingItems.add(event.item_id);
          this.awaitingManualCommit = false;
          this._checkFlushWaiters();
          return;

        case 'conversation.item.input_audio_transcription.delta': {
          const itemId = event.item_id || 'current';
          const next = (this.partialByItem.get(itemId) || '') + (event.delta || '');
          this.partialByItem.set(itemId, next);
          this.onPartial(itemId, next);
          return;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = event.item_id || 'current';
          this.partialByItem.delete(itemId);
          this.pendingItems.delete(itemId);
          this.onPartial(itemId, '');
          const text = event.transcript || '';
          if (text.trim()) this.onTranscript(text, itemId);
          this._checkFlushWaiters();
          return;
        }

        case 'conversation.item.input_audio_transcription.failed': {
          const itemId = event.item_id || 'current';
          this.partialByItem.delete(itemId);
          this.pendingItems.delete(itemId);
          this.onPartial(itemId, '');
          this._checkFlushWaiters();
          return;
        }

        case 'error': {
          const code = event.error?.code || '';
          if (code === 'input_audio_buffer_commit_empty') {
            // Our manual commit raced the server's VAD commit — harmless.
            this.awaitingManualCommit = false;
            this._checkFlushWaiters();
            return;
          }
          const message = event.error?.message || JSON.stringify(event.error || event);
          this.onError(new Error(message));
          return;
        }

        default:
          return;
      }
    });

    ws.on('error', (err) => {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', () => {
      this.ready = false;
      clearTimeout(this.readyFallbackTimer);
      if (this.ws === ws) this.ws = null;
      this.pendingItems.clear();
      this.awaitingManualCommit = false;
      this._resolveFlushWaiters();

      if (this.closedByUser) {
        this.onClose();
        return;
      }

      if (this.retryCount < MAX_RETRIES) {
        this.retryCount += 1;
        setTimeout(() => this._connect(), 750 * this.retryCount);
        return;
      }

      this.onError(new Error('Live transcription disconnected.'));
      this.onClose();
    });
  }
}

module.exports = { RealtimeSttSession };
