import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import wrtc from "wrtc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const clipsDir = path.join(__dirname, "clips");
const dataDir = path.join(__dirname, "data");
const dbPath = process.env.DB_PATH || path.join(dataDir, "app.db");
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 0);
const commandHistory = new Map();
let commandSequence = 1;
const clipComments = new Map();
let clipCommentSequence = 1;
const lastClipBySender = new Map();
const MIN_CLIP_GAP_MS = 5000;

if (!fs.existsSync(clipsDir)) {
  fs.mkdirSync(clipsDir, { recursive: true });
}

if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS signup_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS signup_requests_requested_at_idx ON signup_requests(requested_at);
`);

const normalizeRole = (role) => {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (value === "admin") {
    return "admin";
  }
  return "user";
};

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString("base64")}:${hash.toString("base64")}`;
};

const verifyPassword = (password, storedHash) => {
  if (typeof storedHash !== "string") {
    return false;
  }
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = Buffer.from(parts[1], "base64");
  const expected = Buffer.from(parts[2], "base64");
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
};

const meetsPasswordPolicy = (password) => {
  if (typeof password !== "string") {
    return false;
  }
  if (password.length < 8) {
    return false;
  }
  if (!/[0-9]/.test(password)) {
    return false;
  }
  if (!/[^A-Za-z0-9\s]/.test(password)) {
    return false;
  }
  return true;
};

const userCountStmt = db.prepare("SELECT COUNT(*) AS count FROM users");
const insertSignupRequestStmt = db.prepare(
  "INSERT INTO signup_requests(username, password_hash, reason, requested_at) VALUES(?, ?, ?, ?)"
);
const insertUserStmt = db.prepare(
  "INSERT INTO users(username, password_hash, role, created_at) VALUES(?, ?, ?, ?)"
);
const findUserByUsernameStmt = db.prepare(
  "SELECT id, username, password_hash, role FROM users WHERE username = ?"
);
const findSignupRequestByUsernameStmt = db.prepare(
  "SELECT id FROM signup_requests WHERE username = ?"
);
const listSignupRequestsStmt = db.prepare(
  "SELECT id, username, reason, requested_at FROM signup_requests ORDER BY requested_at DESC"
);
const findSignupRequestByIdStmt = db.prepare(
  "SELECT id, username, password_hash, reason, requested_at FROM signup_requests WHERE id = ?"
);
const deleteSignupRequestByIdStmt = db.prepare(
  "DELETE FROM signup_requests WHERE id = ?"
);
const insertSessionStmt = db.prepare(
  "INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)"
);
const findSessionStmt = db.prepare(
  "SELECT users.username AS username, users.role AS role, sessions.expires_at AS expires_at"
    + " FROM sessions JOIN users ON users.id = sessions.user_id"
    + " WHERE sessions.id = ?"
);
const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
const purgeExpiredSessionsStmt = db.prepare(
  "DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?"
);

const purgeExpiredSessions = () => {
  if (!sessionTtlSeconds || Number.isNaN(sessionTtlSeconds) || sessionTtlSeconds <= 0) {
    return;
  }
  purgeExpiredSessionsStmt.run(new Date().toISOString());
};

const ensureBootstrapUser = () => {
  const row = userCountStmt.get();
  const count = row ? Number(row.count) : 0;
  if (count > 0) {
    return;
  }
  const username = String(process.env.BOOTSTRAP_USERNAME || "").trim();
  const password = String(process.env.BOOTSTRAP_PASSWORD || "");
  const role = normalizeRole(process.env.BOOTSTRAP_ROLE || "admin");
  if (!username || !password) {
    console.error(
      "No users found in DB. Set BOOTSTRAP_USERNAME and BOOTSTRAP_PASSWORD to create the first account."
    );
    return;
  }
  insertUserStmt.run(username, hashPassword(password), role, new Date().toISOString());
  console.log(`Bootstrapped initial user '${username}' with role '${role}'.`);
};

