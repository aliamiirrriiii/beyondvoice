const assert = require("assert");
const { createNeuralRelay, resolveRelayModeAndBackend } = require("../neural-relay.js");

function makeFrame({ concealed = false } = {}) {
  return {
    kind: "packet",
    concealed,
    packet: {
      payloadType: 97,
      marker: false,
      sequenceNumber: 1,
      timestamp: 160,
      ssrc: 123,
      features: {
        energy: 0.6,
        pitchHz: 140,
        voicedProbability: 0.8,
        spectralTilt: 0.2
      },
      payload: Uint8Array.from([1, 2, 3, 4])
    }
  };
}

async function testInProcessRelayPassThrough() {
  const relay = createNeuralRelay({ mode: "off", backend: "in-process" });
  const result = await relay.processFrame({
    roomId: "room",
    senderId: "sender",
    frame: makeFrame()
  });

  assert.equal(result.metadata.mode, "off");
  assert.equal(result.metadata.enhanced, false);
  assert.deepEqual(Array.from(result.frame.packet.payload), [1, 2, 3, 4]);
  await relay.close();
}

async function testChildProcessDeepPlcMode() {
  const relay = createNeuralRelay({ mode: "deep-plc", backend: "child-process" });
  const result = await relay.processFrame({
    roomId: "room",
    senderId: "sender",
    frame: makeFrame({ concealed: true })
  });

  assert.equal(result.metadata.mode, "deep-plc");
  assert.equal(result.metadata.enhanced, true);
  assert.equal(result.metadata.strategy, "concealment-shaped-features");
  assert.deepEqual(Array.from(result.frame.packet.payload), [1, 2, 3, 4]);
  await relay.close();
}

async function testNativeExecutableRelayScaffoldMode() {
  const relay = createNeuralRelay({
    mode: "deep-plc",
    backend: "native-exec"
  });
  const result = await relay.processFrame({
    roomId: "room",
    senderId: "sender",
    frame: makeFrame({ concealed: true })
  });

  assert.equal(result.metadata.mode, "deep-plc");
  assert.equal(result.metadata.enhanced, true);
  assert.equal(result.metadata.strategy, "concealment-shaped-features");
  assert.ok(relay.runtime === "native-opus" || relay.runtime === "js-stdio" || relay.runtime === "native-exec");
  if (relay.runtime === "native-opus") {
    assert.equal(result.metadata.implementation, "native-opus");
    assert.ok((relay.nativeLibrary || "").includes("libopus"));
  }
  assert.deepEqual(Array.from(result.frame.packet.payload), [1, 2, 3, 4]);
  await relay.close();
}

async function testMissingNativeExecutableFallsBack() {
  const resolved = resolveRelayModeAndBackend({
    mode: "fargan",
    backend: "native-exec",
    executablePath: "/definitely/missing/fargan-relay-worker"
  });
  assert.equal(resolved.mode, "deep-plc");
  assert.equal(resolved.backend, "in-process");

  const relay = createNeuralRelay({
    mode: "fargan",
    backend: "native-exec",
    executablePath: "/definitely/missing/fargan-relay-worker"
  });

  assert.equal(relay.backend, "in-process");
  const result = await relay.processFrame({
    roomId: "room",
    senderId: "sender",
    frame: makeFrame({ concealed: true })
  });
  assert.equal(result.metadata.mode, "deep-plc");
  assert.equal(result.metadata.strategy, "concealment-shaped-features");
  await relay.close();
}

function testWrapperRequiresRealNativeBinary() {
  const resolved = resolveRelayModeAndBackend({
    mode: "fargan",
    backend: "native-exec",
    executablePath: "/definitely/missing/fargan-relay-worker"
  });

  assert.equal(resolved.mode, "deep-plc");
}

function testFarganAutoPromotesToNativeExecWhenAvailable() {
  const resolved = resolveRelayModeAndBackend({
    mode: "fargan",
    backend: "in-process"
  });

  assert.equal(resolved.mode, "fargan");
  assert.equal(resolved.backend, "native-exec");
}

async function run() {
  await testInProcessRelayPassThrough();
  await testChildProcessDeepPlcMode();
  await testNativeExecutableRelayScaffoldMode();
  await testMissingNativeExecutableFallsBack();
  testWrapperRequiresRealNativeBinary();
  testFarganAutoPromotesToNativeExecWhenAvailable();
  console.log("neural-relay tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
