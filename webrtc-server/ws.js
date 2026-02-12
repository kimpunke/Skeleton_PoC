import { WebSocketServer } from "ws";
import wrtc from "wrtc";

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } = wrtc;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const rtcConfig = { iceServers, sdpSemantics: "unified-plan" };
const MAX_SENDERS = 4;
const COMMAND_TOKEN = (process.env.COMMAND_TOKEN || "").trim();

const startWebSocketServer = ({ server, auth, stmts, pose }) => {
  const {
    listCommandHistoryStmt,
    insertCommandHistoryStmt,
    deleteCommandHistoryStmt,
    findUserRoleByUsernameStmt
  } = stmts;

  const wss = new WebSocketServer({ server, path: "/ws" });
  const senders = new Map();
  const viewers = new Map();
  const commandHistory = new Map();
  const senderHistoryKeyById = new Map();
  let viewerIdCounter = 1;

  const broadcastToViewers = (payload) => {
    for (const viewer of viewers.values()) {
      try {
        viewer.socket.send(payload);
      } catch (error) {
        // ignore
      }
    }
  };

  const enrichCommandEntry = (entry) => {
    if (!entry || typeof entry !== "object") {
      return entry;
    }
    const userUsername = typeof entry.userUsername === "string" && entry.userUsername
      ? entry.userUsername
      : (typeof entry.user === "string" ? entry.user : "");
    let userRole = typeof entry.userRole === "string" ? entry.userRole : "";
    if (!userRole && userUsername) {
      const row = findUserRoleByUsernameStmt.get(userUsername);
      userRole = row ? row.role : "";
    }
    return {
      ...entry,
      userUsername,
      userRole
    };
  };

  const enrichCommandEntries = (entries) => (entries || []).map(enrichCommandEntry);

  const getCommandHistoryKey = (senderId) => (
    senderHistoryKeyById.get(senderId) || senderId
  );

  const toCommandEntry = (row) => ({
    id: String(row.id),
    user: row.user_display,
    userUsername: row.user_username,
    userRole: row.user_role,
    text: row.text,
    timestamp: row.created_at
  });

  const loadCommandHistoryForKey = (historyKey) => {
    const rows = listCommandHistoryStmt.all(historyKey);
    const entries = rows.map(toCommandEntry);
    commandHistory.set(historyKey, entries);
    return entries;
  };

  const getCommandHistoryForKey = (historyKey) => {
    if (commandHistory.has(historyKey)) {
      return commandHistory.get(historyKey) || [];
    }
    return loadCommandHistoryForKey(historyKey);
  };

  const getCommandHistoryForSender = (senderId) => (
    getCommandHistoryForKey(getCommandHistoryKey(senderId))
  );

  const sendHistoryToViewer = (viewerSocket) => {
    for (const senderId of senders.keys()) {
      const entries = getCommandHistoryForSender(senderId);
      try {
        viewerSocket.send(JSON.stringify({
          type: "command-history",
          senderId,
          entries: enrichCommandEntries(entries)
        }));
      } catch (error) {
        // ignore
      }
    }
  };

  const sendHistoryToSender = (senderId, senderSocket) => {
    const entries = getCommandHistoryForSender(senderId);
    try {
      senderSocket.send(JSON.stringify({
        type: "command-history",
        senderId,
        entries: enrichCommandEntries(entries)
      }));
    } catch (error) {
      // ignore
    }
  };

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
    const historyKey = getCommandHistoryKey(senderId);
    commandHistory.delete(historyKey);
    senderHistoryKeyById.delete(senderId);
    broadcastToViewers(JSON.stringify({
      type: "command-history",
      senderId,
      entries: []
    }));

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
    let sid = "";
    try {
      const url = new URL(requestUrl, "http://localhost");
      sid = (url.searchParams.get("sid") || "").trim();
    } catch (error) {
      sid = "";
    }
    const sidSession = sid ? auth.getSessionById(sid) : null;
    socket.user = sidSession || auth.getSessionFromHeaders(req.headers);
    const isSender = requestUrl.includes("sender");
    const isViewer = requestUrl.includes("viewer");
    let deviceId = "";
    try {
      const url = new URL(requestUrl, "http://localhost");
      deviceId = (url.searchParams.get("deviceId") || url.searchParams.get("device_id") || "").trim();
    } catch (error) {
      deviceId = "";
    }
    const sanitizedDeviceId = deviceId.replace(/[^0-9a-zA-Z_-]/g, "");

    if (isSender) {
      const senderId = allocateSenderId();
      if (!senderId) {
        socket.close();
        return;
      }

      socket.senderId = senderId;
      if (sanitizedDeviceId) {
        senderHistoryKeyById.set(senderId, sanitizedDeviceId);
      }
      senders.set(senderId, {
        socket,
        pc: null,
        track: null,
        stream: null,
        ...pose.createSenderState()
      });
      createSenderPeer(senderId);
      sendHistoryToSender(senderId, socket);
    }

    if (isViewer) {
      const viewerId = String(viewerIdCounter++);
      socket.viewerId = viewerId;
      viewers.set(viewerId, { socket, pcs: new Map(), tracks: new Map() });
      socket.send(JSON.stringify({ type: "viewer-id", viewerId }));
      broadcastViewerCount();
      sendHistoryToViewer(socket);
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
          const label = pose.classifyPose(message.landmarks, sender);
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

      if (message.type === "command") {
        const session = socket.user;
        if (!session) {
          return;
        }
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) {
          return;
        }
        const sender = senders.get(senderId);
        if (!sender || !sender.socket) {
          return;
        }
        const createdAt = new Date().toISOString();
        let entryId = String(Date.now());
        try {
          const result = insertCommandHistoryStmt.run(
            senderId,
            session.username,
            session.nickname || session.username,
            session.role,
            text,
            createdAt
          );
          const lastId = result && (typeof result.lastInsertRowid === "number"
            || typeof result.lastInsertRowid === "bigint")
            ? result.lastInsertRowid
            : null;
          if (lastId !== null) {
            entryId = String(lastId);
          }
        } catch (error) {
          // fall back to in-memory entry only
        }
        const entry = {
          id: entryId,
          user: session.nickname || session.username,
          userUsername: session.username,
          userRole: session.role,
          text,
          timestamp: createdAt
        };
        const history = getCommandHistoryForSender(senderId);
        history.push(entry);
        commandHistory.set(senderId, history);
        const entryPayload = JSON.stringify({
          type: "command-entry",
          senderId,
          entry: enrichCommandEntry(entry)
        });
        broadcastToViewers(entryPayload);
        try {
          sender.socket.send(entryPayload);
        } catch (error) {
          // ignore
        }
        try {
          sender.socket.send(JSON.stringify({
            type: "command",
            senderId,
            text
          }));
        } catch (error) {
          // ignore
        }
        return;
      }

      if (message.type === "delete-command") {
        const session = socket.user;
        if (!session) {
          return;
        }
        const id = typeof message.id === "string" ? message.id.trim() : "";
        if (!id) {
          return;
        }
        const historyKey = getCommandHistoryKey(senderId);
        const history = getCommandHistoryForKey(historyKey);
        const target = history.find((entry) => entry.id === id);
        if (!target) {
          return;
        }

        const displayName = (session && (session.nickname || session.username)) || "";
        const targetUsername = typeof target.userUsername === "string" ? target.userUsername : "";
        const fallbackUsername = !targetUsername && typeof target.user === "string" ? target.user : "";
        const lookupUsername = targetUsername || fallbackUsername;
        const isOwner = Boolean(session)
          && (((lookupUsername && lookupUsername === session.username))
            || target.user === session.username
            || target.user === displayName);

        if (session.role === "admin") {
          // ok
        } else if (session.role === "manager") {
          let targetRole = typeof target.userRole === "string" ? target.userRole : "";
          if (!targetRole && lookupUsername) {
            const row = findUserRoleByUsernameStmt.get(lookupUsername);
            targetRole = row ? row.role : "";
          }
          if (!isOwner && targetRole === "admin") {
            return;
          }
          if (!isOwner && !targetRole) {
            return;
          }
        } else if (!isOwner) {
          return;
        }
        const numericId = Number(id);
        if (Number.isFinite(numericId) && numericId > 0) {
          try {
            deleteCommandHistoryStmt.run(numericId, historyKey);
          } catch (error) {
            // ignore
          }
        }
        const next = history.filter((entry) => entry.id !== id);
        commandHistory.set(historyKey, next);
        const historyPayload = JSON.stringify({
          type: "command-history",
          senderId,
          entries: enrichCommandEntries(next)
        });
        broadcastToViewers(historyPayload);
        const sender = senders.get(senderId);
        if (sender && sender.socket) {
          try {
            sender.socket.send(historyPayload);
          } catch (error) {
            // ignore
          }
        }
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

  return wss;
};

export { startWebSocketServer };