ensureBootstrapUser();

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
  const match = filename.match(/^fall-(\w+)-(\d{8}-\d{6}-\d{3})\.webm$/);
  const senderId = match ? match[1] : "unknown";
  const parsedDate = match ? parseClipStamp(match[2]) : null;
  const timestamp = (parsedDate || stats.mtime).toISOString();
  return {
    id: filename,
    filename,
    url: `/clips/${filename}`,
    senderId,
    timestamp,
    createdAt: stats.mtime.toISOString()
  };
};

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) {
    return {};
  }
  return cookieHeader.split(";").reduce((acc, part) => {
    const [rawKey, ...rest] = part.split("=");
    const key = rawKey ? rawKey.trim() : "";
    if (!key) {
      return acc;
    }
    acc[key] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {});
};

const getSessionFromHeaders = (headers) => {
  purgeExpiredSessions();
  const cookies = parseCookies(headers && headers.cookie);
  const sessionId = cookies.session_id;
  if (!sessionId) {
    return null;
  }
  const row = findSessionStmt.get(sessionId);
  if (!row) {
    return null;
  }
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      deleteSessionStmt.run(sessionId);
      return null;
    }
  }
  return { username: row.username, role: row.role };
};

const createSessionId = () => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
};

const applyCors = (req, res) => {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Vary", "Origin");
};

const readRequestBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  req.on("error", reject);
});

