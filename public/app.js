if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister().catch(() => {});
    }
  }).catch(() => {});
}

if ("caches" in window) {
  caches.keys().then((keys) => {
    for (const key of keys) {
      caches.delete(key).catch(() => {});
    }
  }).catch(() => {});
}

// ── Unsupported in-app browser gate ───────────────────────────────
// Telegram (and friends) ship a stripped-down WebView that can't run
// WebRTC voice calls reliably. Detect → block UI → ask user to open
// the link in their real browser. Runs before mic init so we never
// prompt for microphone in a browser that can't use it.
function detectUnsupportedInAppBrowser() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return null;
  }
  const ua = String(navigator.userAgent || "");
  const hash = String(window.location.hash || "");
  const search = String(window.location.search || "");

  // Telegram in-app browser / Mini App
  if (
    /Telegram(?:WebView|Bot)?/i.test(ua) ||
    (window.Telegram && window.Telegram.WebApp) ||
    /tgWebApp(?:Data|Version|Platform|StartParam)/i.test(hash + search)
  ) {
    return { name: "Telegram", label: "Telegram's in-app browser" };
  }

  // Facebook / Instagram / Messenger WebViews — same WebRTC issues
  if (/\bFBAN\/|\bFBAV\/|\bFB_IAB\b/i.test(ua)) {
    return { name: "Facebook", label: "Facebook's in-app browser" };
  }
  if (/\bInstagram\b/i.test(ua)) {
    return { name: "Instagram", label: "Instagram's in-app browser" };
  }
  if (/\bLine\//i.test(ua)) {
    return { name: "Line", label: "Line's in-app browser" };
  }

  return null;
}

(function gateUnsupportedBrowsers() {
  const detected = detectUnsupportedInAppBrowser();
  if (!detected) return;

  const block = document.getElementById("browser-block");
  const precallEl = document.getElementById("precall");
  const callEl = document.querySelector(".call");
  const appLabel = document.getElementById("browser-block-app");
  const copyBtn = document.getElementById("browser-block-copy");
  const copyLabel = document.getElementById("browser-block-copy-label");

  if (appLabel) {
    appLabel.textContent = detected.label;
  }
  if (block) {
    block.hidden = false;
  }
  if (precallEl) {
    precallEl.style.display = "none";
  }
  if (callEl) {
    callEl.style.display = "none";
  }

  if (copyBtn && copyLabel) {
    copyBtn.addEventListener("click", async () => {
      const url = window.location.href;
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (!copied) {
        // Manual fallback for WebViews where clipboard API is denied
        try {
          const ta = document.createElement("textarea");
          ta.value = url;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          copied = true;
        } catch {
          copied = false;
        }
      }
      copyLabel.textContent = copied ? "Link copied" : "Copy failed";
      copyBtn.classList.toggle("is-copied", copied);
      setTimeout(() => {
        copyLabel.textContent = "Copy link";
        copyBtn.classList.remove("is-copied");
      }, 2400);
    });
  }

  // Hard-stop the rest of the script — no mic prompt, no socket setup,
  // no WebRTC bring-up. The user can't make a call here regardless.
  throw new Error("BeyondVoice: blocked unsupported in-app browser (" + detected.name + ")");
})();

const roomInput = document.querySelector("#room-input");
const nameInput = document.querySelector("#name-input");
const opusModeSelect = document.querySelector("#opus-mode-select");
const opusModeDetails = document.querySelector("#opus-mode-details");
const joinForm = document.querySelector("#join-form");
const joinButton = document.querySelector("#join-button");
const leaveButton = document.querySelector("#leave-button");
const muteButton = document.querySelector("#mute-button");
const reconnectButton = document.querySelector("#reconnect-button");
const clearLogButton = document.querySelector("#clear-log-button");
const micBadge = document.querySelector("#mic-badge");
const micSummary = document.querySelector("#mic-summary");
const micDetails = document.querySelector("#mic-details");
const localParticipantName = document.querySelector("#local-participant-name");
const remoteAudio = document.querySelector("#remote-audio");
const localAudio = document.querySelector("#local-audio");
const statusText = document.querySelector("#status-text");
const roleText = document.querySelector("#role-text");
const peerText = document.querySelector("#peer-text");
const roomText = document.querySelector("#room-text");
const rttText = document.querySelector("#rtt-text");
const jitterText = document.querySelector("#jitter-text");
const lossText = document.querySelector("#loss-text");
const bitrateText = document.querySelector("#bitrate-text");
const transportModeText = document.querySelector("#transport-mode-text");
const headerText = document.querySelector("#header-text");
const bufferText = document.querySelector("#buffer-text");
const plcText = document.querySelector("#plc-text");
const vocoderText = document.querySelector("#vocoder-text");
const logOutput = document.querySelector("#log-output");
const peerContexts = new Map();

const state = {
  roomId: "",
  participantId: "",
  displayName: "",
  role: "",
  peerId: "",
  peerName: "",
  iceServers: null,
  joined: false,
  muted: false,
  localStream: null,
  remoteStream: null,
  signalingSocket: null,
  signalingConnected: false,
  pollAbortController: null,
  polling: false,
  statsIntervalId: null,
  heartbeatIntervalId: null,
  signalingReconnectTimerId: null,
  signalingReconnectAttempts: 0,
  autoRejoinInFlight: false,
  micPermissionState: "unknown",
  micPermissionStatus: null,
  opusMode: "balanced",
  audioProfile: "lean"
};

const DEFAULT_ICE_SERVERS = window.APP_CONFIG?.iceServers || [
  { urls: ["stun:stun.l.google.com:19302"] }
];

const PROFILE_SWITCH_COOLDOWN_MS = 5000;
let lastProfileSwitchAt = 0;

const OPUS_MODE_STORAGE_KEY = "voiceai.opusMode";
const OPUS_MODES = {
  saver: {
    label: "Data Saver",
    details: "Lowest bandwidth. Best for mobile data and weak connections.",
    defaultProfile: "tight",
    profiles: {
      lean: {
        label: "Lean",
        maxBitrate: 24000,
        maxAverageBitrate: 24000,
        maxPlaybackRate: 16000,
        ptime: 20
      },
      tight: {
        label: "Tight",
        maxBitrate: 18000,
        maxAverageBitrate: 18000,
        maxPlaybackRate: 12000,
        ptime: 20
      },
      ultra: {
        label: "Ultra",
        maxBitrate: 12000,
        maxAverageBitrate: 12000,
        maxPlaybackRate: 12000,
        ptime: 40
      },
      extreme: {
        label: "Extreme",
        maxBitrate: 8000,
        maxAverageBitrate: 8000,
        maxPlaybackRate: 8000,
        ptime: 60
      }
    }
  },
  balanced: {
    label: "Balanced",
    details: "Good speech quality without using too much bandwidth.",
    defaultProfile: "lean",
    profiles: {
      lean: {
        label: "Lean",
        maxBitrate: 32000,
        maxAverageBitrate: 32000,
        maxPlaybackRate: 24000,
        ptime: 20
      },
      tight: {
        label: "Tight",
        maxBitrate: 24000,
        maxAverageBitrate: 24000,
        maxPlaybackRate: 16000,
        ptime: 20
      },
      ultra: {
        label: "Ultra",
        maxBitrate: 16000,
        maxAverageBitrate: 16000,
        maxPlaybackRate: 12000,
        ptime: 40
      },
      extreme: {
        label: "Extreme",
        maxBitrate: 9000,
        maxAverageBitrate: 9000,
        maxPlaybackRate: 8000,
        ptime: 60
      }
    }
  },
  quality: {
    label: "High Quality",
    details: "Uses more data to keep fuller, cleaner speech on good networks.",
    defaultProfile: "lean",
    profiles: {
      lean: {
        label: "Lean",
        maxBitrate: 48000,
        maxAverageBitrate: 48000,
        maxPlaybackRate: 32000,
        ptime: 20
      },
      tight: {
        label: "Tight",
        maxBitrate: 36000,
        maxAverageBitrate: 36000,
        maxPlaybackRate: 24000,
        ptime: 20
      },
      ultra: {
        label: "Ultra",
        maxBitrate: 24000,
        maxAverageBitrate: 24000,
        maxPlaybackRate: 16000,
        ptime: 20
      },
      extreme: {
        label: "Extreme",
        maxBitrate: 12000,
        maxAverageBitrate: 12000,
        maxPlaybackRate: 12000,
        ptime: 40
      }
    }
  }
};

