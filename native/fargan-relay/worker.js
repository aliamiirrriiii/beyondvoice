const { FarganRelayEngine, normalizeMode } = require("./engine");

const engine = new FarganRelayEngine({
  mode: normalizeMode(process.env.NEURAL_RELAY_MODE || "off")
});

function fromEnvelope(envelope) {
  if (!envelope) {
    return null;
  }

  if (envelope.kind !== "packet" || !envelope.packet) {
    return envelope;
  }

  return {
    ...envelope,
    packet: {
      ...envelope.packet,
      features: { ...(envelope.packet.features || {}) },
      payload: Uint8Array.from(envelope.packet.payload || [])
    }
  };
}

function toEnvelope(frame) {
  if (!frame) {
    return null;
  }

  if (frame.kind !== "packet" || !frame.packet) {
    return frame;
  }

  return {
    ...frame,
    packet: {
      ...frame.packet,
      features: { ...(frame.packet.features || {}) },
      payload: Array.from(frame.packet.payload || [])
    }
  };
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "process-frame") {
    try {
      const result = engine.processFrame({
        roomId: message.roomId,
        senderId: message.senderId,
        frame: fromEnvelope(message.frame)
      });
      process.send?.({
        type: "process-frame-result",
        requestId: message.requestId,
        result: {
          frame: toEnvelope(result.frame),
          metadata: result.metadata || null
        }
      });
    } catch (error) {
      process.send?.({
        type: "process-frame-result",
        requestId: message.requestId,
        error: error.message
      });
    }
    return;
  }

  if (message.type === "shutdown") {
    engine.close();
    process.exit(0);
  }
});

process.send?.({
  type: "ready",
  mode: engine.mode
});
