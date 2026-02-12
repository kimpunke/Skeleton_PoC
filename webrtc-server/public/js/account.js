const apiHost = location.hostname || "localhost";
const apiPort = location.port || "3000";
const apiProtocol = location.protocol === "https:" ? "https:" : "http:";
const apiBase = location.protocol === "file:"
  ? "http://localhost:3000"
  : `${apiProtocol}//${apiHost}:${apiPort}`;

const apiFetch = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  const sessionId = sessionStorage.getItem("session_id");
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

const accountMetaEl = document.getElementById("accountMeta");
const accountFormEl = document.getElementById("accountForm");
const accountUsernameEl = document.getElementById("accountUsername");
const accountNicknameEl = document.getElementById("accountNickname");
const backToViewerEl = document.getElementById("backToViewer");
const unsavedOverlayEl = document.getElementById("unsavedOverlay");
const unsavedYesEl = document.getElementById("unsavedYes");
const unsavedNoEl = document.getElementById("unsavedNo");
const tabGeneralEl = document.getElementById("tabGeneral");
const tabManageEl = document.getElementById("tabManage");
const tabPanelGeneralEl = document.getElementById("tabPanelGeneral");
const tabPanelManageEl = document.getElementById("tabPanelManage");
const passwordFormEl = document.getElementById("passwordForm");
const passwordCurrentEl = document.getElementById("passwordCurrent");
const passwordNewEl = document.getElementById("passwordNew");
const passwordNewConfirmEl = document.getElementById("passwordNewConfirm");
const toggleCurrentPasswordEl = document.getElementById("toggleCurrentPassword");
const toggleNewPasswordEl = document.getElementById("toggleNewPassword");
const toggleNewPasswordConfirmEl = document.getElementById("toggleNewPasswordConfirm");
const deleteConfirmCheckEl = document.getElementById("deleteConfirmCheck");
const deleteConfirmTextEl = document.getElementById("deleteConfirmText");
const deleteAccountButtonEl = document.getElementById("deleteAccountButton");
const accountErrorEl = document.getElementById("accountError");
const accountSuccessEl = document.getElementById("accountSuccess");

const setError = (text) => {
  if (accountErrorEl) {
    accountErrorEl.textContent = text || "";
  }
};

const setSuccess = (text) => {
  if (accountSuccessEl) {
    accountSuccessEl.textContent = text || "";
  }
};

let initialNickname = "";
let pendingNavigationUrl = null;

const hasUnsavedNickname = () => {
  if (!accountNicknameEl) {
    return false;
  }
  return accountNicknameEl.value.trim() !== (initialNickname || "");
};

const openUnsavedDialog = (url) => {
  pendingNavigationUrl = url || "/";
  if (unsavedOverlayEl) {
    unsavedOverlayEl.style.display = "flex";
  }
};

const closeUnsavedDialog = () => {
  pendingNavigationUrl = null;
  if (unsavedOverlayEl) {
    unsavedOverlayEl.style.display = "none";
  }
};

const togglePasswordField = (buttonEl, inputEl) => {
  if (!buttonEl || !inputEl) {
    return;
  }
  buttonEl.addEventListener("click", () => {
    const isPassword = inputEl.type === "password";
    inputEl.type = isPassword ? "text" : "password";
    buttonEl.textContent = isPassword ? "Hide" : "Show";
  });
};

togglePasswordField(toggleCurrentPasswordEl, passwordCurrentEl);
togglePasswordField(toggleNewPasswordEl, passwordNewEl);
togglePasswordField(toggleNewPasswordConfirmEl, passwordNewConfirmEl);

const saveNickname = async () => {
  setError("");
  setSuccess("");

  const nickname = accountNicknameEl ? accountNicknameEl.value.trim() : "";
  if (!nickname) {
    setError("Enter nickname");
    return false;
  }

  try {
    const response = await apiFetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname })
    });
    if (!response.ok) {
      setError("Failed to save nickname");
      return false;
    }
    initialNickname = nickname;
    setSuccess("Nickname updated");
    return true;
  } catch (error) {
    setError("Failed to save nickname");
    return false;
  }
};

const setActiveTab = (tab) => {
  const general = tab !== "manage";
  if (tabPanelGeneralEl) {
    tabPanelGeneralEl.style.display = general ? "" : "none";
  }
  if (tabPanelManageEl) {
    tabPanelManageEl.style.display = general ? "none" : "";
  }
  if (tabGeneralEl) {
    tabGeneralEl.classList.toggle("active", general);
    tabGeneralEl.setAttribute("aria-selected", general ? "true" : "false");
  }
  if (tabManageEl) {
    tabManageEl.classList.toggle("active", !general);
    tabManageEl.setAttribute("aria-selected", general ? "false" : "true");
  }
  setError("");
  setSuccess("");
};

