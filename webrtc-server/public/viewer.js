const MAX_SENDERS = 4;
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const wsPort = location.port || "3000";
const wsUrl = `${wsProtocol}://${location.hostname}:${wsPort}/ws?viewer`;
const ws = new WebSocket(wsUrl);
const viewerCountEl = document.getElementById("viewerCount");
const headerHostEl = document.getElementById("headerHost");
const gridEl = document.getElementById("grid");
const backButton = document.getElementById("backButton");
const fallAlertEl = document.getElementById("fallAlert");
const fallAlertTextEl = document.getElementById("fallAlertText");
const fallAlertCloseEl = document.getElementById("fallAlertClose");
const exceptionViewEl = document.getElementById("exceptionView");
const exceptionListEl = document.getElementById("exceptionList");
const exceptionPlayerEl = document.getElementById("exceptionPlayer");
const FALL_PREBUFFER_MS = 10000;
const slots = new Map();
const peerConnections = new Map();
let focusedSenderId = null;
let currentMode = "live";
const dismissedFallAlerts = new Set();

const showFallAlert = (senderId) => {
  if (!fallAlertEl) {
    return;
  }
  if (fallAlertTextEl) {
    fallAlertTextEl.textContent = `${senderId}번 화면에서 낙상이 발생했습니다!`;
  }
  fallAlertEl.dataset.senderId = senderId;
  fallAlertEl.classList.add("visible");
};

const hideFallAlert = () => {
  if (!fallAlertEl) {
    return;
  }
  fallAlertEl.classList.remove("visible");
  delete fallAlertEl.dataset.senderId;
};

const showOffline = (senderId) => {
  const slot = slots.get(senderId);
  if (slot && slot.offline) {
    slot.offline.style.display = "block";
  }
};

const hideOffline = (senderId) => {
  const slot = slots.get(senderId);
  if (slot && slot.offline) {
    slot.offline.style.display = "none";
  }
};

const clearStream = (senderId) => {
  const slot = slots.get(senderId);
  if (slot && slot.video) {
    slot.video.srcObject = null;
  }
  stopRecorder(slot);
};

const showOfflineAll = () => {
  for (const senderId of slots.keys()) {
    showOffline(senderId);
    clearStream(senderId);
  }
};

const ensurePeerConnection = (senderId) => {
  if (!senderId || !slots.has(senderId)) {
    return null;
  }
  const existing = peerConnections.get(senderId);
  if (existing) {
    return existing;
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  peerConnections.set(senderId, pc);

  pc.ontrack = (event) => {
    const slot = slots.get(senderId);
    if (slot && event.streams && event.streams[0]) {
      slot.video.srcObject = event.streams[0];
      hideOffline(senderId);
      startRecorder(slot, event.streams[0]);
    }
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === "connected") {
      hideOffline(senderId);
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      showOffline(senderId);
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: "candidate",
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        candidate: event.candidate.candidate,
        senderId
      }));
    }
  };

  return pc;
};

for (let i = 1; i <= MAX_SENDERS; i += 1) {
  const senderId = String(i);
  const video = document.getElementById(`remoteVideo${i}`);
  const offline = document.getElementById(`offlineImage${i}`);
  const label = document.getElementById(`poseLabel${i}`);
  const frame = video ? video.closest(".videoFrame") : null;
  slots.set(senderId, {
    video,
    offline,
    frame,
    label,
    recorder: null,
    recordedChunks: [],
    fallActive: false,
    fallStartedAt: null,
    isFallen: false,
    streamId: null,
    stream: null,
    rollTimer: null,
    pendingUpload: false,
    pendingSenderId: null,
    restartAfterStop: false
  });
  showOffline(senderId);
}

const startRecorder = (slot, stream) => {
  if (!slot || !stream || !window.MediaRecorder) {
    return;
  }
  if (slot.streamId === stream.id && slot.recorder) {
    return;
  }
  stopRecorder(slot);
  const mimeTypes = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  slot.recorder = recorder;
  slot.streamId = stream.id;
  slot.stream = stream;
  slot.recordedChunks = [];
  slot.fallActive = false;
  slot.fallStartedAt = null;
  slot.pendingUpload = false;
  slot.pendingSenderId = null;
  slot.restartAfterStop = false;

  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }
    slot.recordedChunks.push(event.data);
  };

  recorder.onstop = () => {
    const chunks = slot.recordedChunks;
    const senderId = slot.pendingSenderId;
    const fallStartedAt = slot.fallStartedAt;
    const shouldUpload = slot.pendingUpload;
    const shouldRestart = slot.restartAfterStop;
    const nextStream = slot.stream;
    slot.recordedChunks = [];
    slot.pendingUpload = false;
    slot.pendingSenderId = null;
    slot.restartAfterStop = false;
    slot.fallStartedAt = null;
    slot.recorder = null;
    if (shouldUpload) {
      finalizeFallClipData(chunks, senderId, fallStartedAt);
    }
    if (shouldRestart && nextStream) {
      startRecorder(slot, nextStream);
      scheduleRecorderRoll(slot);
    }
  };

  recorder.start();
  scheduleRecorderRoll(slot);
};

