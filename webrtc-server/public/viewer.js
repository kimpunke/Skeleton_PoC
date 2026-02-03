const video = document.getElementById("remoteVideo");
const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
const wsPort = location.port || "3000";
const wsUrl = `${wsProtocol}://${location.hostname}:${wsPort}/ws?viewer`;
const ws = new WebSocket(wsUrl);
let viewerId = null;
const viewerCountEl = document.getElementById("viewerCount");
const offlineImage = document.getElementById("offlineImage");

const showOffline = () => {
  if (offlineImage) {
    offlineImage.style.display = "block";
  }
};

const hideOffline = () => {
  if (offlineImage) {
    offlineImage.style.display = "none";
  }
};

showOffline();

const peerConnection = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
});

peerConnection.ontrack = (event) => {
  if (event.streams && event.streams[0]) {
    video.srcObject = event.streams[0];
    hideOffline();
  }
};

peerConnection.onconnectionstatechange = () => {
  const state = peerConnection.connectionState;
  if (state === "connected") {
    hideOffline();
  } else if (state === "disconnected" || state === "failed" || state === "closed") {
    showOffline();
  }
};

peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    const payload = {
      type: "candidate",
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
      candidate: event.candidate.candidate
    };
    if (viewerId) {
      payload.viewerId = viewerId;
    }
    ws.send(JSON.stringify(payload));
  }
};

ws.onmessage = async (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "viewer-id") {
    viewerId = message.viewerId;
    return;
  }
  if (message.type === "viewer-count") {
    if (viewerCountEl) {
      viewerCountEl.textContent = `Viewers: ${message.count}`;
    }
    return;
  }
  if (message.viewerId) {
    viewerId = message.viewerId;
  }
  if (message.type === "offer") {
    await peerConnection.setRemoteDescription({
      type: "offer",
      sdp: message.sdp
    });
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const payload = {
      type: "answer",
      sdp: answer.sdp
    };
    if (viewerId) {
      payload.viewerId = viewerId;
    }
    ws.send(JSON.stringify(payload));
  } else if (message.type === "candidate") {
    await peerConnection.addIceCandidate({
      sdpMid: message.sdpMid,
      sdpMLineIndex: message.sdpMLineIndex,
      candidate: message.candidate
    });
  }
};

ws.onclose = () => {
  showOffline();
};

ws.onerror = () => {
  showOffline();
};
