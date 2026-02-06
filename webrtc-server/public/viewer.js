const MAX_SENDERS = 4;
const apiHost = location.hostname || "localhost";
const apiPort = location.port || "3000";
const apiProtocol = location.protocol === "https:" ? "https:" : "http:";
const apiBase = location.protocol === "file:"
  ? "http://localhost:3000"
  : `${apiProtocol}//${apiHost}:${apiPort}`;
const wsProtocol = apiProtocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProtocol}://${apiHost}:${apiPort}/ws?viewer`;
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
const loginOverlayEl = document.getElementById("loginOverlay");
const authFormEl = document.getElementById("authForm");
const authUsernameEl = document.getElementById("authUsername");
const authPasswordEl = document.getElementById("authPassword");
const togglePasswordEl = document.getElementById("togglePassword");
const authErrorEl = document.getElementById("authError");
const commandUserEl = document.getElementById("commandUser");
const footerEl = document.getElementById("footer");
const footerUserEl = document.getElementById("footerUser");
const logoutButtonEl = document.getElementById("logoutButton");
const commandFormEl = document.getElementById("commandForm");
const commandInputEl = document.getElementById("commandInput");
const commandHistoryEl = document.getElementById("commandHistory");
const exceptionCommentListEl = document.getElementById("exceptionCommentList");
const exceptionCommentFormEl = document.getElementById("exceptionCommentForm");
const exceptionCommentInputEl = document.getElementById("exceptionCommentInput");
const FALL_PREBUFFER_MS = 30000;
const slots = new Map();
const peerConnections = new Map();
let focusedSenderId = null;
let currentMode = "live";
const dismissedFallAlerts = new Set();
const commandHistoryBySender = new Map();
let currentUser = null;
const clipCommentsById = new Map();
let currentClipId = null;

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

const renderCommandHistory = (senderId) => {
  if (!commandHistoryEl) {
    return;
  }
  commandHistoryEl.innerHTML = "";
  const history = senderId ? commandHistoryBySender.get(senderId) : null;
  if (!history || history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "commandHistoryEmpty";
    empty.textContent = "No commands";
    commandHistoryEl.appendChild(empty);
    return;
  }
  for (const entry of history) {
    const item = document.createElement("div");
    item.className = "commandHistoryItem";
    const text = document.createElement("div");
    text.className = "commandHistoryText";
    text.textContent = `${entry.user}: ${entry.text}`;
    item.appendChild(text);
    if (currentUser && (currentUser.role === "admin" || entry.user === currentUser.username)) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "commandDelete";
      deleteButton.textContent = "Delete";
      deleteButton.dataset.id = entry.id;
      deleteButton.dataset.user = entry.user || "";
      item.appendChild(deleteButton);
    }
    commandHistoryEl.appendChild(item);
  }
  commandHistoryEl.scrollTop = commandHistoryEl.scrollHeight;
};

const recordCommand = (senderId, entry) => {
  if (!senderId) {
    return;
  }
  const history = commandHistoryBySender.get(senderId) || [];
  history.push(entry);
  commandHistoryBySender.set(senderId, history);
  renderCommandHistory(senderId);
};

const setCommandHistory = (senderId, entries) => {
  if (!senderId) {
    return;
  }
  commandHistoryBySender.set(senderId, entries || []);
  if (focusedSenderId === senderId) {
    renderCommandHistory(senderId);
  }
};

const updateAuthUi = () => {
  const loggedIn = Boolean(currentUser);
  if (loginOverlayEl) {
    loginOverlayEl.style.display = loggedIn ? "none" : "flex";
  }
  if (commandFormEl) {
    commandFormEl.style.display = loggedIn ? "flex" : "none";
  }
  if (commandUserEl) {
    commandUserEl.textContent = loggedIn
      ? `User: ${currentUser.username}`
      : "Login required";
  }
  if (footerEl) {
    footerEl.style.display = loggedIn ? "inline-flex" : "none";
  }
  if (footerUserEl) {
    footerUserEl.textContent = loggedIn
      ? `${currentUser.username} (${currentUser.role})`
      : "";
  }
  if (exceptionCommentFormEl) {
    exceptionCommentFormEl.style.display = loggedIn ? "flex" : "none";
  }
  renderCommandHistory(loggedIn ? focusedSenderId : null);
  renderClipComments(currentClipId, loggedIn ? clipCommentsById.get(currentClipId) : null);
};