const sendJson = (res, statusCode, payload, headers = {}) => {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...headers
  });
  res.end(JSON.stringify(payload));
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = urlPath.split("?")[0];

  if (safePath.startsWith("/api/")) {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (safePath === "/api/signup") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    readRequestBody(req)
      .then((body) => {
        let data = null;
        try {
          data = JSON.parse(body || "{}");
        } catch (error) {
          sendJson(res, 400, { error: "invalid-json" });
          return;
        }

        const username = typeof data.username === "string" ? data.username.trim() : "";
        const password = typeof data.password === "string" ? data.password : "";
        const passwordConfirm = typeof data.passwordConfirm === "string" ? data.passwordConfirm : "";
        const reason = typeof data.reason === "string" ? data.reason.trim() : "";
        if (!username || !password || !passwordConfirm || !reason) {
          sendJson(res, 400, { error: "missing-fields" });
          return;
        }
        if (password !== passwordConfirm) {
          sendJson(res, 400, { error: "password-mismatch" });
          return;
        }
        if (!meetsPasswordPolicy(password)) {
          sendJson(res, 400, { error: "weak-password" });
          return;
        }
        if (findUserByUsernameStmt.get(username)) {
          sendJson(res, 409, { error: "username-taken" });
          return;
        }
        if (findSignupRequestByUsernameStmt.get(username)) {
          sendJson(res, 409, { error: "username-pending" });
          return;
        }

        try {
          insertSignupRequestStmt.run(
            username,
            hashPassword(password),
            reason,
            new Date().toISOString()
          );
        } catch (error) {
          sendJson(res, 500, { error: "signup-failed" });
          return;
        }
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 500, { error: "signup-failed" }));
    return;
  }

  if (safePath === "/api/admin/signup-requests") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    const session = getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const rows = listSignupRequestsStmt.all();
    const result = rows.map((row) => ({
      id: String(row.id),
      username: row.username,
      reason: row.reason,
      requestedAt: row.requested_at
    }));
    sendJson(res, 200, result);
    return;
  }

  if (safePath === "/api/admin/signup-requests/approve") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    const session = getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    readRequestBody(req)
      .then((body) => {
        let data = null;
        try {
          data = JSON.parse(body || "{}");
        } catch (error) {
          sendJson(res, 400, { error: "invalid-json" });
          return;
        }
        const rawId = data.id;
        const id = typeof rawId === "number" ? rawId : Number(String(rawId || ""));
        if (!Number.isFinite(id) || id <= 0) {
          sendJson(res, 400, { error: "invalid-id" });
          return;
        }

        const request = findSignupRequestByIdStmt.get(id);
        if (!request) {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        try {
          insertUserStmt.run(
            request.username,
            request.password_hash,
            "user",
            new Date().toISOString()
          );
        } catch (error) {
          sendJson(res, 409, { error: "username-taken" });
          return;
        }
        deleteSignupRequestByIdStmt.run(id);
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 500, { error: "failed" }));
    return;
  }

  if (safePath === "/api/admin/signup-requests/reject") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    const session = getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    readRequestBody(req)
      .then((body) => {
        let data = null;
        try {
          data = JSON.parse(body || "{}");
        } catch (error) {
          sendJson(res, 400, { error: "invalid-json" });
          return;
        }
        const rawId = data.id;
        const id = typeof rawId === "number" ? rawId : Number(String(rawId || ""));
        if (!Number.isFinite(id) || id <= 0) {
          sendJson(res, 400, { error: "invalid-id" });
          return;
        }
        const request = findSignupRequestByIdStmt.get(id);
        if (!request) {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        deleteSignupRequestByIdStmt.run(id);
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 500, { error: "failed" }));
    return;
  }

  if (safePath === "/api/login") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    readRequestBody(req)
      .then((body) => {
        let data = null;
        try {
          data = JSON.parse(body || "{}");
        } catch (error) {
          sendJson(res, 400, { error: "invalid-json" });
          return;
        }
        const username = typeof data.username === "string" ? data.username.trim() : "";
        const password = typeof data.password === "string" ? data.password : "";
        const account = findUserByUsernameStmt.get(username);
        if (!account) {
          if (findSignupRequestByUsernameStmt.get(username)) {
            sendJson(res, 403, { error: "pending-approval" });
            return;
          }
          sendJson(res, 401, { error: "invalid-credentials" });
          return;
        }
        if (!verifyPassword(password, account.password_hash)) {
          sendJson(res, 401, { error: "invalid-credentials" });
          return;
        }
        const sessionId = createSessionId();
        const createdAt = new Date().toISOString();
        const expiresAt = (sessionTtlSeconds && sessionTtlSeconds > 0)
          ? new Date(Date.now() + sessionTtlSeconds * 1000).toISOString()
          : null;
        insertSessionStmt.run(sessionId, account.id, createdAt, expiresAt);
        const maxAge = expiresAt ? `; Max-Age=${Math.floor(sessionTtlSeconds)}` : "";
        const cookie = `session_id=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax${maxAge}`;
        sendJson(res, 200, { username: account.username, role: account.role }, { "Set-Cookie": cookie });
      })
      .catch(() => sendJson(res, 500, { error: "login-failed" }));
    return;
  }

  if (safePath === "/api/session") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    const session = getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    sendJson(res, 200, session);
    return;
  }

  if (safePath === "/api/logout") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies.session_id;
    if (sessionId) {
      deleteSessionStmt.run(sessionId);
    }
    const cookie = "session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
    sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
    return;
  }

  if (safePath === "/api/clip-comments") {
    const session = getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const baseUrl = `http://${req.headers.host || "localhost"}`;
    const requestUrl = new URL(req.url || "", baseUrl);
    const clipId = (requestUrl.searchParams.get("clipId") || "").trim();
    if (!clipId) {
      sendJson(res, 400, { error: "missing-clip" });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, clipComments.get(clipId) || []);
      return;
    }
    if (req.method === "DELETE") {
      readRequestBody(req)
        .then((body) => {
          let data = null;
          try {
            data = JSON.parse(body || "{}");
          } catch (error) {
            sendJson(res, 400, { error: "invalid-json" });
            return;
          }
          const id = typeof data.id === "string" ? data.id.trim() : "";
          if (!id) {
            sendJson(res, 400, { error: "missing-id" });
            return;
          }
          const history = clipComments.get(clipId) || [];
          const target = history.find((entry) => entry.id === id);
          if (!target) {
            sendJson(res, 404, { error: "not-found" });
            return;
          }
          if (session.role !== "admin" && target.user !== session.username) {
            sendJson(res, 403, { error: "forbidden" });
            return;
          }
          const next = history.filter((entry) => entry.id !== id);
          clipComments.set(clipId, next);
          sendJson(res, 200, next);
        })
        .catch(() => sendJson(res, 500, { error: "failed" }));
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }
    readRequestBody(req)
      .then((body) => {
        let data = null;
        try {
          data = JSON.parse(body || "{}");
        } catch (error) {
          sendJson(res, 400, { error: "invalid-json" });
          return;
        }
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (!text) {
          sendJson(res, 400, { error: "empty" });
          return;
        }
        const entry = {
          id: String(clipCommentSequence++),
          user: session.username,
          text,
          timestamp: new Date().toISOString()
        };
        const history = clipComments.get(clipId) || [];
        history.push(entry);
        clipComments.set(clipId, history);
        sendJson(res, 200, history);
      })
      .catch(() => sendJson(res, 500, { error: "failed" }));
    return;
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
          .filter((file) => file.endsWith(".webm"))
          .map((file) => buildClipInfo(file, fs.statSync(path.join(clipsDir, file))))
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(clips));
      });
      return;
    }
    if (req.method === "POST") {
      const senderHeader = req.headers["x-fall-sender"] || "unknown";
      const senderId = String(senderHeader).replace(/[^0-9a-z]/gi, "") || "unknown";
      const timestampHeader = req.headers["x-fall-timestamp"];
      const timestamp = timestampHeader ? new Date(String(timestampHeader)) : new Date();
      const clipDate = Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
      const clipStamp = formatClipStamp(clipDate);
      const filename = `fall-${senderId}-${clipStamp}.webm`;
      const filePath = path.join(clipsDir, filename);
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "empty" }));
          return;
        }
        const nowMs = Date.now();
        const lastClip = lastClipBySender.get(senderId);
        if (lastClip
            && (lastClip.stamp === clipStamp
              || nowMs - lastClip.savedAtMs < MIN_CLIP_GAP_MS)
            && fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          lastClipBySender.set(senderId, { stamp: clipStamp, savedAtMs: nowMs });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildClipInfo(filename, stats)));
          return;
        }
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          lastClipBySender.set(senderId, { stamp: clipStamp, savedAtMs: nowMs });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildClipInfo(filename, stats)));
          return;
        }
        fs.writeFile(filePath, buffer, (writeErr) => {
          if (writeErr) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "write-failed" }));
            return;
          }
          const stats = fs.statSync(filePath);
          lastClipBySender.set(senderId, { stamp: clipStamp, savedAtMs: nowMs });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildClipInfo(filename, stats)));
        });
      });
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method-not-allowed" }));
    return;
  }

  let filePath = null;
  if (safePath.startsWith("/clips/")) {
    const clipName = path.basename(safePath);
    filePath = path.join(clipsDir, clipName);
  } else {
    filePath = path.join(publicDir, safePath);
  }

  const resolved = path.resolve(filePath);
  const baseDir = safePath.startsWith("/clips/") ? clipsDir : publicDir;
  if (!resolved.startsWith(baseDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

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
    } else if (filePath.endsWith(".css")) {
      res.setHeader("Content-Type", "text/css");
    } else if (filePath.endsWith(".png")) {
      res.setHeader("Content-Type", "image/png");
    } else if (filePath.endsWith(".webm")) {
      res.setHeader("Content-Type", "video/webm");
    }
    res.writeHead(200);
    res.end(data);
  });
});

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStream } = wrtc;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const rtcConfig = { iceServers, sdpSemantics: "unified-plan" };
const MAX_SENDERS = 4;
const COMMAND_TOKEN = (process.env.COMMAND_TOKEN || "").trim();
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
const FALL_UPRIGHT_FRAMES = 12;
const FALL_IMPULSE_FRAMES = 14;
const FALL_POST_FRAMES = 24;
const FALL_POST_STILL_FRAMES = 16;
const FALL_POST_TIMEOUT_FRAMES = 36;
const FALL_RECOVERY_FRAMES = 18;
const FALL_HIP_DROP_THRESHOLD = 0.2;
const FALL_DOWN_SPEED_THRESHOLD = 1.0;
const FALL_STILL_SPEED_THRESHOLD = 0.2;
const FALL_MIN_BBOX_HEIGHT = 0.15;
const FALL_ANGLE_CHANGE_THRESHOLD = 50;
const FALL_ASPECT_CHANGE_THRESHOLD = 0.55;
const FALL_UPRIGHT_ANGLE = 22;
const FALL_LYING_ANGLE = 65;
const FALL_UPRIGHT_ASPECT = 1.4;
const FALL_LYING_ASPECT = 1.05;

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