function normalizeOpusMode(mode) {
  return Object.prototype.hasOwnProperty.call(OPUS_MODES, mode) ? mode : "balanced";
}

function readStoredOpusMode() {
  try {
    return normalizeOpusMode(window.localStorage?.getItem(OPUS_MODE_STORAGE_KEY) || "balanced");
  } catch {
    return "balanced";
  }
}

function writeStoredOpusMode(mode) {
  try {
    window.localStorage?.setItem(OPUS_MODE_STORAGE_KEY, normalizeOpusMode(mode));
  } catch {
    // ignore — best-effort
  }
}

function getOpusModeConfig(mode = state.opusMode) {
  return OPUS_MODES[normalizeOpusMode(mode)] || OPUS_MODES.balanced;
}

function getDefaultAudioProfileForMode(mode = state.opusMode) {
  return getOpusModeConfig(mode).defaultProfile;
}

function syncOpusModeUi() {
  const config = getOpusModeConfig();
  if (opusModeSelect) {
    opusModeSelect.value = state.opusMode;
  }
  if (opusModeDetails) {
    opusModeDetails.textContent = config.details;
  }
}

function applyOpusMode(mode, { persist = true, resetProfile = true } = {}) {
  state.opusMode = normalizeOpusMode(mode);
  if (persist) {
    writeStoredOpusMode(state.opusMode);
  }
  if (resetProfile) {
    state.audioProfile = getDefaultAudioProfileForMode(state.opusMode);
  }
  syncOpusModeUi();
}

// Buffered client→server log forwarder so both peers' logs land in the
// server's docker logs in real time. Avoids the manual copy/paste loop.
const REMOTE_LOG_BATCH_MS = 2000;
const REMOTE_LOG_MAX_BATCH = 64;
const remoteLogBuffer = [];
let remoteLogTimer = null;

function remoteDebugLogsEnabled() {
  return Boolean(window.APP_CONFIG?.enableRemoteDebugLogs);
}

function flushRemoteLogs() {
  remoteLogTimer = null;
  if (!remoteDebugLogsEnabled()) {
    remoteLogBuffer.length = 0;
    return;
  }
  if (remoteLogBuffer.length === 0) {
    return;
  }
  const batch = remoteLogBuffer.splice(0, remoteLogBuffer.length);
  try {
    fetch("/api/debug/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        peer: state.participantId || "",
        room: state.roomId || "",
        ua: navigator.userAgent || "",
        entries: batch
      })
    }).catch(() => {});
  } catch {
    // ignore — best-effort
  }
}

function scheduleRemoteLogFlush() {
  if (!remoteDebugLogsEnabled()) {
    remoteLogBuffer.length = 0;
    return;
  }
  if (remoteLogTimer) {
    return;
  }
  if (remoteLogBuffer.length >= REMOTE_LOG_MAX_BATCH) {
    flushRemoteLogs();
    return;
  }
  remoteLogTimer = setTimeout(flushRemoteLogs, REMOTE_LOG_BATCH_MS);
}

function log(message, extra = null) {
  const timestamp = new Date().toLocaleTimeString();
  const line = extra
    ? `[${timestamp}] ${message} ${JSON.stringify(extra)}`
    : `[${timestamp}] ${message}`;
  if (logOutput) {
    logOutput.textContent = `${line}\n${logOutput.textContent}`.trim();
  }
  if (remoteDebugLogsEnabled()) {
    remoteLogBuffer.push({ message, context: extra });
    scheduleRemoteLogFlush();
  }
}

const STATUS_PILL_KIND = {
  idle: "idle",
  connected: "connected",
  connecting: "connecting",
  negotiating: "negotiating",
  reconnecting: "reconnecting",
  rejoining: "reconnecting",
  waiting: "waiting",
  failed: "failed"
};

function statusKindFor(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.startsWith("connected")) return STATUS_PILL_KIND.connected;
  if (lower.startsWith("connecting")) return STATUS_PILL_KIND.connecting;
  if (lower.startsWith("negotiating")) return STATUS_PILL_KIND.negotiating;
  if (lower.startsWith("reconnecting")) return STATUS_PILL_KIND.reconnecting;
  if (lower.startsWith("rejoining")) return STATUS_PILL_KIND.reconnecting;
  if (lower.startsWith("waiting")) return STATUS_PILL_KIND.waiting;
  if (lower.includes("fail")) return STATUS_PILL_KIND.failed;
  return STATUS_PILL_KIND.idle;
}

function updateStatus(text) {
  if (statusText) {
    statusText.textContent = text;
  }
  const pill = document.querySelector(".status-pill");
  if (pill) {
    pill.dataset.status = statusKindFor(text);
  }
}

function getPeerContexts() {
  return Array.from(peerContexts.values())
    .sort((left, right) => left.id.localeCompare(right.id));
}

function ensureRemotePlaybackStream() {
  if (!state.remoteStream) {
    state.remoteStream = new MediaStream();
  }
  if (remoteAudio && remoteAudio.srcObject !== state.remoteStream) {
    remoteAudio.srcObject = state.remoteStream;
  }
  return state.remoteStream;
}

function attachTrackToPeer(context, track) {
  if (!context || !track) {
    return;
  }

  const remoteStream = ensureRemotePlaybackStream();
  if (!context.remoteTrackIds.has(track.id)) {
    context.remoteTrackIds.add(track.id);
  }
  if (!remoteStream.getTracks().some((item) => item.id === track.id)) {
    remoteStream.addTrack(track);
  }
}

function detachTrackFromPeer(context, track) {
  if (!context || !track || !state.remoteStream) {
    return;
  }

  if (context.remoteTrackIds.has(track.id)) {
    context.remoteTrackIds.delete(track.id);
  }

  const attachedTrack = state.remoteStream.getTracks().find((item) => item.id === track.id);
  if (attachedTrack) {
    state.remoteStream.removeTrack(attachedTrack);
  }
}

function ensurePeerContext(peerId, displayName = "") {
  const normalizedPeerId = String(peerId || "").trim();
  if (!normalizedPeerId || normalizedPeerId === state.participantId) {
    return null;
  }

  let context = peerContexts.get(normalizedPeerId);
  if (!context) {
    context = {
      id: normalizedPeerId,
      displayName: displayName || normalizedPeerId,
      connection: null,
      remoteTrackIds: new Set(),
      pendingCandidates: [],
      candidateBatch: [],
      candidateFlushTimerId: null,
      reconnectTimerId: null,
      lastInboundBytes: 0,
      lastStatsAt: 0
    };
    peerContexts.set(normalizedPeerId, context);
  } else if (displayName) {
    context.displayName = displayName;
  }

  return context;
}

function clearPeerTimers(context) {
  if (!context) {
    return;
  }
  if (context.candidateFlushTimerId) {
    clearTimeout(context.candidateFlushTimerId);
    context.candidateFlushTimerId = null;
  }
  if (context.reconnectTimerId) {
    clearTimeout(context.reconnectTimerId);
    context.reconnectTimerId = null;
  }
}

function syncPeerSummary() {
  const peers = getPeerContexts();
  if (peers.length === 0) {
    state.peerId = "";
    state.peerName = "";
    return;
  }

  state.peerId = peers[0].id;
  if (peers.length === 1) {
    state.peerName = peers[0].displayName || peers[0].id;
    return;
  }

  state.peerName = `${peers.length} participants`;
}

function getPeerContext(peerId) {
  return peerContexts.get(String(peerId || "").trim()) || null;
}

