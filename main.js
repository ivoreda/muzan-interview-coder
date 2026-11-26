const { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, clipboard, dialog, screen, safeStorage } = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const { PROVIDERS, generateAnswer } = require('./providers');
const { TranscriptBuffer } = require('./transcriptBuffer');
const { RealtimeSttSession } = require('./realtimeStt');
const { uIOhook, UiohookKey } = require('uiohook-napi');

const IS_MAC = process.platform === 'darwin';

// ---------- Config ----------

const DEFAULT_SHORTCUTS = {
    listen: 'CommandOrControl+Shift+V',
    answer: 'CommandOrControl+Shift+Enter',
    screenshot: 'CommandOrControl+Shift+S',
    multi: 'CommandOrControl+Shift+A',
    reset: 'CommandOrControl+Shift+R',
    toggleWindow: 'CommandOrControl+Shift+W',
    quit: 'CommandOrControl+Shift+Q',
    scrollDown: 'CommandOrControl+Shift+J',
    scrollUp: 'CommandOrControl+Shift+K',
    opacityDown: 'CommandOrControl+Shift+9',
    opacityUp: 'CommandOrControl+Shift+0',
    shrink: 'CommandOrControl+Shift+-',
    grow: 'CommandOrControl+Shift+='
};

function fatalConfigError(message) {
    console.error('Config error:', message);
    dialog.showErrorBox('Muzan Interview Coder — setup needed', message);
    app.exit(1);
}

function isReasoningModel(model) {
    return /^(o\d|gpt-5)/i.test(model) && !/chat/i.test(model);
}

function loadConfig() {
    // Packaged builds look in the per-user data folder first (the app bundle is read-only);
    // a config.json next to main.js still works when running from source.
    const candidates = [path.join(app.getPath('userData'), 'config.json'), path.join(__dirname, 'config.json')];
    const configPath = candidates.find(p => fs.existsSync(p));
    let fileConfig = {};
    if (configPath) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (err) {
            fatalConfigError(`config.json is not valid JSON:\n${err.message}`);
            return null;
        }
    }

    const model = fileConfig.model || 'gpt-4o-mini';
    const reasoning = isReasoningModel(model);
    return {
        model,
        reasoning,
        // Reasoning tokens count toward the completion budget, so give reasoning models more room.
        maxTokens: fileConfig.maxTokens || (reasoning ? 16000 : 5000),
        reasoningEffort: fileConfig.reasoningEffort === undefined ? 'low' : fileConfig.reasoningEffort,
        sttModel: fileConfig.sttModel || 'gpt-4o-mini-transcribe',
        language: fileConfig.language || 'en',
        echoCancellation: Boolean(fileConfig.echoCancellation),
        historyTurns: Number.isInteger(fileConfig.historyTurns) ? fileConfig.historyTurns : 3,
        transcriptWindowSeconds: fileConfig.transcriptWindowSeconds || 90,
        screenshotMaxWidth: fileConfig.screenshotMaxWidth || 1920,
        screenshotJpegQuality: fileConfig.screenshotJpegQuality || 80,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...(fileConfig.shortcuts || {}) }
    };
}

const config = loadConfig();


let providerSettings = { provider: 'openai', profiles: {} };
const keyPath = () => path.join(app.getPath('userData'), 'api-key.enc');

function loadApiKey() {
    try {
        if (safeStorage.isEncryptionAvailable() && fs.existsSync(keyPath())) {
            const stored = safeStorage.decryptString(fs.readFileSync(keyPath()));
            // Preserve keys saved by the original OpenAI-only setup.
            if (stored.startsWith('sk-')) {
                providerSettings.profiles.openai = { key: stored, model: config.model };
            } else {
                const parsed = JSON.parse(stored);
                if (!Object.hasOwn(PROVIDERS, parsed.provider) || !parsed.profiles) throw new Error('Invalid settings');
                providerSettings = parsed;
            }
        }
    } catch (_) {
        console.warn('Saved provider settings could not be read. Configure your provider again.');
    }
}

