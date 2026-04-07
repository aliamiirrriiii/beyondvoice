const assert = require("assert");
const { RtpPacketizer, RohcLiteCompressor, RohcLiteDecompressor } = require("../public/extreme-stack.js");
const { MediaRelayController } = require("../media-relay.js");

async function testRelayDeliversFramesToTarget() {
  let now = 0;
  const delivered = [];
  let processedFrames = 0;
  const relay = new MediaRelayController({
    getNow: () => now,
    neuralRelay: {
      async processFrame({ frame }) {
        processedFrames += 1;
        return {
          frame,
          metadata: {
            mode: "fargan",
            enhanced: true,
            strategy: "test-relay"
          }
        };
      },
      async close() {}
    },
    listTargets: (roomId, senderId) => {
      assert.equal(roomId, "room-a");
      assert.equal(senderId, "sender");
      return ["receiver"];
    },
    deliverFrame: (targetId, bytes) => {
      delivered.push({ targetId, bytes: new Uint8Array(bytes) });
    }
  });

  const packetizer = new RtpPacketizer({
    ssrc: 0x87654321,
    payloadType: 97,
    timestampStep: 160
  });
  const uplinkCompressor = new RohcLiteCompressor();
  const receiverDecompressor = new RohcLiteDecompressor();

  const packet1 = packetizer.createPacket(new Uint8Array([1, 2, 3]), {
    energy: 0.5,
    pitchHz: 120,
    voicedProbability: 0.9
  });
  const packet2 = packetizer.createPacket(new Uint8Array([4, 5, 6]), {
    energy: 0.45,
    pitchHz: 118,
    voicedProbability: 0.85
  });

  relay.receiveCompressedFrame("room-a", "sender", uplinkCompressor.compress(packet1).bytes);
  now = 20;
  relay.receiveCompressedFrame("room-a", "sender", uplinkCompressor.compress(packet2).bytes);
  now = 80;
  await relay.drainRoom("room-a");

  assert.equal(delivered.length >= 2, true);
  assert.equal(delivered[0].targetId, "receiver");
  assert.equal(processedFrames >= 2, true);

  const decoded1 = receiverDecompressor.decompress(delivered[0].bytes);
  const decoded2 = receiverDecompressor.decompress(delivered[1].bytes);
  assert.deepEqual(Array.from(decoded1.packet.payload), [1, 2, 3]);
  assert.deepEqual(Array.from(decoded2.packet.payload), [4, 5, 6]);

  return relay.close();
}

async function testRelayCarriesSynthesizedPcmPayload() {
  let now = 0;
  const delivered = [];
  const relay = new MediaRelayController({
    getNow: () => now,
    neuralRelay: {
      async processFrame({ frame }) {
        return {
          frame: {
            ...frame,
            packet: {
              ...frame.packet,
              payloadType: 98,
              payload: Uint8Array.from([0, 0, 255, 127])
            }
          },
          metadata: {
            mode: "fargan",
            enhanced: true,
            strategy: "pcm-test"
          }
        };
      },
      async close() {}
    },
    listTargets: () => ["receiver"],
    deliverFrame: (targetId, bytes) => {
      delivered.push({ targetId, bytes: new Uint8Array(bytes) });
    }
  });

  const packetizer = new RtpPacketizer({
    ssrc: 0x11111111,
    payloadType: 97,
    timestampStep: 160
  });
  const uplinkCompressor = new RohcLiteCompressor();
  const receiverDecompressor = new RohcLiteDecompressor();
  const packet = packetizer.createPacket(new Uint8Array([9, 9, 9]), {
    energy: 0.3,
    pitchHz: 90,
    voicedProbability: 0.5
  });

  relay.receiveCompressedFrame("room-b", "sender", uplinkCompressor.compress(packet).bytes);
  now = 80;
  await relay.drainRoom("room-b");

  assert.equal(delivered.length >= 1, true);
  const decoded = receiverDecompressor.decompress(delivered[0].bytes);
  assert.equal(decoded.packet.payloadType, 98);
  assert.deepEqual(Array.from(decoded.packet.payload), [0, 0, 255, 127]);

  return relay.close();
}

async function run() {
  await testRelayDeliversFramesToTarget();
  await testRelayCarriesSynthesizedPcmPayload();
  console.log("media-relay tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
