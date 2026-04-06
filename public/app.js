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

const roomInput = document.querySelector("#room-input");
const nameInput = document.querySelector("#name-input");
const joinForm = document.querySelector("#join-form");
const joinButton = document.querySelector("#join-button");
const leaveButton = document.querySelector("#leave-button");
const muteButton = document.querySelector("#mute-button");
const reconnectButton = document.querySelector("#reconnect-button");
const speakerButton = document.querySelector("#speaker-button");
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
const logOutput = document.querySelector("#log-output");

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
  peerConnection: null,
  pendingCandidates: [],
  signalingSocket: null,
  signalingConnected: false,
  pollAbortController: null,
  polling: false,
  statsIntervalId: null,
  heartbeatIntervalId: null,
  reconnectTimerId: null,
  signalingReconnectTimerId: null,
  lastInboundBytes: 0,
  lastStatsAt: 0,
  micPermissionState: "unknown",
  micPermissionStatus: null,
  speakerUnlocked: false,
  audioProfile: "ultra"
};

const DEFAULT_ICE_SERVERS = window.APP_CONFIG?.iceServers || [
  { urls: ["stun:stun.l.google.com:19302"] }
];

const PROFILE_SWITCH_COOLDOWN_MS = 5000;
let lastProfileSwitchAt = 0;

const AUDIO_PROFILES = {
  lean: {
    label: "Lean",
    maxBitrate: 9000,
    maxAverageBitrate: 9000,
    maxPlaybackRate: 12000,
    ptime: 40
  },
  tight: {
    label: "Tight",
    maxBitrate: 7000,
    maxAverageBitrate: 7000,
    maxPlaybackRate: 8000,
    ptime: 60
  },
  ultra: {
    label: "Ultra",
    maxBitrate: 6000,
    maxAverageBitrate: 6000,
    maxPlaybackRate: 8000,
    ptime: 60
  },
  extreme: {
    label: "Extreme",
    maxBitrate: 4000,
    maxAverageBitrate: 4000,
    maxPlaybackRate: 8000,
    ptime: 120
  }
};

function log(message, extra = null) {
  const timestamp = new Date().toLocaleTimeString();
  const line = extra
    ? `[${timestamp}] ${message} ${JSON.stringify(extra)}`
    : `[${timestamp}] ${message}`;
  if (logOutput) {
    logOutput.textContent = `${line}\n${logOutput.textContent}`.trim();
  }
}

function updateStatus(text) {
  if (statusText) {
    statusText.textContent = text;
  }
}

function updatePeerDisplay() {
  if (peerText) {
    peerText.textContent = state.peerName || (state.peerId ? state.peerId : "Waiting");
  }
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
    muteButton.textContent = state.muted ? "Unmute" : "Mute";
  }
  if (reconnectButton) {
    reconnectButton.disabled = !state.joined || !state.peerConnection;
  }
  if (speakerButton) {
    speakerButton.disabled = false;
    speakerButton.textContent = state.speakerUnlocked ? "Speaker ready" : "Enable speaker";
  }
  if (roleText) {
    roleText.textContent = state.role || "-";
  }
  if (roomText) {
    roomText.textContent = state.roomId || "-";
  }
  if (localParticipantName) {
    localParticipantName.textContent = state.displayName || "Microphone source";
  }
  updatePeerDisplay();
}

async function unlockSpeaker() {
  if (!remoteAudio) {
    return;
  }

  const hasPlayableMedia =
    (remoteAudio.srcObject && remoteAudio.srcObject.getTracks().length > 0) ||
    remoteAudio.src;

  if (!hasPlayableMedia) {
    state.speakerUnlocked = false;
    updateControls();
    return;
  }

  try {
    await remoteAudio.play();
    state.speakerUnlocked = true;
    log("Speaker playback unlocked");
  } catch (error) {
    state.speakerUnlocked = false;
    log("Speaker unlock needs a user tap", { message: error.message });
  }
  updateControls();
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

function shouldInitiateOffer() {
  return Boolean(
    state.joined &&
      state.participantId &&
      state.peerId &&
      state.participantId.localeCompare(state.peerId) < 0
  );
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
    setMicStatus(
      "ready",
      "Microphone access is active on this device.",
      "You can stay in the room or reconnect without another permission prompt."
    );
    return state.localStream;
  }

  await refreshMicPermissionState();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        sampleSize: 16,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
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
    log("Local microphone captured");
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
  state.remoteStream = new MediaStream();
  remoteAudio.srcObject = state.remoteStream;
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
  if (state.peerConnection) {
    state.peerConnection.onicecandidate = null;
    state.peerConnection.ontrack = null;
    state.peerConnection.onconnectionstatechange = null;
    state.peerConnection.oniceconnectionstatechange = null;
    state.peerConnection.close();
  }

  state.peerConnection = null;
  state.pendingCandidates = [];
  state.lastInboundBytes = 0;
  state.lastStatsAt = 0;
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

  if (state.reconnectTimerId) {
    clearTimeout(state.reconnectTimerId);
    state.reconnectTimerId = null;
  }

  if (state.signalingReconnectTimerId) {
    clearTimeout(state.signalingReconnectTimerId);
    state.signalingReconnectTimerId = null;
  }
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
}

