const createCommandController = ({
  commandHistoryEl,
  commandHistoryBySender,
  getCurrentUser,
  getFocusedSenderId
}) => {
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
    const currentUser = getCurrentUser();
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
    if (getFocusedSenderId() === senderId) {
      renderCommandHistory(senderId);
    }
  };

  const clearCommandHistory = (senderId) => {
    if (!senderId) {
      return;
    }
    commandHistoryBySender.delete(senderId);
    if (getFocusedSenderId() === senderId) {
      renderCommandHistory(null);
    }
  };

  return {
    renderCommandHistory,
    recordCommand,
    setCommandHistory,
    clearCommandHistory
  };
};

export { createCommandController };