if (tabGeneralEl) {
  tabGeneralEl.addEventListener("click", () => setActiveTab("general"));
}
if (tabManageEl) {
  tabManageEl.addEventListener("click", () => setActiveTab("manage"));
}

const CONFIRM_PHRASE = "이해했습니다";
const updateDeleteUi = () => {
  if (!deleteAccountButtonEl) {
    return;
  }
  const checked = Boolean(deleteConfirmCheckEl && deleteConfirmCheckEl.checked);
  const text = deleteConfirmTextEl ? deleteConfirmTextEl.value.trim() : "";
  deleteAccountButtonEl.disabled = !(checked && text === CONFIRM_PHRASE);
};

if (deleteConfirmCheckEl) {
  deleteConfirmCheckEl.addEventListener("change", updateDeleteUi);
}
if (deleteConfirmTextEl) {
  deleteConfirmTextEl.addEventListener("input", updateDeleteUi);
}

if (deleteAccountButtonEl) {
  deleteAccountButtonEl.addEventListener("click", async () => {
    setError("");
    setSuccess("");
    updateDeleteUi();
    if (deleteAccountButtonEl.disabled) {
      return;
    }
    deleteAccountButtonEl.disabled = true;
    try {
      const response = await apiFetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, phrase: CONFIRM_PHRASE })
      });
      if (!response.ok) {
        setError("Failed to delete account");
        updateDeleteUi();
        return;
      }
      location.href = "/html/login.html";
    } catch (error) {
      setError("Failed to delete account");
      updateDeleteUi();
    }
  });
}

const loadAccount = async () => {
  setError("");
  setSuccess("");
  try {
    const sessionRes = await apiFetch("/api/session");
    if (!sessionRes.ok) {
      location.href = "/html/login.html";
      return;
    }
    const session = await sessionRes.json();
    if (session && session.sessionId) {
      sessionStorage.setItem("session_id", String(session.sessionId));
    }
    const accountRes = await apiFetch("/api/account");
    if (!accountRes.ok) {
      location.href = "/";
      return;
    }
    const account = await accountRes.json();
    if (accountMetaEl) {
      accountMetaEl.textContent = `Signed in as ${account.username} (${account.role})`;
    }
    if (accountUsernameEl) {
      accountUsernameEl.value = account.username || "";
    }
    if (accountNicknameEl) {
      accountNicknameEl.value = account.nickname || session.nickname || session.username || "";
      initialNickname = accountNicknameEl.value.trim();
      accountNicknameEl.focus();
    }
    updateDeleteUi();
  } catch (error) {
    setError("Failed to load account");
  }
};

if (accountFormEl) {
  accountFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveNickname();
  });
}

if (backToViewerEl) {
  backToViewerEl.addEventListener("click", (event) => {
    const href = backToViewerEl.getAttribute("href") || "/";
    if (!hasUnsavedNickname()) {
      return;
    }
    event.preventDefault();
    openUnsavedDialog(href);
  });
}

if (unsavedNoEl) {
  unsavedNoEl.addEventListener("click", () => {
    const url = pendingNavigationUrl || "/";
    closeUnsavedDialog();
    location.href = url;
  });
}

if (unsavedYesEl) {
  unsavedYesEl.addEventListener("click", async () => {
    const url = pendingNavigationUrl || "/";
    const ok = await saveNickname();
    if (!ok) {
      closeUnsavedDialog();
      return;
    }
    closeUnsavedDialog();
    location.href = url;
  });
}

if (passwordFormEl) {
  passwordFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");

    const currentPassword = passwordCurrentEl ? passwordCurrentEl.value : "";
    const newPassword = passwordNewEl ? passwordNewEl.value : "";
    const newPasswordConfirm = passwordNewConfirmEl ? passwordNewConfirmEl.value : "";
    if (!currentPassword || !newPassword || !newPasswordConfirm) {
      setError("Fill all password fields");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError("Passwords do not match");
      return;
    }

    try {
      const response = await apiFetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, newPasswordConfirm })
      });
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch (parseError) {
          payload = null;
        }
        const code = payload && payload.error ? payload.error : "failed";
        if (code === "weak-password") {
          setError("Password must be 8+ chars incl number and special");
        } else if (code === "invalid-credentials") {
          setError("Current password incorrect");
        } else if (code === "password-mismatch") {
          setError("Passwords do not match");
        } else {
          setError("Failed to change password");
        }
        return;
      }
      setSuccess("Password updated");
      if (passwordCurrentEl) {
        passwordCurrentEl.value = "";
      }
      if (passwordNewEl) {
        passwordNewEl.value = "";
      }
      if (passwordNewConfirmEl) {
        passwordNewConfirmEl.value = "";
      }
    } catch (error) {
      setError("Failed to change password");
    }
  });
}

loadAccount();
setActiveTab("general");
