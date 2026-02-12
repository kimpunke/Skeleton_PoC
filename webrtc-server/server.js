import http from "http";
import fs from "fs";
import path from "path";
import { publicDir, clipsDir, dbPath, sessionTtlSeconds } from "./config.js";
import { createDb } from "./db.js";
import { createAuth } from "./auth.js";
import { applyCors } from "./http/utils.js";
import { handleApiRequest } from "./routes/index.js";
import { startWebSocketServer } from "./ws.js";
import * as pose from "./pose.js";

const { stmts } = createDb(dbPath);
const auth = createAuth({ stmts, sessionTtlSeconds });
auth.ensureBootstrapUser();

const server = http.createServer(async (req, res) => {
  const urlPath = req.url === "/" ? "/html/index.html" : req.url;
  const safePath = urlPath.split("?")[0];

  if (safePath.startsWith("/api/")) {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const handled = await handleApiRequest(req, res, safePath, {
      auth,
      stmts,
      config: { clipsDir }
    });
    if (handled) {
      return;
    }
  }

  let filePath = null;
  if (safePath.startsWith("/clips/")) {
    const clipName = path.basename(safePath);
    filePath = path.join(clipsDir, clipName);
  } else {
    const publicPath = safePath.replace(/^\/+/, "");
    filePath = path.join(publicDir, publicPath);
  }

  const resolved = path.resolve(filePath);
  const baseDir = safePath.startsWith("/clips/") ? clipsDir : publicDir;
  if (!resolved.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const contentType = filePath.endsWith(".html")
    ? "text/html"
    : filePath.endsWith(".js")
      ? "text/javascript"
      : filePath.endsWith(".css")
        ? "text/css"
        : filePath.endsWith(".png")
          ? "image/png"
          : filePath.endsWith(".webm")
            ? "video/webm"
            : "application/octet-stream";

  if (filePath.endsWith(".webm")) {
    fs.stat(filePath, (statErr, stats) => {
      if (statErr) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const range = req.headers.range;
      const size = stats.size;
      if (!range) {
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": size,
          "Accept-Ranges": "bytes"
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      const match = range.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : size - 1;
      if (!Number.isFinite(start)
          || !Number.isFinite(end)
          || start > end
          || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        res.end();
        return;
      }
      const clampedEnd = Math.min(end, size - 1);
      res.writeHead(206, {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${clampedEnd}/${size}`,
        "Content-Length": clampedEnd - start + 1,
        "Accept-Ranges": "bytes"
      });
      fs.createReadStream(filePath, { start, end: clampedEnd }).pipe(res);
    });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

startWebSocketServer({ server, auth, stmts, pose });

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`WebRTC server running on http://${host}:${port}`);
});
