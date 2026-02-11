const MAX_SENDERS = 4;
const apiHost = location.hostname || "localhost";
const apiPort = location.port || "3000";
const apiProtocol = location.protocol === "https:" ? "https:" : "http:";
const apiBase = location.protocol === "file:"
  ? "http://localhost:3000"
  : `${apiProtocol}//${apiHost}:${apiPort}`;
const wsProtocol = apiProtocol === "https:" ? "wss" : "ws";

const getSessionId = () => sessionStorage.getItem("session_id") || "";

const apiFetch = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  const sessionId = getSessionId();
  if (sessionId) {
    headers.set("X-Session-Id", sessionId);
  }
  return fetch(`${apiBase}${path}`,
    {
      credentials: "include",
      ...options,
      headers
    }
  );
};

const buildWsUrl = () => {
  const sid = getSessionId();
  const suffix = sid ? `&sid=${encodeURIComponent(sid)}` : "";
  return `${wsProtocol}://${apiHost}:${apiPort}/ws?viewer${suffix}`;
};

let ws = null;
let wsBoundSessionId = null;

const initWebSocket = () => {
  wsBoundSessionId = getSessionId() || "";
  const next = new WebSocket(buildWsUrl());
  ws = next;
  ws.onmessage = handleWsMessage;
  ws.onclose = handleWsClose;
  ws.onerror = handleWsError;
};

const ensureWebSocketSession = () => {
  const sid = getSessionId() || "";
  if (ws && wsBoundSessionId === sid) {
    return;
  }
  try {
    if (ws) {
      ws.close();
    }
  } catch (error) {
    // ignore
  }
  initWebSocket();
};
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
const approvalViewEl = document.getElementById("approvalView");
const approvalListEl = document.getElementById("approvalList");
const approvalRefreshEl = document.getElementById("approvalRefresh");
const usersViewEl = document.getElementById("usersView");
const usersListEl = document.getElementById("usersList");
const usersSaveButtonEl = document.getElementById("usersSave");
const usersSaveStatusEl = document.getElementById("usersSaveStatus");
const commandUserEl = document.getElementById("commandUser");
const commandPanelEl = document.getElementById("commandPanel");
const footerHostEl = document.getElementById("footerHost");
let footerUserWrapEl = null;
let footerUserButtonEl = null;
let footerDropdownEl = null;
let footerAccountButtonEl = null;
let footerLogoutButtonEl = null;
let loginButtonEl = null;
let documentClickHandler = null;
const commandFormEl = document.getElementById("commandForm");
const commandInputEl = document.getElementById("commandInput");
const commandHistoryEl = document.getElementById("commandHistory");
const exceptionCommentListEl = document.getElementById("exceptionCommentList");
const exceptionCommentFormEl = document.getElementById("exceptionCommentForm");
const exceptionCommentInputEl = document.getElementById("exceptionCommentInput");
const FALL_PREBUFFER_MS = 15000;
const FALL_POSTBUFFER_MS = 5000;
const FALL_CHUNK_MS = 1000;
const slots = new Map();
const peerConnections = new Map();
let focusedSenderId = null;
let currentMode = "live";
const dismissedFallAlerts = new Set();
const commandHistoryBySender = new Map();
let currentUser = null;
const clipCommentsById = new Map();
let currentClipId = null;

const pendingRoleChanges = new Map();

const setUsersSaveStatus = (text) => {
  if (usersSaveStatusEl) {
    usersSaveStatusEl.textContent = text || "";
  }
};

