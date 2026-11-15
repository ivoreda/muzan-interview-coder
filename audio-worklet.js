// Collects mic samples off the main thread and posts ~100ms batches to the renderer.
class PcmBatchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = Math.round(sampleRate / 10);
    this.buffer = new Float32Array(this.batchSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let read = 0;
    while (read < channel.length) {
      const n = Math.min(channel.length - read, this.batchSize - this.offset);
      this.buffer.set(channel.subarray(read, read + n), this.offset);
      this.offset += n;
      read += n;
      if (this.offset === this.batchSize) {
        const out = this.buffer;
        this.port.postMessage(out, [out.buffer]);
        this.buffer = new Float32Array(this.batchSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-batch', PcmBatchProcessor);
