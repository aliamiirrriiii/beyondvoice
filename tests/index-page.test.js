const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER_PATH = path.join(ROOT, "server.js");
const TEST_PORT = 3110;
const TEST_HOST = "127.0.0.1";
const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`;

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
      HOST: TEST_HOST
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
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

    const response = await fetch(BASE_URL);
    const html = await response.text();
    assert.equal(response.status, 200, html);
    assert.match(html, /id="speaker-button"/);
    assert.match(html, /aria-label="Enable speaker output"/);
    assert.match(html, /id="remote-audio"/);
  } catch (error) {
    error.message = `${error.message}\nserver stdout:\n${stdout.join("")}\nserver stderr:\n${stderr.join("")}`;
    throw error;
  } finally {
    await shutdownServer(serverProcess);
  }

  console.log("index-page test passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