function clearPeerRemoteStream(context) {
  if (!context?.remoteTrackIds?.size || !state.remoteStream) {
    return;
  }
  for (const track of state.remoteStream.getTracks()) {
    if (context.remoteTrackIds.has(track.id)) {
      state.remoteStream.removeTrack(track);
    }
  }
  context.remoteTrackIds.clear();
}

function getPeerConnections() {
  return getPeerContexts()
    .map((context) => context.connection)
    .filter(Boolean);
}

function shouldInitiateOfferForPeer(peerId) {
  const normalizedPeerId = String(peerId || "").trim();
  return Boolean(
    state.joined &&
      state.participantId &&
      normalizedPeerId &&
      state.participantId.localeCompare(normalizedPeerId) < 0
  );
}

function updateStatusFromPeerConnections() {
  const contexts = getPeerContexts();
  if (!state.joined) {
    updateStatus("Idle");
    return;
  }
  if (contexts.length === 0) {
    updateStatus("Waiting for participants");
    return;
  }

  const states = contexts.map((context) => context.connection?.connectionState || "new");
  if (states.every((value) => value === "connected")) {
    updateStatus("Connected");
    return;
  }
  if (states.some((value) => value === "failed" || value === "disconnected")) {
    updateStatus("Reconnecting");
    return;
  }
  if (states.some((value) => value === "connecting")) {
    updateStatus("Connecting");
    return;
  }
  updateStatus("Negotiating");
}

function destroyPeerContext(peerId) {
  const context = peerContexts.get(peerId);
  if (!context) {
    return;
  }

  clearPeerTimers(context);

  if (context.connection) {
    context.connection.onicecandidate = null;
    context.connection.ontrack = null;
    context.connection.onconnectionstatechange = null;
    context.connection.oniceconnectionstatechange = null;
    context.connection.ondatachannel = null;
    context.connection.close();
    context.connection = null;
  }

  clearPeerRemoteStream(context);

  peerContexts.delete(peerId);
}

function initialLetterFor(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "·";
  const ch = trimmed.charAt(0);
  return /[a-z0-9]/i.test(ch) ? ch.toUpperCase() : "·";
}

function ensureRemoteTile(peerId, displayName) {
  const grid = document.getElementById("stage-grid");
  if (!grid) return null;
  const safeId = peerId.replace(/[^a-z0-9_-]/gi, "");
  let tile = grid.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
  if (!tile) {
    tile = document.createElement("article");
    tile.className = "tile tile-remote";
    tile.dataset.peerId = peerId;
    tile.innerHTML = `
      <div class="tile-halo"></div>
      <div class="tile-body">
        <div class="tile-avatar">
          <span class="tile-initial">${initialLetterFor(displayName || peerId)}</span>
        </div>
        <div class="tile-meta">
          <span class="tile-name"></span>
          <span class="tile-role">Remote</span>
        </div>
      </div>
      <div class="tile-flags">
        <span class="tile-flag tile-flag-mute" aria-label="Muted" title="Muted">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="1" y1="1" x2="23" y2="23"/>
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
          </svg>
        </span>
      </div>
    `;
    grid.appendChild(tile);
  }
  const nameLabel = tile.querySelector(".tile-name");
  const initial = tile.querySelector(".tile-initial");
  const friendly = displayName || peerId;
  if (nameLabel) nameLabel.textContent = friendly;
  if (initial) initial.textContent = initialLetterFor(friendly);
  return tile;
}

function renderParticipantTiles() {
  const grid = document.getElementById("stage-grid");
  if (!grid) return;

  const localTile = grid.querySelector(".tile-local");
  const peers = getPeerContexts();

  // Local tile: reflect joined + muted state
  if (localTile) {
    const localInitial = localTile.querySelector("#local-initial");
    if (localInitial) {
      localInitial.textContent = initialLetterFor(state.displayName);
    }
    localTile.classList.toggle("is-live", Boolean(state.joined));
    localTile.classList.toggle("is-muted", Boolean(state.muted));
  }

  // Reconcile remote tiles
  const wantIds = new Set(peers.map((p) => p.id));
  const existing = grid.querySelectorAll(".tile-remote");
  existing.forEach((tile) => {
    const id = tile.dataset.peerId;
    if (!wantIds.has(id)) {
      tile.classList.add("is-leaving");
      // Remove after exit animation so count updates cleanly
      setTimeout(() => tile.remove(), 200);
    }
  });

  peers.forEach((peer) => {
    const tile = ensureRemoteTile(peer.id, peer.displayName);
    if (!tile) return;
    const connState = peer.connection?.connectionState || "new";
    tile.classList.toggle("is-live", connState === "connected");
  });

  // Update tile count (local + peers that are not being removed)
  const aliveCount = 1 + peers.length;
  grid.dataset.count = String(Math.min(aliveCount, 12));
}

function updatePeerDisplay() {
  syncPeerSummary();
  if (peerText) {
    if (!state.joined) {
      peerText.textContent = "Waiting";
    } else if (peerContexts.size === 0) {
      peerText.textContent = "Alone";
    } else if (peerContexts.size === 1) {
      peerText.textContent = state.peerName || "1 peer";
    } else {
      peerText.textContent = `${peerContexts.size} peers`;
    }
  }
  renderParticipantTiles();
}

function setCtrlButtonLabel(button, label) {
  if (!button) return;
  const labelEl = button.querySelector(".ctrl-label");
  if (labelEl) labelEl.textContent = label;
}

function updateControls() {
  const joinBlocked =
    !state.joined &&
    !window.isSecureContext &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";

  if (joinButton) {
    joinButton.disabled = state.joined || joinBlocked;
  }
  if (leaveButton) {
    leaveButton.disabled = !state.joined;
  }
  if (muteButton) {
    muteButton.disabled = !state.joined || !state.localStream;
    muteButton.classList.toggle("is-active", Boolean(state.muted));
    muteButton.setAttribute("aria-pressed", state.muted ? "true" : "false");
    setCtrlButtonLabel(muteButton, state.muted ? "Unmute" : "Mute");
  }
  if (reconnectButton) {
    reconnectButton.disabled = !state.joined || peerContexts.size === 0;
  }
  if (roleText) {
    roleText.textContent = state.role || "—";
  }
  if (roomText) {
    roomText.textContent = state.roomId || "—";
  }
  if (localParticipantName) {
    localParticipantName.textContent = state.displayName || "You";
  }
  updatePeerDisplay();
}

// Prime <audio>.play() for remote playback. Browsers (especially iOS Safari)
// only allow play() inside a synchronous user-gesture stack — by the time a
// remote WebRTC track arrives via ontrack, the gesture is gone, so we have to
// prime the element earlier (from the Join click handler) and rely on
// auto-resume when tracks are added to the already-playing srcObject. This is
// also called from ontrack as a no-op fallback in case the prime succeeded.
function primeRemoteAudio() {
  ensureRemotePlaybackStream();
  if (!remoteAudio) {
    return;
  }
  try {
    const result = remoteAudio.play();
    if (result && typeof result.catch === "function") {
      result.catch((error) => {
        log("Remote audio autoplay deferred", { message: error.message });
      });
    }
  } catch (error) {
    log("Remote audio autoplay deferred", { message: error.message });
  }
}

function setMicStatus(kind, summary, details) {
  state.micPermissionStatus = kind;
  if (micBadge) {
    micBadge.className = `mic-badge mic-badge-${kind}`;
    micBadge.textContent =
      kind === "ready"
        ? "Ready"
        : kind === "warning"
          ? "Attention"
          : kind === "blocked"
            ? "Blocked"
            : "Checking";
  }
  if (micSummary) {
    micSummary.textContent = summary;
  }
  if (micDetails) {
    micDetails.textContent = details;
  }
  updateControls();
}

function buildDeviceSpecificGuidance() {
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  if (isIos) {
    return "On iPhone or iPad, open the trusted HTTPS page in Safari, accept the certificate if needed, then allow Microphone access when prompted.";
  }

  if (isSafari) {
    return "In Safari, confirm the site is trusted, then allow Microphone for this page in the browser prompt or Website Settings.";
  }

  return "Use a trusted HTTPS page, then allow Microphone when the browser prompt appears. If you denied it earlier, re-enable it in the browser site settings.";
}