function requireApiKey() {
    if (providerSettings.profiles[providerSettings.provider]?.key) return true;
    showMainWindow();
    sendToRenderer('open-api-key-settings');
    return false;
}

function settingsStatus() {
    return {
        configured: Boolean(providerSettings.profiles[providerSettings.provider]?.key),
        provider: providerSettings.provider,
        profiles: Object.fromEntries(Object.entries(PROVIDERS).map(([id, definition]) => [id, {
            configured: Boolean(providerSettings.profiles[id]?.key),
            model: providerSettings.profiles[id]?.model || (id === 'openai' ? config.model : definition.model)
        }]))
    };
}
ipcMain.handle('api-key-status', settingsStatus);
ipcMain.handle('save-api-key', (_event, value) => {
    if (!value || !Object.hasOwn(PROVIDERS, value.provider)) return { error: 'Choose a supported provider.' };
    const key = typeof value.key === 'string' ? value.key.trim() : '';
    const model = typeof value.model === 'string' ? value.model.trim() : '';
    if (!model || model.length > 200 || /\s/.test(model)) return { error: 'Enter a valid model ID.' };
    if (key && (key.length > 4096 || /\s/.test(key))) return { error: 'Enter a valid API key without spaces.' };
    const existing = providerSettings.profiles[value.provider]?.key;
    if (!key && !existing) return { error: 'Enter an API key for this provider.' };
    if (!safeStorage.isEncryptionAvailable()) return { error: 'Secure key storage is unavailable on this computer.' };
    const next = { provider: value.provider, profiles: {
        ...providerSettings.profiles, [value.provider]: { key: key || existing, model }
    }};
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(keyPath(), safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
        stopListeningSession();
        clearTranscriptState();
        providerSettings = next;
        if (currentAbort) currentAbort.abort();
        history = [];
        updateInstruction();
        return settingsStatus();
    } catch (_) {
        return { error: 'Could not securely save provider settings. Please try again.' };
    }
});


// ---------- State ----------

let mainWindow;
let screenshots = [];
let multiPageMode = false;
let showWindow = true;
let stage = 0; // 0 = boot up stage, 1 = multi capture, 2 = AI Answered
let isListening = false;
let answerInFlight = false;
let currentAbort = null;
let sttSession = null;
const partials = new Map(); // STT item id -> in-progress transcript text
const consumedItemIds = new Set(); // partials already sent in an answer; skip their final transcript
const transcriptBuffer = new TranscriptBuffer((config ? config.transcriptWindowSeconds : 90) * 1000);
let history = []; // [{ user, assistant }] — text-only, for follow-up questions
let currentInstruction = '';
let flashTimer = null;
let failedShortcuts = [];

