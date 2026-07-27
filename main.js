const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const screenshot = require('screenshot-desktop');
const fs = require('fs');
const { OpenAI } = require('openai');
const { TranscriptBuffer } = require('./transcriptBuffer');
const { RealtimeSttSession } = require('./realtimeStt');

let config;
try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);

    if (!config.apiKey) {
        throw new Error("API key is missing in config.json");
    }

    if (!config.model) {
        config.model = "gpt-4o-mini";
        console.log("Model not specified in config, using default:", config.model);
    }
} catch (err) {
    console.error("Error reading config:", err.message);
    process.exit(1);
}
const openai = new OpenAI({ apiKey: config.apiKey });

let mainWindow;
let screenshots = [];
let multiPageMode = false;
let showWindow = true;
let stage = 0; // 0 = boot up stage, 1 = multi capture, 2 = AI Answered
let isListening = false;
let answerInFlight = false;
let sttSession = null;
let partialTranscript = '';
const transcriptBuffer = new TranscriptBuffer(90000);

const INSTRUCTIONS = "Ctrl+Shift+V: Listen | Ctrl+Shift+Enter: Answer | Ctrl+Shift+S: Screenshot | Ctrl+Shift+A: Multi | Ctrl+Shift+W: Hide | Ctrl+Shift+Q: Quit";

function log(...args) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]`, ...args);
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

function getPendingTranscript() {
    const committed = transcriptBuffer.getText();
    const partial = (partialTranscript || '').trim();
    if (committed && partial) return `${committed} ${partial}`.trim();
    return committed || partial;
}

function pushTranscriptPreview() {
    sendToRenderer('transcript-update', {
        text: getPendingTranscript(),
        listening: isListening
    });
}

function clearTranscriptState() {
    transcriptBuffer.clear();
    partialTranscript = '';
    pushTranscriptPreview();
}

function updateInstruction(instruction) {
    sendToRenderer('update-instruction', instruction || INSTRUCTIONS);
}

function hideInstruction() {
    sendToRenderer('hide-instruction');
}

async function captureScreenshot() {
    try {
        log('Screenshot: capturing…');
        hideInstruction();
        if (canSendToRenderer()) mainWindow.hide();
        await new Promise(res => setTimeout(res, 200));

        const timestamp = Date.now();
        const imagePath = path.join(app.getPath('pictures'), `screenshot_${timestamp}.png`);
        await screenshot({ filename: imagePath });

        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');

        if (canSendToRenderer()) mainWindow.show();
        log('Screenshot: captured');
        return base64Image;
    } catch (err) {
        if (canSendToRenderer()) mainWindow.show();
        sendToRenderer('error', err.message);
        throw err;
    }
}

function showMainWindow() {
    if (!canSendToRenderer()) return;
    mainWindow.show();
    if (stage == 2)
        sendToRenderer('show-app');
    else
        updateInstruction(isListening ? "Listening... Ctrl+Shift+V to stop | Ctrl+Shift+Enter: Answer" : INSTRUCTIONS);
    showWindow = true;
    log('Window: shown');
}

function hideMainWindow() {
    sendToRenderer('hide-app');
    if (canSendToRenderer()) mainWindow.hide();
    showWindow = false;
    log('Window: hidden');
}

function buildAnswerContent(transcript, images) {
    const parts = [];
    let prompt = "Please answer the following interview question. Provide a complete answer, and ensure all code snippets are wrapped in standard markdown code blocks (e.g. ```javascript ... ```).";

    if (transcript && images.length) {
        prompt += " Use both the spoken question/context and the screenshot(s). If the screenshots show code, troubleshoot or solve it as asked.";
        parts.push({ type: "text", text: `${prompt}\n\nSpoken context:\n${transcript}` });
    } else if (transcript) {
        parts.push({ type: "text", text: `${prompt}\n\nQuestion: ${transcript}` });
    } else {
        parts.push({
            type: "text",
            text: "Please solve or troubleshoot the problem shown in the screenshots. Provide the full solution, and crucially, ensure all code snippets are wrapped in standard markdown code blocks (e.g., ```javascript ... ```)."
        });
    }

    for (const img of images) {
        parts.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${img}` }
        });
    }

    return parts;
}