function isSafariFamilyBrowser() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent || "");
}

function describeAudioTrack(track) {
  if (!track) {
    return null;
  }

  let settings = null;
  try {
    settings = typeof track.getSettings === "function" ? track.getSettings() : null;
  } catch {
    settings = null;
  }

  return {
    id: track.id || "",
    label: track.label || "",
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    settings
  };
}

function getMicBlockedReason(error) {
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        status: "blocked",
        summary: "Microphone access was denied.",
        details:
          "Allow Microphone for this site in the browser settings, then reload and try again."
      };
    case "NotFoundError":
      return {
        status: "blocked",
        summary: "No microphone was found on this device.",
        details:
          "Connect a microphone or switch to a device that has one, then retry."
      };
    case "NotReadableError":
      return {
        status: "warning",
        summary: "The microphone is busy or unavailable.",
        details:
          "Close other apps that may be using the microphone, then retry."
      };
    case "OverconstrainedError":
      return {
        status: "warning",
        summary: "This device rejected the requested audio settings.",
        details:
          "Retry on the same device or another browser. The microphone exists, but the requested capture profile was not accepted."
      };
    default:
      return {
        status: "warning",
        summary: "The browser did not grant microphone access.",
        details: `${buildDeviceSpecificGuidance()} Error: ${error?.message || "unknown microphone failure"}.`
      };
  }
}

async function refreshMicPermissionState() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicStatus(
      "blocked",
      "This browser does not support microphone capture for WebRTC.",
      "Use a current version of Safari, Chrome, Edge, or Firefox."
    );
    return "unsupported";
  }

  if (
    !window.isSecureContext &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    setMicStatus(
      "blocked",
      "This page is not in a secure context, so the browser will not expose the microphone.",
      "Open the app over trusted HTTPS. Raw HTTP on a LAN IP will not reliably get microphone permission."
    );
    return "blocked";
  }

  if (!navigator.permissions?.query) {
    if (state.localStream) {
      setMicStatus(
        "ready",
        "Microphone access is active on this device.",
        "You can join or stay in the room. If audio stops later, refresh the page and allow the microphone again."
      );
      return "granted";
    }

    setMicStatus(
      "pending",
      "The browser will ask for microphone access when you tap Join.",
      buildDeviceSpecificGuidance()
    );
    return "prompt";
  }

  try {
    const permission = await navigator.permissions.query({ name: "microphone" });
    state.micPermissionState = permission.state;

    permission.onchange = () => {
      refreshMicPermissionState().catch((error) => {
        log("Microphone permission refresh failed", { message: error.message });
      });
    };

    if (permission.state === "granted" || state.localStream) {
      setMicStatus(
        "ready",
        "Microphone access is available on this device.",
        "You can join the room immediately."
      );
      return "granted";
    }

    if (permission.state === "denied") {
      setMicStatus(
        "blocked",
        "Microphone access is currently denied for this site.",
        "Re-enable Microphone in the browser's site settings, then reload this page."
      );
      return "denied";
    }

    setMicStatus(
      "pending",
      "The browser is ready to ask for microphone access.",
      "Tap Join to trigger the permission prompt."
    );
    return permission.state;
  } catch (error) {
    setMicStatus(
      "pending",
      "This browser does not expose microphone permission state in advance.",
      buildDeviceSpecificGuidance()
    );
    return "prompt";
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    cache: "no-store",
    ...options
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function ensureLocalAudio() {
  if (state.localStream) {
    localAudio.srcObject = state.localStream;
    setMicStatus(
      "ready",
      "Microphone access is active on this device.",
      "You can stay in the room or reconnect without another permission prompt."
    );
    return state.localStream;
  }

  await refreshMicPermissionState();

  try {
    // Do NOT force sampleRate/channelCount/sampleSize constraints.
    // Safari is more reliable when we avoid forcing capture formats and keep
    // echo cancellation off. Other browsers still get noise suppression.
    const safariFamily = isSafariFamilyBrowser();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: !safariFamily,
        noiseSuppression: true,
        autoGainControl: false
      },
      video: false
    });

    state.localStream = stream;
    localAudio.srcObject = stream;
    setMicStatus(
      "ready",
      "Microphone access is active on this device.",
      "The browser granted access and the app can now join calls."
    );
    updateControls();
    log("Local microphone captured", {
      safariFamily,
      track: describeAudioTrack(stream.getAudioTracks()[0] || null)
    });
    return stream;
  } catch (error) {
    const guidance = getMicBlockedReason(error);
    setMicStatus(guidance.status, guidance.summary, guidance.details);
    throw error;
  }
}

function stopLocalAudio() {
  if (!state.localStream) {
    return;
  }

  for (const track of state.localStream.getTracks()) {
    track.stop();
  }

  state.localStream = null;
  localAudio.srcObject = null;
  refreshMicPermissionState().catch((error) => {
    log("Microphone permission refresh failed", { message: error.message });
  });
}

function resetRemoteAudio() {
  const remoteStream = ensureRemotePlaybackStream();
  for (const peerId of Array.from(peerContexts.keys())) {
    destroyPeerContext(peerId);
  }
  for (const track of remoteStream.getTracks()) {
    remoteStream.removeTrack(track);
  }
  updatePeerDisplay();
  updateStatusFromPeerConnections();
  updateControls();
}

function buildWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsPath = window.APP_CONFIG?.wsPath || "/ws";
  return `${protocol}//${window.location.host}${wsPath}`;
}

function closeSignalingSocket() {
  if (state.signalingSocket) {
    state.signalingSocket.onopen = null;
    state.signalingSocket.onmessage = null;
    state.signalingSocket.onclose = null;
    state.signalingSocket.onerror = null;

    try {
      state.signalingSocket.close();
    } catch (error) {
      log("Signaling socket close skipped", { message: error.message });
    }
  }

  state.signalingSocket = null;
  state.signalingConnected = false;
}

function closePeerConnection() {
  for (const context of getPeerContexts()) {
    clearPeerTimers(context);
    if (context.connection) {
      context.connection.onicecandidate = null;
      context.connection.ondatachannel = null;
      context.connection.ontrack = null;
      context.connection.onconnectionstatechange = null;
      context.connection.oniceconnectionstatechange = null;
      context.connection.close();
      context.connection = null;
    }
    clearPeerRemoteStream(context);
    context.pendingCandidates = [];
    context.lastInboundBytes = 0;
    context.lastStatsAt = 0;
  }
}

function cleanupIntervals() {
  if (state.statsIntervalId) {
    clearInterval(state.statsIntervalId);
    state.statsIntervalId = null;
  }

  if (state.heartbeatIntervalId) {
    clearInterval(state.heartbeatIntervalId);
    state.heartbeatIntervalId = null;
  }

  for (const context of getPeerContexts()) {
    clearPeerTimers(context);
  }

  if (state.signalingReconnectTimerId) {
    clearTimeout(state.signalingReconnectTimerId);
    state.signalingReconnectTimerId = null;
  }

  state.signalingReconnectAttempts = 0;
}

function resetStatsDisplay() {
  if (rttText) {
    rttText.textContent = "-";
  }
  if (jitterText) {
    jitterText.textContent = "-";
  }
  if (lossText) {
    lossText.textContent = "-";
  }
  if (bitrateText) {
    bitrateText.textContent = "-";
  }
  updateAudioDiagnostics();
}

function updateAudioDiagnostics() {
  if (transportModeText) {
    transportModeText.textContent = "Opus · WebRTC";
  }
  if (headerText) {
    headerText.textContent = `${getActiveAudioProfile().ptime} ms`;
  }
  if (bufferText) {
    bufferText.textContent = `${getOpusModeConfig().label} · ${getActiveAudioProfile().label}`;
  }
  if (plcText) {
    plcText.textContent = "FEC + DTX";
  }
  if (vocoderText) {
    vocoderText.textContent = "Opus 48 kHz";
  }
}