const loadSession = async () => {
  try {
    const response = await fetch(`${apiBase}/api/session`, { credentials: "include" });
    if (!response.ok) {
      currentUser = null;
      updateAuthUi();
      return;
    }
    currentUser = await response.json();
    updateAuthUi();
  } catch (error) {
    currentUser = null;
    updateAuthUi();
  }
};

const renderClipComments = (clipId, comments) => {
  if (!exceptionCommentListEl) {
    return;
  }
  exceptionCommentListEl.innerHTML = "";
  if (!clipId) {
    const empty = document.createElement("div");
    empty.className = "exceptionCommentEmpty";
    empty.textContent = "Select a clip";
    exceptionCommentListEl.appendChild(empty);
    return;
  }
  if (!currentUser) {
    const empty = document.createElement("div");
    empty.className = "exceptionCommentEmpty";
    empty.textContent = "Login required";
    exceptionCommentListEl.appendChild(empty);
    return;
  }
  const list = comments || [];
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "exceptionCommentEmpty";
    empty.textContent = "No comments";
    exceptionCommentListEl.appendChild(empty);
    return;
  }
  for (const entry of list) {
    const item = document.createElement("div");
    item.className = "exceptionCommentItem";
    const text = document.createElement("div");
    text.className = "exceptionCommentText";
    text.textContent = `${entry.user}: ${entry.text}`;
    item.appendChild(text);
    if (currentUser && (currentUser.role === "admin" || entry.user === currentUser.username)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "exceptionCommentDelete";
      button.textContent = "Delete";
      button.dataset.id = entry.id;
      button.dataset.user = entry.user || "";
      item.appendChild(button);
    }
    exceptionCommentListEl.appendChild(item);
  }
  exceptionCommentListEl.scrollTop = exceptionCommentListEl.scrollHeight;
};

const loadClipComments = async (clipId) => {
  if (!clipId || !currentUser) {
    renderClipComments(clipId, null);
    return;
  }
  try {
    const response = await fetch(`${apiBase}/api/clip-comments?clipId=${encodeURIComponent(clipId)}`,
      { credentials: "include" }
    );
    if (!response.ok) {
      renderClipComments(clipId, null);
      return;
    }
    const comments = await response.json();
    clipCommentsById.set(clipId, comments);
    renderClipComments(clipId, comments);
  } catch (error) {
    renderClipComments(clipId, null);
  }
};

const selectClip = (clip) => {
  currentClipId = clip ? clip.id : null;
  const cached = currentClipId ? clipCommentsById.get(currentClipId) : null;
  renderClipComments(currentClipId, cached);
  if (currentClipId) {
    void loadClipComments(currentClipId);
  }
};

