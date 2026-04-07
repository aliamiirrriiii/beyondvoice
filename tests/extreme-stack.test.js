const assert = require("assert");
const {
  AdaptiveJitterBuffer,
  FeatureTrajectoryPlcModel,
  RohcLiteCompressor,
  RohcLiteDecompressor,
  RtpPacketizer
} = require("../public/extreme-stack.js");

function testHeaderCompressionRoundTrip() {
  const packetizer = new RtpPacketizer({
    ssrc: 0x12345678,
    payloadType: 97,
    timestampStep: 160
  });
  const compressor = new RohcLiteCompressor();
  const decompressor = new RohcLiteDecompressor();

  const firstPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const secondPayload = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]);

  const firstPacket = packetizer.createPacket(firstPayload, {
    energy: 0.5,
    pitchHz: 120,
    voicedProbability: 0.9,
    spectralTilt: 0.25
  });
  const secondPacket = packetizer.createPacket(secondPayload, {
    energy: 0.3,
    pitchHz: 95,
    voicedProbability: 0.8,
    spectralTilt: -0.1
  });

  const compressedFirst = compressor.compress(firstPacket);
  const decodedFirst = decompressor.decompress(compressedFirst.bytes);
  assert.equal(compressedFirst.headerBytes, 11);
  assert.deepEqual(Array.from(decodedFirst.packet.payload), Array.from(firstPayload));
  assert.equal(decodedFirst.packet.sequenceNumber, firstPacket.sequenceNumber);
  assert.equal(decodedFirst.packet.timestamp, firstPacket.timestamp);

  const compressedSecond = compressor.compress(secondPacket);
  const decodedSecond = decompressor.decompress(compressedSecond.bytes);
  assert.equal(compressedSecond.headerBytes, 5);
  assert.deepEqual(Array.from(decodedSecond.packet.payload), Array.from(secondPayload));
  assert.equal(decodedSecond.packet.sequenceNumber, secondPacket.sequenceNumber);
  assert.equal(decodedSecond.packet.timestamp, secondPacket.timestamp);
}

function testJitterBufferReordersPackets() {
  const packetizer = new RtpPacketizer({
    ssrc: 0x22222222,
    payloadType: 97,
    timestampStep: 160
  });
  const plcModel = new FeatureTrajectoryPlcModel({
    frameSamples: 160,
    sampleRate: 8000
  });
  const buffer = new AdaptiveJitterBuffer({
    frameDurationMs: 20,
    sampleRate: 8000,
    plcModel
  });

  const first = packetizer.createPacket(new Uint8Array([1, 1, 1]), { pitchHz: 120, energy: 0.5 });
  const second = packetizer.createPacket(new Uint8Array([2, 2, 2]), { pitchHz: 125, energy: 0.4 });

  buffer.push(second, 5);
  buffer.push(first, 0);

  const drained = buffer.drain(70);
  assert.equal(drained.length >= 2, true);
  assert.deepEqual(Array.from(drained[0].packet.payload), [1, 1, 1]);
  assert.deepEqual(Array.from(drained[1].packet.payload), [2, 2, 2]);
}

function testJitterBufferConcealsMissingPackets() {
  const packetizer = new RtpPacketizer({
    ssrc: 0x33333333,
    payloadType: 97,
    timestampStep: 160
  });
  const plcModel = new FeatureTrajectoryPlcModel({
    frameSamples: 160,
    sampleRate: 8000
  });
  const buffer = new AdaptiveJitterBuffer({
    frameDurationMs: 20,
    sampleRate: 8000,
    plcModel
  });

  const first = packetizer.createPacket(new Uint8Array([7, 7, 7]), {
    pitchHz: 110,
    energy: 0.5,
    voicedProbability: 0.9
  });
  packetizer.createPacket(new Uint8Array([8, 8, 8]), {
    pitchHz: 112,
    energy: 0.45,
    voicedProbability: 0.9
  });
  const third = packetizer.createPacket(new Uint8Array([9, 9, 9]), {
    pitchHz: 114,
    energy: 0.4,
    voicedProbability: 0.8
  });

  buffer.push(first, 0);
  buffer.push(third, 40);

  const drained = buffer.drain(80);
  assert.equal(drained.length >= 3, true);
  assert.equal(drained[1].concealed, true);
  assert.deepEqual(Array.from(drained[0].packet.payload), [7, 7, 7]);
  assert.deepEqual(Array.from(drained[1].packet.payload), [7, 7, 7]);
  assert.deepEqual(Array.from(drained[2].packet.payload), [9, 9, 9]);
}

function run() {
  testHeaderCompressionRoundTrip();
  testJitterBufferReordersPackets();
  testJitterBufferConcealsMissingPackets();
  console.log("extreme-stack tests passed");
}

run();
