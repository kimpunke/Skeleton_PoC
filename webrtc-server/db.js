import { DatabaseSync } from "node:sqlite";

const createDb = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS clip_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clip_id TEXT NOT NULL,
      user_username TEXT NOT NULL,
      user_display TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,
      user_username TEXT NOT NULL,
      user_display TEXT NOT NULL,
      user_role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS signup_requests_requested_at_idx ON signup_requests(requested_at);
    CREATE INDEX IF NOT EXISTS clip_comments_clip_id_idx ON clip_comments(clip_id);
    CREATE INDEX IF NOT EXISTS command_history_sender_id_idx ON command_history(sender_id);
  `);

  try {
    db.exec("ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';");
  } catch (error) {
    // ignore (already exists)
  }

  db.exec("UPDATE users SET nickname = username WHERE nickname IS NULL OR nickname = '';");

  const stmts = {
    userCountStmt: db.prepare("SELECT COUNT(*) AS count FROM users"),
    insertSignupRequestStmt: db.prepare(
      "INSERT INTO signup_requests(username, password_hash, reason, requested_at) VALUES(?, ?, ?, ?)"
    ),
    insertUserStmt: db.prepare(
      "INSERT INTO users(username, password_hash, nickname, role, created_at) VALUES(?, ?, ?, ?, ?)"
    ),
    findUserByUsernameStmt: db.prepare(
      "SELECT id, username, password_hash, nickname, role FROM users WHERE username = ?"
    ),
    findSignupRequestByUsernameStmt: db.prepare(
      "SELECT id FROM signup_requests WHERE username = ?"
    ),
    listSignupRequestsStmt: db.prepare(
      "SELECT id, username, reason, requested_at FROM signup_requests ORDER BY requested_at DESC"
    ),
    findSignupRequestByIdStmt: db.prepare(
      "SELECT id, username, password_hash, reason, requested_at FROM signup_requests WHERE id = ?"
    ),
    deleteSignupRequestByIdStmt: db.prepare(
      "DELETE FROM signup_requests WHERE id = ?"
    ),
    insertSessionStmt: db.prepare(
      "INSERT INTO sessions(id, user_id, created_at, expires_at) VALUES(?, ?, ?, ?)"
    ),
    findSessionStmt: db.prepare(
      "SELECT users.username AS username, users.nickname AS nickname, users.role AS role, sessions.expires_at AS expires_at"
        + " FROM sessions JOIN users ON users.id = sessions.user_id"
        + " WHERE sessions.id = ?"
    ),
    deleteSessionStmt: db.prepare("DELETE FROM sessions WHERE id = ?"),
    purgeExpiredSessionsStmt: db.prepare(
      "DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at <= ?"
    ),
    updateNicknameStmt: db.prepare(
      "UPDATE users SET nickname = ? WHERE id = ?"
    ),
    updatePasswordHashStmt: db.prepare(
      "UPDATE users SET password_hash = ? WHERE id = ?"
    ),
    listUsersStmt: db.prepare(
      "SELECT id, username, nickname, role FROM users ORDER BY id DESC"
    ),
    updateUserRoleStmt: db.prepare(
      "UPDATE users SET role = ? WHERE id = ?"
    ),
    findUserRoleByUsernameStmt: db.prepare(
      "SELECT role FROM users WHERE username = ?"
    ),
    deleteUserByIdStmt: db.prepare(
      "DELETE FROM users WHERE id = ?"
    ),
    listClipCommentsStmt: db.prepare(
      "SELECT c.id AS id, c.user_username AS user_username, c.user_display AS user_display,"
        + " c.text AS text, c.created_at AS created_at, u.role AS user_role"
        + " FROM clip_comments c LEFT JOIN users u ON u.username = c.user_username"
        + " WHERE c.clip_id = ? ORDER BY c.id ASC"
    ),
    insertClipCommentStmt: db.prepare(
      "INSERT INTO clip_comments(clip_id, user_username, user_display, text, created_at) VALUES(?, ?, ?, ?, ?)"
    ),
    findClipCommentStmt: db.prepare(
      "SELECT c.id AS id, c.user_username AS user_username, c.user_display AS user_display,"
        + " c.text AS text, c.created_at AS created_at, u.role AS user_role"
        + " FROM clip_comments c LEFT JOIN users u ON u.username = c.user_username"
        + " WHERE c.id = ? AND c.clip_id = ?"
    ),
    deleteClipCommentStmt: db.prepare(
      "DELETE FROM clip_comments WHERE id = ? AND clip_id = ?"
    ),
    deleteClipCommentsByClipIdStmt: db.prepare(
      "DELETE FROM clip_comments WHERE clip_id = ?"
    ),
    listCommandHistoryStmt: db.prepare(
      "SELECT id, sender_id, user_username, user_display, user_role, text, created_at"
        + " FROM command_history WHERE sender_id = ? ORDER BY id ASC"
    ),
    insertCommandHistoryStmt: db.prepare(
      "INSERT INTO command_history(sender_id, user_username, user_display, user_role, text, created_at)"
        + " VALUES(?, ?, ?, ?, ?, ?)"
    ),
    deleteCommandHistoryStmt: db.prepare(
      "DELETE FROM command_history WHERE id = ? AND sender_id = ?"
    )
  };

  return { db, stmts };
};

export { createDb };