function resetCallState({ preserveLog = true } = {}) {
  state.peerId = "";
  state.peerName = "";
  state.joined = false;
  state.role = "";
  state.roomId = "";
  state.participantId = "";
  state.displayName = "";
  state.iceServers = null;
  state.muted = false;
  state.speakerUnlocked = false;
  state.audioProfile = "ultra";

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
  return AUDIO_PROFILES[state.audioProfile] || AUDIO_PROFILES.lean;
}

function updateAudioSectionAttribute(section, attribute, value) {
  const regex = new RegExp(`^a=${attribute}:\\d+$`, "m");
  if (regex.test(section)) {
    return section.replace(regex, `a=${attribute}:${value}`);
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

  return tuneAudioPacketization(sdp, activeProfile.ptime);
}

async function applySenderParameters() {
  if (!state.peerConnection) {
    return;
  }

  const sender = state.peerConnection
    .getSenders()
    .find((item) => item.track && item.track.kind === "audio");

  if (!sender || typeof sender.getParameters !== "function") {
    return;
  }

  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }

  const activeProfile = getActiveAudioProfile();
  params.encodings[0].maxBitrate = activeProfile.maxBitrate;
  params.encodings[0].networkPriority = "high";

  try {
    await sender.setParameters(params);
    log("Audio compression profile applied", {
      profile: state.audioProfile,
      bitrate: activeProfile.maxBitrate
    });
  } catch (error) {
    log("Sender parameter tuning skipped", { message: error.message });
  }
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
    return "ultra";
  }

  if (
    (typeof packetsLost === "number" && packetsLost > 8) ||
    (typeof jitterMs === "number" && jitterMs >= 60) ||
    (typeof rttMs === "number" && rttMs >= 400) ||
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps > 0 &&
      availableOutgoingBitrateKbps <= 8)
  ) {
    return "extreme";
  }

  if (
    (typeof packetsLost === "number" && packetsLost > 3) ||
    (typeof jitterMs === "number" && jitterMs >= 30) ||
    (typeof rttMs === "number" && rttMs >= 250) ||
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps > 0 &&
      availableOutgoingBitrateKbps <= 12)
  ) {
    return "ultra";
  }

  if (
    (typeof packetsLost === "number" && packetsLost <= 1) &&
    (typeof jitterMs !== "number" || jitterMs < 18) &&
    (typeof rttMs !== "number" || rttMs < 160) &&
    (typeof availableOutgoingBitrateKbps === "number" &&
      availableOutgoingBitrateKbps >= 28)
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
}

