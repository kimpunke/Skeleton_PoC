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
const MIN_POSE_LANDMARKS = 31;
const CROUCH_KNEE_ANGLE_THRESHOLD = 95;
const CROUCH_KNEE_ANGLE_SOFT = 108;
const SIT_KNEE_ANGLE_THRESHOLD = 140;
const CROUCH_HIP_OFFSET = 0.03;
const CROUCH_HIP_KNEE_SOFT = 0.05;
const CROUCH_HIP_HEEL_THRESHOLD = 0.18;
const CROUCH_HIP_HEEL_X_THRESHOLD = 0.08;
const CROUCH_MIN_CONFIDENCE = 0.6;
const WALKING_SPEED_THRESHOLD = 0.08;

const getLandmark = (landmarks, index) => {
  if (!Array.isArray(landmarks) || index < 0 || index >= landmarks.length) {
    return null;
  }
  const entry = landmarks[index];
  if (!Array.isArray(entry) || entry.length < 3) {
    return null;
  }
  const x = Number(entry[0]);
  const y = Number(entry[1]);
  const z = Number(entry[2]);
  const visibility = Number(entry[3] !== undefined ? entry[3] : 0);
  const presence = Number(entry[4] !== undefined ? entry[4] : 0);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return null;
  }
  return { x, y, z, visibility, presence };
};

const isConfident = (landmark, threshold) => {
  if (!landmark) {
    return false;
  }
  const visibility = Number.isNaN(landmark.visibility) ? 0 : landmark.visibility;
  const presence = Number.isNaN(landmark.presence) ? 0 : landmark.presence;
  return Math.max(visibility, presence) >= threshold;
};

const calculateAngle = (first, mid, last) => {
  if (!first || !mid || !last) {
    return 180;
  }
  const ax = first.x - mid.x;
  const ay = first.y - mid.y;
  const bx = last.x - mid.x;
  const by = last.y - mid.y;
  const dot = ax * bx + ay * by;
  const magA = Math.sqrt(ax * ax + ay * ay);
  const magB = Math.sqrt(bx * bx + by * by);
  if (magA < 1e-6 || magB < 1e-6) {
    return 180;
  }
  let cosine = dot / (magA * magB);
  cosine = Math.max(-1, Math.min(1, cosine));
  return Math.acos(cosine) * (180 / Math.PI);
};

const distance = (x1, y1, x2, y2) => {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
};

const isWalking = (landmarks, senderState, kneeAngle) => {
  if (!senderState || kneeAngle < 150) {
    return false;
  }
  const leftAnkle = getLandmark(landmarks, 27);
  const rightAnkle = getLandmark(landmarks, 28);
  if (!leftAnkle || !rightAnkle) {
    return false;
  }
  const now = Date.now();
  if (!senderState.lastAnkleTimestampMs) {
    senderState.lastAnkleTimestampMs = now;
    senderState.lastLeftAnkle = leftAnkle;
    senderState.lastRightAnkle = rightAnkle;
    return false;
  }
  const deltaMs = now - senderState.lastAnkleTimestampMs;
  if (deltaMs <= 0) {
    return false;
  }
  const leftMove = distance(
    leftAnkle.x,
    leftAnkle.y,
    senderState.lastLeftAnkle.x,
    senderState.lastLeftAnkle.y
  );
  const rightMove = distance(
    rightAnkle.x,
    rightAnkle.y,
    senderState.lastRightAnkle.x,
    senderState.lastRightAnkle.y
  );
  const avgMove = (leftMove + rightMove) * 0.5;
  const speed = avgMove / (deltaMs / 1000);
  senderState.lastAnkleTimestampMs = now;
  senderState.lastLeftAnkle = leftAnkle;
  senderState.lastRightAnkle = rightAnkle;
  return speed > WALKING_SPEED_THRESHOLD;
};