function log(...args) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]`, ...args);
}

// ---------- Instruction banner ----------

function key(name) {
    const accel = config.shortcuts[name];
    if (!accel) return '(unset)';
    return accel.replace(/CommandOrControl|CmdOrCtrl/g, IS_MAC ? 'Cmd' : 'Ctrl');
}

function idleInstruction() {
    if (multiPageMode && screenshots.length) {
        return `Multi-mode: ${screenshots.length} shot(s). ${key('multi')}: add | ${key('answer')}: answer | ${key('screenshot')}: image-only`;
    }
    const listenPrefix = isListening ? `Listening… ${key('listen')}: stop | ` : '';
    if (stage === 2) {
        return `${listenPrefix}${key('answer')}: Answer / follow-up | ${key('scrollDown')}/${key('scrollUp')}: Scroll | ${key('reset')}: Reset | ${key('toggleWindow')}: Hide`;
    }
    if (isListening) {
        return `${listenPrefix}${key('answer')}: Answer | ${key('multi')}: Add screenshot`;
    }
    return `${key('listen')}: Listen | ${key('answer')}: Answer | ${key('screenshot')}: Screenshot | ${key('multi')}: Multi | ${key('toggleWindow')}: Hide | ${key('quit')}: Quit`;
}

function canSendToRenderer() {
    return Boolean(
        mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.webContents &&
        !mainWindow.webContents.isDestroyed()
    );
}

function sendToRenderer(channel, ...args) {
    if (!canSendToRenderer()) return;
    mainWindow.webContents.send(channel, ...args);
}

function updateInstruction(instruction) {
    clearTimeout(flashTimer);
    currentInstruction = instruction || idleInstruction();
    sendToRenderer('update-instruction', currentInstruction);
}

/** Show a message briefly, then restore whatever the banner said before. */
function flashInstruction(message, ms = 1800) {
    clearTimeout(flashTimer);
    sendToRenderer('update-instruction', message);
    flashTimer = setTimeout(() => sendToRenderer('update-instruction', currentInstruction || idleInstruction()), ms);
}

function hideInstruction() {
    sendToRenderer('hide-instruction');
}

function sendError(message) {
    sendToRenderer('error', { message, hint: `Press ${key('reset')} to reset and try again` });
}

// ---------- Transcript ----------

function livePartialEntries() {
    return [...partials.entries()].filter(([id, text]) => text.trim() && !consumedItemIds.has(id));
}

function getPendingTranscript() {
    const committed = transcriptBuffer.getText();
    const partial = livePartialEntries().map(([, t]) => t.trim()).join(' ');
    return [committed, partial].filter(Boolean).join(' ').trim();
}

function pushTranscriptPreview() {
    sendToRenderer('transcript-update', {
        text: getPendingTranscript(),
        listening: isListening
    });
}

function clearTranscriptState() {
    transcriptBuffer.clear();
    partials.clear();
    pushTranscriptPreview();
}

// ---------- Screenshots ----------

async function captureScreenshot() {
    log('Screenshot: capturing…');
    hideInstruction();
    if (canSendToRenderer()) mainWindow.hide();
    await new Promise(res => setTimeout(res, 200));

    try {
        // Capture straight to memory (no file left behind in ~/Pictures), then downscale
        // and re-encode as JPEG: far smaller upload and fewer image tokens than a Retina PNG.
        const png = await screenshot({ format: 'png' });
        let image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) throw new Error('Screenshot came back empty (check Screen Recording permission).');

        const { width } = image.getSize();
        if (width > config.screenshotMaxWidth) {
            image = image.resize({ width: config.screenshotMaxWidth, quality: 'good' });
        }
        const jpeg = image.toJPEG(config.screenshotJpegQuality);
        log(`Screenshot: captured (${Math.round(png.length / 1024)}KB png → ${Math.round(jpeg.length / 1024)}KB jpeg)`);
        return jpeg.toString('base64');
    } finally {
        if (canSendToRenderer()) mainWindow.showInactive();
        showWindow = true;
    }
}

// ---------- Model ----------

const SYSTEM_PROMPT = [
    'You are a strong candidate answering a technical interview question. Reply exactly as you would say it to the interviewer.',
    'Start with the answer in the very first sentence. No preamble, no restating the question, no "Great question", no headings like "Answer:", no closing summary.',
    'Conceptual / behavioral / "what is X" questions: a direct 1–2 sentence answer, then at most 2–4 short supporting points. Add ONE brief example (a single line or small snippet) only when it makes the answer clearer.',
    'Coding / algorithm problems: one or two lines on the approach, the complete correct code, then one line with time and space complexity. Mention an edge case only if it matters.',
    'Keep it short enough to read aloud in under a minute. Do not list alternatives, caveats or follow-ups unless asked.',
    'Unless the question explicitly requires a different language, write all code in JavaScript.',
    'Always wrap code in fenced markdown code blocks with a language tag (e.g. ```javascript).',
    'If screenshots show code, troubleshoot or solve it as asked.',
    'Earlier turns in this conversation may be related; treat short questions as follow-ups to them.'
].join('\n');

