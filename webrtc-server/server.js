import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import wrtc from "wrtc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = urlPath.split("?")[0];
  const filePath = path.join(publicDir, safePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    if (filePath.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html");
    } else if (filePath.endsWith(".js")) {
      res.setHeader("Content-Type", "text/javascript");
    } else if (filePath.endsWith(".png")) {
      res.setHeader("Content-Type", "image/png");
    }
    res.writeHead(200);
    res.end(data);
  });
});

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } = wrtc;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const rtcConfig = { iceServers, sdpSemantics: "unified-plan" };
const MAX_SENDERS = 4;

const wss = new WebSocketServer({ server, path: "/ws" });
const senders = new Map();
const viewers = new Map();
let viewerIdCounter = 1;

const broadcastViewerCount = () => {
  const payload = JSON.stringify({ type: "viewer-count", count: viewers.size });
  for (const viewer of viewers.values()) {
    try {
      viewer.socket.send(payload);
    } catch (error) {
      // ignore
    }
  }
};

const allocateSenderId = () => {
  for (let i = 1; i <= MAX_SENDERS; i += 1) {
    const id = String(i);
    if (!senders.has(id)) {
      return id;
    }
  }
  return null;
};

const createSenderPeer = (senderId) => {
  const sender = senders.get(senderId);
  if (!sender) {
    return;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  sender.pc = pc;
  pc.addTransceiver("video", { direction: "recvonly" });

  pc.onicecandidate = (event) => {
    if (event.candidate && sender.socket) {
      sender.socket.send(JSON.stringify({
        type: "candidate",
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        candidate: event.candidate.candidate
      }));
    }
  };

  pc.ontrack = (event) => {
    sender.track = event.track;
    if (event.streams && event.streams[0]) {
      sender.stream = event.streams[0];
    } else {
      if (!sender.stream) {
        sender.stream = new MediaStream();
      }
      if (!sender.stream.getTracks().includes(sender.track)) {
        sender.stream.addTrack(sender.track);
      }
    }

    for (const viewerId of viewers.keys()) {
      void ensureViewerPeer(viewerId, senderId);
    }
  };
};

const ensureViewerPeer = async (viewerId, senderId) => {
  const viewer = viewers.get(viewerId);
  const sender = senders.get(senderId);
  if (!viewer || !sender || !sender.track) {
    return;
  }

  if (viewer.pcs.has(senderId)) {
    return;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  viewer.pcs.set(senderId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      viewer.socket.send(JSON.stringify({
        type: "candidate",
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        candidate: event.candidate.candidate,
        senderId
      }));
    }
  };

  const clonedTrack = sender.track.clone();
  const stream = new MediaStream([clonedTrack]);
  pc.addTrack(clonedTrack, stream);
  viewer.tracks.set(senderId, clonedTrack);

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    viewer.socket.send(JSON.stringify({
      type: "offer",
      sdp: offer.sdp,
      senderId
    }));
  } catch (error) {
    // ignore
  }
};

const closeSender = (senderId) => {
  const sender = senders.get(senderId);
  if (!sender) {
    return;
  }

  if (sender.pc) {
    sender.pc.close();
  }
  senders.delete(senderId);

  for (const viewer of viewers.values()) {
    const pc = viewer.pcs.get(senderId);
    if (pc) {
      pc.close();
      viewer.pcs.delete(senderId);
    }
    const track = viewer.tracks.get(senderId);
    if (track) {
      track.stop();
      viewer.tracks.delete(senderId);
    }
    try {
      viewer.socket.send(JSON.stringify({ type: "sender-disconnected", senderId }));
    } catch (error) {
      // ignore
    }
  }
};

wss.on("connection", (socket, req) => {
  const requestUrl = req.url || "";
  const isSender = requestUrl.includes("sender");
  const isViewer = requestUrl.includes("viewer");

  if (isSender) {
    const senderId = allocateSenderId();
    if (!senderId) {
      socket.close();
      return;
    }

    socket.senderId = senderId;
    senders.set(senderId, {
      socket,
      pc: null,
      track: null,
      stream: null
    });
    createSenderPeer(senderId);
  }

  if (isViewer) {
    const viewerId = String(viewerIdCounter++);
    socket.viewerId = viewerId;
    viewers.set(viewerId, { socket, pcs: new Map(), tracks: new Map() });
    socket.send(JSON.stringify({ type: "viewer-id", viewerId }));
    broadcastViewerCount();
    for (const senderId of senders.keys()) {
      void ensureViewerPeer(viewerId, senderId);
    }
  }

  socket.on("message", async (data) => {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      return;
    }

    if (socket.senderId) {
      const sender = senders.get(socket.senderId);
      if (!sender || !sender.pc) {
        return;
      }
      if (message.type === "offer") {
        await sender.pc.setRemoteDescription(
          new RTCSessionDescription({ type: "offer", sdp: message.sdp })
        );
        const answer = await sender.pc.createAnswer();
        await sender.pc.setLocalDescription(answer);
        socket.send(JSON.stringify({ type: "answer", sdp: answer.sdp }));
      } else if (message.type === "candidate") {
        await sender.pc.addIceCandidate(new RTCIceCandidate({
          sdpMid: message.sdpMid,
          sdpMLineIndex: message.sdpMLineIndex,
          candidate: message.candidate
        }));
      }
      return;
    }

    const viewerId = socket.viewerId;
    const senderId = message.senderId || (senders.size === 1 ? Array.from(senders.keys())[0] : null);
    if (!viewerId || !senderId) {
      return;
    }
    const viewer = viewers.get(viewerId);
    const pc = viewer ? viewer.pcs.get(senderId) : null;
    if (!pc) {
      return;
    }

    if (message.type === "answer") {
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: message.sdp })
      );
    } else if (message.type === "candidate") {
      await pc.addIceCandidate(new RTCIceCandidate({
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex,
        candidate: message.candidate
      }));
    }
  });

  socket.on("close", () => {
    if (socket.senderId) {
      closeSender(socket.senderId);
    }
    if (socket.viewerId) {
      const viewer = viewers.get(socket.viewerId);
      if (viewer) {
        for (const pc of viewer.pcs.values()) {
          pc.close();
        }
        for (const track of viewer.tracks.values()) {
          track.stop();
        }
      }
      viewers.delete(socket.viewerId);
      broadcastViewerCount();
    }
  });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`WebRTC server running on http://${host}:${port}`);
});
