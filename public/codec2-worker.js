/**
 * Codec2 AudioWorklet Processor
 *
 * Encodes raw PCM into Codec2 low-bitrate frames, decodes incoming frames back to PCM.
 * Communicates with the main thread via MessagePort:
 *   Main → Worker: { type: "decode", data: Uint8Array }
 *   Worker → Main: { type: "encoded", data: Uint8Array }
 *
 * Requires codec2.wasm to be loaded and posted as:
 *   { type: "init", module: WebAssembly.Module }
 *
 * Frame size and byte size are discovered from the loaded Codec2 mode at runtime.
 */

const CODEC2_MODE = 8;
const CODEC2_SAMPLE_RATE = 8000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimatePitchHz(frame, sampleRate) {
  if (!frame || frame.length < 32) {
    return 0;
  }

  const minLag = Math.max(8, Math.floor(sampleRate / 320));
  const maxLag = Math.min(frame.length - 1, Math.floor(sampleRate / 60));
  let bestLag = 0;
  let bestCorrelation = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let correlation = 0;
    let energy = 0;

    for (let index = 0; index < frame.length - lag; index += 1) {
      correlation += frame[index] * frame[index + lag];
      energy += Math.abs(frame[index]) + Math.abs(frame[index + lag]);
    }

    if (!energy) {
      continue;
    }

    const normalized = correlation / energy;
    if (normalized > bestCorrelation) {
      bestCorrelation = normalized;
      bestLag = lag;
    }
  }

  if (!bestLag || bestCorrelation < 0.015) {
    return 0;
  }

  return sampleRate / bestLag;
}

function extractFrameFeatures(frame) {
  let sumSquares = 0;
  let zeroCrossings = 0;
  let lowBandEnergy = 0;
  let highBandEnergy = 0;

  for (let index = 0; index < frame.length; index += 1) {
    const sample = frame[index] || 0;
    sumSquares += sample * sample;

    if (index > 0) {
      const previous = frame[index - 1] || 0;
      if ((previous >= 0 && sample < 0) || (previous < 0 && sample >= 0)) {
        zeroCrossings += 1;
      }

      const delta = sample - previous;
      highBandEnergy += Math.abs(delta);
      lowBandEnergy += Math.abs(sample + previous) * 0.5;
    }
  }

  const rms = Math.sqrt(sumSquares / Math.max(frame.length, 1));
  const pitchHz = estimatePitchHz(frame, CODEC2_SAMPLE_RATE);
  const zeroCrossingRate = zeroCrossings / Math.max(frame.length - 1, 1);
  const voicedProbability = pitchHz
    ? clamp(0.75 - (zeroCrossingRate * 2.2) + (rms * 1.5), 0, 1)
    : clamp(0.2 + (rms * 1.2) - (zeroCrossingRate * 2.5), 0, 1);
  const spectralTilt = clamp(
    (lowBandEnergy - highBandEnergy) / Math.max(lowBandEnergy + highBandEnergy, 1e-6),
    -1,
    1
  );

  return {
    energy: clamp(rms * 4, 0, 1),
    pitchHz: clamp(pitchHz, 0, 400),
    voicedProbability,
    spectralTilt
  };
}

function instantiateCodec2Module(wasmModule) {
  const wasi = {
    fd_close() {
      return 0;
    },
    fd_seek() {
      return 0;
    },
    fd_write() {
      return 0;
    }
  };

  return WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: wasi
  }).then((result) => {
    const instance = result.instance || result;
    const exports = instance.exports;
    if (typeof exports._initialize === "function") {
      exports._initialize();
    }
    return exports;
  });
}

class Codec2Encoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.buffer = [];
    this.encoder = null;
    this.frameSamples = 0;
    this.frameBytes = 0;
    this.inputStep = sampleRate / CODEC2_SAMPLE_RATE;
    this.inputOffset = 0;
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
    const exports = await instantiateCodec2Module(wasmModule);
    const memory = exports.memory;

    const codec2Ptr = exports.codec2_create(CODEC2_MODE);
    this.frameSamples = exports.codec2_samples_per_frame(codec2Ptr);
    this.frameBytes = exports.codec2_bytes_per_frame(codec2Ptr);
    const inPtr = exports.malloc(this.frameSamples * 2);
    const outPtr = exports.malloc(this.frameBytes);

    this.encoder = { exports, memory, codec2Ptr, inPtr, outPtr };
    this.ready = true;
    this.port.postMessage({
      type: "ready",
      samplesPerFrame: this.frameSamples,
      bytesPerFrame: this.frameBytes,
      mode: CODEC2_MODE
    });
  }

  _downsample(input) {
    if (!input || input.length === 0) {
      return [];
    }

    const downsampled = [];
    let position = this.inputOffset;
    while (position < input.length) {
      const index = Math.max(0, Math.min(input.length - 1, Math.floor(position)));
      downsampled.push(input[index]);
      position += this.inputStep;
    }
    this.inputOffset = position - input.length;
    return downsampled;
  }

  process(inputs) {
    if (!this.ready || !inputs[0] || !inputs[0][0]) return true;

    const downsampled = this._downsample(inputs[0][0]);
    this.buffer.push(...downsampled);

    while (this.buffer.length >= this.frameSamples) {
      const frame = Float32Array.from(this.buffer.splice(0, this.frameSamples));
      this._encodeFrame(frame);
    }

    return true;
  }

  _encodeFrame(float32Frame) {
    const { exports, memory, codec2Ptr, inPtr, outPtr } = this.encoder;
    const features = extractFrameFeatures(float32Frame);

    // Convert float32 [-1,1] to int16
    const int16View = new Int16Array(memory.buffer, inPtr, this.frameSamples);
    for (let i = 0; i < this.frameSamples; i++) {
      int16View[i] = Math.max(-32768, Math.min(32767, Math.round(float32Frame[i] * 32767)));
    }

    exports.codec2_encode(codec2Ptr, outPtr, inPtr);

    const encoded = new Uint8Array(memory.buffer, outPtr, this.frameBytes).slice();
    this.port.postMessage({ type: "encoded", data: encoded, features }, [encoded.buffer]);
  }
}