function resetCallState({ preserveLog = true } = {}) {
  state.peerId = "";
  state.peerName = "";
  state.joined = false;
  state.autoRejoinInFlight = false;
  state.role = "";
  state.roomId = "";
  state.participantId = "";
  state.displayName = "";
  state.iceServers = null;
  state.muted = false;
  state.audioProfile = getDefaultAudioProfileForMode(state.opusMode);

  if (state.pollAbortController) {
    state.pollAbortController.abort();
    state.pollAbortController = null;
  }

  cleanupIntervals();
  closeSignalingSocket();
  closePeerConnection();
  stopLocalAudio();
  resetRemoteAudio();
  resetStatsDisplay();
  updateStatus("Idle");
  updateControls();

  if (!preserveLog) {
    logOutput.textContent = "";
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getActiveAudioProfile() {
  const opusMode = getOpusModeConfig();
  return opusMode.profiles[state.audioProfile] || opusMode.profiles[opusMode.defaultProfile];
}

function updateAudioSectionAttribute(section, attribute, value) {
  const regex = new RegExp(`^a=${attribute}:\\d+$`, "m");
  if (regex.test(section)) {
    return section.replace(regex, `a=${attribute}:${value}`);
  }

  // Insert before any trailing newline(s) so we don't create a blank line
  // in the SDP body when the audio section is the last m-section.
  const trailing = section.match(/(\r?\n)+$/);
  if (trailing) {
    return `${section.slice(0, -trailing[0].length)}\r\na=${attribute}:${value}${trailing[0]}`;
  }
  return `${section}\r\na=${attribute}:${value}`;
}

function tuneAudioPacketization(sdp, ptime) {
  if (!sdp || !ptime) {
    return sdp;
  }

  const sections = sdp.split(/\r\n(?=m=)/);
  return sections
    .map((section) => {
      if (!section.startsWith("m=audio ")) {
        return section;
      }

      let tuned = updateAudioSectionAttribute(section, "ptime", ptime);
      tuned = updateAudioSectionAttribute(tuned, "maxptime", ptime);
      return tuned;
    })
    .join("\r\n");
}

function preferRedForOpus(sdp) {
  if (!sdp) {
    return sdp;
  }

  const sections = sdp.split(/\r\n(?=m=)/);
  return sections
    .map((section) => {
      if (!section.startsWith("m=audio ")) {
        return section;
      }

      const opusMatch = section.match(/^a=rtpmap:(\d+) opus\/48000\/2$/m);
      if (!opusMatch) {
        return section;
      }

      const opusPayloadType = opusMatch[1];
      const redPayloadTypes = Array.from(section.matchAll(/^a=rtpmap:(\d+) red\/48000\/2$/gm))
        .map((match) => match[1])
        .filter((payloadType) => {
          const fmtpMatch = section.match(
            new RegExp(`^a=fmtp:${escapeRegex(payloadType)}\\s+(.+)$`, "m")
          );
          if (!fmtpMatch) {
            return false;
          }
          return fmtpMatch[1]
            .split(";")
            .map((part) => part.trim())
            .includes(`apt=${opusPayloadType}`);
        });

      if (redPayloadTypes.length === 0) {
        return section;
      }

      return section.replace(
        /^m=audio\s+(\d+)\s+([A-Z0-9/]+)\s+(.+)$/m,
        (line, port, protocol, payloadList) => {
          const payloadTypes = payloadList.trim().split(/\s+/);
          if (!payloadTypes.includes(opusPayloadType)) {
            return line;
          }

          const preferred = redPayloadTypes.filter((payloadType) => payloadTypes.includes(payloadType));
          if (preferred.length === 0) {
            return line;
          }

          const preferredSet = new Set([...preferred, opusPayloadType]);
          const reordered = [
            ...preferred,
            opusPayloadType,
            ...payloadTypes.filter((payloadType) => !preferredSet.has(payloadType))
          ];
          return `m=audio ${port} ${protocol} ${reordered.join(" ")}`;
        }
      );
    })
    .join("\r\n");
}

function tuneOpusInSdp(sdp) {
  if (!sdp) {
    return sdp;
  }

  const audioMatch = sdp.match(/^a=rtpmap:(\d+) opus\/48000\/2$/m);
  if (!audioMatch) {
    return sdp;
  }

  const payloadType = audioMatch[1];
  const fmtpRegex = new RegExp(`^a=fmtp:${escapeRegex(payloadType)}\\s+(.+)$`, "m");
  const fmtpMatch = sdp.match(fmtpRegex);
  const activeProfile = getActiveAudioProfile();
  const desiredParams = [
    "minptime=10",
    "useinbandfec=1",
    "usedtx=1",
    "cbr=0",
    "stereo=0",
    "sprop-stereo=0",
    `maxaveragebitrate=${activeProfile.maxAverageBitrate}`,
    `maxplaybackrate=${activeProfile.maxPlaybackRate}`
  ];

  if (fmtpMatch) {
    const existing = fmtpMatch[1]
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    const merged = new Map();

    for (const item of existing) {
      const [key, value = ""] = item.split("=");
      merged.set(key, value);
    }

    for (const item of desiredParams) {
      const [key, value = ""] = item.split("=");
      merged.set(key, value);
    }

    const value = Array.from(merged.entries())
      .map(([key, item]) => `${key}=${item}`)
      .join(";");

    sdp = sdp.replace(fmtpRegex, `a=fmtp:${payloadType} ${value}`);
  }

  return tuneAudioPacketization(preferRedForOpus(sdp), activeProfile.ptime);
}

async function applySenderParameters() {
  const contexts = getPeerContexts().filter((context) => context.connection);
  if (contexts.length === 0) {
    return;
  }

  const activeProfile = getActiveAudioProfile();
  for (const context of contexts) {
    const sender = context.connection
      .getSenders()
      .find((item) => item.track && item.track.kind === "audio");

    if (!sender || typeof sender.getParameters !== "function") {
      continue;
    }

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }

    params.encodings[0].maxBitrate = activeProfile.maxBitrate;
    params.encodings[0].networkPriority = "high";

    try {
      await sender.setParameters(params);
    } catch (error) {
      log("Sender parameter tuning skipped", {
        peerId: context.id,
        message: error.message
      });
    }
  }

  log("Audio compression profile applied", {
    profile: state.audioProfile,
    bitrate: activeProfile.maxBitrate,
    peers: contexts.length
  });
}

function pickAudioProfile({
  packetsLost,
  jitterMs,
  rttMs,
  availableOutgoingBitrateKbps
}) {
  if (
    packetsLost == null &&
    jitterMs == null &&
    rttMs == null &&
    availableOutgoingBitrateKbps == null
  ) {
    return "lean";
  }

  if (
    (typeof packetsLost === "number" && packetsLost > 12) ||
    (typeof jitterMs === "number" && jitterMs >= 120) ||
    (typeof rttMs === "number" && rttMs >= 700) ||
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps > 0 &&
      availableOutgoingBitrateKbps <= 10)
  ) {
    return "extreme";
  }

  if (
    (typeof packetsLost === "number" && packetsLost > 6) ||
    (typeof jitterMs === "number" && jitterMs >= 60) ||
    (typeof rttMs === "number" && rttMs >= 400) ||
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps > 0 &&
      availableOutgoingBitrateKbps <= 14)
  ) {
    return "ultra";
  }

  if (
    (typeof packetsLost === "number" && packetsLost > 2) ||
    (typeof jitterMs === "number" && jitterMs >= 30) ||
    (typeof rttMs === "number" && rttMs >= 250) ||
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps > 0 &&
      availableOutgoingBitrateKbps <= 24)
  ) {
    return "tight";
  }

  if (
    (typeof packetsLost === "number" && packetsLost <= 1) &&
    (typeof jitterMs !== "number" || jitterMs < 18) &&
    (typeof rttMs !== "number" || rttMs < 160) &&
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps >= 32)
  ) {
    return "lean";
  }

  return "tight";
}

