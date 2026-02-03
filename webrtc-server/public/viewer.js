const MAX_SENDERS = 4;
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const wsPort = location.port || "3000";
const wsUrl = `${wsProtocol}://${location.hostname}:${wsPort}/ws?viewer`;
const ws = new WebSocket(wsUrl);
const viewerCountEl = document.getElementById("viewerCount");
const slots = new Map();
const peerConnections = new Map();

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
  slots.set(senderId, { video, offline });
  showOffline(senderId);
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
  }
};

ws.onclose = () => {
  showOfflineAll();
};

ws.onerror = () => {
  showOfflineAll();
};