async function createPeerConnection() {
  closePeerConnection();
  resetRemoteAudio();

  const connection = new RTCPeerConnection({
    iceServers: state.iceServers || DEFAULT_ICE_SERVERS,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
  });

  let candidateBatch = [];
  let candidateFlushTimer = null;

  function flushCandidates() {
    candidateFlushTimer = null;
    if (candidateBatch.length === 0) {
      return;
    }
    const batch = candidateBatch;
    candidateBatch = [];
    sendSignal("candidates", { candidates: batch });
  }

  connection.onicecandidate = (event) => {
    if (!event.candidate || !state.peerId) {
      if (!event.candidate && candidateBatch.length > 0) {
        flushCandidates();
      }
      return;
    }

    const c = event.candidate;
    if (c.candidate.includes(".local") || c.candidate.includes(" host ")) {
      return;
    }

    candidateBatch.push(c);
    if (!candidateFlushTimer) {
      candidateFlushTimer = setTimeout(flushCandidates, 200);
    }
  };

  connection.ontrack = (event) => {
    if (event.streams && event.streams.length > 0) {
      for (const stream of event.streams) {
        for (const track of stream.getTracks()) {
          if (!state.remoteStream.getTracks().some((item) => item.id === track.id)) {
            state.remoteStream.addTrack(track);
          }
        }
      }
    } else if (
      event.track &&
      !state.remoteStream.getTracks().some((track) => track.id === event.track.id)
    ) {
      state.remoteStream.addTrack(event.track);
    }
    if (event.track) {
      log("Remote track received", {
        id: event.track.id,
        kind: event.track.kind,
        muted: event.track.muted,
        readyState: event.track.readyState
      });
      event.track.onunmute = () => {
        log("Remote track unmuted", { id: event.track.id });
      };
      event.track.onmute = () => {
        log("Remote track muted", { id: event.track.id });
      };
      event.track.onended = () => {
        log("Remote track ended", { id: event.track.id });
      };
    }
    unlockSpeaker().catch((error) => {
      log("Remote audio playback may need a tap", { message: error.message });
    });
    updateStatus("Connected");
  };

  connection.onconnectionstatechange = () => {
    updateStatus(connection.connectionState);
    log("Connection state changed", { state: connection.connectionState });

    if (
      connection.connectionState === "failed" ||
      connection.connectionState === "disconnected"
    ) {
      scheduleIceRestart();
    }
  };

  connection.oniceconnectionstatechange = () => {
    log("ICE state changed", { state: connection.iceConnectionState });
    if (connection.iceConnectionState === "failed") {
      scheduleIceRestart();
    }
  };

  const stream = await ensureLocalAudio();
  for (const track of stream.getAudioTracks()) {
    connection.addTrack(track, stream);
  }

  state.peerConnection = connection;
  await applySenderParameters();
  updateControls();
}

async function createAndSendOffer({ iceRestart = false } = {}) {
  if (!state.peerConnection || !state.peerId) {
    return;
  }

  const offer = await state.peerConnection.createOffer({ iceRestart });
  offer.sdp = tuneOpusInSdp(offer.sdp);
  await state.peerConnection.setLocalDescription(offer);
  const ld = state.peerConnection.localDescription;
  await sendSignal("offer", {
    description: { type: ld.type, sdp: ld.sdp }
  });
  updateStatus(iceRestart ? "Reconnecting" : "Connecting");
  log(iceRestart ? "Sent ICE restart offer" : "Sent offer");
}

async function handleOffer(from, payload) {
  state.peerId = from;
  await createPeerConnection();
  updateControls();

  const description = {
    type: payload.description.type,
    sdp: payload.description.sdp
  };
  await state.peerConnection.setRemoteDescription(description);
  await flushPendingCandidates();

  const answer = await state.peerConnection.createAnswer();
  answer.sdp = tuneOpusInSdp(answer.sdp);
  await state.peerConnection.setLocalDescription(answer);
  const ald = state.peerConnection.localDescription;
  await sendSignal("answer", {
    description: { type: ald.type, sdp: ald.sdp }
  });
  log("Accepted offer and sent answer");
}

async function handleAnswer(payload) {
  if (!state.peerConnection) {
    return;
  }

  const description = {
    type: payload.description.type,
    sdp: payload.description.sdp
  };
  await state.peerConnection.setRemoteDescription(description);
  await flushPendingCandidates();
  log("Remote answer applied");
}

async function addSingleCandidate(candidate) {
  if (
    state.peerConnection &&
    state.peerConnection.remoteDescription &&
    state.peerConnection.remoteDescription.type
  ) {
    await state.peerConnection.addIceCandidate(candidate);
    return;
  }
  state.pendingCandidates.push(candidate);
}

async function handleCandidate(payload) {
  if (payload.candidate) {
    await addSingleCandidate(payload.candidate);
  }
}

async function handleCandidates(payload) {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) {
    return;
  }
  for (const candidate of candidates) {
    await addSingleCandidate(candidate);
  }
}

async function flushPendingCandidates() {
  if (!state.peerConnection || !state.peerConnection.remoteDescription) {
    return;
  }

  while (state.pendingCandidates.length > 0) {
    const candidate = state.pendingCandidates.shift();
    await state.peerConnection.addIceCandidate(candidate);
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
  const remotePeer = message.peers?.[0];
  state.peerId = remotePeer?.id || "";
  state.peerName = remotePeer?.displayName || "";
  updateControls();
  log("Room sync received", {
    peers: message.peers?.length || 0,
    signaling: "websocket"
  });

  if (state.peerId && !state.peerConnection) {
    await createPeerConnection();
  }

  if (state.peerId && shouldInitiateOffer()) {
    await createAndSendOffer();
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
    }
  }, 15000);
}

