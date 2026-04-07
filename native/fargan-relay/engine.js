function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeMode(mode) {
  const normalized = String(mode || "off").trim().toLowerCase();
  if (normalized === "deep-plc" || normalized === "fargan" || normalized === "off") {
    return normalized;
  }
  return "off";
}

class FarganRelayEngine {
  constructor({ mode = "off" } = {}) {
    this.mode = normalizeMode(mode);
    this.senderState = new Map();
  }

  ensureSenderState(senderKey) {
    let state = this.senderState.get(senderKey);
    if (state) {
      return state;
    }

    state = {
      lastFeatures: null,
      processedFrames: 0,
      concealedFrames: 0
    };
    this.senderState.set(senderKey, state);
    return state;
  }

  processFrame({ roomId = "", senderId = "", frame }) {
    if (!frame || frame.kind !== "packet" || !frame.packet) {
      return { frame, metadata: { mode: this.mode, enhanced: false } };
    }

    const senderKey = `${roomId}:${senderId}`;
    const state = this.ensureSenderState(senderKey);
    const packet = {
      ...frame.packet,
      features: { ...(frame.packet.features || {}) },
      payload: frame.packet.payload?.slice ? frame.packet.payload.slice() : frame.packet.payload
    };
    const processedFrame = {
      ...frame,
      packet
    };

    state.processedFrames += 1;
    if (frame.concealed) {
      state.concealedFrames += 1;
    }

    if (this.mode === "off") {
      state.lastFeatures = { ...packet.features };
      return {
        frame: processedFrame,
        metadata: { mode: this.mode, enhanced: false }
      };
    }

    if (this.mode === "deep-plc" && frame.concealed) {
      packet.features.energy = clamp((packet.features.energy || 0.08) * 0.9, 0, 1);
      packet.features.voicedProbability = clamp(packet.features.voicedProbability || 0, 0, 1);
      state.lastFeatures = { ...packet.features };
      return {
        frame: processedFrame,
        metadata: {
          mode: this.mode,
          enhanced: true,
          strategy: "concealment-shaped-features"
        }
      };
    }

    if (this.mode === "fargan") {
      const previous = state.lastFeatures;
      if (previous) {
        packet.features.energy = clamp(
          ((previous.energy || 0) * 0.35) + ((packet.features.energy || 0) * 0.65),
          0,
          1
        );
        packet.features.pitchHz = clamp(
          ((previous.pitchHz || packet.features.pitchHz || 0) * 0.25) +
            ((packet.features.pitchHz || 0) * 0.75),
          0,
          400
        );
        packet.features.voicedProbability = clamp(
          ((previous.voicedProbability || 0) * 0.2) +
            ((packet.features.voicedProbability || 0) * 0.8),
          0,
          1
        );
        packet.features.spectralTilt = clamp(
          ((previous.spectralTilt || 0) * 0.25) +
            ((packet.features.spectralTilt || 0) * 0.75),
          -1,
          1
        );
      }

      if (frame.concealed) {
        packet.features.energy = clamp((packet.features.energy || 0.08) * 0.88, 0, 1);
      }

      state.lastFeatures = { ...packet.features };
      return {
        frame: processedFrame,
        metadata: {
          mode: this.mode,
          enhanced: true,
          strategy: "fargan-worker-scaffold"
        }
      };
    }

    state.lastFeatures = { ...packet.features };
    return {
      frame: processedFrame,
      metadata: { mode: this.mode, enhanced: false }
    };
  }

  close() {
    this.senderState.clear();
  }
}

module.exports = {
  FarganRelayEngine,
  normalizeMode
};
