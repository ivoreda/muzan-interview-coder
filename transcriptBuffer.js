class TranscriptBuffer {
  constructor(maxAgeMs = 90000) {
    this.maxAgeMs = maxAgeMs;
    this.entries = [];
  }

  append(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    this.prune();
    this.entries.push({ text: trimmed, at: Date.now() });
  }

  getText() {
    this.prune();
    return this.entries.map((e) => e.text).join(' ').trim();
  }

  clear() {
    this.entries = [];
  }

  prune() {
    const cutoff = Date.now() - this.maxAgeMs;
    this.entries = this.entries.filter((e) => e.at >= cutoff);
  }
}

module.exports = { TranscriptBuffer };