function buildUserText(transcript, imageCount) {
    if (transcript && imageCount) {
        return `Use both the spoken question/context and the screenshot(s).\n\nSpoken context:\n${transcript}`;
    }
    if (transcript) return `Question: ${transcript}`;
    return 'Solve or troubleshoot the problem shown in the screenshot(s). Provide the full solution.';
}

function buildMessages(userText, images) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    for (const turn of history) {
        messages.push({ role: 'user', content: turn.user });
        messages.push({ role: 'assistant', content: turn.assistant });
    }
    messages.push({
        role: 'user',
        content: [
            { type: 'text', text: userText },
            ...images.map((img) => ({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${img}` }
            }))
        ]
    });
    return messages;
}

async function streamModel(messages, signal, onDelta) {
    const { provider, profiles } = providerSettings;
    return generateAnswer(provider, profiles[provider], [], fetch, {
        messages, signal, onDelta,
        maxTokens: config.maxTokens,
        reasoningEffort: config.reasoningEffort
    });
}

async function answerNow({ imagesOnly = false } = {}) {
    if (!requireApiKey()) return;
    if (answerInFlight) {
        flashInstruction(`Still answering… ${key('reset')} to cancel`);
        return;
    }

    answerInFlight = true;
    const abort = new AbortController();
    currentAbort = abort;
    let consumedIds = [];

    try {
        // If the interviewer just stopped talking, finish transcribing that last bit first.
        if (!imagesOnly && sttSession) {
            updateInstruction('Finishing transcript…');
            await sttSession.flush(1500);
            if (abort.signal.aborted) return;
        }

        const snapshot = imagesOnly ? { text: '', lastSeq: 0 } : transcriptBuffer.snapshot();
        const partialEntries = imagesOnly ? [] : livePartialEntries();
        const transcript = [snapshot.text, ...partialEntries.map(([, t]) => t.trim())].filter(Boolean).join(' ').trim();
        const images = [...screenshots];

        if (!transcript && images.length === 0) {
            log('Answer: skipped (empty context)');
            updateInstruction();
            flashInstruction('Nothing to answer yet');
            return;
        }

        consumedIds = partialEntries.map(([id]) => id);
        consumedIds.forEach((id) => consumedItemIds.add(id));

        log('Answer: thinking…', {
            transcriptChars: transcript.length,
            screenshots: images.length,
            historyTurns: history.length
        });
        const startedAt = Date.now();
        const userText = buildUserText(transcript, images.length);
        sendToRenderer('answer-start', { label: 'Thinking…' });
        updateInstruction(`Answering… ${key('reset')}: cancel | ${key('scrollDown')}/${key('scrollUp')}: Scroll`);

        const { text, finishReason } = await streamModel(
            buildMessages(userText, images),
            abort.signal,
            (delta) => { if (!abort.signal.aborted) sendToRenderer('answer-delta', delta); }
        );
        if (abort.signal.aborted) return;

        if (!text.trim()) {
            throw new Error(finishReason === 'length'
                ? `The model used its whole token budget (maxTokens: ${config.maxTokens}) before answering. Lower "reasoningEffort" or raise "maxTokens" in config.json.`
                : 'The model returned an empty answer.');
        }

        // Consume only what was actually sent — speech/screenshots that arrived during
        // the request stay queued for the next answer.
        screenshots = screenshots.slice(images.length);
        multiPageMode = screenshots.length > 0;
        transcriptBuffer.clearThrough(snapshot.lastSeq);
        consumedIds.forEach((id) => partials.delete(id));
        pushTranscriptPreview();

        const historyUser = images.length ? `${userText}\n\n[${images.length} screenshot(s) were attached]` : userText;
        history.push({ user: historyUser, assistant: text });
        if (history.length > config.historyTurns) history = history.slice(history.length - config.historyTurns);

        const elapsedMs = Date.now() - startedAt;
        sendToRenderer('answer-done', {
            text,
            elapsedMs,
            note: finishReason === 'length' ? 'hit maxTokens — answer may be cut off' : ''
        });
        stage = 2;
        updateInstruction();
        log(`Answer: done in ${(elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
        consumedIds.forEach((id) => consumedItemIds.delete(id));
        if (abort.signal.aborted) {
            log('Answer: cancelled');
            return;
        }
        console.error('Error in answerNow:', err);
        sendError(err.message);
        updateInstruction();
    } finally {
        if (currentAbort === abort) currentAbort = null;
        answerInFlight = false;
    }
}

// ---------- Listening ----------

function stopListeningSession({ notifyRenderer = true } = {}) {
    const wasListening = isListening || Boolean(sttSession);
    isListening = false;
    partials.clear();
    consumedItemIds.clear();
    if (sttSession) {
        sttSession.stop();
        sttSession = null;
    }
    if (notifyRenderer) {
        sendToRenderer('stop-listening');
        pushTranscriptPreview();
    }
    if (wasListening) log('Listen: stopped');
}

function startListeningSession() {
    if (!providerSettings.profiles.openai?.key) {
        showMainWindow();
        sendToRenderer('open-api-key-settings');
        flashInstruction('Live transcription needs an OpenAI key. Save one in API key settings.', 5000);
        return;
    }
    if (sttSession) {
        sttSession.stop();
        sttSession = null;
    }

    partials.clear();
    consumedItemIds.clear();
    log('Listen: starting STT session…');
    sttSession = new RealtimeSttSession({
        apiKey: providerSettings.profiles.openai.key,
        model: config.sttModel,
        language: config.language,
        onTranscript: (text, itemId) => {
            if (consumedItemIds.delete(itemId)) return; // already answered from its partial
            transcriptBuffer.append(text);
            pushTranscriptPreview();
            const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
            log('Transcript:', preview);
        },
        onPartial: (itemId, text) => {
            if (text) partials.set(itemId, text);
            else partials.delete(itemId);
            pushTranscriptPreview();
        },
        onError: (err) => {
            log('STT error:', err.message);
            flashInstruction(`STT error: ${err.message}`, 4000);
        },
        onClose: () => {
            if (!isListening) return;
            isListening = false;
            sttSession = null;
            partials.clear();
            sendToRenderer('stop-listening');
            updateInstruction();
            flashInstruction('Listening stopped (connection lost)', 4000);
            pushTranscriptPreview();
            log('Listen: connection lost');
        }
    });

    isListening = true;
    sttSession.start();
    sendToRenderer('start-listening', { echoCancellation: config.echoCancellation });
    updateInstruction();
    pushTranscriptPreview();
    log('Listen: on');
}

function toggleListening() {
    if (isListening) {
        stopListeningSession();
        clearTranscriptState();
        updateInstruction();
    } else {
        startListeningSession();
    }
}

function resetProcess() {
    log('Reset');
    if (currentAbort) currentAbort.abort();
    screenshots = [];
    multiPageMode = false;
    history = [];
    stage = 0;
    clearTranscriptState();
    sendToRenderer('clear-result');
    updateInstruction();
}

// ---------- Window ----------

function showMainWindow() {
    if (!canSendToRenderer()) return;
    mainWindow.showInactive();
    sendToRenderer('show-app', { showResponse: stage === 2 || answerInFlight });
    updateInstruction();
    showWindow = true;
    log('Window: shown');
}

function hideMainWindow() {
    sendToRenderer('hide-app');
    if (canSendToRenderer()) mainWindow.hide();
    showWindow = false;
    log('Window: hidden');
}

function adjustOpacity(delta) {
    if (!canSendToRenderer()) return;
    const next = Math.max(0.2, Math.min(1, Math.round((mainWindow.getOpacity() + delta) * 10) / 10));
    mainWindow.setOpacity(next);
    flashInstruction(`Opacity ${Math.round(next * 100)}%`, 1000);
}

function resizeWindow(factor) {
    if (!canSendToRenderer()) return;
    const bounds = mainWindow.getBounds();
    const { workArea } = screen.getDisplayMatching(bounds);
    const width = Math.max(420, Math.min(workArea.width, Math.round(bounds.width * factor)));
    const height = Math.max(320, Math.min(workArea.height, Math.round(bounds.height * factor)));
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
    flashInstruction(`Size ${width}×${height}`, 1000);
}

ipcMain.on('audio-chunk', (event, pcm) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (isListening && sttSession && pcm) {
        sttSession.appendAudio(Buffer.from(pcm).toString('base64'));
    }
});

ipcMain.on('listen-failed', (event, message) => {
    log('Listen: mic failed —', message);
    stopListeningSession();
    clearTranscriptState();
    updateInstruction(`Microphone access denied: ${message}`);
});

ipcMain.on('copy-text', (event, text) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    clipboard.writeText(String(text || ''));
});

function createWindow() {
    stage = 0;
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        },
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        paintWhenInitiallyHidden: true,
        contentProtection: true,
        type: 'toolbar',
    });

    mainWindow.loadFile('index.html');
    mainWindow.setContentProtection(true);

    const { session } = mainWindow.webContents;
    session.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(permission === 'media');
    });
    session.setPermissionCheckHandler((webContents, permission) => permission === 'media');

    // Links in model output must never navigate the overlay or open new windows.
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    mainWindow.webContents.on('did-finish-load', () => {
        updateInstruction();
        if (failedShortcuts.length) {
            flashInstruction(`Shortcut(s) in use by another app: ${failedShortcuts.join(', ')} — change them in config.json`, 8000);
        }
    });

    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

    mainWindow.on('closed', () => {
        log('Window: closed');
        mainWindow = null;
    });
}