async function adaptAudioCompression(metrics) {
  const nextProfile = pickAudioProfile(metrics);
  if (nextProfile === state.audioProfile) {
    return;
  }

  const elapsed = performance.now() - lastProfileSwitchAt;
  if (elapsed < PROFILE_SWITCH_COOLDOWN_MS) {
    return;
  }

  lastProfileSwitchAt = performance.now();
  state.audioProfile = nextProfile;
  log("Switching audio compression profile", {
    profile: nextProfile,
    metrics
  });

  await applySenderParameters();
  updateAudioDiagnostics();
}

function syncPeersFromSnapshot(peers = []) {
  const liveIds = new Set();
  for (const peer of peers) {
    if (!peer?.id || peer.id === state.participantId) {
      continue;
    }
    ensurePeerContext(peer.id, peer.displayName || peer.id);
    liveIds.add(peer.id);
  }

  for (const context of getPeerContexts()) {
    if (!liveIds.has(context.id)) {
      destroyPeerContext(context.id);
    }
  }

  updatePeerDisplay();
  updateControls();
}

async function createPeerConnection(peerId, { replace = false } = {}) {
  const context = ensurePeerContext(peerId);
  if (!context) {
    return null;
  }

  if (replace && context.connection) {
    clearPeerTimers(context);
    context.connection.onicecandidate = null;
    context.connection.ondatachannel = null;
    context.connection.ontrack = null;
    context.connection.onconnectionstatechange = null;
    context.connection.oniceconnectionstatechange = null;
    context.connection.close();
    context.connection = null;
    context.pendingCandidates = [];
    context.candidateBatch = [];
    clearPeerRemoteStream(context);
  }

  if (context.connection) {
    return context.connection;
  }

  const connection = new RTCPeerConnection({
    iceServers: state.iceServers || DEFAULT_ICE_SERVERS,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  });

  function flushCandidates() {
    context.candidateFlushTimerId = null;
    if (context.candidateBatch.length === 0) {
      return;
    }
    const batch = context.candidateBatch;
    context.candidateBatch = [];
    sendSignal("candidates", { candidates: batch }, context.id).catch((error) => {
      log("Candidate batch send failed", {
        peerId: context.id,
        message: error.message
      });
    });
  }

  connection.onicecandidate = (event) => {
    if (!event.candidate) {
      if (context.candidateBatch.length > 0) {
        flushCandidates();
      }
      return;
    }

    // Do not drop host or mDNS ICE candidates. They are often the only viable
    // path for same-LAN, same-device, or NAT-unfriendly call setups, and
    // filtering them can leave the UI "connected" while no media ever flows.
    context.candidateBatch.push(event.candidate);
    if (!context.candidateFlushTimerId) {
      context.candidateFlushTimerId = window.setTimeout(flushCandidates, 200);
    }
  };

  connection.ontrack = (event) => {
    if (event.streams && event.streams.length > 0) {
      for (const stream of event.streams) {
        for (const track of stream.getTracks()) {
          attachTrackToPeer(context, track);
        }
      }
    } else if (event.track) {
      attachTrackToPeer(context, event.track);
    }

    if (event.track) {
      log("Remote track received", {
        peerId: context.id,
        id: event.track.id,
        kind: event.track.kind,
        muted: event.track.muted,
        readyState: event.track.readyState
      });
      event.track.onunmute = () => {
        log("Remote track unmuted", { peerId: context.id, id: event.track.id });
      };
      event.track.onmute = () => {
        log("Remote track muted", { peerId: context.id, id: event.track.id });
      };
      event.track.onended = () => {
        detachTrackFromPeer(context, event.track);
        log("Remote track ended", { peerId: context.id, id: event.track.id });
      };
    }

    primeRemoteAudio();
    updateStatusFromPeerConnections();
  };

  connection.onconnectionstatechange = () => {
    log("Connection state changed", {
      peerId: context.id,
      state: connection.connectionState
    });
    updateStatusFromPeerConnections();

    if (
      connection.connectionState === "failed" ||
      connection.connectionState === "disconnected"
    ) {
      scheduleIceRestart(context.id);
    }
  };

  connection.oniceconnectionstatechange = () => {
    log("ICE state changed", {
      peerId: context.id,
      state: connection.iceConnectionState
    });
    if (connection.iceConnectionState === "failed") {
      scheduleIceRestart(context.id);
    }
  };

  const stream = await ensureLocalAudio();
  for (const track of stream.getAudioTracks()) {
    track.enabled = !state.muted;
    connection.addTrack(track, stream);
  }

  context.connection = connection;
  context.lastInboundBytes = 0;
  context.lastStatsAt = 0;
  await applySenderParameters();
  updatePeerDisplay();
  updateStatusFromPeerConnections();
  updateControls();
  return connection;
}

async function createAndSendOffer(peerId, { iceRestart = false } = {}) {
  const context = getPeerContext(peerId);
  if (!context?.connection) {
    return;
  }
  if (
    !iceRestart &&
    (context.connection.localDescription || context.connection.remoteDescription)
  ) {
    return;
  }
  if (context.connection.signalingState !== "stable" && !iceRestart) {
    return;
  }

  const offer = await context.connection.createOffer({ iceRestart });
  offer.sdp = tuneOpusInSdp(offer.sdp);
  await context.connection.setLocalDescription(offer);
  const localDescription = context.connection.localDescription;
  await sendSignal("offer", {
    description: { type: localDescription.type, sdp: localDescription.sdp }
  }, context.id);
  updateStatus(iceRestart ? "Reconnecting" : "Connecting");
  log(iceRestart ? "Sent ICE restart offer" : "Sent offer", { peerId: context.id });
}

async function handleOffer(from, payload) {
  const context = ensurePeerContext(from);
  if (!context) {
    return;
  }

  const connection = await createPeerConnection(from);
  updateControls();

  const description = {
    type: payload.description.type,
    sdp: payload.description.sdp
  };
  await connection.setRemoteDescription(description);
  await flushPendingCandidates(from);

  const answer = await connection.createAnswer();
  answer.sdp = tuneOpusInSdp(answer.sdp);
  await connection.setLocalDescription(answer);
  const localDescription = connection.localDescription;
  await sendSignal("answer", {
    description: { type: localDescription.type, sdp: localDescription.sdp }
  }, context.id);
  log("Accepted offer and sent answer", { peerId: context.id });
}

async function handleAnswer(from, payload) {
  const context = getPeerContext(from);
  if (!context?.connection) {
    return;
  }

  const description = {
    type: payload.description.type,
    sdp: payload.description.sdp
  };
  await context.connection.setRemoteDescription(description);
  await flushPendingCandidates(from);
  log("Remote answer applied", { peerId: context.id });
}

async function addSingleCandidate(peerId, candidate) {
  const context = ensurePeerContext(peerId);
  if (!context) {
    return;
  }

  if (
    context.connection &&
    context.connection.remoteDescription &&
    context.connection.remoteDescription.type
  ) {
    await context.connection.addIceCandidate(candidate);
    return;
  }
  context.pendingCandidates.push(candidate);
}

async function handleCandidate(from, payload) {
  if (payload.candidate) {
    await addSingleCandidate(from, payload.candidate);
  }
}

async function handleCandidates(from, payload) {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    return;
  }
  for (const candidate of candidates) {
    await addSingleCandidate(from, candidate);
  }
}

async function flushPendingCandidates(peerId) {
  const context = getPeerContext(peerId);
  if (!context?.connection || !context.connection.remoteDescription) {
    return;
  }

  while (context.pendingCandidates.length > 0) {
    const candidate = context.pendingCandidates.shift();
    await context.connection.addIceCandidate(candidate);
  }
}

function sendSocketPayload(payload) {
  if (!state.signalingSocket || state.signalingSocket.readyState !== WebSocket.OPEN) {
    return false;
  }

  state.signalingSocket.send(JSON.stringify(payload));
  return true;
}

async function handleRoomSync(message) {
  state.signalingReconnectAttempts = 0;
  const peers = Array.isArray(message.peers) ? message.peers : [];
  syncPeersFromSnapshot(peers);
  log("Room sync received", {
    peers: peers.length,
    signaling: "websocket"
  });

  for (const peer of peers) {
    await createPeerConnection(peer.id);
  }

  updateStatusFromPeerConnections();

  for (const peer of peers) {
    if (shouldInitiateOfferForPeer(peer.id)) {
      await createAndSendOffer(peer.id);
    }
  }
}

