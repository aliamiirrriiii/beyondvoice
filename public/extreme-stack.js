(function initExtremeStack(globalScope, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  globalScope.ExtremeStack = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const FULL_HEADER_MODE = 0;
  const DELTA_HEADER_MODE = 1;
  const FULL_HEADER_BYTES = 11;
  const DELTA_HEADER_BYTES = 5;
  const FEATURE_BYTES = 4;
  const DEFAULT_SAMPLE_RATE = 8000;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toUint8Array(value) {
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(value || []);
  }

  function writeUint16(target, offset, value) {
    target[offset] = (value >>> 8) & 0xff;
    target[offset + 1] = value & 0xff;
  }

  function writeUint32(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
  }

  function readUint16(source, offset) {
    return ((source[offset] << 8) | source[offset + 1]) >>> 0;
  }

  function readUint32(source, offset) {
    return (
      ((source[offset] << 24) >>> 0) |
      (source[offset + 1] << 16) |
      (source[offset + 2] << 8) |
      source[offset + 3]
    ) >>> 0;
  }

  function quantizeSignedUnit(value) {
    return Math.round(clamp((Number(value) + 1) / 2, 0, 1) * 255);
  }

  function dequantizeSignedUnit(value) {
    return (clamp(Number(value) / 255, 0, 1) * 2) - 1;
  }

  function quantizeFeatures(features = {}) {
    const bytes = new Uint8Array(FEATURE_BYTES);
    bytes[0] = Math.round(clamp(Number(features.energy) || 0, 0, 1) * 255);
    bytes[1] = Math.round(clamp((Number(features.pitchHz) || 0) / 400, 0, 1) * 255);
    bytes[2] = Math.round(clamp(Number(features.voicedProbability) || 0, 0, 1) * 255);
    bytes[3] = quantizeSignedUnit(Number(features.spectralTilt) || 0);
    return bytes;
  }

  function dequantizeFeatures(bytes) {
    const source = toUint8Array(bytes);
    return {
      energy: clamp((source[0] || 0) / 255, 0, 1),
      pitchHz: clamp(((source[1] || 0) / 255) * 400, 0, 400),
      voicedProbability: clamp((source[2] || 0) / 255, 0, 1),
      spectralTilt: dequantizeSignedUnit(source[3] || 0)
    };
  }

  function createSsrc() {
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
  }

  class RtpPacketizer {
    constructor({
      ssrc = createSsrc(),
      payloadType = 97,
      timestampStep = 160
    } = {}) {
      this.ssrc = ssrc >>> 0;
      this.payloadType = payloadType & 0x7f;
      this.timestampStep = Math.max(1, Math.round(timestampStep));
      this.sequenceNumber = 0;
      this.timestamp = 0;
    }

    createPacket(payload, features = {}) {
      const packet = {
        payloadType: this.payloadType,
        marker: false,
        sequenceNumber: this.sequenceNumber,
        timestamp: this.timestamp >>> 0,
        ssrc: this.ssrc >>> 0,
        features: {
          energy: Number(features.energy) || 0,
          pitchHz: Number(features.pitchHz) || 0,
          voicedProbability: Number(features.voicedProbability) || 0,
          spectralTilt: Number(features.spectralTilt) || 0
        },
        payload: toUint8Array(payload).slice()
      };

      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.timestamp = (this.timestamp + this.timestampStep) >>> 0;
      return packet;
    }
  }

  class RohcLiteCompressor {
    constructor() {
      this.context = null;
    }

    compress(packet) {
      const normalized = {
        payloadType: packet.payloadType & 0x7f,
        marker: Boolean(packet.marker),
        sequenceNumber: packet.sequenceNumber & 0xffff,
        timestamp: packet.timestamp >>> 0,
        ssrc: packet.ssrc >>> 0,
        features: packet.features || {},
        payload: toUint8Array(packet.payload).slice()
      };

      let header;
      if (!this.context || this.context.ssrc !== normalized.ssrc) {
        header = new Uint8Array(FULL_HEADER_BYTES);
        header[0] = FULL_HEADER_MODE;
        header[1] = normalized.payloadType | (normalized.marker ? 0x80 : 0x00);
        writeUint16(header, 2, normalized.sequenceNumber);
        writeUint32(header, 4, normalized.timestamp);
        writeUint32(header, 8, normalized.ssrc);
      } else {
        const sequenceDelta =
          (normalized.sequenceNumber - this.context.sequenceNumber + 0x10000) & 0xffff;
        const timestampDelta =
          (normalized.timestamp - this.context.timestamp + 0x100000000) >>> 0;

        if (sequenceDelta > 0xff || timestampDelta > 0xffff) {
          header = new Uint8Array(FULL_HEADER_BYTES);
          header[0] = FULL_HEADER_MODE;
          header[1] = normalized.payloadType | (normalized.marker ? 0x80 : 0x00);
          writeUint16(header, 2, normalized.sequenceNumber);
          writeUint32(header, 4, normalized.timestamp);
          writeUint32(header, 8, normalized.ssrc);
        } else {
          header = new Uint8Array(DELTA_HEADER_BYTES);
          header[0] = DELTA_HEADER_MODE;
          header[1] = sequenceDelta & 0xff;
          writeUint16(header, 2, timestampDelta & 0xffff);
          header[4] = normalized.payloadType | (normalized.marker ? 0x80 : 0x00);
        }
      }

      this.context = {
        sequenceNumber: normalized.sequenceNumber,
        timestamp: normalized.timestamp,
        ssrc: normalized.ssrc
      };

      const featureBytes = quantizeFeatures(normalized.features);
      const bytes = new Uint8Array(header.length + FEATURE_BYTES + normalized.payload.length);
      bytes.set(header, 0);
      bytes.set(featureBytes, header.length);
      bytes.set(normalized.payload, header.length + FEATURE_BYTES);

      return {
        bytes,
        headerBytes: header.length,
        rawHeaderBytes: FULL_HEADER_BYTES
      };
    }
  }

  class RohcLiteDecompressor {
    constructor() {
      this.context = null;
    }

    decompress(packetBytes) {
      const bytes = toUint8Array(packetBytes);
      if (bytes.length < DELTA_HEADER_BYTES + FEATURE_BYTES) {
        throw new Error("Compressed packet is too short");
      }

      let header;
      let offset = 0;

      if (bytes[0] === FULL_HEADER_MODE) {
        if (bytes.length < FULL_HEADER_BYTES + FEATURE_BYTES) {
          throw new Error("Full header packet is too short");
        }
        header = {
          payloadType: bytes[1] & 0x7f,
          marker: Boolean(bytes[1] & 0x80),
          sequenceNumber: readUint16(bytes, 2),
          timestamp: readUint32(bytes, 4),
          ssrc: readUint32(bytes, 8)
        };
        offset = FULL_HEADER_BYTES;
      } else if (bytes[0] === DELTA_HEADER_MODE) {
        if (!this.context) {
          throw new Error("Delta header received before context was established");
        }
        header = {
          payloadType: bytes[4] & 0x7f,
          marker: Boolean(bytes[4] & 0x80),
          sequenceNumber: (this.context.sequenceNumber + bytes[1]) & 0xffff,
          timestamp: (this.context.timestamp + readUint16(bytes, 2)) >>> 0,
          ssrc: this.context.ssrc >>> 0
        };
        offset = DELTA_HEADER_BYTES;
      } else {
        throw new Error("Unknown compressed header mode");
      }

      this.context = {
        sequenceNumber: header.sequenceNumber,
        timestamp: header.timestamp,
        ssrc: header.ssrc
      };

      const features = dequantizeFeatures(bytes.subarray(offset, offset + FEATURE_BYTES));
      const payload = bytes.subarray(offset + FEATURE_BYTES).slice();

      return {
        headerBytes: offset,
        rawHeaderBytes: FULL_HEADER_BYTES,
        packet: {
          ...header,
          features,
          payload
        }
      };
    }
  }

  class NeuralVocoderAdapter {
    constructor({
      mode = "passthrough",
      label = "Codec2 decode",
      sampleRate = DEFAULT_SAMPLE_RATE
    } = {}) {
      this.mode = mode;
      this.label = label;
      this.sampleRate = sampleRate;
    }

    describe() {
      if (this.mode === "lpcnet") {
        return "LPCNet";
      }

      if (this.mode === "external-model") {
        return this.label;
      }

      return `${this.label} (adapter ready)`;
    }
  }

  class FeatureTrajectoryPlcModel {
    constructor({
      frameSamples = 160,
      sampleRate = DEFAULT_SAMPLE_RATE
    } = {}) {
      this.frameSamples = frameSamples;
      this.sampleRate = sampleRate;
      this.lastPacket = null;
      this.phase = 0;
    }

    observe(packet) {
      this.lastPacket = {
        payload: packet.payload ? packet.payload.slice() : null,
        features: { ...(packet.features || {}) }
      };
    }

    conceal({ concealmentCount = 1 } = {}) {
      const fade = clamp(1 - ((concealmentCount - 1) * 0.12), 0.4, 1);
      const features = { ...(this.lastPacket?.features || {}) };
      features.energy = clamp((features.energy || 0.08) * fade, 0, 1);
      features.voicedProbability = clamp(features.voicedProbability || 0, 0, 1);

      if (this.lastPacket?.payload?.length) {
        return {
          kind: "packet",
          concealed: true,
          gain: fade,
          payload: this.lastPacket.payload.slice(),
          features
        };
      }

      const pcm = new Float32Array(this.frameSamples);
      const voiced = (features.voicedProbability || 0) >= 0.4;
      const pitchHz = clamp(features.pitchHz || 120, 70, 260);
      const amplitude = clamp((features.energy || 0.08) * 0.35, 0.01, 0.35);
      const phaseStep = (Math.PI * 2 * pitchHz) / this.sampleRate;

      for (let index = 0; index < pcm.length; index += 1) {
        let sample;
        if (voiced) {
          sample = Math.sin(this.phase) * amplitude;
          this.phase += phaseStep;
        } else {
          sample = ((Math.random() * 2) - 1) * amplitude * 0.45;
        }
        const taper = 1 - (index / pcm.length) * 0.2;
        pcm[index] = sample * taper * fade;
      }

      return {
        kind: "pcm",
        concealed: true,
        gain: 1,
        pcm,
        features
      };
    }
  }

  class AdaptiveJitterBuffer {
    constructor({
      frameDurationMs = 20,
      sampleRate = DEFAULT_SAMPLE_RATE,
      maxFramesPerDrain = 6,
      initialDelayFrames = 1,
      minDelayFrames = 1,
      maxDelayFrames = 4,
      plcModel = new FeatureTrajectoryPlcModel()
    } = {}) {
      this.frameDurationMs = frameDurationMs;
      this.sampleRate = sampleRate;
      this.maxFramesPerDrain = maxFramesPerDrain;
      this.minDelayFrames = Math.max(1, Math.round(minDelayFrames));
      this.maxDelayFrames = Math.max(this.minDelayFrames, Math.round(maxDelayFrames));
      this.plcModel = plcModel;
      this.queue = new Map();
      this.expectedSequenceNumber = null;
      this.playoutStartedAt = null;
      this.emittedFrames = 0;
      this.targetDelayFrames = clamp(
        Math.round(initialDelayFrames),
        this.minDelayFrames,
        this.maxDelayFrames
      );
      this.arrivalJitterMs = 0;
      this.lastArrivalTimeMs = null;
      this.lastPacketTimestamp = null;
      this.lastEmittedPacket = null;
      this.concealmentBurst = 0;
      this.stats = {
        queuedPackets: 0,
        targetDelayMs: this.targetDelayFrames * this.frameDurationMs,
        arrivalJitterMs: 0,
        concealedFrames: 0,
        lateDrops: 0,
        emittedFrames: 0
      };
    }

    updateNetworkMetrics({
      jitterMs = null,
      rttMs = null,
      packetsLost = null
    } = {}) {
      const inferred = this.arrivalJitterMs;
      const effectiveJitter = Math.max(
        inferred,
        typeof jitterMs === "number" ? jitterMs : 0
      );
      const lossPenalty = typeof packetsLost === "number" ? Math.min(packetsLost, 8) * 0.08 : 0;
      const rttPenalty =
        typeof rttMs === "number" ? (Math.min(rttMs, 600) / 600) * 0.35 : 0;
      const delayFrames = clamp(
        Math.round(
          this.minDelayFrames +
            ((effectiveJitter / this.frameDurationMs) * 0.6) +
            lossPenalty +
            rttPenalty
        ),
        this.minDelayFrames,
        this.maxDelayFrames
      );

      this.targetDelayFrames = delayFrames;
      this.stats.targetDelayMs = delayFrames * this.frameDurationMs;
    }

    push(packet, arrivalTimeMs = Date.now()) {
      if (this.expectedSequenceNumber != null) {
        const backwardDistance =
          (this.expectedSequenceNumber - packet.sequenceNumber + 0x10000) & 0xffff;
        if (this.emittedFrames === 0 && backwardDistance > 0 && backwardDistance < 32) {
          this.expectedSequenceNumber = packet.sequenceNumber;
          this.playoutStartedAt = arrivalTimeMs + (this.targetDelayFrames * this.frameDurationMs);
        } else if (backwardDistance > 0 && backwardDistance < 0x8000) {
          this.stats.lateDrops += 1;
          return;
        }
      }

      if (this.lastArrivalTimeMs != null && this.lastPacketTimestamp != null) {
        const arrivalDelta = Math.max(0, arrivalTimeMs - this.lastArrivalTimeMs);
        const timestampDeltaMs =
          (((packet.timestamp - this.lastPacketTimestamp + 0x100000000) >>> 0) / this.sampleRate) * 1000;
        const transitDelta = Math.abs(arrivalDelta - timestampDeltaMs);
        this.arrivalJitterMs = (this.arrivalJitterMs * 0.8) + (transitDelta * 0.2);
        this.stats.arrivalJitterMs = Math.round(this.arrivalJitterMs);
      }

      this.lastArrivalTimeMs = arrivalTimeMs;
      this.lastPacketTimestamp = packet.timestamp;
      this.queue.set(packet.sequenceNumber, packet);
      this.stats.queuedPackets = this.queue.size;

      if (this.expectedSequenceNumber == null) {
        this.expectedSequenceNumber = packet.sequenceNumber;
        this.playoutStartedAt = arrivalTimeMs + (this.targetDelayFrames * this.frameDurationMs);
      }
    }

    drain(nowMs = Date.now()) {
      if (this.expectedSequenceNumber == null || this.playoutStartedAt == null) {
        return [];
      }

      const frames = [];
      while (
        nowMs >= this.playoutStartedAt + (this.emittedFrames * this.frameDurationMs) &&
        frames.length < this.maxFramesPerDrain
      ) {
        const packet = this.queue.get(this.expectedSequenceNumber);
        if (packet) {
          this.queue.delete(this.expectedSequenceNumber);
          this.lastEmittedPacket = packet;
          this.plcModel.observe(packet);
          this.concealmentBurst = 0;
          frames.push({
            kind: "packet",
            concealed: false,
            gain: 1,
            packet
          });
        } else {
          this.concealmentBurst += 1;
          const concealment = this.plcModel.conceal({
            concealmentCount: this.concealmentBurst
          });

          if (concealment.kind === "packet") {
            frames.push({
              kind: "packet",
              concealed: true,
              gain: concealment.gain,
              packet: {
                payloadType: this.lastEmittedPacket?.payloadType || 97,
                marker: false,
                sequenceNumber: this.expectedSequenceNumber,
                timestamp: this.lastEmittedPacket?.timestamp || 0,
                ssrc: this.lastEmittedPacket?.ssrc || 0,
                features: concealment.features,
                payload: concealment.payload
              }
            });
          } else {
            frames.push(concealment);
          }

          this.stats.concealedFrames += 1;
        }

        this.expectedSequenceNumber = (this.expectedSequenceNumber + 1) & 0xffff;
        this.emittedFrames += 1;
        this.stats.emittedFrames = this.emittedFrames;
        this.stats.queuedPackets = this.queue.size;

        if (this.queue.size === 0 && frames.length === 0) {
          break;
        }
      }

      return frames;
    }

    getStats() {
      return {
        ...this.stats,
        queuedPackets: this.queue.size,
        targetDelayMs: this.targetDelayFrames * this.frameDurationMs
      };
    }
  }

  return {
    AdaptiveJitterBuffer,
    FeatureTrajectoryPlcModel,
    NeuralVocoderAdapter,
    RohcLiteCompressor,
    RohcLiteDecompressor,
    RtpPacketizer,
    clamp,
    createSsrc,
    dequantizeFeatures,
    quantizeFeatures
  };
});
