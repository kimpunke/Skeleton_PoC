import { readRequestBody, sendJson } from "../http/utils.js";

const handleAuthRoutes = async (req, res, safePath, ctx) => {
  const { auth, stmts } = ctx;
  const {
    insertSignupRequestStmt,
    insertUserStmt,
    findUserByUsernameStmt,
    findSignupRequestByUsernameStmt,
    insertSessionStmt,
    updateNicknameStmt,
    updatePasswordHashStmt,
    deleteSessionStmt,
    deleteUserByIdStmt
  } = stmts;

  if (safePath === "/api/signup") {
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

      const username = typeof data.username === "string" ? data.username.trim() : "";
      const password = typeof data.password === "string" ? data.password : "";
      const passwordConfirm = typeof data.passwordConfirm === "string" ? data.passwordConfirm : "";
      const reason = typeof data.reason === "string" ? data.reason.trim() : "";
      if (!username || !password || !passwordConfirm || !reason) {
        sendJson(res, 400, { error: "missing-fields" });
        return true;
      }
      if (password !== passwordConfirm) {
        sendJson(res, 400, { error: "password-mismatch" });
        return true;
      }
      if (!auth.meetsPasswordPolicy(password)) {
        sendJson(res, 400, { error: "weak-password" });
        return true;
      }
      if (findUserByUsernameStmt.get(username)) {
        sendJson(res, 409, { error: "username-taken" });
        return true;
      }
      if (findSignupRequestByUsernameStmt.get(username)) {
        sendJson(res, 409, { error: "username-pending" });
        return true;
      }

      try {
        insertSignupRequestStmt.run(
          username,
          auth.hashPassword(password),
          reason,
          new Date().toISOString()
        );
      } catch (error) {
        sendJson(res, 500, { error: "signup-failed" });
        return true;
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "signup-failed" });
    }
    return true;
  }

  if (safePath === "/api/login") {
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
      const username = typeof data.username === "string" ? data.username.trim() : "";
      const password = typeof data.password === "string" ? data.password : "";
      const account = findUserByUsernameStmt.get(username);
      if (!account) {
        if (findSignupRequestByUsernameStmt.get(username)) {
          sendJson(res, 403, { error: "pending-approval" });
          return true;
        }
        sendJson(res, 401, { error: "invalid-credentials" });
        return true;
      }
      if (!auth.verifyPassword(password, account.password_hash)) {
        sendJson(res, 401, { error: "invalid-credentials" });
        return true;
      }
      const sessionId = auth.createSessionId();
      const createdAt = new Date().toISOString();
      const expiresAt = (auth.sessionTtlSeconds && auth.sessionTtlSeconds > 0)
        ? new Date(Date.now() + auth.sessionTtlSeconds * 1000).toISOString()
        : null;
      insertSessionStmt.run(sessionId, account.id, createdAt, expiresAt);
      const maxAge = expiresAt ? `; Max-Age=${Math.floor(auth.sessionTtlSeconds)}` : "";
      const cookie = `session_id=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax${maxAge}`;
      sendJson(
        res,
        200,
        {
          sessionId,
          username: account.username,
          nickname: account.nickname || account.username,
          role: account.role
        },
        { "Set-Cookie": cookie }
      );
    } catch (error) {
      sendJson(res, 500, { error: "login-failed" });
    }
    return true;
  }

  if (safePath === "/api/session") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    sendJson(res, 200, session);
    return true;
  }

  if (safePath === "/api/logout") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (session && session.sessionId) {
      deleteSessionStmt.run(session.sessionId);
    }
    const cookie = "session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
    sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
    return true;
  }

  if (safePath === "/api/account") {
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const account = findUserByUsernameStmt.get(session.username);
    if (!account) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    if (req.method === "GET") {
      sendJson(res, 200, {
        username: account.username,
        nickname: account.nickname || account.username,
        role: account.role
      });
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
      const nickname = typeof data.nickname === "string" ? data.nickname.trim() : "";
      if (!nickname) {
        sendJson(res, 400, { error: "missing-nickname" });
        return true;
      }
      updateNicknameStmt.run(nickname, account.id);
      sendJson(res, 200, { ok: true, nickname });
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  if (safePath === "/api/account/password") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const account = findUserByUsernameStmt.get(session.username);
    if (!account) {
      sendJson(res, 401, { error: "unauthorized" });
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
      const currentPassword = typeof data.currentPassword === "string" ? data.currentPassword : "";
      const newPassword = typeof data.newPassword === "string" ? data.newPassword : "";
      const newPasswordConfirm = typeof data.newPasswordConfirm === "string" ? data.newPasswordConfirm : "";
      if (!currentPassword || !newPassword || !newPasswordConfirm) {
        sendJson(res, 400, { error: "missing-fields" });
        return true;
      }
      if (!auth.verifyPassword(currentPassword, account.password_hash)) {
        sendJson(res, 401, { error: "invalid-credentials" });
        return true;
      }
      if (newPassword !== newPasswordConfirm) {
        sendJson(res, 400, { error: "password-mismatch" });
        return true;
      }
      if (!auth.meetsPasswordPolicy(newPassword)) {
        sendJson(res, 400, { error: "weak-password" });
        return true;
      }

      updatePasswordHashStmt.run(auth.hashPassword(newPassword), account.id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  if (safePath === "/api/account/delete") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    const account = findUserByUsernameStmt.get(session.username);
    if (!account) {
      sendJson(res, 401, { error: "unauthorized" });
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
      const confirm = Boolean(data && data.confirm);
      const phrase = typeof data.phrase === "string" ? data.phrase.trim() : "";
      if (!confirm || phrase !== "이해했습니다") {
        sendJson(res, 400, { error: "confirmation-required" });
        return true;
      }

      if (session.sessionId) {
        deleteSessionStmt.run(session.sessionId);
      }
      deleteUserByIdStmt.run(account.id);
      const cookie = "session_id=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
      sendJson(res, 200, { ok: true }, { "Set-Cookie": cookie });
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  return false;
};

export { handleAuthRoutes };