class Codec2Decoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ready = false;
    this.pcmQueue = [];
    this.queueOffset = 0;
    this.decoder = null;
    this.frameSamples = 0;
    this.frameBytes = 0;
    this.outputStep = CODEC2_SAMPLE_RATE / sampleRate;
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  _onMessage(msg) {
    if (msg.type === "init" && msg.module) {
      this._initWasm(msg.module).catch((err) => {
        this.port.postMessage({ type: "error", error: err.message });
      });
    } else if (msg.type === "decode" && msg.data) {
      this._decodeFrame(new Uint8Array(msg.data), {
        gain: typeof msg.gain === "number" ? msg.gain : 1
      });
    } else if (msg.type === "inject-pcm" && msg.data) {
      this._injectPcm(new Float32Array(msg.data), typeof msg.gain === "number" ? msg.gain : 1);
    }
  }

  async _initWasm(wasmModule) {
    const exports = await instantiateCodec2Module(wasmModule);
    const memory = exports.memory;

    const codec2Ptr = exports.codec2_create(CODEC2_MODE);
    this.frameSamples = exports.codec2_samples_per_frame(codec2Ptr);
    this.frameBytes = exports.codec2_bytes_per_frame(codec2Ptr);
    const inPtr = exports.malloc(this.frameBytes);
    const outPtr = exports.malloc(this.frameSamples * 2);

    this.decoder = { exports, memory, codec2Ptr, inPtr, outPtr };
    this.ready = true;
    this.port.postMessage({
      type: "ready",
      samplesPerFrame: this.frameSamples,
      bytesPerFrame: this.frameBytes,
      mode: CODEC2_MODE
    });
  }

  _decodeFrame(encoded, { gain = 1 } = {}) {
    if (!this.ready || encoded.length < this.frameBytes) return;

    const { exports, memory, codec2Ptr, inPtr, outPtr } = this.decoder;

    new Uint8Array(memory.buffer, inPtr, this.frameBytes).set(encoded.subarray(0, this.frameBytes));
    exports.codec2_decode(codec2Ptr, outPtr, inPtr);

    const int16View = new Int16Array(memory.buffer, outPtr, this.frameSamples);
    const float32 = new Float32Array(this.frameSamples);
    for (let i = 0; i < this.frameSamples; i++) {
      float32[i] = (int16View[i] / 32768) * gain;
    }

    this.pcmQueue.push(float32);
  }

  _injectPcm(frame, gain = 1) {
    if (!frame?.length) {
      return;
    }

    const pcm = new Float32Array(frame.length);
    for (let index = 0; index < frame.length; index += 1) {
      pcm[index] = (frame[index] || 0) * gain;
    }
    this.pcmQueue.push(pcm);
  }

  process(inputs, outputs) {
    if (!this.ready) return true;

    const channels = outputs[0];
    const output = channels?.[0];
    if (!output) return true;

    for (let i = 0; i < output.length; i++) {
      let sample = 0;

      if (this.pcmQueue.length > 0) {
        const frame = this.pcmQueue[0];
        const index = Math.min(frame.length - 1, Math.floor(this.queueOffset));
        sample = frame[index] || 0;
        this.queueOffset += this.outputStep;

        while (this.pcmQueue.length > 0 && this.queueOffset >= this.pcmQueue[0].length) {
          this.queueOffset -= this.pcmQueue[0].length;
          this.pcmQueue.shift();
        }
      }

      output[i] = sample;
    }

    for (let channelIndex = 1; channelIndex < channels.length; channelIndex++) {
      channels[channelIndex].set(output);
    }

    return true;
  }
}

registerProcessor("codec2-encoder", Codec2Encoder);
registerProcessor("codec2-decoder", Codec2Decoder);