async function handleSocketMessage(message) {
  switch (message.type) {
    case "room-sync":
      await handleRoomSync(message);
      break;
    case "server-shutdown":
      log("Signaling server is restarting");
      updateStatus("Reconnecting");
      break;
    case "error":
      log("Signaling error", { message: message.error });
      if (message.error === "Participant not found") {
        attemptAutoRejoin("signaling participant timeout").catch((error) => {
          log("Auto-rejoin failed", { message: error.message });
        });
      }
      break;
    default:
      await handleEvent(message);
  }
}

function startHeartbeat() {
  if (state.heartbeatIntervalId) {
    clearInterval(state.heartbeatIntervalId);
  }

  state.heartbeatIntervalId = window.setInterval(async () => {
    if (!state.joined) {
      return;
    }

    if (state.signalingSocket && state.signalingSocket.readyState === WebSocket.OPEN) {
      state.signalingSocket.send("h");
      return;
    }

    try {
      await request(`/api/rooms/${encodeURIComponent(state.roomId)}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ participantId: state.participantId })
      });
    } catch (error) {
      log("Heartbeat failed", { message: error.message });
      if (error.message === "Participant not found") {
        attemptAutoRejoin("heartbeat timeout").catch((rejoinError) => {
          log("Heartbeat auto-rejoin failed", { message: rejoinError.message });
        });
      }
    }
  }, 15000);
}

function getSignalingReconnectDelayMs() {
  const attempt = Math.max(0, state.signalingReconnectAttempts);
  const baseDelayMs = 2000;
  const capDelayMs = Math.max(
    baseDelayMs,
    Number(window.APP_CONFIG?.maxReconnectDelayMs || 15000)
  );
  const exponentialDelayMs = Math.min(capDelayMs, baseDelayMs * (2 ** attempt));
  const jitterFactor = 0.85 + (Math.random() * 0.3);
  return Math.round(exponentialDelayMs * jitterFactor);
}

function scheduleSignalingReconnect() {
  if (!state.joined || state.signalingReconnectTimerId) {
    return;
  }

  const delayMs = getSignalingReconnectDelayMs();
  const attemptNumber = state.signalingReconnectAttempts + 1;
  log("Scheduling signaling reconnect", {
    attempt: attemptNumber,
    delayMs
  });
  state.signalingReconnectAttempts = attemptNumber;

  state.signalingReconnectTimerId = window.setTimeout(() => {
    state.signalingReconnectTimerId = null;
    connectSignalingSocket().catch((error) => {
      log("Signaling reconnect failed", { message: error.message });
      scheduleSignalingReconnect();
    });
  }, delayMs);
}

async function attemptAutoRejoin(reason) {
  if (
    state.autoRejoinInFlight ||
    !state.joined ||
    !state.roomId ||
    !state.displayName
  ) {
    return;
  }

  state.autoRejoinInFlight = true;
  log("Attempting automatic rejoin", { reason, roomId: state.roomId });
  updateStatus("Rejoining");
  cleanupIntervals();
  closeSignalingSocket();
  closePeerConnection();
  resetRemoteAudio();

  try {
    await ensureLocalAudio();
    const payload = await request(`/api/rooms/${encodeURIComponent(state.roomId)}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: state.displayName })
    });

    state.participantId = payload.participant.id;
    state.iceServers = payload.iceServers || DEFAULT_ICE_SERVERS;
    state.role = payload.role;
    state.signalingReconnectAttempts = 0;
    syncPeersFromSnapshot(payload.peers || []);
    updateStatus(getPeerContexts().length > 0 ? "Reconnecting" : "Waiting for participants");

    // Let the authenticated room-sync snapshot own connection setup so we do
    // not duplicate offer generation from both the join response and the socket.
    await connectSignalingSocket();

    startHeartbeat();
    startStatsLoop();
    log("Automatic rejoin completed", {
      roomId: state.roomId,
      participantId: state.participantId
    });
  } finally {
    state.autoRejoinInFlight = false;
  }
}

async function connectSignalingSocket() {
  closeSignalingSocket();

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(buildWebSocketUrl());
    let settled = false;

    socket.onopen = () => {
      state.signalingSocket = socket;
      state.signalingConnected = true;
      state.signalingReconnectAttempts = 0;
      sendSocketPayload({
        type: "auth",
        roomId: state.roomId,
        participantId: state.participantId
      });
      log("Signaling socket connected");
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (!settled && message?.type === "room-sync") {
          settled = true;
          resolve();
        }
        handleSocketMessage(message).catch((error) => {
          log("Socket message handling failed", { message: error.message });
        });
      } catch (error) {
        log("Invalid signaling message", { message: error.message });
      }
    };

    socket.onerror = () => {
      if (!settled) {
        reject(new Error("WebSocket connection failed"));
      }
    };

    socket.onclose = () => {
      const wasConnected = state.signalingConnected;
      state.signalingConnected = false;
      if (state.signalingSocket === socket) {
        state.signalingSocket = null;
      }

      if (state.joined) {
        log("Signaling socket closed");
        if (wasConnected) {
          updateStatus("Reconnecting");
        }
        scheduleSignalingReconnect();
      }

      if (!settled) {
        reject(new Error("WebSocket closed before it connected"));
      }
    };
  });
}

async function sendSignal(type, payload, targetId) {
  if (!state.roomId || !state.participantId) {
    return;
  }

  if (
    sendSocketPayload({
      type: "signal",
      signalType: type,
      targetId: targetId || undefined,
      payload
    })
  ) {
    return;
  }

  await request(`/api/rooms/${encodeURIComponent(state.roomId)}/signal`, {
    method: "POST",
    body: JSON.stringify({
      participantId: state.participantId,
      targetId: targetId || undefined,
      type,
      payload
    })
  });
}

async function scheduleIceRestart(peerId) {
  const context = getPeerContext(peerId);
  if (!context || !shouldInitiateOfferForPeer(peerId) || context.reconnectTimerId) {
    return;
  }

  context.reconnectTimerId = window.setTimeout(async () => {
    context.reconnectTimerId = null;
    if (!context.connection) {
      return;
    }

    try {
      await createAndSendOffer(peerId, { iceRestart: true });
    } catch (error) {
      log("ICE restart failed", { peerId, message: error.message });
    }
  }, 2000);
}

async function handleEvent(event) {
  switch (event.type) {
    case "peer-joined":
      ensurePeerContext(event.peer.id, event.peer.displayName);
      updatePeerDisplay();
      log("Peer joined", event.peer);
      await createPeerConnection(event.peer.id);
      if (shouldInitiateOfferForPeer(event.peer.id)) {
        await createAndSendOffer(event.peer.id);
      }
      updateStatusFromPeerConnections();
      break;
    case "peer-left":
      log("Peer left", event.peer);
      destroyPeerContext(event.peer.id);
      updatePeerDisplay();
      updateStatusFromPeerConnections();
      updateControls();
      break;
    case "signal":
      ensurePeerContext(event.from, event.peer?.displayName || event.from);
      switch (event.signal.type) {
        case "offer":
          await handleOffer(event.from, event.signal.payload);
          break;
        case "answer":
          await handleAnswer(event.from, event.signal.payload);
          break;
        case "candidate":
          await handleCandidate(event.from, event.signal.payload);
          break;
        case "candidates":
          await handleCandidates(event.from, event.signal.payload);
          break;
        default:
          log("Ignored unknown signal", event.signal);
      }
      break;
    default:
      log("Ignored unknown event", event);
  }
}

