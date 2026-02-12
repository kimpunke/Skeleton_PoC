const MAX_SENDERS = 4;
import { apiFetch, buildWsUrl, getSessionId } from "./api.js";
import { createRecordingController } from "./recording.js";
import { createCommandController } from "./commands.js";
import { createAdminController } from "./admin.js";
import { createClipController } from "./clips.js";
import { createRtcController } from "./rtc.js";
import { createWebSocketController } from "./ws.js";

let webSocketController = null;
let rtcController = null;
let adminController = null;
let clipController = null;
let commandController = null;
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
const exceptionRefreshEl = document.getElementById("exceptionRefresh");
const approvalViewEl = document.getElementById("approvalView");
const approvalListEl = document.getElementById("approvalList");
const approvalRefreshEl = document.getElementById("approvalRefresh");
const usersViewEl = document.getElementById("usersView");
const usersListEl = document.getElementById("usersList");
const usersSaveButtonEl = document.getElementById("usersSave");
const usersSaveStatusEl = document.getElementById("usersSaveStatus");
const commandUserEl = document.getElementById("commandUser");
const commandPanelEl = document.getElementById("commandPanel");
const recordControlsEl = document.getElementById("recordControls");
const recordToggleEl = document.getElementById("recordToggle");
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
let recordingController = null;
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

const updateUsersSaveUi = () => {
  if (!adminController) {
    return;
  }
  adminController.updateUsersSaveUi();
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
  if (!commandController) {
    return;
  }
  commandController.renderCommandHistory(senderId);
};

const getFocusedSlot = () => (focusedSenderId ? slots.get(focusedSenderId) : null);

const updateRecordUi = () => {
  if (!recordControlsEl || !recordToggleEl) {
    return;
  }
  const isAdmin = currentUser && currentUser.role === "admin";
  const canRecord = Boolean(isAdmin && focusedSenderId && currentMode === "live");
  recordControlsEl.style.display = canRecord ? "flex" : "none";
  const slot = getFocusedSlot();
  const recording = Boolean(slot && slot.manualRecording);
  recordToggleEl.textContent = recording ? "Stop" : "Record";
  recordToggleEl.classList.toggle("recording", recording);
  recordToggleEl.disabled = !canRecord || !slot || !slot.stream;
};

const startManualRecording = (slot) => {
  if (!recordingController) {
    return;
  }
  recordingController.startManualRecording(slot);
};

const stopManualRecording = (slot) => {
  if (!recordingController) {
    return;
  }
  recordingController.stopManualRecording(slot);
};

const startRecorder = (slot, stream) => {
  if (!recordingController) {
    return;
  }
  recordingController.startRecorder(slot, stream);
};

const stopRecorder = (slot) => {
  if (!recordingController) {
    return;
  }
  recordingController.stopRecorder(slot);
};

const scheduleRecorderRoll = (slot) => {
  if (!recordingController) {
    return;
  }
  recordingController.scheduleRecorderRoll(slot);
};

const rollRecorder = (slot) => {
  if (!recordingController) {
    return;
  }
  recordingController.rollRecorder(slot);
};

const startFallClip = (slot) => {
  if (!recordingController) {
    return;
  }
  recordingController.startFallClip(slot);
};

const finishFallClip = (slot, senderId) => {
  if (!recordingController) {
    return;
  }
  recordingController.finishFallClip(slot, senderId);
};

const setCommandHistory = (senderId, entries) => {
  if (!commandController) {
    return;
  }
  commandController.setCommandHistory(senderId, entries);
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
  if (clipController) {
    const clipId = clipController.getCurrentClipId();
    const comments = loggedIn ? clipController.getClipComments(clipId) : null;
    clipController.renderClipComments(clipId, comments);
  }
  updateRecordUi();
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
    if (webSocketController) {
      webSocketController.ensureWebSocketSession();
    }
  } catch (error) {
    currentUser = null;
    updateAuthUi();
  }
};

const loadSignupRequests = () => {
  if (!adminController) {
    return;
  }
  return adminController.loadSignupRequests();
};

if (approvalRefreshEl) {
  approvalRefreshEl.addEventListener("click", () => {
    void loadSignupRequests();
  });
}

const loadUsers = () => {
  if (!adminController) {
    return;
  }
  return adminController.loadUsers();
};

const sendCommand = () => {
  if (!commandInputEl || !focusedSenderId || !currentUser) {
    return;
  }
  const text = commandInputEl.value.trim();
  if (!text) {
    return;
  }
  if (!webSocketController) {
    return;
  }
  webSocketController.sendMessage({
    type: "command",
    senderId: focusedSenderId,
    text
  });
  commandInputEl.value = "";
};

const loadFallClips = () => {
  if (!clipController) {
    return;
  }
  return clipController.loadFallClips();
};