const recordFallHistory = (senderState, comY, downSpeed, torsoAngle, aspectRatio) => {
  if (!senderState) {
    return;
  }
  const index = senderState.fallHistoryIndex || 0;
  senderState.comYHistory[index] = comY;
  senderState.downSpeedHistory[index] = downSpeed;
  senderState.angleHistory[index] = torsoAngle;
  senderState.aspectHistory[index] = aspectRatio;
  senderState.fallHistoryIndex = (index + 1) % FALL_IMPULSE_FRAMES;
  senderState.fallHistoryCount = Math.min(
    (senderState.fallHistoryCount || 0) + 1,
    FALL_IMPULSE_FRAMES
  );
};

const isFallImpulse = (senderState, comY, normHeight) => {
  if (!senderState || senderState.fallHistoryCount < FALL_IMPULSE_FRAMES) {
    return false;
  }
  let minComY = senderState.comYHistory[0];
  let minAngle = senderState.angleHistory[0];
  let maxAngle = senderState.angleHistory[0];
  let minAspect = senderState.aspectHistory[0];
  let maxAspect = senderState.aspectHistory[0];
  let maxDownSpeed = senderState.downSpeedHistory[0];
  for (let i = 1; i < senderState.fallHistoryCount; i += 1) {
    minComY = Math.min(minComY, senderState.comYHistory[i]);
    minAngle = Math.min(minAngle, senderState.angleHistory[i]);
    maxAngle = Math.max(maxAngle, senderState.angleHistory[i]);
    minAspect = Math.min(minAspect, senderState.aspectHistory[i]);
    maxAspect = Math.max(maxAspect, senderState.aspectHistory[i]);
    maxDownSpeed = Math.max(maxDownSpeed, senderState.downSpeedHistory[i]);
  }
  const hipDrop = (comY - minComY) / normHeight;
  const angleChange = maxAngle - minAngle;
  const aspectChange = maxAspect - minAspect;
  return hipDrop > FALL_HIP_DROP_THRESHOLD
    && maxDownSpeed > FALL_DOWN_SPEED_THRESHOLD
    && angleChange > FALL_ANGLE_CHANGE_THRESHOLD
    && aspectChange > FALL_ASPECT_CHANGE_THRESHOLD;
};

