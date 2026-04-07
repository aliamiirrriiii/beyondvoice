const {
  AdaptiveJitterBuffer,
  FeatureTrajectoryPlcModel,
  RohcLiteCompressor,
  RohcLiteDecompressor
} = require("./public/extreme-stack.js");

class MediaRelayController {
  constructor({
    deliverFrame,
    listTargets,
    neuralRelay = null,
    getNow = () => Date.now(),
    drainIntervalMs = 10,
    frameDurationMs = 20,
    sampleRate = 8000,
    frameSamples = Math.max(1, Math.round((sampleRate * frameDurationMs) / 1000))
  } = {}) {
    if (typeof deliverFrame !== "function") {
      throw new Error("deliverFrame callback is required");
    }
    if (typeof listTargets !== "function") {
      throw new Error("listTargets callback is required");
    }

    this.deliverFrame = deliverFrame;
    this.listTargets = listTargets;
    this.neuralRelay = neuralRelay;
    this.getNow = getNow;
    this.drainIntervalMs = drainIntervalMs;
    this.frameDurationMs = frameDurationMs;
    this.sampleRate = sampleRate;
    this.frameSamples = frameSamples;
    this.rooms = new Map();
  }

  ensureRoom(roomId) {
    let room = this.rooms.get(roomId);
    if (room) {
      return room;
    }

    room = {
      senders: new Map(),
      timer: setInterval(() => {
        this.drainRoom(roomId).catch((error) => {
          console.error("Media relay drain failed", error);
        });
      }, this.drainIntervalMs)
    };
    room.timer.unref?.();
    this.rooms.set(roomId, room);
    return room;
  }

  ensureSenderContext(roomId, senderId) {
    const room = this.ensureRoom(roomId);
    let sender = room.senders.get(senderId);
    if (sender) {
      return sender;
    }

    const plcModel = new FeatureTrajectoryPlcModel({
      frameSamples: this.frameSamples,
      sampleRate: this.sampleRate
    });

    sender = {
      uplinkDecompressor: new RohcLiteDecompressor(),
      downlinkCompressors: new Map(),
      relayStats: {
        processedFrames: 0,
        enhancedFrames: 0,
        concealedFrames: 0,
        lastStrategy: "passthrough"
      },
      jitterBuffer: new AdaptiveJitterBuffer({
        frameDurationMs: this.frameDurationMs,
        sampleRate: this.sampleRate,
        plcModel
      }),
      lastActivityAt: this.getNow()
    };

    room.senders.set(senderId, sender);
    return sender;
  }

  receiveCompressedFrame(roomId, senderId, bytes) {
    if (!roomId || !senderId || !bytes?.length) {
      return false;
    }

    const sender = this.ensureSenderContext(roomId, senderId);
    const decoded = sender.uplinkDecompressor.decompress(bytes);
    sender.jitterBuffer.push(decoded.packet, this.getNow());
    sender.lastActivityAt = this.getNow();
    return true;
  }

  async drainRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const now = this.getNow();
    for (const [senderId, sender] of room.senders.entries()) {
      const frames = sender.jitterBuffer.drain(now);
      if (frames.length === 0) {
        continue;
      }

      const targets = this.listTargets(roomId, senderId) || [];
      if (targets.length === 0) {
        continue;
      }

      for (const frame of frames) {
        let processedFrame = frame;
        if (this.neuralRelay) {
          const result = await this.neuralRelay.processFrame({
            roomId,
            senderId,
            frame
          });
          processedFrame = result?.frame || frame;
          sender.relayStats.processedFrames += 1;
          if (result?.metadata?.enhanced) {
            sender.relayStats.enhancedFrames += 1;
          }
          if (frame.concealed) {
            sender.relayStats.concealedFrames += 1;
          }
          if (result?.metadata?.strategy) {
            sender.relayStats.lastStrategy = result.metadata.strategy;
          }
        }

        if (processedFrame.kind !== "packet" || !processedFrame.packet?.payload?.length) {
          continue;
        }

        for (const targetId of targets) {
          let compressor = sender.downlinkCompressors.get(targetId);
          if (!compressor) {
            compressor = new RohcLiteCompressor();
            sender.downlinkCompressors.set(targetId, compressor);
          }

          const compressed = compressor.compress(processedFrame.packet);
          this.deliverFrame(targetId, compressed.bytes);
        }
      }
    }
  }

  removeParticipant(roomId, participantId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    room.senders.delete(participantId);
    for (const sender of room.senders.values()) {
      sender.downlinkCompressors.delete(participantId);
    }

    if (room.senders.size === 0) {
      clearInterval(room.timer);
      this.rooms.delete(roomId);
    }
  }

  close() {
    for (const room of this.rooms.values()) {
      clearInterval(room.timer);
    }
    this.rooms.clear();
    return Promise.resolve(this.neuralRelay?.close?.());
  }
}

module.exports = {
  MediaRelayController
};
