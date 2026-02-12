const createRtcController = ({
  slots,
  peerConnections,
  sendMessage,
  startRecorder,
  stopRecorder,
  stopManualRecording,
  updateRecordUi
}) => {
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
    if (slot && slot.manualRecording) {
      stopManualRecording(slot);
    }
    stopRecorder(slot);
    updateRecordUi();
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
        sendMessage({
          type: "candidate",
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          candidate: event.candidate.candidate,
          senderId
        });
      }
    };

    return pc;
  };

  const removePeerConnection = (senderId) => {
    const pc = peerConnections.get(senderId);
    if (pc) {
      pc.close();
      peerConnections.delete(senderId);
    }
  };

  return {
    showOffline,
    hideOffline,
    clearStream,
    showOfflineAll,
    ensurePeerConnection,
    removePeerConnection
  };
};

export { createRtcController };