function startStatsLoop() {
  if (state.statsIntervalId) {
    clearInterval(state.statsIntervalId);
  }

  state.statsIntervalId = window.setInterval(async () => {
    const contexts = getPeerContexts().filter((context) => context.connection);
    if (contexts.length === 0) {
      return;
    }

    try {
      let packetsLost = null;
      let jitter = null;
      let rtt = null;
      let availableOutgoingBitrate = null;
      let aggregateBitrateKbps = 0;

      for (const context of contexts) {
        const stats = await context.connection.getStats();
        let peerPacketsLost = null;
        let peerJitter = null;
        let peerRtt = null;
        let inboundBytes = null;
        let peerAvailableOutgoingBitrate = null;

        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "audio") {
            peerPacketsLost = report.packetsLost;
            peerJitter = report.jitter;
            inboundBytes = report.bytesReceived;
          }

          if (
            report.type === "candidate-pair" &&
            report.state === "succeeded" &&
            report.nominated
          ) {
            peerRtt = report.currentRoundTripTime;
            peerAvailableOutgoingBitrate = report.availableOutgoingBitrate;
          }
        });

        if (typeof peerPacketsLost === "number") {
          packetsLost = packetsLost == null ? peerPacketsLost : Math.max(packetsLost, peerPacketsLost);
        }
        if (typeof peerJitter === "number") {
          jitter = jitter == null ? peerJitter : Math.max(jitter, peerJitter);
        }
        if (typeof peerRtt === "number") {
          rtt = rtt == null ? peerRtt : Math.max(rtt, peerRtt);
        }
        if (typeof peerAvailableOutgoingBitrate === "number") {
          availableOutgoingBitrate =
            availableOutgoingBitrate == null
              ? peerAvailableOutgoingBitrate
              : Math.min(availableOutgoingBitrate, peerAvailableOutgoingBitrate);
        }

        if (typeof inboundBytes === "number") {
          const currentTime = performance.now();
          if (context.lastStatsAt && inboundBytes >= context.lastInboundBytes) {
            const seconds = (currentTime - context.lastStatsAt) / 1000;
            const bits = (inboundBytes - context.lastInboundBytes) * 8;
            aggregateBitrateKbps += bits / seconds / 1000;
          }
          context.lastInboundBytes = inboundBytes;
          context.lastStatsAt = currentTime;
        }
      }

      if (typeof packetsLost === "number") {
        lossText.textContent = String(packetsLost);
      }

      if (typeof jitter === "number") {
        jitterText.textContent = `${Math.round(jitter * 1000)} ms`;
      }

      if (typeof rtt === "number") {
        rttText.textContent = `${Math.round(rtt * 1000)} ms`;
      }

      if (aggregateBitrateKbps > 0) {
        bitrateText.textContent = `${Math.round(aggregateBitrateKbps)} kbps`;
      }

      await adaptAudioCompression({
        packetsLost,
        jitterMs: typeof jitter === "number" ? jitter * 1000 : null,
        rttMs: typeof rtt === "number" ? rtt * 1000 : null,
        availableOutgoingBitrateKbps:
          typeof availableOutgoingBitrate === "number"
            ? availableOutgoingBitrate / 1000
            : null
      });
    } catch (error) {
      log("Stats collection failed", { message: error.message });
    }
  }, 1000);
}

async function joinRoom(event) {
  event.preventDefault();

  const roomValue = roomInput.value.trim().toLowerCase();
  const nameValue = nameInput.value.trim();

  if (!roomValue || !nameValue) {
    log("Join blocked: room and name are required");
    return;
  }

  // Prime <audio>.play() while we are still inside the synchronous user
  // gesture stack of the form submit. iOS Safari will only honour autoplay
  // for elements that had play() called inside a real gesture; once we hit
  // the first await below the gesture context is gone and any later play()
  // attempt from ontrack will be rejected with NotAllowedError.
  primeRemoteAudio();

  try {
    setMicStatus(
      "pending",
      "Requesting microphone access from the browser.",
      "Approve the browser prompt on this device to continue."
    );
    log("Join started", { room: roomValue, name: nameValue });
    await ensureLocalAudio();
    const payload = await request(`/api/rooms/${encodeURIComponent(roomValue)}/join`, {
      method: "POST",
      body: JSON.stringify({ displayName: nameValue })
    });

    state.roomId = payload.roomId;
    state.participantId = payload.participant.id;
    state.displayName = payload.participant.displayName;
    state.iceServers = payload.iceServers || DEFAULT_ICE_SERVERS;
    state.role = payload.role;
    state.joined = true;
    syncPeersFromSnapshot(payload.peers || []);
    updateStatus(getPeerContexts().length > 0 ? "Connecting" : "Waiting for participants");
    log("Joined room", {
      roomId: payload.roomId,
      role: payload.role,
      participantId: payload.participant.id
    });

    // Let the authenticated room-sync snapshot own connection setup so we do
    // not duplicate offer generation from both the join response and the socket.
    await connectSignalingSocket();

    startHeartbeat();
    startStatsLoop();
  } catch (error) {
    log("Join failed", { message: error.message });
    updateStatus("Join failed");
    const isMicError = error.name === "NotAllowedError" || error.name === "NotFoundError" ||
      error.name === "NotReadableError" || error.name === "OverconstrainedError" ||
      error.name === "TypeError" || (error.message && error.message.includes("microphone"));
    if (isMicError) {
      alert("Microphone access is required to join.\n\nPlease allow microphone access in your browser settings and try again.\n\nIf you opened this link from Telegram, WhatsApp, or another app, tap the menu and choose \"Open in Safari\" or \"Open in Chrome\" instead.");
    } else {
      alert(`Join failed: ${error.message}`);
    }
  }
}

async function leaveRoom() {
  if (!state.joined) {
    resetCallState();
    return;
  }

  try {
    sendSocketPayload({ type: "leave" });
    await request(`/api/rooms/${encodeURIComponent(state.roomId)}/leave`, {
      method: "POST",
      body: JSON.stringify({ participantId: state.participantId })
    });
  } catch (error) {
    log("Leave request failed", { message: error.message });
  } finally {
    log("Left room");
    resetCallState();
  }
}

function toggleMute() {
  if (!state.localStream) {
    return;
  }

  state.muted = !state.muted;
  for (const track of state.localStream.getAudioTracks()) {
    track.enabled = !state.muted;
  }

  updateControls();
}

if (joinForm) {
  joinForm.addEventListener("submit", joinRoom);
}
if (leaveButton) {
  leaveButton.addEventListener("click", leaveRoom);
}
if (muteButton) {
  muteButton.addEventListener("click", toggleMute);
}
if (reconnectButton) {
  reconnectButton.addEventListener("click", () => {
    Promise.all(
      getPeerContexts()
        .filter((context) => shouldInitiateOfferForPeer(context.id))
        .map((context) =>
          createAndSendOffer(context.id, { iceRestart: true }).catch((error) => {
            log("Manual ICE restart failed", {
              peerId: context.id,
              message: error.message
            });
          })
        )
    ).catch(() => {});
  });
}
if (clearLogButton) {
  clearLogButton.addEventListener("click", () => {
    logOutput.textContent = "";
  });
}
if (opusModeSelect) {
  opusModeSelect.addEventListener("change", (event) => {
    applyOpusMode(event.target.value);
  });
}

window.addEventListener("beforeunload", () => {
  if (state.joined) {
    navigator.sendBeacon(
      `/api/rooms/${encodeURIComponent(state.roomId)}/leave`,
      JSON.stringify({ participantId: state.participantId })
    );
  }
});

resetRemoteAudio();
applyOpusMode(readStoredOpusMode(), { persist: false, resetProfile: true });
(async () => {
  await refreshMicPermissionState().catch(() => "unknown");
})();
updateControls();
log("Ready");

const infoToggle = document.getElementById("info-toggle");
const infoPanel = document.getElementById("info-panel");
const precall = document.getElementById("precall");

if (infoToggle && infoPanel) {
  infoToggle.addEventListener("click", () => {
    infoPanel.classList.toggle("hidden");
  });
}

if (precall && joinButton) {
  const precallObserver = new MutationObserver(() => {
    if (joinButton.disabled && state.joined) {
      precall.classList.add("hidden");
    } else if (!state.joined) {
      precall.classList.remove("hidden");
    }
  });
  precallObserver.observe(joinButton, { attributes: true, attributeFilter: ["disabled"] });
}
