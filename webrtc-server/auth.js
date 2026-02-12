import crypto from "crypto";
import { parseCookies } from "./http/utils.js";

const normalizeRole = (role) => {
  const value = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (value === "admin") {
    return "admin";
  }
  if (value === "manager") {
    return "manager";
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

const createSessionId = () => {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
};

const createAuth = ({ stmts, sessionTtlSeconds }) => {
  const {
    userCountStmt,
    insertUserStmt,
    findSessionStmt,
    deleteSessionStmt,
    purgeExpiredSessionsStmt
  } = stmts;

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
    insertUserStmt.run(
      username,
      hashPassword(password),
      username,
      role,
      new Date().toISOString()
    );
    console.log(`Bootstrapped initial user '${username}' with role '${role}'.`);
  };

  const getSessionById = (sessionId) => {
    purgeExpiredSessions();
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
    return {
      sessionId,
      username: row.username,
      nickname: row.nickname || row.username,
      role: row.role
    };
  };

  const getSessionFromHeaders = (headers) => {
    const headerSessionId = headers && typeof headers["x-session-id"] === "string"
      ? headers["x-session-id"].trim()
      : "";
    if (headerSessionId) {
      return getSessionById(headerSessionId);
    }
    const cookies = parseCookies(headers && headers.cookie);
    const sessionId = cookies.session_id;
    return getSessionById(sessionId);
  };

  return {
    normalizeRole,
    hashPassword,
    verifyPassword,
    meetsPasswordPolicy,
    createSessionId,
    getSessionById,
    getSessionFromHeaders,
    ensureBootstrapUser,
    sessionTtlSeconds
  };
};

export { createAuth };