// ---------- Shortcuts ----------

async function onScreenshotSolve() {
    if (!requireApiKey()) return;
    if (answerInFlight) {
        flashInstruction(`Still answering… ${key('reset')} to cancel`);
        return;
    }
    try {
        screenshots.push(await captureScreenshot());
    } catch (err) {
        console.error('Screenshot error:', err);
        sendError(err.message);
        updateInstruction();
        return;
    }
    await answerNow({ imagesOnly: true });
}

async function onMultiCapture() {
    if (!requireApiKey()) return;
    try {
        multiPageMode = true;
        screenshots.push(await captureScreenshot());
        stage = 1;
        updateInstruction();
    } catch (err) {
        console.error('Multi capture error:', err);
        sendError(err.message);
        updateInstruction();
    }
}

function registerShortcuts() {
    const actions = {
        listen: toggleListening,
        answer: () => answerNow(),
        screenshot: onScreenshotSolve,
        multi: onMultiCapture,
        reset: resetProcess,
        toggleWindow: () => (showWindow ? hideMainWindow() : showMainWindow()),
        quit: () => {
            log('Quit requested');
            stopListeningSession({ notifyRenderer: false });
            app.quit();
        },
        scrollDown: () => sendToRenderer('scroll-response', 1),
        scrollUp: () => sendToRenderer('scroll-response', -1),
        opacityDown: () => adjustOpacity(-0.1),
        opacityUp: () => adjustOpacity(0.1),
        shrink: () => resizeWindow(0.9),
        grow: () => resizeWindow(1.1)
    };

    failedShortcuts = [];
    for (const [name, handler] of Object.entries(actions)) {
        const accelerator = config.shortcuts[name];
        if (!accelerator) continue; // disabled in config
        let ok = false;
        try {
            ok = globalShortcut.register(accelerator, handler);
        } catch (err) {
            log(`Shortcut "${name}" has an invalid accelerator "${accelerator}":`, err.message);
        }
        if (!ok) failedShortcuts.push(`${name} (${key(name)})`);
    }
    if (failedShortcuts.length) log('Failed to register shortcuts:', failedShortcuts.join(', '));
}