const updateUsersSaveUi = () => {
  if (usersSaveButtonEl) {
    usersSaveButtonEl.disabled = pendingRoleChanges.size === 0;
  }
  if (pendingRoleChanges.size === 0) {
    setUsersSaveStatus("");
  } else {
    setUsersSaveStatus(`Pending changes: ${pendingRoleChanges.size}`);
  }
};

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
    const displayName = currentUser ? (currentUser.nickname || currentUser.username) : "";
    const entryUsername = entry && typeof entry.userUsername === "string" ? entry.userUsername : "";
    const entryRole = entry && typeof entry.userRole === "string" ? entry.userRole : "";
    const isOwner = currentUser && ((entryUsername && entryUsername === currentUser.username)
      || entry.user === currentUser.username
      || entry.user === displayName);
    const isAdmin = currentUser && currentUser.role === "admin";
    const isManager = currentUser && currentUser.role === "manager";
    const canDeleteOther = isAdmin || (isManager && entryRole && entryRole !== "admin");
    if (currentUser && (isOwner || canDeleteOther)) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "commandDelete";
      deleteButton.textContent = "Delete";
      deleteButton.dataset.id = entry.id;
      deleteButton.dataset.user = entry.user || "";
      deleteButton.dataset.role = entryRole || "";
      deleteButton.dataset.username = entryUsername || "";
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
  const isAdmin = loggedIn && currentUser && currentUser.role === "admin";
  if (!loggedIn && (currentMode === "exception" || currentMode === "approval" || currentMode === "users")) {
    setMode("live");
  }
  if (!isAdmin && (currentMode === "approval" || currentMode === "users")) {
    setMode("live");
  }
  if (commandPanelEl) {
    commandPanelEl.style.display = loggedIn ? "" : "none";
  }
  const exceptionButton = document.getElementById("modeException");
  if (exceptionButton) {
    exceptionButton.style.display = loggedIn ? "" : "none";
  }
  const approvalButton = document.getElementById("modeApproval");
  if (approvalButton) {
    approvalButton.style.display = isAdmin ? "" : "none";
  }
  const usersButton = document.getElementById("modeUsers");
  if (usersButton) {
    usersButton.style.display = isAdmin ? "" : "none";
  }
  if (commandFormEl) {
    commandFormEl.style.display = loggedIn ? "flex" : "none";
  }
  if (commandUserEl) {
    commandUserEl.textContent = loggedIn
      ? `User: ${currentUser.nickname || currentUser.username}`
      : "Login required";
  }
  if (footerUserWrapEl) {
    footerUserWrapEl.style.display = loggedIn ? "inline-flex" : "none";
  }
  if (footerUserButtonEl) {
    footerUserButtonEl.textContent = loggedIn
      ? `${currentUser.nickname || currentUser.username} (${currentUser.role})`
      : "";
    footerUserButtonEl.disabled = !loggedIn;
  }
  closeFooterDropdown();
  if (loginButtonEl) {
    loginButtonEl.style.display = loggedIn ? "none" : "inline-flex";
  }
  if (exceptionCommentFormEl) {
    exceptionCommentFormEl.style.display = loggedIn ? "flex" : "none";
  }
  renderCommandHistory(loggedIn ? focusedSenderId : null);
  renderClipComments(currentClipId, loggedIn ? clipCommentsById.get(currentClipId) : null);
};

const closeFooterDropdown = () => {
  if (footerDropdownEl) {
    footerDropdownEl.classList.remove("visible");
  }
  if (footerUserButtonEl) {
    footerUserButtonEl.setAttribute("aria-expanded", "false");
  }
  if (documentClickHandler) {
    document.removeEventListener("click", documentClickHandler);
    documentClickHandler = null;
  }
};

const toggleFooterDropdown = () => {
  if (!footerDropdownEl || !footerUserButtonEl) {
    return;
  }
  const open = footerDropdownEl.classList.toggle("visible");
  footerUserButtonEl.setAttribute("aria-expanded", open ? "true" : "false");
  if (open && !documentClickHandler) {
    documentClickHandler = (event) => {
      if (!footerDropdownEl || !footerUserWrapEl) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!footerUserWrapEl.contains(target)) {
        closeFooterDropdown();
      }
    };
    setTimeout(() => {
      if (documentClickHandler) {
        document.addEventListener("click", documentClickHandler);
      }
    }, 0);
  }
  if (!open) {
    closeFooterDropdown();
  }
};

