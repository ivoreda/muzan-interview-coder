class TranscriptBuffer {
  constructor(maxAgeMs = 90000) {
    this.maxAgeMs = maxAgeMs;
    this.entries = [];
    this.seq = 0;
  }

  append(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    this.prune();
    this.seq += 1;
    this.entries.push({ seq: this.seq, text: trimmed, at: Date.now() });
  }

  /**
   * Returns the current text plus the sequence number of the last entry included,
   * so the caller can later clear exactly what it consumed (and nothing newer).
   */
  snapshot() {
    this.prune();
    return {
      text: this.entries.map((e) => e.text).join(' ').trim(),
      lastSeq: this.entries.length ? this.entries[this.entries.length - 1].seq : 0
    };
  }

  getText() {
    return this.snapshot().text;
  }

  /** Remove entries up to and including `seq`; anything appended later is kept. */
  clearThrough(seq) {
    this.entries = this.entries.filter((e) => e.seq > seq);
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