async function runModel(contentParts) {
    const response = await openai.chat.completions.create({
        model: config.model,
        messages: [{ role: "user", content: contentParts }],
        max_completion_tokens: 5000
    });
    return response.choices[0].message.content;
}

async function processScreenshots() {
    try {
        log('Answer: image-only solve…');
        const content = buildAnswerContent('', screenshots);
        const result = await runModel(content);
        screenshots = [];
        multiPageMode = false;
        sendToRenderer('analysis-result', result);
        stage = 2;
        log('Answer: image-only done');
    } catch (err) {
        console.error("Error in processScreenshots:", err);
        sendToRenderer('error', err.message);
    }
}

async function answerNow() {
    if (answerInFlight) return;

    const transcript = getPendingTranscript();
    const images = [...screenshots];

    if (!transcript && images.length === 0) {
        log('Answer: skipped (empty context)');
        updateInstruction("Nothing to answer yet");
        return;
    }

    answerInFlight = true;
    try {
        log('Answer: thinking…', {
            transcriptChars: transcript.length,
            screenshots: images.length
        });
        updateInstruction("Thinking...");
        const content = buildAnswerContent(transcript, images);
        const result = await runModel(content);
        screenshots = [];
        multiPageMode = false;
        clearTranscriptState();
        sendToRenderer('analysis-result', result);
        stage = 2;
        if (isListening) {
            updateInstruction("Listening... Ctrl+Shift+V to stop | Ctrl+Shift+Enter: Answer");
        }
        log('Answer: done');
    } catch (err) {
        console.error("Error in answerNow:", err);
        sendToRenderer('error', err.message);
    } finally {
        answerInFlight = false;
    }
}

function stopListeningSession({ notifyRenderer = true } = {}) {
    const wasListening = isListening || Boolean(sttSession);
    isListening = false;
    partialTranscript = '';
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
    if (sttSession) {
        sttSession.stop();
        sttSession = null;
    }

    partialTranscript = '';
    log('Listen: starting STT session…');
    sttSession = new RealtimeSttSession({
        apiKey: config.apiKey,
        model: config.sttModel || 'gpt-4o-mini-transcribe',
        onTranscript: (text) => {
            transcriptBuffer.append(text);
            pushTranscriptPreview();
            const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
            log('Transcript:', preview);
        },
        onPartial: (text) => {
            partialTranscript = text || '';
            pushTranscriptPreview();
        },
        onError: (err) => {
            console.error("STT error:", err.message);
            log('STT error:', err.message);
            sendToRenderer('update-instruction', `STT error: ${err.message}`);
        },
        onClose: () => {
            if (!isListening) return;
            isListening = false;
            sttSession = null;
            partialTranscript = '';
            sendToRenderer('stop-listening');
            updateInstruction("Listening stopped (connection lost). " + INSTRUCTIONS);
            pushTranscriptPreview();
            log('Listen: connection lost');
        }
    });

    isListening = true;
    sttSession.start();
    sendToRenderer('start-listening');
    updateInstruction("Listening... Ctrl+Shift+V to stop | Ctrl+Shift+Enter: Answer");
    pushTranscriptPreview();
    log('Listen: on');
}

function toggleListening() {
    if (isListening) {
        stopListeningSession();
        clearTranscriptState();
        updateInstruction(INSTRUCTIONS);
    } else {
        startListeningSession();
    }
}

function resetProcess() {
    log('Reset');
    screenshots = [];
    multiPageMode = false;
    clearTranscriptState();
    sendToRenderer('clear-result');
    updateInstruction(isListening
        ? "Listening... Ctrl+Shift+V to stop | Ctrl+Shift+Enter: Answer"
        : INSTRUCTIONS);
    stage = 0;
}

