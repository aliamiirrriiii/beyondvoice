const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { WebSocket } = require("ws");
const { RtpPacketizer, RohcLiteCompressor, RohcLiteDecompressor } = require("../public/extreme-stack.js");

const ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "server.js");
const NATIVE_WORKER = path.join(ROOT, "native", "fargan-relay", "bin", "fargan-relay-worker");
const TEST_PORT = 3107;
const TEST_HOST = "127.0.0.1";
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;
const WS_BASE_URL = `ws://${TEST_HOST}:${TEST_PORT}`;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json();
  return { response, json };
}

async function waitForServerReady(baseUrl, timeoutMs = 10000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/ready`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`Unexpected ready status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error("Server did not become ready");
}

function spawnServer() {
  return spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HOST: TEST_HOST,
      NEURAL_RELAY_MODE: "fargan",
      NEURAL_RELAY_BACKEND: "native-exec"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function waitForSocketMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for socket message"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
      ws.off("close", onClose);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onClose(code, reason) {
      cleanup();
      reject(new Error(`Socket closed before expected message (${code} ${String(reason)})`));
    }

    function onMessage(raw, isBinary) {
      let parsed = raw;
      if (!isBinary) {
        try {
          parsed = JSON.parse(raw.toString("utf-8"));
        } catch {
          parsed = raw.toString("utf-8");
        }
      }

      if (!predicate(parsed, isBinary)) {
        return;
      }

      cleanup();
      resolve({ message: parsed, isBinary });
    }

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function openMediaSocket(roomId, participantId) {
  const ws = new WebSocket(`${WS_BASE_URL}/media`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({
    type: "auth",
    roomId,
    participantId
  }));

  const ready = await waitForSocketMessage(
    ws,
    (message, isBinary) => !isBinary && message?.type === "media-ready"
  );
  assert.equal(ready.message.roomId, roomId);
  assert.equal(ready.message.participant.id, participantId);
  return ws;
}

async function joinRoom(roomId, displayName) {
  const { response, json } = await fetchJson(`${BASE_URL}/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ displayName })
  });

  assert.equal(response.status, 200, JSON.stringify(json));
  return json;
}

async function collectBinaryPackets(ws, count, timeoutMs = 5000) {
  const packets = [];
  const startedAt = Date.now();

  while (packets.length < count) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${count} media packets; received ${packets.length}`);
    }

    const result = await waitForSocketMessage(ws, (_message, isBinary) => isBinary, remaining);
    packets.push(new Uint8Array(result.message));
  }

  return packets;
}

async function shutdownServer(serverProcess) {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      serverProcess.kill("SIGKILL");
    }, 5000);

    serverProcess.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    serverProcess.kill("SIGINT");
  });
}

async function run() {
  assert.equal(fs.existsSync(NATIVE_WORKER), true, "Native FARGAN relay executable is missing");

  const serverProcess = spawnServer();
  const stdout = [];
  const stderr = [];
  serverProcess.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf-8")));
  serverProcess.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf-8")));

  try {
    await waitForServerReady(BASE_URL);

    const { response: healthResponse, json: health } = await fetchJson(`${BASE_URL}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal(health.ok, true);
    assert.equal(health.neuralRelayMode, "fargan");
    assert.equal(health.neuralRelayBackend, "native-exec");

    const roomId = `e2e-${Date.now().toString(36)}`;
    const senderJoin = await joinRoom(roomId, "sender");
    const receiverJoin = await joinRoom(roomId, "receiver");

    const senderSocket = await openMediaSocket(roomId, senderJoin.participant.id);
    const receiverSocket = await openMediaSocket(roomId, receiverJoin.participant.id);

    try {
      const packetizer = new RtpPacketizer({
        ssrc: 0x10203040,
        payloadType: 97,
        timestampStep: 320
      });
      const compressor = new RohcLiteCompressor();
      const decompressor = new RohcLiteDecompressor();

      const expectedFrames = 6;
      const receivePromise = collectBinaryPackets(receiverSocket, expectedFrames, 5000);

      for (let index = 0; index < expectedFrames; index += 1) {
        const packet = packetizer.createPacket(
          Uint8Array.from([index & 0xff, 0, 0, 0]),
          {
            energy: 0.2 + (index * 0.05),
            pitchHz: 110 + index,
            voicedProbability: 0.8,
            spectralTilt: 0.1
          }
        );
        const compressed = compressor.compress(packet);
        senderSocket.send(compressed.bytes);
        await delay(40);
      }

      const delivered = await receivePromise;
      assert.equal(delivered.length, expectedFrames);

      const decodedPackets = delivered.map((bytes) => decompressor.decompress(bytes).packet);
      for (const packet of decodedPackets) {
        assert.equal(packet.payloadType, 98);
        assert.equal(packet.payload.length, 640);
        assert.equal(packet.payload.length % 2, 0);
      }

      senderSocket.close();
      receiverSocket.close();
    } catch (error) {
      throw error;
    }
  } catch (error) {
    error.message = `${error.message}\nserver stdout:\n${stdout.join("")}\nserver stderr:\n${stderr.join("")}`;
    throw error;
  } finally {
    await shutdownServer(serverProcess);
  }

  console.log("media-relay e2e test passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
