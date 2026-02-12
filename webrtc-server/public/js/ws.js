const createWebSocketController = ({
  buildWsUrl,
  getSessionId,
  viewerCountEl,
  fallAlertEl,
  slots,
  dismissedFallAlerts,
  getCurrentMode,
  getFocusedSenderId,
  commandController,
  rtcController,
  startFallClip,
  finishFallClip,
  showFallAlert,
  hideFallAlert,
  clearFocus
}) => {
  let ws = null;
  let wsBoundSessionId = null;

  const sendMessage = (payload) => {
    if (!ws) {
      return false;
    }
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      return false;
    }
  };

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
            && ((getCurrentMode() === "exception")
              || (getFocusedSenderId() && senderId !== getFocusedSenderId()))
            && !dismissedFallAlerts.has(senderId)) {
          showFallAlert(senderId);
        }
      }
      return;
    }
    if (message.type === "command-entry") {
      if (message.senderId && message.entry) {
        commandController.recordCommand(message.senderId, message.entry);
      }
      return;
    }
    if (message.type === "command-history") {
      if (message.senderId) {
        commandController.setCommandHistory(message.senderId, message.entries || []);
      }
      return;
    }
    if (message.type === "offer") {
      const senderId = message.senderId;
      const pc = rtcController.ensurePeerConnection(senderId);
      if (!pc) {
        return;
      }
      await pc.setRemoteDescription({
        type: "offer",
        sdp: message.sdp
      });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendMessage({
        type: "answer",
        sdp: answer.sdp,
        senderId
      });
    } else if (message.type === "candidate") {
      const senderId = message.senderId;
      const pc = rtcController.ensurePeerConnection(senderId);
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
      rtcController.removePeerConnection(senderId);
      rtcController.showOffline(senderId);
      rtcController.clearStream(senderId);
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
      commandController.clearCommandHistory(senderId);
      dismissedFallAlerts.delete(senderId);
      if (getFocusedSenderId() === senderId) {
        clearFocus();
      }
    }
  };

  const handleWsClose = () => {
    rtcController.showOfflineAll();
  };

  const handleWsError = () => {
    rtcController.showOfflineAll();
  };

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

  return {
    initWebSocket,
    ensureWebSocketSession,
    sendMessage
  };
};

export { createWebSocketController };
