const readline = require("readline");
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

process.stdout.write(`${JSON.stringify({
  type: "ready",
  mode: engine.mode,
  runtime: "js-stdio"
})}\n`);

const input = readline.createInterface({
  input: process.stdin
});

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === "process-frame") {
    try {
      const result = engine.processFrame({
        roomId: message.roomId,
        senderId: message.senderId,
        frame: fromEnvelope(message.frame)
      });
      process.stdout.write(`${JSON.stringify({
        type: "process-frame-result",
        requestId: message.requestId,
        result: {
          frame: toEnvelope(result.frame),
          metadata: result.metadata || null
        }
      })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        type: "process-frame-result",
        requestId: message.requestId,
        error: error.message
      })}\n`);
    }
    return;
  }

  if (message.type === "shutdown") {
    engine.close();
    process.exit(0);
  }
});