const updateFallState = (senderState, comX, comY, torsoAngle, aspectRatio, bboxHeight, now) => {
  if (!senderState) {
    return false;
  }
  const normHeight = Math.max(bboxHeight, FALL_MIN_BBOX_HEIGHT);
  let downSpeed = 0;
  let speed = 0;
  if (senderState.lastFallSampleTimestampMs) {
    const dt = (now - senderState.lastFallSampleTimestampMs) / 1000;
    if (dt > 0) {
      const dx = comX - senderState.lastComX;
      const dy = comY - senderState.lastComY;
      speed = Math.hypot(dx, dy) / dt / normHeight;
      downSpeed = dy / dt / normHeight;
    }
  }
  senderState.lastComX = comX;
  senderState.lastComY = comY;
  senderState.lastFallSampleTimestampMs = now;

  recordFallHistory(senderState, comY, downSpeed, torsoAngle, aspectRatio);
  const upright = torsoAngle < FALL_UPRIGHT_ANGLE && aspectRatio > FALL_UPRIGHT_ASPECT;
  const lying = torsoAngle > FALL_LYING_ANGLE && aspectRatio < FALL_LYING_ASPECT;
  const fallImpulse = isFallImpulse(senderState, comY, normHeight);

  switch (senderState.fallState) {
    case "IDLE":
      if (upright) {
        senderState.uprightFrames += 1;
        if (senderState.uprightFrames >= FALL_UPRIGHT_FRAMES) {
          senderState.fallState = "ARMED";
        }
      } else {
        senderState.uprightFrames = 0;
      }
      break;
    case "ARMED":
      if (fallImpulse) {
        senderState.fallState = "POST";
        senderState.postFrames = 0;
        senderState.postTimeoutFrames = 0;
      }
      if (!upright) {
        senderState.uprightFrames = 0;
      }
      break;
    case "POST":
      if (lying) {
        senderState.postFrames += 1;
        if (speed < FALL_STILL_SPEED_THRESHOLD) {
          senderState.postStillFrames += 1;
        } else {
          senderState.postStillFrames = 0;
        }
        senderState.postTimeoutFrames = 0;
      } else {
        senderState.postFrames = 0;
        senderState.postStillFrames = 0;
        senderState.postTimeoutFrames += 1;
      }
      if (senderState.postFrames >= FALL_POST_FRAMES
          && senderState.postStillFrames >= FALL_POST_STILL_FRAMES) {
        senderState.fallState = "FALLEN";
        senderState.recoveryFrames = 0;
      } else if (senderState.postTimeoutFrames >= FALL_POST_TIMEOUT_FRAMES) {
        resetFallState(senderState);
      }
      break;
    case "FALLEN":
      if (upright) {
        senderState.recoveryFrames += 1;
        if (senderState.recoveryFrames >= FALL_RECOVERY_FRAMES) {
          resetFallState(senderState);
        }
      } else {
        senderState.recoveryFrames = 0;
      }
      break;
    default:
      break;
  }

  return senderState.fallState === "FALLEN";
};