const stopRecorder = (slot) => {
  if (!slot || !slot.recorder) {
    return;
  }
  if (slot.rollTimer) {
    clearTimeout(slot.rollTimer);
    slot.rollTimer = null;
  }
  if (slot.recorder.state !== "inactive") {
    slot.recorder.stop();
  }
  slot.recordedChunks = [];
  slot.fallActive = false;
  slot.streamId = null;
  slot.stream = null;
  slot.pendingUpload = false;
  slot.pendingSenderId = null;
  slot.restartAfterStop = false;
};

const scheduleRecorderRoll = (slot) => {
  if (!slot || !slot.recorder) {
    return;
  }
  if (slot.rollTimer) {
    clearTimeout(slot.rollTimer);
  }
  slot.rollTimer = setTimeout(() => {
    if (!slot.fallActive) {
      rollRecorder(slot);
    }
  }, FALL_PREBUFFER_MS);
};

const rollRecorder = (slot) => {
  if (!slot || !slot.recorder || slot.recorder.state !== "recording") {
    return;
  }
  slot.pendingUpload = false;
  slot.pendingSenderId = null;
  slot.restartAfterStop = true;
  slot.recordedChunks = [];
  slot.recorder.stop();
};

const startFallClip = (slot) => {
  if (!slot || !slot.recorder) {
    return;
  }
  slot.fallActive = true;
  slot.fallStartedAt = Date.now();
  if (slot.rollTimer) {
    clearTimeout(slot.rollTimer);
    slot.rollTimer = null;
  }
};

const finishFallClip = (slot, senderId) => {
  if (!slot) {
    return;
  }
  slot.fallActive = false;
  if (!slot.recorder || slot.recorder.state !== "recording") {
    return;
  }
  slot.pendingUpload = true;
  slot.pendingSenderId = senderId;
  slot.restartAfterStop = true;
  slot.recorder.stop();
};

const finalizeFallClipData = (chunks, senderId, fallStartedAt) => {
  if (!chunks || chunks.length === 0) {
    return;
  }
  const blob = new Blob(chunks, { type: "video/webm" });
  const timestamp = new Date(fallStartedAt || Date.now()).toISOString();
  void uploadFallClip(blob, senderId, timestamp);
};

const uploadFallClip = async (blob, senderId, timestamp) => {
  try {
    const response = await fetch("/api/fall-clips", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Fall-Sender": senderId,
        "X-Fall-Timestamp": timestamp
      },
      body: blob
    });
    if (response.ok && currentMode === "exception") {
      await loadFallClips();
    }
  } catch (error) {
    // ignore
  }
};

