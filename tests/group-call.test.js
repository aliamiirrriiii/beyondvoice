const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { WebSocket } = require("ws");

const ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "server.js");
const TEST_PORT = 3108;
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
      ENABLE_MEDIA_RELAY: "false",
      NEURAL_RELAY_MODE: "off"
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

    function onMessage(raw) {
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf-8"));
      } catch {
        return;
      }

      if (!predicate(parsed)) {
        return;
      }

      cleanup();
      resolve(parsed);
    }

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function expectNoSocketMessage(ws, predicate, timeoutMs = 500) {
  try {
    const message = await waitForSocketMessage(ws, predicate, timeoutMs);
    throw new Error(`Unexpected socket message: ${JSON.stringify(message)}`);
  } catch (error) {
    if (String(error.message || "").includes("Timed out waiting for socket message")) {
      return;
    }
    throw error;
  }
}

async function openSignalSocket(roomId, participantId) {
  const ws = new WebSocket(`${WS_BASE_URL}/ws`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({
    type: "auth",
    roomId,
    participantId
  }));

  const roomSync = await waitForSocketMessage(ws, (message) => message?.type === "room-sync");
  return { ws, roomSync };
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

async function leaveRoom(roomId, participantId) {
  const { response, json } = await fetchJson(`${BASE_URL}/api/rooms/${roomId}/leave`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ participantId })
  });

  assert.equal(response.status, 200, JSON.stringify(json));
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
  const serverProcess = spawnServer();
  const stdout = [];
  const stderr = [];
  serverProcess.stdout.on("data", (chunk) => stdout.push(chunk.toString("utf-8")));
  serverProcess.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf-8")));

  try {
    await waitForServerReady(BASE_URL);

    const roomId = `group-${Date.now().toString(36)}`;
    const alice = await joinRoom(roomId, "Alice");
    const bob = await joinRoom(roomId, "Bob");
    const charlie = await joinRoom(roomId, "Charlie");

    assert.equal(alice.peers.length, 0);
    assert.deepEqual(bob.peers.map((peer) => peer.displayName), ["Alice"]);
    assert.deepEqual(
      charlie.peers.map((peer) => peer.displayName).sort(),
      ["Alice", "Bob"]
    );

    const aliceSocket = await openSignalSocket(roomId, alice.participant.id);
    const bobSocket = await openSignalSocket(roomId, bob.participant.id);
    const charlieSocket = await openSignalSocket(roomId, charlie.participant.id);

    try {
      assert.equal(aliceSocket.roomSync.peers.length, 2);
      assert.equal(bobSocket.roomSync.peers.length, 2);
      assert.equal(charlieSocket.roomSync.peers.length, 2);

      const bobSignalPromise = waitForSocketMessage(
        bobSocket.ws,
        (message) =>
          message?.type === "signal" &&
          message.from === alice.participant.id &&
          message.signal?.type === "offer"
      );

      aliceSocket.ws.send(JSON.stringify({
        type: "signal",
        signalType: "offer",
        targetId: bob.participant.id,
        payload: {
          description: {
            type: "offer",
            sdp: "v=0\r\n"
          }
        }
      }));

      const bobSignal = await bobSignalPromise;
      assert.equal(bobSignal.targetId, bob.participant.id);
      assert.equal(bobSignal.from, alice.participant.id);
      assert.equal(bobSignal.signal.type, "offer");

      await expectNoSocketMessage(
        charlieSocket.ws,
        (message) =>
          message?.type === "signal" &&
          message.from === alice.participant.id &&
          message.signal?.type === "offer"
      );

      const missingTargetErrorPromise = waitForSocketMessage(
        aliceSocket.ws,
        (message) => message?.type === "error" && message.error === "Signal target not found"
      );
      aliceSocket.ws.send(JSON.stringify({
        type: "signal",
        signalType: "offer",
        targetId: "peer-missing",
        payload: {
          description: {
            type: "offer",
            sdp: "v=0\r\n"
          }
        }
      }));
      const missingTargetError = await missingTargetErrorPromise;
      assert.equal(missingTargetError.error, "Signal target not found");

      const alicePeerLeftPromise = waitForSocketMessage(
        aliceSocket.ws,
        (message) => message?.type === "peer-left" && message.peer?.id === bob.participant.id
      );
      const charliePeerLeftPromise = waitForSocketMessage(
        charlieSocket.ws,
        (message) => message?.type === "peer-left" && message.peer?.id === bob.participant.id
      );

      await leaveRoom(roomId, bob.participant.id);

      const [alicePeerLeft, charliePeerLeft] = await Promise.all([
        alicePeerLeftPromise,
        charliePeerLeftPromise
      ]);
      assert.equal(alicePeerLeft.peer.displayName, "Bob");
      assert.equal(charliePeerLeft.peer.displayName, "Bob");
    } finally {
      aliceSocket.ws.close();
      bobSocket.ws.close();
      charlieSocket.ws.close();
    }
  } catch (error) {
    error.stdout = stdout.join("");
    error.stderr = stderr.join("");
    throw error;
  } finally {
    await shutdownServer(serverProcess);
  }
}

run().then(() => {
  console.log("group-call tests passed");
}).catch((error) => {
  console.error(error);
  if (error.stdout) {
    console.error("--- stdout ---");
    console.error(error.stdout);
  }
  if (error.stderr) {
    console.error("--- stderr ---");
    console.error(error.stderr);
  }
  process.exit(1);
});