const classifyPose = (landmarks, senderState) => {
  if (!Array.isArray(landmarks) || landmarks.length < MIN_POSE_LANDMARKS) {
    return "Unknown";
  }

  const leftShoulder = getLandmark(landmarks, 11);
  const rightShoulder = getLandmark(landmarks, 12);
  const leftHip = getLandmark(landmarks, 23);
  const rightHip = getLandmark(landmarks, 24);
  const leftKnee = getLandmark(landmarks, 25);
  const rightKnee = getLandmark(landmarks, 26);
  const leftAnkle = getLandmark(landmarks, 27);
  const rightAnkle = getLandmark(landmarks, 28);
  const leftHeel = getLandmark(landmarks, 29);
  const rightHeel = getLandmark(landmarks, 30);

  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip
      || !leftKnee || !rightKnee || !leftAnkle || !rightAnkle
      || !leftHeel || !rightHeel) {
    return "Unknown";
  }

  const shoulderX = (leftShoulder.x + rightShoulder.x) * 0.5;
  const shoulderY = (leftShoulder.y + rightShoulder.y) * 0.5;
  const hipX = (leftHip.x + rightHip.x) * 0.5;
  const hipY = (leftHip.y + rightHip.y) * 0.5;
  const kneeY = (leftKnee.y + rightKnee.y) * 0.5;
  const heelX = (leftHeel.x + rightHeel.x) * 0.5;
  const heelY = (leftHeel.y + rightHeel.y) * 0.5;

  const torsoDx = Math.abs(shoulderX - hipX);
  const torsoDy = Math.abs(shoulderY - hipY);
  if (torsoDx > torsoDy * 1.2) {
    return "Lying";
  }

  const leftKneeAngle = calculateAngle(leftHip, leftKnee, leftAnkle);
  const rightKneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
  const kneeAngle = (leftKneeAngle + rightKneeAngle) * 0.5;
  const hipKneeDelta = Math.abs(hipY - kneeY);
  const hipToHeel = Math.abs(heelY - hipY);
  const hipHeelDeltaX = Math.abs(hipX - heelX);
  const crouchReliable = isConfident(leftHip, CROUCH_MIN_CONFIDENCE)
    && isConfident(rightHip, CROUCH_MIN_CONFIDENCE)
    && isConfident(leftKnee, CROUCH_MIN_CONFIDENCE)
    && isConfident(rightKnee, CROUCH_MIN_CONFIDENCE)
    && isConfident(leftHeel, CROUCH_MIN_CONFIDENCE)
    && isConfident(rightHeel, CROUCH_MIN_CONFIDENCE);
  const tightCrouch = crouchReliable
    && kneeAngle < CROUCH_KNEE_ANGLE_THRESHOLD
    && hipKneeDelta < CROUCH_HIP_OFFSET
    && hipHeelDeltaX < CROUCH_HIP_HEEL_X_THRESHOLD;
  const lowHipCrouch = crouchReliable
    && kneeAngle < CROUCH_KNEE_ANGLE_SOFT
    && hipToHeel < CROUCH_HIP_HEEL_THRESHOLD
    && hipKneeDelta < CROUCH_HIP_KNEE_SOFT
    && hipHeelDeltaX < CROUCH_HIP_HEEL_X_THRESHOLD;
  if (tightCrouch || lowHipCrouch) {
    return "Crouching";
  }
  if (kneeAngle < SIT_KNEE_ANGLE_THRESHOLD) {
    return "Sitting";
  }
  if (isWalking(landmarks, senderState, kneeAngle)) {
    return "Walking";
  }
  return "Standing";
};

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
      stream: null,
      lastAnkleTimestampMs: 0,
      lastLeftAnkle: null,
      lastRightAnkle: null
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
      } else if (message.type === "pose") {
        if (!Array.isArray(message.landmarks)) {
          return;
        }
        const label = classifyPose(message.landmarks, sender);
        const payload = JSON.stringify({
          type: "pose-label",
          senderId: socket.senderId,
          label
        });
        try {
          socket.send(payload);
        } catch (error) {
          // ignore
        }
        for (const viewer of viewers.values()) {
          try {
            viewer.socket.send(payload);
          } catch (error) {
            // ignore
          }
        }
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