const resetFallState = (senderState) => {
  senderState.fallState = "IDLE";
  senderState.uprightFrames = 0;
  senderState.postFrames = 0;
  senderState.postStillFrames = 0;
  senderState.postTimeoutFrames = 0;
  senderState.recoveryFrames = 0;
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
  const torsoAngle = Math.atan2(torsoDx, torsoDy) * (180 / Math.PI);
  const comX = (shoulderX + hipX) * 0.5;
  const comY = (shoulderY + hipY) * 0.5;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const entry of landmarks) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const x = Number(entry[0]);
    const y = Number(entry[1]);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const bboxWidth = Math.max(maxX - minX, 1e-6);
  const bboxHeight = Math.max(maxY - minY, 1e-6);
  const aspectRatio = bboxHeight / bboxWidth;
  const torsoHorizontal = torsoDx > torsoDy * 1.2;
  const now = Date.now();
  if (updateFallState(senderState, comX, comY, torsoAngle, aspectRatio, bboxHeight, now)) {
    return "Fallen";
  }
  if (torsoHorizontal) {
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

const broadcastToViewers = (payload) => {
  for (const viewer of viewers.values()) {
    try {
      viewer.socket.send(payload);
    } catch (error) {
      // ignore
    }
  }
};

const sendHistoryToViewer = (viewerSocket) => {
  for (const [senderId, entries] of commandHistory.entries()) {
    try {
      viewerSocket.send(JSON.stringify({
        type: "command-history",
        senderId,
        entries
      }));
    } catch (error) {
      // ignore
    }
  }
};

const sendHistoryToSender = (senderId, senderSocket) => {
  const entries = commandHistory.get(senderId) || [];
  try {
    senderSocket.send(JSON.stringify({
      type: "command-history",
      senderId,
      entries
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
  commandHistory.delete(senderId);
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
  socket.user = getSessionFromHeaders(req.headers);
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
      lastRightAnkle: null,
      comYHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
      downSpeedHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
      angleHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
      aspectHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
      fallHistoryIndex: 0,
      fallHistoryCount: 0,
      uprightFrames: 0,
      postFrames: 0,
      postStillFrames: 0,
      postTimeoutFrames: 0,
      recoveryFrames: 0,
      lastComX: 0,
      lastComY: 0,
      lastFallSampleTimestampMs: 0,
      fallState: "IDLE"
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
      const entry = {
        id: String(commandSequence++),
        user: session.username,
        text,
        timestamp: new Date().toISOString()
      };
      const history = commandHistory.get(senderId) || [];
      history.push(entry);
      commandHistory.set(senderId, history);
      const entryPayload = JSON.stringify({
        type: "command-entry",
        senderId,
        entry
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
      const history = commandHistory.get(senderId) || [];
      const target = history.find((entry) => entry.id === id);
      if (!target) {
        return;
      }
      if (session && session.role !== "admin" && target.user !== session.username) {
        return;
      }
      const next = history.filter((entry) => entry.id !== id);
      commandHistory.set(senderId, next);
      const historyPayload = JSON.stringify({
        type: "command-history",
        senderId,
        entries: next
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

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
server.listen(port, host, () => {
  console.log(`WebRTC server running on http://${host}:${port}`);
});
