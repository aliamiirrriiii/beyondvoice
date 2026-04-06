const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { URL } = require("url");
const { WebSocketServer } = require("ws");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const JSON_LIMIT_BYTES = 64 * 1024;
const ROOM_IDLE_MS = Number(process.env.ROOM_IDLE_MS || 5 * 60 * 1000);
const PARTICIPANT_IDLE_MS = Number(process.env.PARTICIPANT_IDLE_MS || 45 * 1000);
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 10000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 240);
const MAX_EVENTS_PER_PARTICIPANT = Number(process.env.MAX_EVENTS_PER_PARTICIPANT || 128);
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 20_000);
const REDIS_URL = process.env.REDIS_URL || "";
const REDIS_PREFIX = process.env.REDIS_PREFIX || "voiceai";
const allowedOrigin = process.env.ALLOWED_ORIGIN || "";
const TURN_AUTH_SECRET = process.env.TURN_AUTH_SECRET || "";
const TURN_REALM = process.env.TURN_REALM || "";
const TURN_CREDENTIAL_TTL_SECONDS = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS || 3600);
const TURN_USERNAME = process.env.TURN_USERNAME || "";
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || "";
const AUTH_USERNAME = process.env.AUTH_USERNAME || "";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";

let isShuttingDown = false;
const rateLimits = new Map();
const socketsByParticipant = new Map();
const participantsByRoom = new Map();

function now() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeRoomId(roomId) {
  return String(roomId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 48);
}

function participantSnapshot(participant) {
  return {
    id: participant.id,
    displayName: participant.displayName,
    joinedAt: participant.joinedAt
  };
}

function securityHeaders(contentType = "text/plain; charset=utf-8", cacheControl = "no-store") {
  return {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(payload));
}

function text(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, securityHeaders(contentType));
  response.end(body);
}

function notFound(response) {
  text(response, 404, "Not found");
}

function badRequest(response, message) {
  json(response, 400, { error: message });
}

function unauthorized(response, message) {
  json(response, 401, { error: message });
}

function unauthorizedBasic(response) {
  response.writeHead(401, {
    ...securityHeaders("application/json; charset=utf-8"),
    "WWW-Authenticate": 'Basic realm="VoiceAI", charset="UTF-8"'
  });
  response.end(JSON.stringify({ error: "Authentication required" }));
}

function tooManyRequests(response) {
  json(response, 429, { error: "Rate limit exceeded" });
}

function getClientIp(request) {
  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return request.socket.remoteAddress || "unknown";
}

function allowRequest(request) {
  if (RATE_LIMIT_MAX_REQUESTS <= 0) {
    return true;
  }

  const currentTime = now();
  const bucketKey = `${getClientIp(request)}:${request.method}:${request.url.split("?")[0]}`;
  const bucket = rateLimits.get(bucketKey) || {
    startedAt: currentTime,
    count: 0
  };

  if (currentTime - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
    bucket.startedAt = currentTime;
    bucket.count = 0;
  }

  bucket.count += 1;
  rateLimits.set(bucketKey, bucket);
  return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

function cleanupRateLimits() {
  const currentTime = now();
  for (const [key, bucket] of rateLimits.entries()) {
    if (currentTime - bucket.startedAt > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimits.delete(key);
    }
  }
}

function authEnabled() {
  return Boolean(AUTH_USERNAME && AUTH_PASSWORD);
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseBasicAuthHeader(request) {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      return null;
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return null;
  }
}

function isAuthenticatedRequest(request) {
  if (!authEnabled()) {
    return true;
  }

  const creds = parseBasicAuthHeader(request);
  if (!creds) {
    return false;
  }

  return safeCompare(creds.username, AUTH_USERNAME) && safeCompare(creds.password, AUTH_PASSWORD);
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

const COMPRESSIBLE_TYPES = new Set([".html", ".css", ".js", ".json", ".svg"]);

function sendFile(response, filePath, request) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === "ENOENT") {
        notFound(response);
        return;
      }
      text(response, 500, "Failed to read file");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === ".html";
    const headers = securityHeaders(mimeTypeFor(filePath), "no-store");

    if (!COMPRESSIBLE_TYPES.has(ext) || !request) {
      response.writeHead(200, headers);
      response.end(data);
      return;
    }

    const accept = String(request.headers["accept-encoding"] || "");
    if (accept.includes("br")) {
      headers["Content-Encoding"] = "br";
      headers["Vary"] = "Accept-Encoding";
      zlib.brotliCompress(data, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
      }, (err, compressed) => {
        response.writeHead(200, headers);
        response.end(err ? data : compressed);
      });
    } else if (accept.includes("gzip")) {
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
      zlib.gzip(data, { level: 6 }, (err, compressed) => {
        response.writeHead(200, headers);
        response.end(err ? data : compressed);
      });
    } else {
      response.writeHead(200, headers);
      response.end(data);
    }
  });
}