// ---------- Window movement (hold Cmd/Ctrl+Shift+Arrow) ----------

const MOVE_TICK_PX = 12;
const MOVE_TICK_MS = 16; // ~60fps

const ARROW_DELTAS = {
    [UiohookKey.ArrowUp]: [0, -1],
    [UiohookKey.ArrowDown]: [0, 1],
    [UiohookKey.ArrowLeft]: [-1, 0],
    [UiohookKey.ArrowRight]: [1, 0],
};

const moveModifierHeld = { primary: false, shift: false }; // primary = Cmd on mac, Ctrl elsewhere
const moveIntervals = new Map(); // keycode -> interval id

function isMoveModifierKey(keycode) {
    if (IS_MAC) {
        return keycode === UiohookKey.Meta || keycode === UiohookKey.MetaRight;
    }
    return keycode === UiohookKey.Ctrl || keycode === UiohookKey.CtrlRight;
}

function isShiftKey(keycode) {
    return keycode === UiohookKey.Shift || keycode === UiohookKey.ShiftRight;
}

function stepWindow(dx, dy) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const pos = mainWindow.getPosition();
    mainWindow.setPosition(pos[0] + dx, pos[1] + dy);
}

function stopAllWindowMoves() {
    for (const intervalId of moveIntervals.values()) clearInterval(intervalId);
    moveIntervals.clear();
}

