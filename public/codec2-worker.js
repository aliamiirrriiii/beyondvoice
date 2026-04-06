/**
 * Codec2 AudioWorklet Processor
 *
 * Encodes raw PCM into Codec2 1200bps frames, decodes incoming frames back to PCM.
 * Communicates with the main thread via MessagePort:
 *   Main → Worker: { type: "decode", data: Uint8Array }
 *   Worker → Main: { type: "encoded", data: Uint8Array }
 *
 * Requires codec2.wasm to be loaded and posted as:
 *   { type: "init", wasm: ArrayBuffer }
 *
 * Codec2 1200 mode: 320 samples in (40ms @ 8kHz) → 6 bytes out
 */

const FRAME_SAMPLES = 320; // 40ms at 8kHz
const FRAME_BYTES = 6;     // Codec2 1200bps output
const SAMPLE_RATE = 8000;

class Codec2Encoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.buffer = new Float32Array(0);
    this.encoder = null;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type === "init" && msg.module) {
      this._initWasm(msg.module).catch((err) => {
        this.port.postMessage({ type: "error", error: err.message });
      });
    }
  }

  async _initWasm(wasmModule) {
    // Instantiate the Codec2 WASM module.
    // Expected exports: codec2_create(mode) → ptr, codec2_encode(ptr, outBuf, inBuf), malloc, free, memory
    const instance = await WebAssembly.instantiate(wasmModule);
    const exports = instance.exports;
    const memory = exports.memory;

    const codec2Ptr = exports.codec2_create(8); // mode 8 = CODEC2_MODE_1200
    const inPtr = exports.malloc(FRAME_SAMPLES * 2); // int16 input
    const outPtr = exports.malloc(FRAME_BYTES);

    this.encoder = { exports, memory, codec2Ptr, inPtr, outPtr };
    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }

  process(inputs) {
    if (!this.ready || !inputs[0] || !inputs[0][0]) return true;

    const input = inputs[0][0]; // Float32, 128 samples at sampleRate
    // Downsample to 8kHz (simple decimation — for production, use a proper resampler)
    const ratio = sampleRate / SAMPLE_RATE;
    const downsampled = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < downsampled.length; i++) {
      downsampled[i] = input[Math.round(i * ratio)];
    }

    // Accumulate into frame buffer
    const prev = this.buffer;
    this.buffer = new Float32Array(prev.length + downsampled.length);
    this.buffer.set(prev);
    this.buffer.set(downsampled, prev.length);

    // Encode complete frames
    while (this.buffer.length >= FRAME_SAMPLES) {
      const frame = this.buffer.slice(0, FRAME_SAMPLES);
      this.buffer = this.buffer.slice(FRAME_SAMPLES);
      this._encodeFrame(frame);
    }

    return true;
  }

  _encodeFrame(float32Frame) {
    const { exports, memory, codec2Ptr, inPtr, outPtr } = this.encoder;

    // Convert float32 [-1,1] to int16
    const int16View = new Int16Array(memory.buffer, inPtr, FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      int16View[i] = Math.max(-32768, Math.min(32767, Math.round(float32Frame[i] * 32767)));
    }

    exports.codec2_encode(codec2Ptr, outPtr, inPtr);

    const encoded = new Uint8Array(memory.buffer, outPtr, FRAME_BYTES).slice();
    this.port.postMessage({ type: "encoded", data: encoded }, [encoded.buffer]);
  }
}

class Codec2Decoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.pcmQueue = [];
    this.queueOffset = 0;
    this.decoder = null;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type === "init" && msg.module) {
      this._initWasm(msg.module).catch((err) => {
        this.port.postMessage({ type: "error", error: err.message });
      });
    } else if (msg.type === "decode" && msg.data) {
      this._decodeFrame(new Uint8Array(msg.data));
    }
  }

  async _initWasm(wasmModule) {
    const instance = await WebAssembly.instantiate(wasmModule);
    const exports = instance.exports;
    const memory = exports.memory;

    const codec2Ptr = exports.codec2_create(8);
    const inPtr = exports.malloc(FRAME_BYTES);
    const outPtr = exports.malloc(FRAME_SAMPLES * 2);

    this.decoder = { exports, memory, codec2Ptr, inPtr, outPtr };
    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }

  _decodeFrame(encoded) {
    if (!this.ready || encoded.length < FRAME_BYTES) return;

    const { exports, memory, codec2Ptr, inPtr, outPtr } = this.decoder;

    new Uint8Array(memory.buffer, inPtr, FRAME_BYTES).set(encoded);
    exports.codec2_decode(codec2Ptr, outPtr, inPtr);

    const int16View = new Int16Array(memory.buffer, outPtr, FRAME_SAMPLES);
    const float32 = new Float32Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      float32[i] = int16View[i] / 32768;
    }

    this.pcmQueue.push(float32);
  }

  process(inputs, outputs) {
    if (!this.ready) return true;

    const output = outputs[0]?.[0];
    if (!output) return true;

    // Upsample from 8kHz to output sampleRate and fill output buffer
    const ratio = sampleRate / SAMPLE_RATE;
    let written = 0;

    while (written < output.length && this.pcmQueue.length > 0) {
      const frame = this.pcmQueue[0];
      while (written < output.length && this.queueOffset < frame.length) {
        output[written] = frame[Math.min(this.queueOffset, frame.length - 1)];
        written++;
        this.queueOffset += 1 / ratio;
      }
      if (this.queueOffset >= frame.length) {
        this.pcmQueue.shift();
        this.queueOffset = 0;
      }
    }

    // Fill remaining with silence
    for (let i = written; i < output.length; i++) {
      output[i] = 0;
    }

    return true;
  }
}

registerProcessor("codec2-encoder", Codec2Encoder);
registerProcessor("codec2-decoder", Codec2Decoder);
