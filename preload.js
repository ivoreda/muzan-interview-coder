// Runs in an isolated, sandboxed context. Exposes a narrow API to the renderer instead
// of full Node access, so model output rendered as HTML can't reach the filesystem/shell.
const { contextBridge, ipcRenderer } = require('electron');

const RECEIVE_CHANNELS = new Set([
  'open-api-key-settings',
  'answer-start',
  'answer-delta',
  'answer-done',
  'error',
  'update-instruction',
  'hide-instruction',
  'hide-app',
  'show-app',
  'clear-result',
  'transcript-update',
  'start-listening',
  'stop-listening',
  'scroll-response'
]);

contextBridge.exposeInMainWorld('muzan', {
  keyStatus: () => ipcRenderer.invoke('api-key-status'),
  saveKey: (value) => ipcRenderer.invoke('save-api-key', value),
  on(channel, callback) {
    if (!RECEIVE_CHANNELS.has(channel)) throw new Error(`Unknown channel: ${channel}`);
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },
  sendAudio(arrayBuffer) {
    ipcRenderer.send('audio-chunk', arrayBuffer);
  },
  listenFailed(message) {
    ipcRenderer.send('listen-failed', String(message));
  },
  copyText(text) {
    ipcRenderer.send('copy-text', String(text));
  }
});