const loadSession = async () => {
  try {
    const response = await apiFetch("/api/session");
    if (!response.ok) {
      currentUser = null;
      updateAuthUi();
      return;
    }
    currentUser = await response.json();
    if (currentUser && currentUser.sessionId) {
      sessionStorage.setItem("session_id", String(currentUser.sessionId));
    }
    updateAuthUi();
    ensureWebSocketSession();
  } catch (error) {
    currentUser = null;
    updateAuthUi();
  }
};

const formatApprovalTimestamp = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return value || "";
  }
  return date.toLocaleString();
};

const renderSignupRequests = (requests) => {
  if (!approvalListEl) {
    return;
  }
  approvalListEl.innerHTML = "";

  if (!currentUser) {
    const empty = document.createElement("div");
    empty.className = "approvalReason";
    empty.textContent = "Login required";
    approvalListEl.appendChild(empty);
    return;
  }
  if (currentUser.role !== "admin") {
    const empty = document.createElement("div");
    empty.className = "approvalReason";
    empty.textContent = "Admin only";
    approvalListEl.appendChild(empty);
    return;
  }

  if (!Array.isArray(requests) || requests.length === 0) {
    const empty = document.createElement("div");
    empty.className = "approvalReason";
    empty.textContent = "No signup requests";
    approvalListEl.appendChild(empty);
    return;
  }

  for (const request of requests) {
    const item = document.createElement("div");
    item.className = "approvalItem";

    const meta = document.createElement("div");
    meta.className = "approvalMeta";

    const username = document.createElement("div");
    username.className = "approvalUsername";
    username.textContent = request.username || "";

    const requestedAt = document.createElement("div");
    requestedAt.className = "approvalRequestedAt";
    requestedAt.textContent = formatApprovalTimestamp(request.requestedAt);

    meta.appendChild(username);
    meta.appendChild(requestedAt);

    const reason = document.createElement("div");
    reason.className = "approvalReason";
    reason.textContent = request.reason || "";

    const actions = document.createElement("div");
    actions.className = "approvalActions";

    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "approvalApprove";
    approve.textContent = "승인";
    approve.dataset.action = "approve";
    approve.dataset.id = request.id;

    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "approvalReject";
    reject.textContent = "거절";
    reject.dataset.action = "reject";
    reject.dataset.id = request.id;

    actions.appendChild(approve);
    actions.appendChild(reject);

    item.appendChild(meta);
    item.appendChild(reason);
    item.appendChild(actions);
    approvalListEl.appendChild(item);
  }
};

const loadSignupRequests = async () => {
  if (!approvalListEl) {
    return;
  }
  if (!currentUser || currentUser.role !== "admin") {
    renderSignupRequests([]);
    return;
  }
  try {
    const response = await apiFetch("/api/admin/signup-requests");
    if (!response.ok) {
      renderSignupRequests([]);
      return;
    }
    const list = await response.json();
    renderSignupRequests(list);
  } catch (error) {
    renderSignupRequests([]);
  }
};

if (approvalRefreshEl) {
  approvalRefreshEl.addEventListener("click", () => {
    void loadSignupRequests();
  });
}

