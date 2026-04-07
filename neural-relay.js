const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { fork, spawn } = require("child_process");
const { FarganRelayEngine, normalizeMode } = require("./native/fargan-relay/engine");

const DEFAULT_NATIVE_EXECUTABLE = path.join(
  __dirname,
  "native",
  "fargan-relay",
  "bin",
  "fargan-relay-worker"
);

function serializeFrame(frame) {
  if (!frame || frame.kind !== "packet" || !frame.packet) {
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

function deserializeFrame(frame) {
  if (!frame || frame.kind !== "packet" || !frame.packet) {
    return frame;
  }

  return {
    ...frame,
    packet: {
      ...frame.packet,
      features: { ...(frame.packet.features || {}) },
      payload: Uint8Array.from(frame.packet.payload || [])
    }
  };
}

class InProcessNeuralRelay {
  constructor({ mode = "off" } = {}) {
    this.mode = normalizeMode(mode);
    this.engine = new FarganRelayEngine({ mode: this.mode });
    this.backend = "in-process";
    this.runtime = "in-process";
  }

  async processFrame(input) {
    return this.engine.processFrame(input);
  }

  async close() {
    this.engine.close();
  }
}

class ChildProcessNeuralRelay {
  constructor({ mode = "off" } = {}) {
    this.mode = normalizeMode(mode);
    this.backend = "child-process";
    this.runtime = "child-process";
    this.requestId = 0;
    this.pending = new Map();
    this.ready = false;
    this.child = fork(path.join(__dirname, "native", "fargan-relay", "worker.js"), {
      env: {
        ...process.env,
        NEURAL_RELAY_MODE: this.mode
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type === "ready") {
          this.ready = true;
          this.child.off("message", onMessage);
          resolve();
        }
      };

      this.child.on("message", onMessage);
      this.child.once("error", reject);
      this.child.once("exit", (code) => {
        if (!this.ready) {
          reject(new Error(`Neural relay worker exited before ready (${code})`));
        }
      });
    });

    this.child.on("message", (message) => {
      if (message?.type !== "process-frame-result") {
        return;
      }

      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(message.requestId);

      if (message.error) {
        pending.reject(new Error(message.error));
        return;
      }

      pending.resolve({
        frame: deserializeFrame(message.result?.frame),
        metadata: message.result?.metadata || null
      });
    });
  }

  async processFrame({ roomId, senderId, frame }) {
    await this.readyPromise;

    const requestId = `req_${this.requestId += 1}`;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    this.child.send({
      type: "process-frame",
      requestId,
      roomId,
      senderId,
      frame: serializeFrame(frame)
    });

    return promise;
  }

  async close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Neural relay worker shutting down"));
    }
    this.pending.clear();

    if (this.child.connected) {
      this.child.send({ type: "shutdown" });
    }
  }
}

class NativeExecutableNeuralRelay {
  constructor({
    mode = "off",
    executablePath = process.env.NEURAL_RELAY_EXECUTABLE || DEFAULT_NATIVE_EXECUTABLE
  } = {}) {
    this.mode = normalizeMode(mode);
    this.backend = "native-exec";
    this.runtime = "native-exec";
    this.nativeLibrary = null;
    this.executablePath = executablePath;
    this.requestId = 0;
    this.pending = new Map();
    this.ready = false;
    this.process = spawn(this.executablePath, [], {
      env: {
        ...process.env,
        NEURAL_RELAY_MODE: this.mode
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.readyPromise = new Promise((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        reject(new Error("Native neural relay executable did not become ready"));
      }, 5000);

      const lineReader = readline.createInterface({
        input: this.process.stdout
      });

      lineReader.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }

        if (message.type === "ready") {
          clearTimeout(readyTimeout);
          this.ready = true;
          this.runtime = message.runtime || this.runtime;
          this.nativeLibrary = message.opusVersion || null;
          resolve();
          return;
        }

        if (message.type !== "process-frame-result") {
          return;
        }

        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(message.requestId);

        if (message.error) {
          pending.reject(new Error(message.error));
          return;
        }

        pending.resolve({
          frame: deserializeFrame(message.result?.frame),
          metadata: message.result?.metadata || null
        });
      });

      this.process.once("error", (error) => {
        clearTimeout(readyTimeout);
        reject(error);
      });
      this.process.once("exit", (code) => {
        clearTimeout(readyTimeout);
        if (!this.ready) {
          reject(new Error(`Native neural relay executable exited before ready (${code})`));
        }
      });
    });
  }

  async processFrame({ roomId, senderId, frame }) {
    await this.readyPromise;

    const requestId = `req_${this.requestId += 1}`;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    this.process.stdin.write(`${JSON.stringify({
      type: "process-frame",
      requestId,
      roomId,
      senderId,
      frame: serializeFrame(frame)
    })}\n`);

    return promise;
  }

  async close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Native neural relay executable shutting down"));
    }
    this.pending.clear();

    if (!this.process.killed) {
      this.process.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      this.process.kill("SIGTERM");
    }
  }
}

function createNeuralRelay({
  mode = "off",
  backend = "in-process",
  executablePath
} = {}) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === "off") {
    return new InProcessNeuralRelay({ mode: normalizedMode });
  }

  if (backend === "native-exec") {
    const resolvedExecutablePath =
      executablePath || process.env.NEURAL_RELAY_EXECUTABLE || DEFAULT_NATIVE_EXECUTABLE;
    if (!fs.existsSync(resolvedExecutablePath)) {
      return new InProcessNeuralRelay({ mode: normalizedMode });
    }
    return new NativeExecutableNeuralRelay({
      mode: normalizedMode,
      executablePath: resolvedExecutablePath
    });
  }

  if (backend === "child-process") {
    return new ChildProcessNeuralRelay({ mode: normalizedMode });
  }

  return new InProcessNeuralRelay({ mode: normalizedMode });
}

module.exports = {
  ChildProcessNeuralRelay,
  InProcessNeuralRelay,
  NativeExecutableNeuralRelay,
  createNeuralRelay
};