const formatClipLabel = (timestamp) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "fallen";
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}월 ${day}일 ${hour}시 ${minute}분 fallen`;
};

const loadFallClips = async () => {
  if (!exceptionListEl) {
    return;
  }
  exceptionListEl.innerHTML = "";
  try {
    const response = await fetch("/api/fall-clips");
    if (!response.ok) {
      exceptionListEl.textContent = "No fall clips";
      return;
    }
    const clips = await response.json();
    if (!Array.isArray(clips) || clips.length === 0) {
      exceptionListEl.textContent = "No fall clips";
      return;
    }
    for (const clip of clips) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "exceptionItem";
      item.textContent = formatClipLabel(clip.timestamp || clip.createdAt);
      item.addEventListener("click", () => {
        if (exceptionPlayerEl) {
          exceptionPlayerEl.src = clip.url;
          exceptionPlayerEl.play();
        }
        for (const button of exceptionListEl.querySelectorAll(".exceptionItem")) {
          button.classList.toggle("active", button === item);
        }
      });
      exceptionListEl.appendChild(item);
    }
  } catch (error) {
    exceptionListEl.textContent = "No fall clips";
  }
};

const clearFocus = () => {
  if (!gridEl) {
    return;
  }
  focusedSenderId = null;
  gridEl.classList.remove("focused");
  for (const slot of slots.values()) {
    if (slot.frame) {
      slot.frame.classList.remove("focused");
    }
  }
  if (backButton) {
    backButton.classList.remove("visible");
  }
};

const focusSender = (senderId) => {
  if (!gridEl) {
    return;
  }
  const slot = slots.get(senderId);
  if (!slot || !slot.frame) {
    return;
  }
  focusedSenderId = senderId;
  gridEl.classList.add("focused");
  for (const [id, entry] of slots.entries()) {
    if (entry.frame) {
      entry.frame.classList.toggle("focused", id === senderId);
    }
  }
  if (backButton) {
    backButton.classList.add("visible");
  }
};

const setMode = (mode) => {
  currentMode = mode;
  document.body.classList.toggle("mode-exception", mode === "exception");
  if (mode === "exception") {
    clearFocus();
    if (exceptionPlayerEl) {
      exceptionPlayerEl.pause();
    }
    void loadFallClips();
  }
  const liveButton = document.getElementById("modeLive");
  const exceptionButton = document.getElementById("modeException");
  if (liveButton) {
    liveButton.classList.toggle("active", mode === "live");
  }
  if (exceptionButton) {
    exceptionButton.classList.toggle("active", mode === "exception");
  }
};

const initHeader = async () => {
  if (!headerHostEl) {
    return;
  }
  try {
    const response = await fetch("header.html");
    if (!response.ok) {
      return;
    }
    headerHostEl.innerHTML = await response.text();
    const liveButton = document.getElementById("modeLive");
    const exceptionButton = document.getElementById("modeException");
    if (liveButton) {
      liveButton.addEventListener("click", () => setMode("live"));
    }
    if (exceptionButton) {
      exceptionButton.addEventListener("click", () => setMode("exception"));
    }
    setMode("live");
  } catch (error) {
    // ignore
  }
};

if (fallAlertEl) {
  fallAlertEl.addEventListener("click", () => {
    const senderId = fallAlertEl.dataset.senderId;
    if (!senderId) {
      return;
    }
    setMode("live");
    focusSender(senderId);
    hideFallAlert();
  });
}

if (fallAlertCloseEl) {
  fallAlertCloseEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (fallAlertEl && fallAlertEl.dataset.senderId) {
      dismissedFallAlerts.add(fallAlertEl.dataset.senderId);
    }
    hideFallAlert();
  });
}

if (backButton) {
  backButton.addEventListener("click", () => {
    clearFocus();
  });
}

ws.onmessage = async (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "viewer-id") {
    return;
  }
  if (message.type === "viewer-count") {
    if (viewerCountEl) {
      viewerCountEl.textContent = `Viewers: ${message.count}`;
    }
    return;
  }
  if (message.type === "pose-label") {
    const senderId = message.senderId;
    const slot = slots.get(senderId);
    if (slot && slot.label) {
      const text = message.label || "";
      slot.label.textContent = text;
      slot.label.style.display = text ? "block" : "none";
      if (slot.frame) {
        slot.frame.classList.toggle("fallen", text === "Fallen");
      }
      const isFallen = text === "Fallen";
      if (isFallen && !slot.isFallen) {
        startFallClip(slot);
      }
      if (!isFallen && slot.isFallen) {
        finishFallClip(slot, senderId);
      }
      slot.isFallen = isFallen;
      if (text !== "Fallen") {
        dismissedFallAlerts.delete(senderId);
        if (fallAlertEl && fallAlertEl.dataset.senderId === senderId) {
          hideFallAlert();
        }
      }
      if (text === "Fallen"
          && ((currentMode === "exception")
            || (focusedSenderId && senderId !== focusedSenderId))
          && !dismissedFallAlerts.has(senderId)) {
        showFallAlert(senderId);
      }
    }
    return;
  }
  if (message.type === "offer") {
    const senderId = message.senderId;
    const pc = ensurePeerConnection(senderId);
    if (!pc) {
      return;
    }
    await pc.setRemoteDescription({
      type: "offer",
      sdp: message.sdp
    });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({
      type: "answer",
      sdp: answer.sdp,
      senderId
    }));
  } else if (message.type === "candidate") {
    const senderId = message.senderId;
    const pc = ensurePeerConnection(senderId);
    if (!pc) {
      return;
    }
    await pc.addIceCandidate({
      sdpMid: message.sdpMid,
      sdpMLineIndex: message.sdpMLineIndex,
      candidate: message.candidate
    });
  } else if (message.type === "sender-disconnected") {
    const senderId = message.senderId;
    const pc = peerConnections.get(senderId);
    if (pc) {
      pc.close();
      peerConnections.delete(senderId);
    }
    showOffline(senderId);
    clearStream(senderId);
    const slot = slots.get(senderId);
    if (slot && slot.label) {
      slot.label.textContent = "";
      slot.label.style.display = "none";
    }
    if (slot && slot.frame) {
      slot.frame.classList.remove("fallen");
    }
    if (slot) {
      finishFallClip(slot, senderId);
      slot.isFallen = false;
    }
    if (fallAlertEl && fallAlertEl.dataset.senderId === senderId) {
      hideFallAlert();
    }
    dismissedFallAlerts.delete(senderId);
    if (focusedSenderId === senderId) {
      clearFocus();
    }
  }
};

for (const [senderId, slot] of slots.entries()) {
  if (!slot.frame) {
    continue;
  }
  slot.frame.addEventListener("click", () => {
    if (focusedSenderId === senderId) {
      return;
    }
    focusSender(senderId);
  });
}

ws.onclose = () => {
  showOfflineAll();
};

ws.onerror = () => {
  showOfflineAll();
};

initHeader();
