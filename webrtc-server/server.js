import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";

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
    }
    res.writeHead(200);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });
let sender = null;
const viewers = new Map();
let viewerIdCounter = 1;

const broadcastViewerCount = () => {
  const payload = JSON.stringify({ type: "viewer-count", count: viewers.size });
  for (const viewer of viewers.values()) {
    try {
      viewer.send(payload);
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
    if (sender) {
      sender.close();
    }
    sender = socket;
    for (const viewerId of viewers.keys()) {
      sender.send(JSON.stringify({ type: "ready", viewerId }));
    }
  } else if (isViewer) {
    const viewerId = String(viewerIdCounter++);
    socket.viewerId = viewerId;
    viewers.set(viewerId, socket);
    socket.send(JSON.stringify({ type: "viewer-id", viewerId }));
    broadcastViewerCount();
    if (sender) {
      sender.send(JSON.stringify({ type: "ready", viewerId }));
    }
  }

  socket.on("message", (data) => {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      return;
    }

    if (socket === sender) {
      let viewerId = message.viewerId;
      if (!viewerId && viewers.size === 1) {
        viewerId = Array.from(viewers.keys())[0];
        message.viewerId = viewerId;
      }
      const viewerSocket = viewerId ? viewers.get(viewerId) : null;
      if (viewerSocket) {
        viewerSocket.send(JSON.stringify(message));
      }
    } else if (sender) {
      const viewerId = socket.viewerId;
      if (viewerId && !message.viewerId) {
        message.viewerId = viewerId;
      }
      sender.send(JSON.stringify(message));
    }
  });

  socket.on("close", () => {
    if (socket === sender) {
      sender = null;
    }
    if (socket.viewerId) {
      const viewerId = socket.viewerId;
      viewers.delete(viewerId);
      broadcastViewerCount();
      if (sender) {
        sender.send(JSON.stringify({ type: "viewer-disconnected", viewerId }));
      }
    }
  });
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`WebRTC server running on http://${host}:${port}`);
});
