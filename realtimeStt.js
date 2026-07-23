const WebSocket = require('ws');

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const MAX_RETRIES = 2;

class RealtimeSttSession {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.model]
   * @param {(text: string) => void} options.onTranscript
   * @param {(partial: string) => void} [options.onPartial]
   * @param {(err: Error) => void} [options.onError]
   * @param {() => void} [options.onClose]
   */
  constructor({ apiKey, model = 'gpt-4o-mini-transcribe', onTranscript, onPartial, onError, onClose }) {
    this.apiKey = apiKey;
    this.model = model;
    this.onTranscript = onTranscript;
    this.onPartial = onPartial || (() => {});
    this.onError = onError || (() => {});
    this.onClose = onClose || (() => {});
    this.ws = null;
    this.closedByUser = false;
    this.retryCount = 0;
    this.ready = false;
    this.partialByItem = new Map();
  }

  start() {
    this.closedByUser = false;
    this.retryCount = 0;
    this._connect();
  }

  stop() {
    this.closedByUser = true;
    this.ready = false;
    this.partialByItem.clear();
    this.onPartial('');
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }

  appendAudio(base64Pcm16) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return;
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Pcm16
    }));
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

    ws.on('open', () => {
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
                language: 'en'
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

      if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
        this.ready = true;
        this.retryCount = 0;
        return;
      }

      if (event.type === 'session.created' || event.type === 'transcription_session.created') {
        // Wait for session.updated before marking ready when possible;
        // some deployments only emit created — allow append after created as fallback.
        this.ready = true;
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        const itemId = event.item_id || 'current';
        const prev = this.partialByItem.get(itemId) || '';
        const next = prev + (event.delta || '');
        this.partialByItem.set(itemId, next);
        this.onPartial(next);
        return;
      }

      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = event.item_id || 'current';
        this.partialByItem.delete(itemId);
        this.onPartial('');
        const text = event.transcript || '';
        if (text.trim()) this.onTranscript(text);
        return;
      }

      if (event.type === 'error') {
        const message = event.error?.message || JSON.stringify(event.error || event);
        this.onError(new Error(message));
      }
    });

    ws.on('error', (err) => {
      this.onError(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', () => {
      this.ready = false;
      if (this.ws === ws) this.ws = null;

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
