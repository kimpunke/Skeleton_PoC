const createAdminController = ({
  apiFetch,
  approvalListEl,
  usersListEl,
  usersSaveButtonEl,
  usersSaveStatusEl,
  pendingRoleChanges,
  getCurrentUser
}) => {
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

    const currentUser = getCurrentUser();
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
    const currentUser = getCurrentUser();
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

  const renderUsers = (users) => {
    if (!usersListEl) {
      return;
    }
    usersListEl.innerHTML = "";

    const currentUser = getCurrentUser();
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
    const currentUser = getCurrentUser();
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

  return {
    setUsersSaveStatus,
    updateUsersSaveUi,
    formatApprovalTimestamp,
    renderSignupRequests,
    loadSignupRequests,
    renderUsers,
    loadUsers
  };
};

export { createAdminController };