function startWindowMoveListener() {
    uIOhook.on('keydown', (e) => {
        if (isMoveModifierKey(e.keycode)) moveModifierHeld.primary = true;
        if (isShiftKey(e.keycode)) moveModifierHeld.shift = true;

        const delta = ARROW_DELTAS[e.keycode];
        if (!delta || !moveModifierHeld.primary || !moveModifierHeld.shift) return;
        if (moveIntervals.has(e.keycode)) return; // already moving from key auto-repeat

        stepWindow(delta[0] * MOVE_TICK_PX, delta[1] * MOVE_TICK_PX);
        moveIntervals.set(e.keycode, setInterval(() => {
            stepWindow(delta[0] * MOVE_TICK_PX, delta[1] * MOVE_TICK_PX);
        }, MOVE_TICK_MS));
    });

    uIOhook.on('keyup', (e) => {
        if (isMoveModifierKey(e.keycode)) {
            moveModifierHeld.primary = false;
            stopAllWindowMoves();
        }
        if (isShiftKey(e.keycode)) {
            moveModifierHeld.shift = false;
            stopAllWindowMoves();
        }
        if (moveIntervals.has(e.keycode)) {
            clearInterval(moveIntervals.get(e.keycode));
            moveIntervals.delete(e.keycode);
        }
    });

    uIOhook.start();
}

// ---------- App lifecycle ----------

if (config) {
    app.whenReady().then(() => {
        loadApiKey();
        log('App ready — model:', config.model,
            config.reasoning ? `(reasoning: ${config.reasoningEffort || 'default'})` : '',
            '| STT:', config.sttModel);
        createWindow();
        // Registered once per app run (not per window) so re-creating the window can't fail them.
        registerShortcuts();
        startWindowMoveListener();
        log(idleInstruction());
    });
}

app.on('window-all-closed', () => {
    stopListeningSession({ notifyRenderer: false });
    globalShortcut.unregisterAll();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    log('App quitting');
    if (currentAbort) currentAbort.abort();
    stopListeningSession({ notifyRenderer: false });
    globalShortcut.unregisterAll();
    stopAllWindowMoves();
    try { uIOhook.stop(); } catch (_) {}
});

app.on('activate', () => {
    if (config && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        if (!globalShortcut.isRegistered(config.shortcuts.answer)) registerShortcuts();
    }
});
