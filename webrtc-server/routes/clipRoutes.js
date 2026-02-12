import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { readRequestBody, sendJson } from "../http/utils.js";

const MIN_CLIP_GAP_MS = 1000;
const MAX_CLIP_BYTES = 30 * 1024 * 1024;
const lastClipBySender = new Map();
let ffmpegBinary = null;

const resolveFfmpegBinary = async () => {
  if (ffmpegBinary) {
    return ffmpegBinary;
  }
  const envPath = (process.env.FFMPEG_PATH || "").trim();
  if (envPath) {
    ffmpegBinary = envPath;
    return ffmpegBinary;
  }
  try {
    const mod = await import("ffmpeg-static");
    const resolved = typeof mod.default === "string" ? mod.default : mod;
    if (resolved) {
      ffmpegBinary = resolved;
      return ffmpegBinary;
    }
  } catch (error) {
    // ignore
  }
  ffmpegBinary = "ffmpeg";
  return ffmpegBinary;
};

const remuxWebm = async (buffer, outputPath) => {
  const binary = await resolveFfmpegBinary();
  if (!binary) {
    throw new Error("ffmpeg-unavailable");
  }
  const tempInput = path.join(os.tmpdir(), `fall-upload-${crypto.randomUUID()}.webm`);
  await fs.promises.writeFile(tempInput, buffer);
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(binary, [
        "-y",
        "-fflags",
        "+genpts+discardcorrupt",
        "-i",
        tempInput,
        "-c:v",
        "libvpx",
        "-b:v",
        "1M",
        "-g",
        "30",
        "-keyint_min",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-reset_timestamps",
        "1",
        "-avoid_negative_ts",
        "make_zero",
        "-f",
        "webm",
        outputPath
      ]);
      proc.on("error", () => reject(new Error("ffmpeg-unavailable")));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg-exit-${code}`));
        }
      });
    });
  } finally {
    try {
      await fs.promises.unlink(tempInput);
    } catch (error) {
      // ignore
    }
  }
};

const formatClipStamp = (date) => {
  const pad2 = (value) => String(value).padStart(2, "0");
  const pad3 = (value) => String(value).padStart(3, "0");
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
    + `-${pad3(date.getMilliseconds())}`;
};

const parseClipStamp = (stamp) => {
  const match = stamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute, second, milli] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(milli)
  );
};

const buildClipInfo = (filename, stats) => {
  const match = filename.match(/^(fall|record)-(\w+)-(\d{8}-\d{6}-\d{3})\.webm$/);
  const type = match ? match[1] : "fall";
  const senderId = match ? match[2] : "unknown";
  const parsedDate = match ? parseClipStamp(match[3]) : null;
  const timestamp = (parsedDate || stats.mtime).toISOString();
  return {
    id: filename,
    filename,
    url: `/clips/${filename}`,
    senderId,
    timestamp,
    createdAt: stats.mtime.toISOString(),
    type
  };
};

const handleClipRoutes = async (req, res, safePath, ctx) => {
  const { auth, stmts, config } = ctx;
  const {
    listClipCommentsStmt,
    insertClipCommentStmt,
    findClipCommentStmt,
    deleteClipCommentStmt,
    deleteClipCommentsByClipIdStmt
  } = stmts;
  const { clipsDir } = config;

  if (safePath === "/api/clip-comments") {
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const baseUrl = `http://${req.headers.host || "localhost"}`;
    const requestUrl = new URL(req.url || "", baseUrl);
    const clipId = (requestUrl.searchParams.get("clipId") || "").trim();
    if (!clipId) {
      sendJson(res, 400, { error: "missing-clip" });
      return true;
    }
    if (req.method === "GET") {
      const rows = listClipCommentsStmt.all(clipId);
      const result = rows.map((row) => ({
        id: String(row.id),
        user: row.user_display,
        userUsername: row.user_username,
        userRole: row.user_role || "user",
        text: row.text,
        timestamp: row.created_at
      }));
      sendJson(res, 200, result);
      return true;
    }
    if (req.method === "DELETE") {
      try {
        const body = await readRequestBody(req);
        let data = null;
        try {
          data = JSON.parse(body || "{}");
        } catch (error) {
          sendJson(res, 400, { error: "invalid-json" });
          return true;
        }
        const id = typeof data.id === "string" ? data.id.trim() : "";
        if (!id) {
          sendJson(res, 400, { error: "missing-id" });
          return true;
        }
        const numericId = Number(id);
        if (!Number.isFinite(numericId) || numericId <= 0) {
          sendJson(res, 400, { error: "invalid-id" });
          return true;
        }
        const target = findClipCommentStmt.get(numericId, clipId);
        if (!target) {
          sendJson(res, 404, { error: "not-found" });
          return true;
        }

        const isOwner = target.user_username === session.username;
        if (session.role === "admin") {
          // ok
        } else if (session.role === "manager") {
          if (!isOwner && target.user_role === "admin") {
            sendJson(res, 403, { error: "forbidden" });
            return true;
          }
        } else if (!isOwner) {
          sendJson(res, 403, { error: "forbidden" });
          return true;
        }

        deleteClipCommentStmt.run(numericId, clipId);
        const rows = listClipCommentsStmt.all(clipId);
        const result = rows.map((row) => ({
          id: String(row.id),
          user: row.user_display,
          userUsername: row.user_username,
          userRole: row.user_role || "user",
          text: row.text,
          timestamp: row.created_at
        }));
        sendJson(res, 200, result);
      } catch (error) {
        sendJson(res, 500, { error: "failed" });
      }
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    try {
      const body = await readRequestBody(req);
      let data = null;
      try {
        data = JSON.parse(body || "{}");
      } catch (error) {
        sendJson(res, 400, { error: "invalid-json" });
        return true;
      }
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) {
        sendJson(res, 400, { error: "empty" });
        return true;
      }
      const createdAt = new Date().toISOString();
      insertClipCommentStmt.run(
        clipId,
        session.username,
        session.nickname || session.username,
        text,
        createdAt
      );
      const rows = listClipCommentsStmt.all(clipId);
      const result = rows.map((row) => ({
        id: String(row.id),
        user: row.user_display,
        userUsername: row.user_username,
        userRole: row.user_role || "user",
        text: row.text,
        timestamp: row.created_at
      }));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  if (safePath === "/api/fall-clips") {
    if (req.method === "GET") {
      fs.readdir(clipsDir, (err, files) => {
        if (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "failed" }));
          return;
        }
        const clips = files
          .filter((file) => /^(fall|record)-[0-9a-z]+-\d{8}-\d{6}-\d{3}\.webm$/i.test(file))
          .map((file) => buildClipInfo(file, fs.statSync(path.join(clipsDir, file))))
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(clips));
      });
      return true;
    }
    if (req.method === "DELETE") {
      const session = auth.getSessionFromHeaders(req.headers);
      if (!session) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return true;
      }
      if (session.role !== "admin") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return true;
      }
      const baseUrl = `http://${req.headers.host || "localhost"}`;
      const requestUrl = new URL(req.url || "", baseUrl);
      const clipId = (requestUrl.searchParams.get("id") || "").trim();
      if (!clipId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing-id" }));
        return true;
      }
      const filename = path.basename(clipId);
      if (!/^(fall|record)-[0-9a-z]+-\d{8}-\d{6}-\d{3}\.webm$/i.test(filename)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid-id" }));
        return true;
      }
      const filePath = path.join(clipsDir, filename);
      if (!filePath.startsWith(clipsDir)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return true;
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not-found" }));
        return true;
      }
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "delete-failed" }));
        return true;
      }
      try {
        deleteClipCommentsByClipIdStmt.run(filename);
      } catch (error) {
        // ignore
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    if (req.method === "POST") {
      const senderHeader = req.headers["x-fall-sender"] || "unknown";
      const senderId = String(senderHeader).replace(/[^0-9a-z]/gi, "") || "unknown";
      const clipTypeHeader = String(req.headers["x-clip-type"] || "").trim().toLowerCase();
      const clipType = clipTypeHeader === "record" ? "record" : "fall";
      const timestampHeader = req.headers["x-fall-timestamp"];
      const timestamp = timestampHeader ? new Date(String(timestampHeader)) : new Date();
      const clipDate = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
      const requestedStamp = formatClipStamp(clipDate);
      const chunks = [];
      let receivedBytes = 0;
      let payloadTooLarge = false;
      req.on("data", (chunk) => {
        if (payloadTooLarge) {
          return;
        }
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_CLIP_BYTES) {
          payloadTooLarge = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "payload-too-large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (payloadTooLarge) {
          return;
        }
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "empty" }));
          return;
        }
        const nowMs = Date.now();
        const lastClip = lastClipBySender.get(senderId);
        if (lastClip && lastClip.type === clipType && nowMs - lastClip.savedAtMs < MIN_CLIP_GAP_MS) {
          const existingStamp = lastClip.stamp;
          const existingFilename = `${clipType}-${senderId}-${existingStamp}.webm`;
          const existingPath = path.join(clipsDir, existingFilename);
          if (fs.existsSync(existingPath)) {
            const stats = fs.statSync(existingPath);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(buildClipInfo(existingFilename, stats)));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, pending: true }));
          return;
        }

        const clipStamp = requestedStamp;
        const filename = `${clipType}-${senderId}-${clipStamp}.webm`;
        const filePath = path.join(clipsDir, filename);
        lastClipBySender.set(senderId, { stamp: clipStamp, savedAtMs: nowMs, type: clipType });

        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildClipInfo(filename, stats)));
          return;
        }

        remuxWebm(buffer, filePath)
          .then(() => {
            const stats = fs.statSync(filePath);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(buildClipInfo(filename, stats)));
          })
          .catch(() => {
            const current = lastClipBySender.get(senderId);
            if (current && current.stamp === clipStamp && current.type === clipType) {
              lastClipBySender.delete(senderId);
            }
            try {
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
              }
            } catch (error) {
              // ignore
            }
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "mux-failed" }));
          });
      });
      return true;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method-not-allowed" }));
    return true;
  }

  return false;
};

export { handleClipRoutes };