const submitClipComment = async () => {
  if (!currentUser || !currentClipId || !exceptionCommentInputEl) {
    return;
  }
  const text = exceptionCommentInputEl.value.trim();
  if (!text) {
    return;
  }
  try {
    const response = await fetch(`${apiBase}/api/clip-comments?clipId=${encodeURIComponent(currentClipId)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      }
    );
    if (!response.ok) {
      return;
    }
    const comments = await response.json();
    clipCommentsById.set(currentClipId, comments);
    renderClipComments(currentClipId, comments);
    exceptionCommentInputEl.value = "";
  } catch (error) {
    // ignore
  }
};

const sendCommand = () => {
  if (!commandInputEl || !focusedSenderId || !currentUser) {
    return;
  }
  const text = commandInputEl.value.trim();
  if (!text) {
    return;
  }
  ws.send(JSON.stringify({
    type: "command",
    senderId: focusedSenderId,
    text
  }));
  commandInputEl.value = "";
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
    const response = await fetch(`${apiBase}/api/fall-clips`, {
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
  currentClipId = null;
  renderClipComments(null, null);
  try {
    const response = await fetch(`${apiBase}/api/fall-clips`);
    if (!response.ok) {
      exceptionListEl.textContent = "No fall clips";
      renderClipComments(null, null);
      return;
    }
    const clips = await response.json();
    if (!Array.isArray(clips) || clips.length === 0) {
      exceptionListEl.textContent = "No fall clips";
      renderClipComments(null, null);
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
        selectClip(clip);
      });
      exceptionListEl.appendChild(item);
    }
  } catch (error) {
    exceptionListEl.textContent = "No fall clips";
    renderClipComments(null, null);
  }
};

const clearFocus = () => {
  if (!gridEl) {
    return;
  }
  document.body.classList.remove("focused");
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
  if (commandInputEl) {
    commandInputEl.value = "";
  }
  renderCommandHistory(null);
};

const focusSender = (senderId) => {
  if (!gridEl) {
    return;
  }
  const slot = slots.get(senderId);
  if (!slot || !slot.frame) {
    return;
  }
  document.body.classList.add("focused");
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
  if (commandInputEl) {
    commandInputEl.focus();
  }
  if (currentUser) {
    renderCommandHistory(senderId);
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

if (commandFormEl) {
  commandFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    sendCommand();
  });
}

if (exceptionCommentFormEl) {
  exceptionCommentFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitClipComment();
  });
}

if (exceptionCommentListEl) {
  exceptionCommentListEl.addEventListener("click", async (event) => {
    if (!currentUser || !currentClipId) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest(".exceptionCommentDelete");
    if (!button) {
      return;
    }
    const id = button.dataset.id;
    const owner = button.dataset.user || "";
    if (!id) {
      return;
    }
    if (currentUser.role !== "admin" && owner !== currentUser.username) {
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/clip-comments?clipId=${encodeURIComponent(currentClipId)}`,
        {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        }
      );
      if (!response.ok) {
        return;
      }
      const comments = await response.json();
      clipCommentsById.set(currentClipId, comments);
      renderClipComments(currentClipId, comments);
    } catch (error) {
      // ignore
    }
  });
}

if (authFormEl) {
  authFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authErrorEl) {
      authErrorEl.textContent = "";
    }
    const username = authUsernameEl ? authUsernameEl.value.trim() : "";
    const password = authPasswordEl ? authPasswordEl.value : "";
    if (!username || !password) {
      if (authErrorEl) {
        authErrorEl.textContent = "Enter username and password";
      }
      return;
    }
    try {
      const response = await fetch(`${apiBase}/api/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      if (!response.ok) {
        if (authErrorEl) {
          authErrorEl.textContent = "Login failed";
        }
        return;
      }
      location.reload();
    } catch (error) {
      if (authErrorEl) {
        authErrorEl.textContent = "Login failed";
      }
    }
  });
}

if (togglePasswordEl && authPasswordEl) {
  togglePasswordEl.addEventListener("click", () => {
    const isPassword = authPasswordEl.type === "password";
    authPasswordEl.type = isPassword ? "text" : "password";
    togglePasswordEl.textContent = isPassword ? "Hide" : "Show";
  });
}

if (logoutButtonEl) {
  logoutButtonEl.addEventListener("click", async () => {
    try {
      await fetch(`${apiBase}/api/logout`, {
        method: "POST",
        credentials: "include"
      });
    } catch (error) {
      // ignore
    }
    location.reload();
  });
}

if (commandHistoryEl) {
  commandHistoryEl.addEventListener("click", (event) => {
    if (!currentUser) {
      return;
    }
    if (!focusedSenderId) {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest(".commandDelete");
    if (!button) {
      return;
    }
    const id = button.dataset.id;
    const owner = button.dataset.user || "";
    if (!id) {
      return;
    }
    if (currentUser.role !== "admin" && owner !== currentUser.username) {
      return;
    }
    ws.send(JSON.stringify({
      type: "delete-command",
      senderId: focusedSenderId,
      id
    }));
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
  if (message.type === "command-entry") {
    if (message.senderId && message.entry) {
      recordCommand(message.senderId, message.entry);
    }
    return;
  }
  if (message.type === "command-history") {
    if (message.senderId) {
      setCommandHistory(message.senderId, message.entries || []);
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
    commandHistoryBySender.delete(senderId);
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
loadSession();
