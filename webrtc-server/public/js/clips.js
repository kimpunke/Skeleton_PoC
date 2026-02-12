const createClipController = ({
  apiFetch,
  exceptionListEl,
  exceptionPlayerEl,
  exceptionCommentListEl,
  exceptionCommentInputEl,
  clipCommentsById,
  getCurrentUser,
  getCurrentMode,
  getCurrentClipId,
  setCurrentClipId
}) => {
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
    const currentUser = getCurrentUser();
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
    const currentUser = getCurrentUser();
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
    const nextId = clip ? clip.id : null;
    setCurrentClipId(nextId);
    const cached = nextId ? clipCommentsById.get(nextId) : null;
    renderClipComments(nextId, cached);
    if (nextId) {
      void loadClipComments(nextId);
    }
  };

  const submitClipComment = async () => {
    const currentUser = getCurrentUser();
    const currentClipId = getCurrentClipId();
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

  const formatClipLabel = (clip) => {
    const timestamp = clip && typeof clip === "object" ? (clip.timestamp || clip.createdAt) : clip;
    const date = new Date(timestamp);
    const type = clip && typeof clip === "object"
      ? (clip.type || (typeof clip.id === "string" && clip.id.startsWith("record-") ? "record" : "fall"))
      : "fall";
    const label = type === "record" ? "record" : "fallen";
    if (Number.isNaN(date.getTime())) {
      return label;
    }
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month}월 ${day}일 ${hour}시 ${minute}분 ${label}`;
  };

  const loadFallClips = async () => {
    if (!exceptionListEl) {
      return;
    }
    exceptionListEl.innerHTML = "";
    setCurrentClipId(null);
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
        item.textContent = formatClipLabel(clip);
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

        const currentUser = getCurrentUser();
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
              if (getCurrentClipId() === clipId) {
                setCurrentClipId(null);
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

  const getClipComments = (clipId) => (
    clipId ? clipCommentsById.get(clipId) : null
  );

  return {
    renderClipComments,
    loadClipComments,
    selectClip,
    submitClipComment,
    formatClipLabel,
    loadFallClips,
    getCurrentClipId,
    getClipComments
  };
};

export { createClipController };