function buildIceServers() {
  const iceServers = [];
  const stunUrls = (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  const turnUrls = (process.env.TURN_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (turnUrls.length > 0) {
    if (TURN_AUTH_SECRET || (TURN_USERNAME && TURN_CREDENTIAL)) {
      iceServers.push({
        urls: turnUrls,
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL
      });
    }
  }

  return iceServers;
}

function buildTurnCredential(participantId) {
  if (!TURN_AUTH_SECRET) {
    return null;
  }

  const expiresAt = Math.floor(now() / 1000) + TURN_CREDENTIAL_TTL_SECONDS;
  const username = `${expiresAt}:${participantId}`;
  const credential = crypto
    .createHmac("sha1", TURN_AUTH_SECRET)
    .update(username)
    .digest("base64");

  return {
    username,
    credential,
    ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS
  };
}

function buildIceServersForParticipant(participantId) {
  const staticServers = buildIceServers();
  const turnCredential = buildTurnCredential(participantId);

  if (!turnCredential) {
    return staticServers;
  }

  return staticServers.map((server) => {
    if (!server.urls) {
      return server;
    }

    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const hasTurnUrl = urls.some((url) => String(url).startsWith("turn:") || String(url).startsWith("turns:"));
    if (!hasTurnUrl) {
      return server;
    }

    return {
      urls: server.urls,
      username: turnCredential.username,
      credential: turnCredential.credential
    };
  });
}

function appConfigScript() {
  const codec2Available =
    fs.existsSync(path.join(PUBLIC_DIR, "codec2.wasm")) &&
    fs.existsSync(path.join(PUBLIC_DIR, "codec2-worker.js"));
  const config = {
    iceServers: buildIceServers().filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.every((url) => !String(url).startsWith("turn:") && !String(url).startsWith("turns:"));
    }),
    maxReconnectDelayMs: 5000,
    wsPath: "/ws",
    enableCodec2: codec2Available
  };

  return `window.APP_CONFIG = ${JSON.stringify(config, null, 2)};`;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > JSON_LIMIT_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

function parseParticipant(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function createMemoryStore(publishEvent) {
  const rooms = new Map();

  function getOrCreateRoom(roomId) {
    const normalized = normalizeRoomId(roomId);
    if (!normalized) {
      return null;
    }

    const existing = rooms.get(normalized);
    if (existing) {
      return existing;
    }

    const room = {
      id: normalized,
      participants: new Map(),
      updatedAt: now()
    };
    rooms.set(normalized, room);
    return room;
  }

  function getRoom(roomId) {
    const normalized = normalizeRoomId(roomId);
    if (!normalized) {
      return null;
    }
    return rooms.get(normalized) || null;
  }

  async function pruneRoom(roomId) {
    const room = getRoom(roomId);
    if (!room) {
      return [];
    }

    const stale = [];
    const currentTime = now();
    for (const [participantId, participant] of room.participants.entries()) {
      if (currentTime - participant.lastSeenAt > PARTICIPANT_IDLE_MS) {
        room.participants.delete(participantId);
        stale.push(participantSnapshot(participant));
      }
    }

    for (const participant of stale) {
      await publishEvent(room.id, {
        type: "peer-left",
        peer: participant,
        reason: "timeout"
      });
    }

    if (room.participants.size === 0) {
      rooms.delete(room.id);
    }

    return stale;
  }

  return {
    mode: "memory",
    async joinRoom(roomId, displayName) {
      const room = getOrCreateRoom(roomId);
      if (!room) {
        throw new Error("Invalid room id");
      }

      await pruneRoom(room.id);
      const liveParticipants = Array.from(room.participants.values());
      if (liveParticipants.length >= 2) {
        const error = new Error("Room is full");
        error.statusCode = 409;
        throw error;
      }

      const participant = {
        id: randomId("peer"),
        displayName: String(displayName || "Anonymous").trim().slice(0, 32) || "Anonymous",
        joinedAt: now(),
        lastSeenAt: now()
      };

      const role = liveParticipants.length === 0 ? "host" : "guest";
      room.participants.set(participant.id, participant);
      room.updatedAt = now();

      await publishEvent(room.id, {
        type: "peer-joined",
        peer: participantSnapshot(participant)
      });

      return {
        roomId: room.id,
        participant,
        role,
        peers: liveParticipants.map(participantSnapshot)
      };
    },
    async touchParticipant(roomId, participantId) {
      const room = getRoom(roomId);
      if (!room) {
        return null;
      }

      const participant = room.participants.get(participantId);
      if (!participant) {
        return null;
      }

      participant.lastSeenAt = now();
      room.updatedAt = now();
      return participant;
    },
    async getLivePeers(roomId, excludeParticipantId = "") {
      const room = getRoom(roomId);
      if (!room) {
        return [];
      }

      await pruneRoom(room.id);
      return Array.from(room.participants.values())
        .filter((participant) => participant.id !== excludeParticipantId)
        .map(participantSnapshot);
    },
    async hasParticipant(roomId, participantId) {
      const room = getRoom(roomId);
      return Boolean(room && room.participants.has(participantId));
    },
    async publishSignal(roomId, fromId, targetId, signal) {
      const room = getRoom(roomId);
      if (!room || !room.participants.has(fromId)) {
        return false;
      }

      if (targetId && !room.participants.has(targetId)) {
        return false;
      }

      await publishEvent(room.id, {
        type: "signal",
        from: fromId,
        targetId: targetId || "",
        signal
      });
      return true;
    },
    async removeParticipant(roomId, participantId, reason = "left") {
      const room = getRoom(roomId);
      if (!room) {
        return null;
      }

      const participant = room.participants.get(participantId);
      if (!participant) {
        return null;
      }

      room.participants.delete(participantId);
      room.updatedAt = now();

      await publishEvent(room.id, {
        type: "peer-left",
        peer: participantSnapshot(participant),
        reason
      });

      if (room.participants.size === 0) {
        rooms.delete(room.id);
      }

      return participant;
    },
    async cleanupIdle() {
      for (const room of rooms.values()) {
        await pruneRoom(room.id);
      }
    },
    async getRoomsCount() {
      return rooms.size;
    }
  };
}

function createRedisStore(commandClient, publishEvent) {
  const roomsIndexKey = `${REDIS_PREFIX}:rooms`;
  const roomParticipantsKey = (roomId) => `${REDIS_PREFIX}:room:${roomId}:participants`;

  async function listParticipants(roomId) {
    const values = await commandClient.hVals(roomParticipantsKey(roomId));
    return values.map(parseParticipant).filter(Boolean);
  }

  async function persistParticipant(roomId, participant) {
    await commandClient.hSet(roomParticipantsKey(roomId), participant.id, JSON.stringify(participant));
    await commandClient.sAdd(roomsIndexKey, roomId);
  }

  async function pruneRoom(roomId) {
    const participants = await listParticipants(roomId);
    const stale = participants.filter((participant) => now() - participant.lastSeenAt > PARTICIPANT_IDLE_MS);

    for (const participant of stale) {
      await commandClient.hDel(roomParticipantsKey(roomId), participant.id);
      await publishEvent(roomId, {
        type: "peer-left",
        peer: participantSnapshot(participant),
        reason: "timeout"
      });
    }

    const remainingCount = await commandClient.hLen(roomParticipantsKey(roomId));
    if (remainingCount === 0) {
      await commandClient.del(roomParticipantsKey(roomId));
      await commandClient.sRem(roomsIndexKey, roomId);
    }
  }

  return {
    mode: "redis",
    async joinRoom(roomId, displayName) {
      const normalizedRoomId = normalizeRoomId(roomId);
      if (!normalizedRoomId) {
        throw new Error("Invalid room id");
      }

      await pruneRoom(normalizedRoomId);
      const liveParticipants = await listParticipants(normalizedRoomId);
      if (liveParticipants.length >= 2) {
        const error = new Error("Room is full");
        error.statusCode = 409;
        throw error;
      }

      const participant = {
        id: randomId("peer"),
        displayName: String(displayName || "Anonymous").trim().slice(0, 32) || "Anonymous",
        joinedAt: now(),
        lastSeenAt: now()
      };

      const role = liveParticipants.length === 0 ? "host" : "guest";
      await persistParticipant(normalizedRoomId, participant);

      await publishEvent(normalizedRoomId, {
        type: "peer-joined",
        peer: participantSnapshot(participant)
      });

      return {
        roomId: normalizedRoomId,
        participant,
        role,
        peers: liveParticipants.map(participantSnapshot)
      };
    },
    async touchParticipant(roomId, participantId) {
      const value = await commandClient.hGet(roomParticipantsKey(roomId), participantId);
      if (!value) {
        return null;
      }

      const participant = parseParticipant(value);
      if (!participant) {
        return null;
      }

      participant.lastSeenAt = now();
      await persistParticipant(roomId, participant);
      return participant;
    },
    async getLivePeers(roomId, excludeParticipantId = "") {
      await pruneRoom(roomId);
      const participants = await listParticipants(roomId);
      return participants
        .filter((participant) => participant.id !== excludeParticipantId)
        .map(participantSnapshot);
    },
    async hasParticipant(roomId, participantId) {
      return (await commandClient.hExists(roomParticipantsKey(roomId), participantId)) === 1;
    },
    async publishSignal(roomId, fromId, targetId, signal) {
      const senderExists = await commandClient.hExists(roomParticipantsKey(roomId), fromId);
      if (senderExists !== 1) {
        return false;
      }

      if (targetId) {
        const targetExists = await commandClient.hExists(roomParticipantsKey(roomId), targetId);
        if (targetExists !== 1) {
          return false;
        }
      }

      await publishEvent(roomId, {
        type: "signal",
        from: fromId,
        targetId: targetId || "",
        signal
      });
      return true;
    },
    async removeParticipant(roomId, participantId, reason = "left") {
      const value = await commandClient.hGet(roomParticipantsKey(roomId), participantId);
      if (!value) {
        return null;
      }

      const participant = parseParticipant(value);
      if (!participant) {
        return null;
      }

      await commandClient.hDel(roomParticipantsKey(roomId), participantId);
      await publishEvent(roomId, {
        type: "peer-left",
        peer: participantSnapshot(participant),
        reason
      });

      const remainingCount = await commandClient.hLen(roomParticipantsKey(roomId));
      if (remainingCount === 0) {
        await commandClient.del(roomParticipantsKey(roomId));
        await commandClient.sRem(roomsIndexKey, roomId);
      }

      return participant;
    },
    async cleanupIdle() {
      const rooms = await commandClient.sMembers(roomsIndexKey);
      for (const roomId of rooms) {
        await pruneRoom(roomId);
      }
    },
    async getRoomsCount() {
      return commandClient.sCard(roomsIndexKey);
    }
  };
}

function sendSocketMessage(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function registerSocket(ws, roomId, participantId) {
  unregisterSocket(ws);

  ws.roomId = roomId;
  ws.participantId = participantId;
  socketsByParticipant.set(participantId, ws);

  const roomSet = participantsByRoom.get(roomId) || new Set();
  roomSet.add(participantId);
  participantsByRoom.set(roomId, roomSet);
}

function unregisterSocket(ws) {
  if (!ws || !ws.participantId || !ws.roomId) {
    return;
  }

  if (socketsByParticipant.get(ws.participantId) === ws) {
    socketsByParticipant.delete(ws.participantId);
  }

  const roomSet = participantsByRoom.get(ws.roomId);
  if (roomSet) {
    roomSet.delete(ws.participantId);
    if (roomSet.size === 0) {
      participantsByRoom.delete(ws.roomId);
    }
  }

  ws.participantId = "";
  ws.roomId = "";
}

function routeEventLocally(roomId, event) {
  const roomSet = participantsByRoom.get(roomId);
  if (!roomSet || roomSet.size === 0) {
    return;
  }

  if (event.targetId) {
    const ws = socketsByParticipant.get(event.targetId);
    if (ws && ws.roomId === roomId) {
      sendSocketMessage(ws, event);
    }
    return;
  }

  for (const participantId of roomSet) {
    if (event.type === "peer-joined" && participantId === event.peer.id) {
      continue;
    }
    if (event.type === "peer-left" && participantId === event.peer.id) {
      continue;
    }
    if (event.type === "signal" && participantId === event.from) {
      continue;
    }

    sendSocketMessage(socketsByParticipant.get(participantId), event);
  }
}

async function createStore() {
  if (!REDIS_URL) {
    return {
      store: createMemoryStore(async (roomId, event) => {
        routeEventLocally(roomId, event);
      }),
      redisClients: null
    };
  }

  const commandClient = createClient({ url: REDIS_URL });
  const publisherClient = commandClient.duplicate();
  const subscriberClient = commandClient.duplicate();

  await commandClient.connect();
  await publisherClient.connect();
  await subscriberClient.connect();

  const channel = `${REDIS_PREFIX}:events`;
  await subscriberClient.subscribe(channel, (rawMessage) => {
    try {
      const envelope = JSON.parse(rawMessage);
      routeEventLocally(envelope.roomId, envelope.event);
    } catch (error) {
      console.error("Failed to route pubsub event", error);
    }
  });

  const publishEvent = async (roomId, event) => {
    await publisherClient.publish(channel, JSON.stringify({ roomId, event }));
  };

  return {
    store: createRedisStore(commandClient, publishEvent),
    redisClients: {
      commandClient,
      publisherClient,
      subscriberClient
    }
  };
}

async function main() {
  const { store, redisClients } = await createStore();
  const cachedAppConfig = appConfigScript();

  async function handleJoin(request, response, roomId) {
    const body = await readJsonBody(request);
    try {
      const result = await store.joinRoom(roomId, body.displayName);
      json(response, 200, {
        roomId: result.roomId,
        participant: participantSnapshot(result.participant),
        role: result.role,
        peers: result.peers,
        iceServers: buildIceServersForParticipant(result.participant.id)
      });
    } catch (error) {
      json(response, error.statusCode || 400, { error: error.message });
    }
  }

  async function handleSignal(request, response, roomId) {
    const body = await readJsonBody(request);
    const participant = await store.touchParticipant(roomId, body.participantId);
    if (!participant) {
      unauthorized(response, "Participant not found");
      return;
    }

    const ok = await store.publishSignal(roomId, participant.id, body.targetId, {
      type: body.type,
      payload: body.payload || {}
    });

    if (!ok) {
      json(response, 404, { error: "Signal target not found" });
      return;
    }

    json(response, 202, { ok: true });
  }

  async function handleHeartbeat(request, response, roomId) {
    const body = await readJsonBody(request);
    const participant = await store.touchParticipant(roomId, body.participantId);
    if (!participant) {
      unauthorized(response, "Participant not found");
      return;
    }

    json(response, 200, { ok: true });
  }

  async function handleLeave(request, response, roomId) {
    const body = await readJsonBody(request);
    await store.removeParticipant(roomId, body.participantId, "left");
    json(response, 200, { ok: true });
  }

  function routeApi(request, response, url) {
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/health") {
      Promise.resolve(store.getRoomsCount())
        .then((roomsCount) => {
          json(response, 200, {
            ok: true,
            now: new Date().toISOString(),
            rooms: roomsCount,
            signaling: store.mode
          });
        })
        .catch((error) => {
          json(response, 500, { ok: false, error: error.message });
        });
      return true;
    }

    if (url.pathname === "/ready") {
      json(response, isShuttingDown ? 503 : 200, {
        ok: !isShuttingDown,
        shuttingDown: isShuttingDown,
        signaling: store.mode
      });
      return true;
    }

    if (pathParts[0] !== "api" || pathParts[1] !== "rooms" || !pathParts[2]) {
      return false;
    }

    if (isShuttingDown) {
      json(response, 503, { error: "Server is shutting down" });
      return true;
    }

    if (!allowRequest(request)) {
      tooManyRequests(response);
      return true;
    }

    const roomId = pathParts[2];
    const action = pathParts[3] || "";

    if (request.method === "POST" && action === "join") {
      handleJoin(request, response, roomId).catch((error) => badRequest(response, error.message));
      return true;
    }

    if (request.method === "POST" && action === "signal") {
      handleSignal(request, response, roomId).catch((error) => badRequest(response, error.message));
      return true;
    }

    if (request.method === "POST" && action === "heartbeat") {
      handleHeartbeat(request, response, roomId).catch((error) => badRequest(response, error.message));
      return true;
    }

    if (request.method === "POST" && action === "leave") {
      handleLeave(request, response, roomId).catch((error) => badRequest(response, error.message));
      return true;
    }

    if (request.method === "GET" && action === "poll") {
      json(response, 410, { error: "Long polling disabled; use WebSocket signaling" });
      return true;
    }

    text(response, 405, "Method not allowed");
    return true;
  }

  const requestHandler = (request, response) => {
    if (allowedOrigin) {
      response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      response.setHeader("Vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...securityHeaders(),
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      response.end();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    const isPublicPath = url.pathname === "/health" || url.pathname === "/ready";
    if (!isPublicPath && !isAuthenticatedRequest(request)) {
      unauthorizedBasic(response);
      return;
    }

    if (routeApi(request, response, url)) {
      return;
    }

    if (url.pathname === "/app-config.js") {
      text(response, 200, cachedAppConfig, "application/javascript; charset=utf-8");
      return;
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const absolutePath = path.join(PUBLIC_DIR, requestedPath);
    const normalizedPath = path.normalize(absolutePath);
    if (!normalizedPath.startsWith(PUBLIC_DIR)) {
      notFound(response);
      return;
    }

    sendFile(response, normalizedPath, request);
  };

  const hasTls = TLS_KEY_PATH && TLS_CERT_PATH;
  const server = hasTls
    ? https.createServer(
        {
          key: fs.readFileSync(TLS_KEY_PATH),
          cert: fs.readFileSync(TLS_CERT_PATH)
        },
        requestHandler
      )
    : http.createServer(requestHandler);

  server.keepAliveTimeout = 61_000;
  server.headersTimeout = 65_000;
  server.requestTimeout = 70_000;

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6 },
      threshold: 128
    }
  });

  async function authenticateSocket(ws, message) {
    const roomId = normalizeRoomId(message.roomId);
    const participantId = String(message.participantId || "").trim();

    if (!roomId || !participantId) {
      sendSocketMessage(ws, { type: "error", error: "Missing room or participant id" });
      ws.close(4001, "Missing auth");
      return;
    }

    const participant = await store.touchParticipant(roomId, participantId);
    if (!participant) {
      sendSocketMessage(ws, { type: "error", error: "Participant not found" });
      ws.close(4004, "Participant not found");
      return;
    }

    registerSocket(ws, roomId, participantId);
    const peers = await store.getLivePeers(roomId, participantId);
    sendSocketMessage(ws, {
      type: "room-sync",
      roomId,
      participant: participantSnapshot(participant),
      peers
    });
  }

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.participantId = "";
    ws.roomId = "";

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (rawMessage) => {
      const raw = rawMessage.toString("utf-8");

      // Fast-path: single-char heartbeat
      if (raw === "h") {
        if (ws.roomId && ws.participantId) {
          await store.touchParticipant(ws.roomId, ws.participantId);
        }
        return;
      }

      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        sendSocketMessage(ws, { type: "error", error: "Invalid JSON message" });
        return;
      }

      try {
        switch (message.type) {
          case "auth":
            await authenticateSocket(ws, message);
            break;
          case "heartbeat":
            if (ws.roomId && ws.participantId) {
              await store.touchParticipant(ws.roomId, ws.participantId);
            }
            break;
          case "signal":
            if (!ws.roomId || !ws.participantId) {
              sendSocketMessage(ws, { type: "error", error: "Socket is not authenticated" });
              return;
            }

            await store.touchParticipant(ws.roomId, ws.participantId);
            await store.publishSignal(ws.roomId, ws.participantId, message.targetId, {
              type: message.signalType,
              payload: message.payload || {}
            });
            break;
          case "leave":
            if (ws.roomId && ws.participantId) {
              await store.removeParticipant(ws.roomId, ws.participantId, "left");
            }
            unregisterSocket(ws);
            break;
          default:
            sendSocketMessage(ws, { type: "error", error: "Unknown message type" });
        }
      } catch (error) {
        sendSocketMessage(ws, { type: "error", error: error.message });
      }
    });

    ws.on("close", () => {
      unregisterSocket(ws);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    if (isShuttingDown) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!isAuthenticatedRequest(request)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"VoiceAI\", charset=\"UTF-8\"\r\n\r\n"
      );
      socket.destroy();
      return;
    }

    if (!allowRequest(request)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (allowedOrigin && request.headers.origin !== allowedOrigin) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  const redisCleanup = setInterval(() => {
    store.cleanupIdle().catch((error) => {
      console.error("Idle cleanup failed", error);
    });
    cleanupRateLimits();
  }, 10_000);
  redisCleanup.unref();

  const wsPingInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        unregisterSocket(ws);
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, WS_PING_INTERVAL_MS);
  wsPingInterval.unref();

  server.listen(PORT, HOST, () => {
    const scheme = hasTls ? "https" : "http";
    console.log(`VoiceAI listening on ${scheme}://${HOST}:${PORT} with ${store.mode} signaling`);
  });

  async function shutdown(signal) {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully`);

    for (const ws of wss.clients) {
      sendSocketMessage(ws, { type: "server-shutdown" });
      ws.close(1012, "Server shutting down");
    }

    const forceExitTimer = setTimeout(() => {
      console.error("Forced shutdown after grace period");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    server.close(async (error) => {
      clearTimeout(forceExitTimer);
      clearInterval(redisCleanup);
      clearInterval(wsPingInterval);

      if (redisClients) {
        await Promise.allSettled([
          redisClients.subscriberClient.quit(),
          redisClients.publisherClient.quit(),
          redisClients.commandClient.quit()
        ]);
      }

      if (error) {
        console.error("Shutdown error", error);
        process.exit(1);
        return;
      }

      process.exit(0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Failed to start VoiceAI", error);
  process.exit(1);
});