ipcMain.on('audio-chunk', (event, base64Pcm16) => {
    if (isListening && sttSession) {
        sttSession.appendAudio(base64Pcm16);
    }
});

ipcMain.on('listen-failed', (event, message) => {
    log('Listen: mic failed —', message);
    stopListeningSession();
    clearTranscriptState();
    updateInstruction(`Microphone access denied: ${message}`);
});

function createWindow() {
    stage = 0;
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
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

    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(permission === 'media');
    });
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);

    mainWindow.on('closed', () => {
        log('Window: closed');
        mainWindow = null;
    });

    log('App ready — model:', config.model, '| STT:', config.sttModel || 'gpt-4o-mini-transcribe');
    log(INSTRUCTIONS);

    // Ctrl+Shift+S => image-only solve (or finalize multi-mode)
    globalShortcut.register('CommandOrControl+Shift+S', async () => {
        try {
            const img = await captureScreenshot();
            screenshots.push(img);
            await processScreenshots();
        } catch (error) {
            console.error("Ctrl+Shift+S error:", error);
        }
    });

    // Ctrl+Shift+A => multi-page mode (capture without solving)
    globalShortcut.register('CommandOrControl+Shift+A', async () => {
        try {
            if (!multiPageMode) {
                multiPageMode = true;
                updateInstruction("Multi-mode: Ctrl+Shift+A to add, Ctrl+Shift+Enter to answer (or Ctrl+Shift+S for image-only)");
            }
            const img = await captureScreenshot();
            screenshots.push(img);
            updateInstruction(`Multi-mode: ${screenshots.length} shot(s). Ctrl+Shift+A add | Ctrl+Shift+Enter answer | Ctrl+Shift+S image-only`);
            stage = 1;
        } catch (error) {
            console.error("Ctrl+Shift+A error:", error);
        }
    });

    // Ctrl+Shift+V => toggle live listen session
    globalShortcut.register('CommandOrControl+Shift+V', () => {
        toggleListening();
    });

    // Ctrl+Shift+Enter/Return => answer from live transcript + explicit screenshots
    const answerHotkey = () => { answerNow(); };
    globalShortcut.register('CommandOrControl+Shift+Enter', answerHotkey);
    globalShortcut.register('CommandOrControl+Shift+Return', answerHotkey);

    // Ctrl+Shift+R => reset
    globalShortcut.register('CommandOrControl+Shift+R', () => {
        resetProcess();
    });

    // Ctrl+Shift+W => Hide app
    globalShortcut.register('CommandOrControl+Shift+W', () => {
        if (showWindow) {
            hideMainWindow();
        }
        else {
            showMainWindow();
        }
    });

    // Ctrl+Shift+Q => Quit the application
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
        log('Quit requested');
        stopListeningSession({ notifyRenderer: false });
        app.quit();
    });

    // Window Movement Shortcuts
    const moveStep = 40;

    globalShortcut.register('CommandOrControl+Shift+Up', () => {
        const pos = mainWindow.getPosition();
        mainWindow.setPosition(pos[0], pos[1] - moveStep);
    });

    globalShortcut.register('CommandOrControl+Shift+Down', () => {
        const pos = mainWindow.getPosition();
        mainWindow.setPosition(pos[0], pos[1] + moveStep);
    });

    globalShortcut.register('CommandOrControl+Shift+Left', () => {
        const pos = mainWindow.getPosition();
        mainWindow.setPosition(pos[0] - moveStep, pos[1]);
    });

    globalShortcut.register('CommandOrControl+Shift+Right', () => {
        const pos = mainWindow.getPosition();
        mainWindow.setPosition(pos[0] + moveStep, pos[1]);
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    stopListeningSession({ notifyRenderer: false });
    globalShortcut.unregisterAll();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    log('App quitting');
    stopListeningSession({ notifyRenderer: false });
    globalShortcut.unregisterAll();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