const submitClipComment = () => {
  if (!clipController) {
    return;
  }
  return clipController.submitClipComment();
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
    restartAfterStop: false,
    manualRecorder: null,
    manualChunks: [],
    manualRecording: false,
    manualStartedAt: null,
    manualSenderId: null
  });
}


commandController = createCommandController({
  commandHistoryEl,
  commandHistoryBySender,
  getCurrentUser: () => currentUser,
  getFocusedSenderId: () => focusedSenderId
});

adminController = createAdminController({
  apiFetch,
  approvalListEl,
  usersListEl,
  usersSaveButtonEl,
  usersSaveStatusEl,
  pendingRoleChanges,
  getCurrentUser: () => currentUser
});

clipController = createClipController({
  apiFetch,
  exceptionListEl,
  exceptionPlayerEl,
  exceptionCommentListEl,
  exceptionCommentInputEl,
  clipCommentsById,
  getCurrentUser: () => currentUser,
  getCurrentMode: () => currentMode,
  getCurrentClipId: () => currentClipId,
  setCurrentClipId: (value) => {
    currentClipId = value;
  }
});

recordingController = createRecordingController({
  apiFetch,
  getCurrentMode: () => currentMode,
  loadFallClips,
  updateRecordUi,
  getFocusedSenderId: () => focusedSenderId
});

rtcController = createRtcController({
  slots,
  peerConnections,
  sendMessage: (payload) => (webSocketController ? webSocketController.sendMessage(payload) : false),
  startRecorder,
  stopRecorder,
  stopManualRecording,
  updateRecordUi
});

rtcController.showOfflineAll();

const clearFocus = () => {
  if (!gridEl) {
    return;
  }
  const currentSlot = getFocusedSlot();
  if (currentSlot && currentSlot.manualRecording) {
    stopManualRecording(currentSlot);
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
  updateRecordUi();
};

const focusSender = (senderId) => {
  if (!gridEl) {
    return;
  }
  const previousSlot = getFocusedSlot();
  if (previousSlot && previousSlot.manualRecording) {
    stopManualRecording(previousSlot);
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
  updateRecordUi();
};

webSocketController = createWebSocketController({
  buildWsUrl,
  getSessionId,
  viewerCountEl,
  fallAlertEl,
  slots,
  dismissedFallAlerts,
  getCurrentMode: () => currentMode,
  getFocusedSenderId: () => focusedSenderId,
  commandController,
  rtcController,
  startFallClip,
  finishFallClip,
  showFallAlert,
  hideFallAlert,
  clearFocus
});

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
  updateRecordUi();
};

const initHeader = async () => {
  if (!headerHostEl) {
    return;
  }
  try {
    const response = await fetch("/html/header.html");
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
    if (adminController) {
      adminController.setUsersSaveStatus("Saving...");
    }

    const entries = Array.from(pendingRoleChanges.entries());
    for (const [id, role] of entries) {
      try {
        const response = await apiFetch("/api/admin/users/role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, role })
        });
        if (!response.ok) {
          if (adminController) {
            adminController.setUsersSaveStatus("Failed to save");
          }
          updateUsersSaveUi();
          return;
        }
      } catch (error) {
        if (adminController) {
          adminController.setUsersSaveStatus("Failed to save");
        }
        updateUsersSaveUi();
        return;
      }
    }

    pendingRoleChanges.clear();
    if (adminController) {
      adminController.setUsersSaveStatus("Saved");
    }
    void loadUsers();
  });
}

const initFooter = async () => {
  if (!footerHostEl) {
    return;
  }
  try {
    const response = await fetch("/html/footer.html");
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
        location.href = "/html/account.html";
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
        location.href = "/html/login.html";
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

if (exceptionRefreshEl) {
  exceptionRefreshEl.addEventListener("click", () => {
    void loadFallClips();
  });
}

if (commandFormEl) {
  commandFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    sendCommand();
  });
}

if (recordToggleEl) {
  recordToggleEl.addEventListener("click", () => {
    if (!currentUser || currentUser.role !== "admin") {
      return;
    }
    if (currentMode !== "live") {
      return;
    }
    const slot = getFocusedSlot();
    if (!slot) {
      return;
    }
    if (slot.manualRecording) {
      stopManualRecording(slot);
    } else {
      startManualRecording(slot);
    }
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
      if (clipController) {
        clipController.renderClipComments(currentClipId, comments);
      }
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
      const response = await apiFetch(endpoint, {
        method: "POST",
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
    if (!webSocketController) {
      return;
    }
    webSocketController.sendMessage({
      type: "delete-command",
      senderId: focusedSenderId,
      id
    });
  });
}


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

if (webSocketController) {
  webSocketController.initWebSocket();
}
initHeader();
initFooter();
updateAuthUi();
loadSession();
