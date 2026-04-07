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
const transportModeText = document.querySelector("#transport-mode-text");
const headerText = document.querySelector("#header-text");
const bufferText = document.querySelector("#buffer-text");
const plcText = document.querySelector("#plc-text");
const vocoderText = document.querySelector("#vocoder-text");
const logOutput = document.querySelector("#log-output");
const ExtremeStack = window.ExtremeStack || null;

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

function buildMediaWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsPath = window.APP_CONFIG?.mediaWsPath || "/media";
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
  codec2.teardown();
  if (state.peerConnection) {
    state.peerConnection.onicecandidate = null;
    state.peerConnection.ondatachannel = null;
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
  if (transportModeText) {
    transportModeText.textContent = "-";
  }
  if (headerText) {
    headerText.textContent = "-";
  }
  if (bufferText) {
    bufferText.textContent = "-";
  }
  if (plcText) {
    plcText.textContent = "-";
  }
  if (vocoderText) {
    vocoderText.textContent = "-";
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
    await codec2.setDesiredActive(nextProfile === "extreme");
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
  await codec2.setDesiredActive(nextProfile === "extreme");
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
  await codec2.init(connection, stream, { initiator: shouldInitiateOffer() });
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
      codec2.updateNetworkMetrics({
        packetsLost,
        jitterMs: typeof jitter === "number" ? jitter * 1000 : null,
        rttMs: typeof rtt === "number" ? rtt * 1000 : null
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

// ── Codec2 ultra-low-bitrate transport ──
// Activated only on the most aggressive profile when both peers finish
// Codec2 initialization and exchange readiness over a dedicated data channel.
const codec2 = {
  active: false,
  desiredActive: false,
  localReady: false,
  peerReady: false,
  encoderReady: false,
  decoderReady: false,
  readyAnnouncementSent: false,
  encoderNode: null,
  decoderNode: null,
  dataChannel: null,
  audioContext: null,
  sender: null,
  originalTrack: null,
  samplesPerFrame: 0,
  bytesPerFrame: 0,
  frameDurationMs: 20,
  packetizer: null,
  headerCompressor: null,
  headerDecompressor: null,
  jitterBuffer: null,
  plcModel: null,
  neuralVocoder: null,
  playoutIntervalId: null,
  transportStats: null,
  relaySocket: null,
  relayReady: false,

  isSupported() {
    return Boolean(
      window.APP_CONFIG?.enableCodec2 &&
      ExtremeStack &&
      typeof window.AudioContext === "function" &&
      typeof window.AudioWorkletNode === "function" &&
      typeof window.WebAssembly === "object"
    );
  },

  useRelayTransport() {
    return Boolean(window.APP_CONFIG?.enableMediaRelay);
  },

  getNeuralRelayMode() {
    return String(window.APP_CONFIG?.neuralRelayMode || "off").trim().toLowerCase();
  },

  resetTransportStats() {
    this.transportStats = {
      sentPackets: 0,
      sentHeaderBytes: 0,
      sentRawHeaderBytes: 0,
      receivedPackets: 0,
      receivedHeaderBytes: 0,
      receivedRawHeaderBytes: 0,
      concealedFrames: 0
    };
  },

  updateDiagnostics() {
    if (transportModeText) {
      if (this.active) {
        transportModeText.textContent = this.useRelayTransport()
          ? "Codec2 relay RTP"
          : "Codec2 compact RTP";
      } else if (this.isSupported()) {
        transportModeText.textContent = "Opus fallback";
      } else {
        transportModeText.textContent = "Unavailable";
      }
    }

    if (headerText) {
      if (this.transportStats?.sentPackets) {
        const averageHeader = this.transportStats.sentHeaderBytes / this.transportStats.sentPackets;
        const averageRaw = this.transportStats.sentRawHeaderBytes / this.transportStats.sentPackets;
        headerText.textContent = `${averageHeader.toFixed(1)} / ${averageRaw.toFixed(1)} B`;
      } else {
        headerText.textContent = "-";
      }
    }

    if (bufferText) {
      if (this.jitterBuffer) {
        const stats = this.jitterBuffer.getStats();
        bufferText.textContent = `${stats.queuedPackets} q / ${stats.targetDelayMs} ms`;
      } else {
        bufferText.textContent = "-";
      }
    }

    if (plcText) {
      plcText.textContent = this.transportStats
        ? String(this.transportStats.concealedFrames)
        : "-";
    }

    if (vocoderText) {
      if (this.useRelayTransport()) {
        const mode = this.getNeuralRelayMode();
        const backend = String(window.APP_CONFIG?.neuralRelayBackend || "unknown");
        vocoderText.textContent =
          mode === "off"
            ? `Relay passthrough (${backend})`
            : `${mode} relay (${backend})`;
      } else {
        vocoderText.textContent = this.neuralVocoder
          ? this.neuralVocoder.describe()
          : "Codec2 decode";
      }
    }
  },

  resetPlayoutState() {
    if (!ExtremeStack || !this.samplesPerFrame) {
      return;
    }

    this.plcModel = new ExtremeStack.FeatureTrajectoryPlcModel({
      frameSamples: this.samplesPerFrame,
      sampleRate: 8000
    });
    this.jitterBuffer = new ExtremeStack.AdaptiveJitterBuffer({
      frameDurationMs: this.frameDurationMs,
      sampleRate: 8000,
      plcModel: this.plcModel
    });
  },

  ensureTransportPipeline() {
    if (!ExtremeStack || !this.samplesPerFrame || this.packetizer) {
      return;
    }

    this.frameDurationMs = Math.max(20, Math.round((this.samplesPerFrame / 8000) * 1000));
    this.packetizer = new ExtremeStack.RtpPacketizer({
      payloadType: 97,
      timestampStep: this.samplesPerFrame
    });
    this.headerCompressor = new ExtremeStack.RohcLiteCompressor();
    this.headerDecompressor = new ExtremeStack.RohcLiteDecompressor();
    this.neuralVocoder = new ExtremeStack.NeuralVocoderAdapter({
      mode: "passthrough",
      label: "Codec2 decoder"
    });
    this.resetPlayoutState();

    if (this.playoutIntervalId) {
      clearInterval(this.playoutIntervalId);
    }
    this.playoutIntervalId = window.setInterval(() => {
      this.drainJitterBuffer();
    }, Math.max(8, Math.floor(this.frameDurationMs / 2)));
  },

  postDecodePacket(packet, gain = 1, concealment = false) {
    if (!this.decoderNode || !packet?.payload?.length) {
      return;
    }

    if (packet.payloadType === 98) {
      const byteLength = packet.payload.length - (packet.payload.length % 2);
      const pcm = new Float32Array(byteLength / 2);
      for (let index = 0; index < pcm.length; index += 1) {
        const lo = packet.payload[index * 2];
        const hi = packet.payload[index * 2 + 1];
        let sample = (hi << 8) | lo;
        if (sample & 0x8000) {
          sample -= 0x10000;
        }
        pcm[index] = sample / 32768;
      }
      this.postInjectedPcm({ pcm, gain });
      return;
    }

    const payload = packet.payload.slice();
    this.decoderNode.port.postMessage({
      type: "decode",
      data: payload.buffer,
      gain,
      concealment,
      features: packet.features || {}
    }, [payload.buffer]);
  },

  postInjectedPcm(frame) {
    if (!this.decoderNode || !frame?.pcm) {
      return;
    }

    const pcm = frame.pcm instanceof Float32Array
      ? frame.pcm.slice()
      : new Float32Array(frame.pcm);

    this.decoderNode.port.postMessage({
      type: "inject-pcm",
      data: pcm.buffer,
      gain: frame.gain ?? 1,
      concealment: true
    }, [pcm.buffer]);
  },

  drainJitterBuffer() {
    if (!this.jitterBuffer || !this.decoderNode) {
      return;
    }
    if (!this.transportStats) {
      this.resetTransportStats();
    }

    const frames = this.jitterBuffer.drain(performance.now());
    for (const frame of frames) {
      if (frame.concealed) {
        this.transportStats.concealedFrames += 1;
      }

      if (frame.kind === "packet") {
        this.postDecodePacket(frame.packet, frame.gain, frame.concealed);
      } else if (frame.kind === "pcm") {
        this.postInjectedPcm(frame);
      }
    }

    if (frames.length > 0) {
      this.updateDiagnostics();
    }
  },

  sendEncodedFrame(payload, features = {}) {
    if (!this.transportStats) {
      this.resetTransportStats();
    }

    const sendBinary = (bytes) => {
      if (this.useRelayTransport()) {
        if (!this.relaySocket || this.relaySocket.readyState !== WebSocket.OPEN) {
          return false;
        }
        this.relaySocket.send(bytes);
        return true;
      }

      if (!this.dataChannel || this.dataChannel.readyState !== "open") {
        return false;
      }
      this.dataChannel.send(bytes);
      return true;
    };

    if (!this.packetizer || !this.headerCompressor) {
      sendBinary(payload);
      return;
    }

    const packet = this.packetizer.createPacket(payload, features);
    const compressed = this.headerCompressor.compress(packet);

    if (!sendBinary(compressed.bytes)) {
      return;
    }

    this.transportStats.sentPackets += 1;
    this.transportStats.sentHeaderBytes += compressed.headerBytes;
    this.transportStats.sentRawHeaderBytes += compressed.rawHeaderBytes;
    this.updateDiagnostics();
  },

  handleIncomingFrame(data) {
    if (!this.decoderNode) {
      return;
    }
    if (!this.transportStats) {
      this.resetTransportStats();
    }

    if (this.headerDecompressor && this.jitterBuffer) {
      try {
        const decoded = this.headerDecompressor.decompress(new Uint8Array(data));
        this.transportStats.receivedPackets += 1;
        this.transportStats.receivedHeaderBytes += decoded.headerBytes;
        this.transportStats.receivedRawHeaderBytes += decoded.rawHeaderBytes;
        this.jitterBuffer.push(decoded.packet, performance.now());
        this.updateDiagnostics();
        return;
      } catch (error) {
        log("Codec2 compressed packet parse failed", { message: error.message });
      }
    }

    this.decoderNode.port.postMessage(
      { type: "decode", data },
      [data]
    );
  },

  updateNetworkMetrics(metrics) {
    if (!this.jitterBuffer) {
      return;
    }

    this.jitterBuffer.updateNetworkMetrics(metrics);
    this.updateDiagnostics();
  },

  closeRelaySocket() {
    if (!this.relaySocket) {
      this.relayReady = false;
      return;
    }

    this.relaySocket.onopen = null;
    this.relaySocket.onclose = null;
    this.relaySocket.onerror = null;
    this.relaySocket.onmessage = null;

    try {
      this.relaySocket.close();
    } catch (error) {
      log("Codec2 relay socket close skipped", { message: error.message });
    }

    this.relaySocket = null;
    this.relayReady = false;
  },

  async connectRelaySocket() {
    if (!this.useRelayTransport()) {
      return;
    }

    this.closeRelaySocket();

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(buildMediaWebSocketUrl());
      socket.binaryType = "arraybuffer";
      let settled = false;

      socket.onopen = () => {
        this.relaySocket = socket;
        socket.send(JSON.stringify({
          type: "auth",
          roomId: state.roomId,
          participantId: state.participantId
        }));
      };

      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const message = JSON.parse(event.data);
            if (message.type === "media-ready") {
              this.relayReady = true;
              this.updateDiagnostics();
              this.syncActiveState().catch((error) => {
                log("Codec2 relay sync failed", { message: error.message });
              });
              if (!settled) {
                settled = true;
                resolve();
              }
              return;
            }

            if (message.type === "server-shutdown") {
              log("Codec2 relay server is restarting");
            } else if (message.type === "error") {
              log("Codec2 relay error", { message: message.error });
            }
          } catch (error) {
            log("Codec2 relay control parse failed", { message: error.message });
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          this.handleIncomingFrame(event.data);
        }
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Relay WebSocket connection failed"));
        }
      };

      socket.onclose = () => {
        this.relayReady = false;
        if (this.relaySocket === socket) {
          this.relaySocket = null;
        }
        this.syncActiveState().catch((error) => {
          log("Codec2 relay close sync failed", { message: error.message });
        });
        if (!settled) {
          settled = true;
          reject(new Error("Relay WebSocket closed before it connected"));
        }
      };
    });
  },

  handleWorkerMessage(kind, data) {
    if (data.type === "error") {
      log(`Codec2 ${kind} failed`, { message: data.error });
      this.desiredActive = false;
      this.syncActiveState().catch((error) => {
        log("Codec2 deactivation failed", { message: error.message });
      });
      return;
    }

    if (data.type === "ready") {
      this.samplesPerFrame = data.samplesPerFrame || this.samplesPerFrame;
      this.bytesPerFrame = data.bytesPerFrame || this.bytesPerFrame;
      this.ensureTransportPipeline();

      if (kind === "encoder") {
        this.encoderReady = true;
      } else {
        this.decoderReady = true;
      }

      if (this.encoderReady && this.decoderReady && !this.localReady) {
        this.localReady = true;
        log("Codec2 worklets ready", {
          mode: data.mode,
          samplesPerFrame: this.samplesPerFrame,
          bytesPerFrame: this.bytesPerFrame
        });
        this.maybeAnnounceReady();
        this.syncActiveState().catch((error) => {
          log("Codec2 activation sync failed", { message: error.message });
        });
      }
      return;
    }

    if (kind === "encoder" && data.type === "encoded") {
      if (this.active && this.dataChannel?.readyState === "open") {
        this.sendEncodedFrame(data.data, data.features || {});
      }
    }
  },

  attachDataChannel(channel) {
    if (this.dataChannel === channel) {
      return;
    }

    this.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      log("Codec2 data channel open");
      this.maybeAnnounceReady();
      this.syncActiveState().catch((error) => {
        log("Codec2 open sync failed", { message: error.message });
      });
    };
    channel.onclose = () => {
      log("Codec2 data channel closed");
      this.peerReady = false;
      this.readyAnnouncementSent = false;
      this.syncActiveState().catch((error) => {
        log("Codec2 close sync failed", { message: error.message });
      });
    };
    channel.onerror = () => {
      log("Codec2 data channel error");
    };
    channel.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "codec2-ready") {
            this.peerReady = true;
            log("Codec2 peer ready", {
              samplesPerFrame: message.samplesPerFrame,
              bytesPerFrame: message.bytesPerFrame
            });
            this.syncActiveState().catch((error) => {
              log("Codec2 peer sync failed", { message: error.message });
            });
          }
        } catch (error) {
          log("Codec2 control message ignored", { message: error.message });
        }
        return;
      }

      if (!(event.data instanceof ArrayBuffer) || !this.decoderNode) {
        return;
      }

      this.handleIncomingFrame(event.data);
    };
  },

  maybeAnnounceReady() {
    if (
      !this.localReady ||
      !this.dataChannel ||
      this.dataChannel.readyState !== "open" ||
      this.readyAnnouncementSent
    ) {
      return;
    }

    this.dataChannel.send(JSON.stringify({
      type: "codec2-ready",
      samplesPerFrame: this.samplesPerFrame,
      bytesPerFrame: this.bytesPerFrame
    }));
    this.readyAnnouncementSent = true;
  },

  async syncActiveState() {
    const transportReady = this.useRelayTransport()
      ? Boolean(
          this.relayReady &&
          this.relaySocket &&
          this.relaySocket.readyState === WebSocket.OPEN
        )
      : Boolean(
          this.peerReady &&
          this.dataChannel &&
          this.dataChannel.readyState === "open"
        );

    const shouldBeActive = Boolean(
      this.desiredActive &&
      this.localReady &&
      transportReady &&
      this.sender &&
      this.originalTrack
    );

    if (shouldBeActive === this.active) {
      return;
    }

    if (shouldBeActive) {
      await this.sender.replaceTrack(null);
      remoteAudio.muted = true;
      this.resetPlayoutState();
      this.active = true;
      log("Codec2 transport active", {
        samplesPerFrame: this.samplesPerFrame,
        bytesPerFrame: this.bytesPerFrame
      });
      this.updateDiagnostics();
      return;
    }

    if (this.sender && this.originalTrack) {
      await this.sender.replaceTrack(this.originalTrack);
    }
    remoteAudio.muted = false;
    this.active = false;
    this.resetPlayoutState();
    log("Codec2 transport inactive");
    this.updateDiagnostics();
  },

  async setDesiredActive(enabled) {
    this.desiredActive = Boolean(enabled);
    if (!this.isSupported()) {
      return;
    }
    await this.syncActiveState();
  },

  async init(peerConnection, localStream, { initiator = false } = {}) {
    this.teardown();
    if (!this.isSupported()) {
      return;
    }

    try {
      const wasmResponse = await fetch("/codec2.wasm");
      if (!wasmResponse.ok) {
        log("Codec2 WASM not found, skipping ultra-low-bitrate mode");
        return;
      }
      const wasmModule = await WebAssembly.compile(await wasmResponse.arrayBuffer());

      const audioCtx = new AudioContext({ sampleRate: 48000 });
      await audioCtx.resume().catch(() => {});
      await audioCtx.audioWorklet.addModule("/codec2-worker.js");

      // Encoder: local mic → Codec2 → DataChannel
      const encoderNode = new AudioWorkletNode(audioCtx, "codec2-encoder");
      const source = audioCtx.createMediaStreamSource(localStream);
      source.connect(encoderNode);
      encoderNode.port.onmessage = (e) => this.handleWorkerMessage("encoder", e.data);
      encoderNode.port.postMessage({ type: "init", module: wasmModule });

      // Decoder: DataChannel → Codec2 → speaker
      const decoderNode = new AudioWorkletNode(audioCtx, "codec2-decoder");
      decoderNode.connect(audioCtx.destination);
      decoderNode.port.onmessage = (e) => this.handleWorkerMessage("decoder", e.data);
      decoderNode.port.postMessage({ type: "init", module: wasmModule });

      this.sender = peerConnection
        .getSenders()
        .find((item) => item.track && item.track.kind === "audio") || null;
      this.originalTrack = localStream.getAudioTracks()[0] || null;
      this.desiredActive = state.audioProfile === "extreme";

      if (this.useRelayTransport()) {
        await this.connectRelaySocket();
      } else {
        peerConnection.ondatachannel = (event) => {
          if (event.channel.label === "codec2") {
            this.attachDataChannel(event.channel);
          }
        };

        if (initiator) {
          const channel = peerConnection.createDataChannel("codec2", {
            ordered: false,
            maxRetransmits: 0
          });
          this.attachDataChannel(channel);
        }
      }

      this.encoderNode = encoderNode;
      this.decoderNode = decoderNode;
      this.audioContext = audioCtx;
      this.resetTransportStats();
      log("Codec2 transport initialized");
      this.updateDiagnostics();
    } catch (error) {
      log("Codec2 init failed, using Opus", { message: error.message });
      this.teardown();
    }
  },

  teardown() {
    this.desiredActive = false;
    if (this.sender && this.originalTrack && this.active) {
      this.sender.replaceTrack(this.originalTrack).catch(() => {});
    }
    this.active = false;
    this.localReady = false;
    this.peerReady = false;
    this.encoderReady = false;
    this.decoderReady = false;
    this.readyAnnouncementSent = false;
    this.samplesPerFrame = 0;
    this.bytesPerFrame = 0;
    this.frameDurationMs = 20;
    this.relayReady = false;
    remoteAudio.muted = false;
    if (this.playoutIntervalId) {
      clearInterval(this.playoutIntervalId);
      this.playoutIntervalId = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
    }
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
    }
    this.closeRelaySocket();
    this.encoderNode = null;
    this.decoderNode = null;
    this.dataChannel = null;
    this.audioContext = null;
    this.sender = null;
    this.originalTrack = null;
    this.packetizer = null;
    this.headerCompressor = null;
    this.headerDecompressor = null;
    this.jitterBuffer = null;
    this.plcModel = null;
    this.neuralVocoder = null;
    this.resetTransportStats();
    this.updateDiagnostics();
  }
};