function scheduleSignalingReconnect() {
  if (!state.joined || state.signalingReconnectTimerId) {
    return;
  }

  state.signalingReconnectTimerId = window.setTimeout(() => {
    state.signalingReconnectTimerId = null;
    connectSignalingSocket().catch((error) => {
      log("Signaling reconnect failed", { message: error.message });
      scheduleSignalingReconnect();
    });
  }, window.APP_CONFIG?.maxReconnectDelayMs || 5000);
}

async function connectSignalingSocket() {
  closeSignalingSocket();

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(buildWebSocketUrl());
    let settled = false;

    socket.onopen = () => {
      state.signalingSocket = socket;
      state.signalingConnected = true;
      sendSocketPayload({
        type: "auth",
        roomId: state.roomId,
        participantId: state.participantId
      });
      log("Signaling socket connected");
      settled = true;
      resolve();
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
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

async function sendSignal(type, payload) {
  if (!state.roomId || !state.participantId) {
    return;
  }

  if (
    sendSocketPayload({
      type: "signal",
      signalType: type,
      targetId: state.peerId || undefined,
      payload
    })
  ) {
    return;
  }

  await request(`/api/rooms/${encodeURIComponent(state.roomId)}/signal`, {
    method: "POST",
    body: JSON.stringify({
      participantId: state.participantId,
      targetId: state.peerId || undefined,
      type,
      payload
    })
  });
}

async function scheduleIceRestart() {
  if (!shouldInitiateOffer() || state.reconnectTimerId || !state.peerId) {
    return;
  }

  state.reconnectTimerId = window.setTimeout(async () => {
    state.reconnectTimerId = null;
    if (!state.peerConnection || !state.peerId) {
      return;
    }

    try {
      await createAndSendOffer({ iceRestart: true });
    } catch (error) {
      log("ICE restart failed", { message: error.message });
    }
  }, 2000);
}

async function handleEvent(event) {
  switch (event.type) {
    case "peer-joined":
      state.peerId = event.peer.id;
      state.peerName = event.peer.displayName;
      updatePeerDisplay();
      log("Peer joined", event.peer);
      if (!state.peerConnection) {
        await createPeerConnection();
      }
      if (shouldInitiateOffer()) {
        await createAndSendOffer();
      }
      break;
    case "peer-left":
      log("Peer left", event.peer);
      state.peerId = "";
      state.peerName = "";
      updatePeerDisplay();
      closePeerConnection();
      resetRemoteAudio();
      updateStatus("Waiting for peer");
      updateControls();
      break;
    case "signal":
      if (event.from && !state.peerId) {
        state.peerId = event.from;
      }
      switch (event.signal.type) {
        case "offer":
          await handleOffer(event.from, event.signal.payload);
          break;
        case "answer":
          await handleAnswer(event.signal.payload);
          break;
        case "candidate":
          await handleCandidate(event.signal.payload);
          break;
        case "candidates":
          await handleCandidates(event.signal.payload);
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
    if (!state.peerConnection) {
      return;
    }

    try {
      const stats = await state.peerConnection.getStats();
      let packetsLost = null;
      let jitter = null;
      let rtt = null;
      let inboundBytes = null;
      let availableOutgoingBitrate = null;

      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          packetsLost = report.packetsLost;
          jitter = report.jitter;
          inboundBytes = report.bytesReceived;
        }

        if (
          report.type === "candidate-pair" &&
          report.state === "succeeded" &&
          report.nominated
        ) {
          rtt = report.currentRoundTripTime;
          availableOutgoingBitrate = report.availableOutgoingBitrate;
        }
      });

      if (typeof packetsLost === "number") {
        lossText.textContent = String(packetsLost);
      }

      if (typeof jitter === "number") {
        jitterText.textContent = `${Math.round(jitter * 1000)} ms`;
      }

      if (typeof rtt === "number") {
        rttText.textContent = `${Math.round(rtt * 1000)} ms`;
      }

      if (typeof inboundBytes === "number") {
        const currentTime = performance.now();
        if (state.lastStatsAt && inboundBytes >= state.lastInboundBytes) {
          const seconds = (currentTime - state.lastStatsAt) / 1000;
          const bits = (inboundBytes - state.lastInboundBytes) * 8;
          bitrateText.textContent = `${Math.round(bits / seconds / 1000)} kbps`;
        }
        state.lastInboundBytes = inboundBytes;
        state.lastStatsAt = currentTime;
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
    state.peerId = payload.peers[0]?.id || "";
    state.peerName = payload.peers[0]?.displayName || "";

    updateStatus(state.peerId ? "Connecting" : "Waiting for peer");
    updateControls();
    log("Joined room", {
      roomId: payload.roomId,
      role: payload.role,
      participantId: payload.participant.id
    });

    await connectSignalingSocket();

    if (state.peerId) {
      await createPeerConnection();
      if (shouldInitiateOffer()) {
        await createAndSendOffer();
      }
    }

    startHeartbeat();
    startStatsLoop();
  } catch (error) {
    log("Join failed", { message: error.message });
    updateStatus("Join failed");
    alert(`Join failed: ${error.message}`);
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
if (speakerButton) {
  speakerButton.addEventListener("click", () => {
    unlockSpeaker().catch((error) => {
      log("Speaker unlock failed", { message: error.message });
    });
  });
}
if (reconnectButton) {
  reconnectButton.addEventListener("click", () => {
    createAndSendOffer({ iceRestart: true }).catch((error) => {
      log("Manual ICE restart failed", { message: error.message });
    });
  });
}
if (clearLogButton) {
  clearLogButton.addEventListener("click", () => {
    logOutput.textContent = "";
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
refreshMicPermissionState().catch((error) => {
  log("Initial microphone permission check failed", { message: error.message });
});
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

// ── Codec2 1.2kbps DataChannel transport ──
// Activated when a codec2.wasm file is present and network is catastrophic.
// Uses WebRTC DataChannel instead of RTP, bypassing Opus entirely.
// To enable: place codec2.wasm in /public/ and set APP_CONFIG.enableCodec2 = true
const codec2 = {
  active: false,
  encoderNode: null,
  decoderNode: null,
  dataChannel: null,
  audioContext: null,

  async init(peerConnection, localStream) {
    if (!window.APP_CONFIG?.enableCodec2) return;

    try {
      const wasmResponse = await fetch("/codec2.wasm");
      if (!wasmResponse.ok) {
        log("Codec2 WASM not found, skipping ultra-low-bitrate mode");
        return;
      }
      const wasmModule = await WebAssembly.compile(await wasmResponse.arrayBuffer());

      const audioCtx = new AudioContext({ sampleRate: 48000 });
      await audioCtx.audioWorklet.addModule("/codec2-worker.js");

      // Encoder: local mic → Codec2 → DataChannel
      const encoderNode = new AudioWorkletNode(audioCtx, "codec2-encoder");
      const source = audioCtx.createMediaStreamSource(localStream);
      source.connect(encoderNode);
      encoderNode.port.postMessage({ type: "init", module: wasmModule });

      // Decoder: DataChannel → Codec2 → speaker
      const decoderNode = new AudioWorkletNode(audioCtx, "codec2-decoder");
      decoderNode.connect(audioCtx.destination);
      decoderNode.port.postMessage({ type: "init", module: wasmModule });

      // DataChannel for binary codec2 frames
      const dc = peerConnection.createDataChannel("codec2", {
        ordered: false,
        maxRetransmits: 0
      });

      dc.binaryType = "arraybuffer";
      dc.onmessage = (e) => {
        decoderNode.port.postMessage(
          { type: "decode", data: e.data },
          [e.data]
        );
      };

      encoderNode.port.onmessage = (e) => {
        if (e.data.type === "encoded" && dc.readyState === "open") {
          dc.send(e.data.data);
        }
      };

      // Handle incoming DataChannel from peer
      peerConnection.ondatachannel = (event) => {
        if (event.channel.label === "codec2") {
          event.channel.binaryType = "arraybuffer";
          event.channel.onmessage = (e) => {
            decoderNode.port.postMessage(
              { type: "decode", data: e.data },
              [e.data]
            );
          };
        }
      };

      this.encoderNode = encoderNode;
      this.decoderNode = decoderNode;
      this.dataChannel = dc;
      this.audioContext = audioCtx;
      this.active = true;
      log("Codec2 1.2kbps mode initialized");
    } catch (error) {
      log("Codec2 init failed, using Opus", { message: error.message });
    }
  },

  teardown() {
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
    }
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    this.encoderNode = null;
    this.decoderNode = null;
    this.dataChannel = null;
    this.audioContext = null;
    this.active = false;
  }
};