const renderUsers = (users) => {
  if (!usersListEl) {
    return;
  }
  usersListEl.innerHTML = "";

  if (!currentUser || currentUser.role !== "admin") {
    const empty = document.createElement("div");
    empty.className = "approvalReason";
    empty.textContent = "Admin only";
    usersListEl.appendChild(empty);
    return;
  }

  if (!Array.isArray(users) || users.length === 0) {
    const empty = document.createElement("div");
    empty.className = "approvalReason";
    empty.textContent = "No users";
    usersListEl.appendChild(empty);
    return;
  }

  for (const user of users) {
    const item = document.createElement("div");
    item.className = "userItem";
    const meta = document.createElement("div");
    meta.className = "userMeta";

    const name = document.createElement("div");
    name.className = "userName";
    name.textContent = user.username || "";

    const nick = document.createElement("div");
    nick.className = "userNick";
    nick.textContent = user.nickname ? `Chat: ${user.nickname}` : "";

    meta.appendChild(name);
    meta.appendChild(nick);

    const select = document.createElement("select");
    select.className = "userRoleSelect";
    select.dataset.id = user.id;
    const roles = ["user", "manager", "admin"];
    for (const role of roles) {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = role;
      if (role === user.role) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    if (user.username === currentUser.username) {
      select.disabled = true;
      select.title = "Cannot change your own role";
    }

    const pending = pendingRoleChanges.get(String(user.id));
    if (pending && pending !== user.role) {
      select.value = pending;
      select.classList.add("pending");
    } else {
      select.classList.remove("pending");
    }

    item.appendChild(meta);
    item.appendChild(select);
    usersListEl.appendChild(item);
  }
  updateUsersSaveUi();
};

const loadUsers = async () => {
  if (!usersListEl) {
    return;
  }
  if (!currentUser || currentUser.role !== "admin") {
    renderUsers([]);
    return;
  }
  try {
    const response = await apiFetch("/api/admin/users");
    if (!response.ok) {
      renderUsers([]);
      return;
    }
    const list = await response.json();
    renderUsers(list);
  } catch (error) {
    renderUsers([]);
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
    const displayName = currentUser ? (currentUser.nickname || currentUser.username) : "";
    const entryUsername = entry && typeof entry.userUsername === "string" ? entry.userUsername : "";
    const entryRole = entry && typeof entry.userRole === "string" ? entry.userRole : "";
    const isOwner = currentUser && ((entryUsername && entryUsername === currentUser.username)
      || entry.user === currentUser.username
      || entry.user === displayName);
    const isAdmin = currentUser && currentUser.role === "admin";
    const isManager = currentUser && currentUser.role === "manager";
    const canDeleteOther = isAdmin || (isManager && entryRole && entryRole !== "admin");
    if (currentUser && (isOwner || canDeleteOther)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "exceptionCommentDelete";
      button.textContent = "Delete";
      button.dataset.id = entry.id;
      button.dataset.user = entry.user || "";
      button.dataset.role = entryRole || "";
      button.dataset.username = entryUsername || "";
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
    const response = await apiFetch(`/api/clip-comments?clipId=${encodeURIComponent(clipId)}`);
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
    const response = await apiFetch(`/api/clip-comments?clipId=${encodeURIComponent(currentClipId)}`,
      {
        method: "POST",
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
  if (!ws) {
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
    bufferChunks: [],
    headerChunk: null,
    fallActive: false,
    fallStartedAt: null,
    fallStopTimer: null,
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
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp9",
    "video/webm"
  ];
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  slot.recorder = recorder;
  slot.streamId = stream.id;
  slot.stream = stream;
  slot.recordedChunks = [];
  slot.bufferChunks = [];
  slot.headerChunk = null;
  slot.fallActive = false;
  slot.fallStartedAt = null;
  if (slot.fallStopTimer) {
    clearTimeout(slot.fallStopTimer);
    slot.fallStopTimer = null;
  }
  slot.pendingUpload = false;
  slot.pendingSenderId = null;
  slot.restartAfterStop = false;

  recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) {
      return;
    }
    const now = Date.now();
    const entry = {
      data: event.data,
      timestamp: now
    };
    if (!slot.headerChunk) {
      slot.headerChunk = entry;
    }
    if (slot.fallActive || slot.pendingUpload) {
      slot.recordedChunks.push(entry);
      return;
    }
    slot.bufferChunks.push(entry);
    const cutoff = now - FALL_PREBUFFER_MS;
    while (slot.bufferChunks.length > 0 && slot.bufferChunks[0].timestamp < cutoff) {
      slot.bufferChunks.shift();
    }
  };

  recorder.onstop = () => {
    const chunks = slot.recordedChunks;
    const senderId = slot.pendingSenderId;
    const fallStartedAt = slot.fallStartedAt;
    const headerChunk = slot.headerChunk;
    const shouldUpload = slot.pendingUpload;
    const shouldRestart = slot.restartAfterStop;
    const nextStream = slot.stream;
    slot.recordedChunks = [];
    slot.pendingUpload = false;
    slot.pendingSenderId = null;
    slot.restartAfterStop = false;
    slot.fallStartedAt = null;
    slot.headerChunk = null;
    if (slot.fallStopTimer) {
      clearTimeout(slot.fallStopTimer);
      slot.fallStopTimer = null;
    }
    slot.recorder = null;
    if (shouldUpload) {
      void finalizeFallClipData(chunks, senderId, fallStartedAt, headerChunk);
    }
    if (shouldRestart && nextStream) {
      startRecorder(slot, nextStream);
    }
  };

  recorder.start(FALL_CHUNK_MS);
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
  slot.bufferChunks = [];
  slot.fallActive = false;
  slot.headerChunk = null;
  if (slot.fallStopTimer) {
    clearTimeout(slot.fallStopTimer);
    slot.fallStopTimer = null;
  }
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
  if (slot.fallStopTimer) {
    clearTimeout(slot.fallStopTimer);
    slot.fallStopTimer = null;
  }
  if (slot.bufferChunks && slot.bufferChunks.length > 0) {
    slot.recordedChunks = slot.bufferChunks.slice();
    slot.bufferChunks = [];
  } else {
    slot.recordedChunks = [];
  }
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
  if (slot.fallStopTimer) {
    clearTimeout(slot.fallStopTimer);
  }
  slot.fallStopTimer = setTimeout(() => {
    slot.fallStopTimer = null;
    if (!slot.recorder || slot.recorder.state !== "recording") {
      return;
    }
    if (slot.fallActive) {
      return;
    }
    slot.recorder.stop();
  }, FALL_POSTBUFFER_MS);
};

const normalizeFallChunks = (chunks, fallStartedAt, headerChunk) => {
  const data = [];
  let firstTimestamp = null;
  let lastTimestamp = null;
  for (const entry of chunks) {
    if (!entry) {
      continue;
    }
    if (entry.data) {
      data.push(entry.data);
      if (Number.isFinite(entry.timestamp)) {
        if (firstTimestamp === null) {
          firstTimestamp = entry.timestamp;
        }
        lastTimestamp = entry.timestamp;
      }
    } else {
      data.push(entry);
    }
  }
  let durationMs = 0;
  if (firstTimestamp !== null && lastTimestamp !== null) {
    durationMs = Math.max(FALL_CHUNK_MS, lastTimestamp - firstTimestamp + FALL_CHUNK_MS);
  } else if (Number.isFinite(fallStartedAt)) {
    durationMs = Math.max(FALL_CHUNK_MS, Date.now() - fallStartedAt);
  } else {
    durationMs = data.length * FALL_CHUNK_MS;
  }
  if (headerChunk && headerChunk.data && data.length > 0) {
    const headerData = headerChunk.data;
    const headerIndex = data.indexOf(headerData);
    if (headerIndex === 0) {
      return { data, durationMs };
    }
    if (headerIndex > 0) {
      data.splice(headerIndex, 1);
    }
    data.unshift(headerData);
  }
  return { data, durationMs };
};

const getVintLength = (firstByte) => {
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (firstByte & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  return length <= 8 ? length : null;
};

const readVintId = (data, offset) => {
  const length = getVintLength(data[offset]);
  if (!length || offset + length > data.length) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = (value << 8) + data[offset + i];
  }
  return { length, value };
};

const readVintSize = (data, offset) => {
  const length = getVintLength(data[offset]);
  if (!length || offset + length > data.length) {
    return null;
  }
  const mask = 0xFF >> length;
  let value = data[offset] & mask;
  for (let i = 1; i < length; i += 1) {
    value = (value << 8) + data[offset + i];
  }
  const max = Math.pow(2, 7 * length) - 1;
  if (value === max) {
    return { length, value: -1 };
  }
  return { length, value };
};

const fixWebmDuration = async (blob, durationMs) => {
  if (!blob || !Number.isFinite(durationMs) || durationMs <= 0) {
    return blob;
  }
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);
  let offset = 0;
  let segmentStart = null;
  let segmentEnd = data.length;

  while (offset < data.length) {
    const id = readVintId(data, offset);
    if (!id) {
      break;
    }
    offset += id.length;
    const size = readVintSize(data, offset);
    if (!size) {
      break;
    }
    offset += size.length;
    if (id.value === 0x18538067) {
      segmentStart = offset;
      segmentEnd = size.value === -1 ? data.length : offset + size.value;
      break;
    }
    offset += size.value === -1 ? 0 : size.value;
  }

  if (segmentStart === null) {
    return blob;
  }

  let infoOffset = null;
  let infoSize = null;
  let timecodeScale = 1000000;
  offset = segmentStart;

  while (offset < segmentEnd) {
    const id = readVintId(data, offset);
    if (!id) {
      break;
    }
    offset += id.length;
    const size = readVintSize(data, offset);
    if (!size) {
      break;
    }
    offset += size.length;
    if (id.value === 0x1549A966) {
      infoOffset = offset;
      infoSize = size.value;
      break;
    }
    offset += size.value === -1 ? 0 : size.value;
  }

  if (infoOffset === null || infoSize === null || infoSize === -1) {
    return blob;
  }

  let durationOffset = null;
  let durationSize = null;
  const infoEnd = infoOffset + infoSize;
  offset = infoOffset;

  while (offset < infoEnd) {
    const id = readVintId(data, offset);
    if (!id) {
      break;
    }
    offset += id.length;
    const size = readVintSize(data, offset);
    if (!size) {
      break;
    }
    offset += size.length;
    if (id.value === 0x2AD7B1) {
      let scale = 0;
      for (let i = 0; i < size.value; i += 1) {
        scale = (scale << 8) + data[offset + i];
      }
      if (scale > 0) {
        timecodeScale = scale;
      }
    }
    if (id.value === 0x4489) {
      durationOffset = offset;
      durationSize = size.value;
      break;
    }
    offset += size.value;
  }

  if (durationOffset === null || !durationSize) {
    return blob;
  }

  const duration = (durationMs * 1000000) / timecodeScale;
  const view = new DataView(buffer);
  if (durationSize === 4) {
    view.setFloat32(durationOffset, duration);
  } else {
    view.setFloat64(durationOffset, duration);
  }

  return new Blob([buffer], { type: "video/webm" });
};

const finalizeFallClipData = async (chunks, senderId, fallStartedAt, headerChunk) => {
  if (!chunks || chunks.length === 0) {
    return;
  }
  const { data } = normalizeFallChunks(chunks, fallStartedAt, headerChunk);
  if (data.length === 0) {
    return;
  }
  const blob = new Blob(data, { type: "video/webm" });
  const timestamp = new Date(fallStartedAt || Date.now()).toISOString();
  void uploadFallClip(blob, senderId, timestamp);
};

const uploadFallClip = async (blob, senderId, timestamp) => {
  try {
    const response = await apiFetch("/api/fall-clips", {
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
    const response = await apiFetch("/api/fall-clips");
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
      const row = document.createElement("div");
      row.className = "exceptionItemRow";

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
      row.appendChild(item);

      if (currentUser && currentUser.role === "admin") {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "exceptionClipDelete";
        del.textContent = "Delete";
        del.dataset.id = clip.id;
        del.addEventListener("click", async (event) => {
          event.stopPropagation();
          const clipId = del.dataset.id;
          if (!clipId) {
            return;
          }
          if (!confirm("Delete this clip?")) {
            return;
          }
          try {
            const res = await apiFetch(`/api/fall-clips?id=${encodeURIComponent(clipId)}`,
              { method: "DELETE" }
            );
            if (!res.ok) {
              return;
            }
            if (currentClipId === clipId) {
              currentClipId = null;
              clipCommentsById.delete(clipId);
              renderClipComments(null, null);
              if (exceptionPlayerEl) {
                exceptionPlayerEl.pause();
                exceptionPlayerEl.removeAttribute("src");
                exceptionPlayerEl.load();
              }
            }
            await loadFallClips();
          } catch (error) {
            // ignore
          }
        });
        row.appendChild(del);
      }

      exceptionListEl.appendChild(row);
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
  document.body.classList.toggle("mode-approval", mode === "approval");
  document.body.classList.toggle("mode-users", mode === "users");
  if (mode === "exception") {
    clearFocus();
    if (exceptionPlayerEl) {
      exceptionPlayerEl.pause();
    }
    void loadFallClips();
  } else if (mode === "approval") {
    clearFocus();
    if (exceptionPlayerEl) {
      exceptionPlayerEl.pause();
    }
    void loadSignupRequests();
  } else if (mode === "users") {
    clearFocus();
    if (exceptionPlayerEl) {
      exceptionPlayerEl.pause();
    }
    void loadUsers();
  }
  const liveButton = document.getElementById("modeLive");
  const exceptionButton = document.getElementById("modeException");
  const approvalButton = document.getElementById("modeApproval");
  const usersButton = document.getElementById("modeUsers");
  if (liveButton) {
    liveButton.classList.toggle("active", mode === "live");
  }
  if (exceptionButton) {
    exceptionButton.classList.toggle("active", mode === "exception");
  }
  if (approvalButton) {
    approvalButton.classList.toggle("active", mode === "approval");
  }
  if (usersButton) {
    usersButton.classList.toggle("active", mode === "users");
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
    const approvalButton = document.getElementById("modeApproval");
    const usersButton = document.getElementById("modeUsers");
    if (liveButton) {
      liveButton.addEventListener("click", () => setMode("live"));
    }
    if (exceptionButton) {
      exceptionButton.addEventListener("click", () => setMode("exception"));
    }
    if (approvalButton) {
      approvalButton.addEventListener("click", () => setMode("approval"));
    }
    if (usersButton) {
      usersButton.addEventListener("click", () => setMode("users"));
    }
    setMode("live");
    updateAuthUi();
  } catch (error) {
    // ignore
  }
};

if (usersListEl) {
  usersListEl.addEventListener("change", async (event) => {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) {
      return;
    }
    if (!target.classList.contains("userRoleSelect")) {
      return;
    }
    const id = target.dataset.id;
    const role = target.value;
    if (!id || (role !== "admin" && role !== "manager" && role !== "user")) {
      return;
    }
    pendingRoleChanges.set(String(id), role);
    target.classList.add("pending");
    updateUsersSaveUi();
  });
}

if (usersSaveButtonEl) {
  usersSaveButtonEl.addEventListener("click", async () => {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }
    if (pendingRoleChanges.size === 0) {
      return;
    }
    usersSaveButtonEl.disabled = true;
    setUsersSaveStatus("Saving...");

    const entries = Array.from(pendingRoleChanges.entries());
    for (const [id, role] of entries) {
      try {
        const response = await apiFetch("/api/admin/users/role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, role })
        });
        if (!response.ok) {
          setUsersSaveStatus("Failed to save");
          updateUsersSaveUi();
          return;
        }
      } catch (error) {
        setUsersSaveStatus("Failed to save");
        updateUsersSaveUi();
        return;
      }
    }

    pendingRoleChanges.clear();
    setUsersSaveStatus("Saved");
    void loadUsers();
  });
}

const initFooter = async () => {
  if (!footerHostEl) {
    return;
  }
  try {
    const response = await fetch("footer.html");
    if (!response.ok) {
      return;
    }
    footerHostEl.innerHTML = await response.text();
    footerUserWrapEl = document.getElementById("footerUserWrap");
    footerUserButtonEl = document.getElementById("footerUserButton");
    footerDropdownEl = document.getElementById("footerDropdown");
    footerAccountButtonEl = document.getElementById("footerAccountButton");
    footerLogoutButtonEl = document.getElementById("footerLogoutButton");
    loginButtonEl = document.getElementById("loginButton");

    if (footerUserButtonEl) {
      footerUserButtonEl.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleFooterDropdown();
      });
    }

    if (footerAccountButtonEl) {
      footerAccountButtonEl.addEventListener("click", () => {
        closeFooterDropdown();
        location.href = "account.html";
      });
    }

    if (footerLogoutButtonEl) {
      footerLogoutButtonEl.addEventListener("click", async () => {
        closeFooterDropdown();
        try {
          await apiFetch("/api/logout", { method: "POST" });
        } catch (error) {
          // ignore
        }
        sessionStorage.removeItem("session_id");
        location.reload();
      });
    }

    if (loginButtonEl) {
      loginButtonEl.addEventListener("click", () => {
        location.href = "login.html";
      });
    }

    updateAuthUi();
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
    const ownerRole = button.dataset.role || "";
    const ownerUsername = button.dataset.username || "";
    if (!id) {
      return;
    }
    const displayName = currentUser.nickname || currentUser.username;
    const elevated = currentUser.role === "admin" || currentUser.role === "manager";
    const isOwner = (ownerUsername && ownerUsername === currentUser.username)
      || owner === currentUser.username
      || owner === displayName;
    if (currentUser.role === "manager" && !isOwner) {
      if (!ownerRole) {
        return;
      }
      if (ownerRole === "admin") {
        return;
      }
    }
    if (!elevated && !isOwner) {
      return;
    }
    try {
      const response = await apiFetch(`/api/clip-comments?clipId=${encodeURIComponent(currentClipId)}`,
        {
          method: "DELETE",
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

if (approvalListEl) {
  approvalListEl.addEventListener("click", async (event) => {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const button = target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const action = button.dataset.action;
    const id = button.dataset.id;
    if (!id || (action !== "approve" && action !== "reject")) {
      return;
    }
    const endpoint = action === "approve"
      ? "/api/admin/signup-requests/approve"
      : "/api/admin/signup-requests/reject";
    try {
      const response = await fetch(`${apiBase}${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
      if (!response.ok) {
        return;
      }
      await loadSignupRequests();
    } catch (error) {
      // ignore
    }
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
    const ownerRole = button.dataset.role || "";
    const ownerUsername = button.dataset.username || "";
    if (!id) {
      return;
    }
    const displayName = currentUser.nickname || currentUser.username;
    const elevated = currentUser.role === "admin" || currentUser.role === "manager";
    const isOwner = (ownerUsername && ownerUsername === currentUser.username)
      || owner === currentUser.username
      || owner === displayName;
    if (currentUser.role === "manager" && !isOwner) {
      if (!ownerRole) {
        return;
      }
      if (ownerRole === "admin") {
        return;
      }
    }
    if (!elevated && !isOwner) {
      return;
    }
    if (!ws) {
      return;
    }
    ws.send(JSON.stringify({
      type: "delete-command",
      senderId: focusedSenderId,
      id
    }));
  });
}

const handleWsMessage = async (event) => {
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

const handleWsClose = () => {
  showOfflineAll();
};

const handleWsError = () => {
  showOfflineAll();
};

initWebSocket();
initHeader();
initFooter();
updateAuthUi();
loadSession();
