import { readRequestBody, sendJson } from "../http/utils.js";

const handleAdminRoutes = async (req, res, safePath, ctx) => {
  const { auth, stmts } = ctx;
  const {
    listUsersStmt,
    updateUserRoleStmt,
    listSignupRequestsStmt,
    findSignupRequestByIdStmt,
    insertUserStmt,
    deleteSignupRequestByIdStmt
  } = stmts;

  if (safePath === "/api/admin/users") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }
    const rows = listUsersStmt.all();
    const result = rows.map((row) => ({
      id: String(row.id),
      username: row.username,
      nickname: row.nickname || row.username,
      role: row.role
    }));
    sendJson(res, 200, result);
    return true;
  }

  if (safePath === "/api/admin/users/role") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
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
      const rawId = data.id;
      const id = typeof rawId === "number" ? rawId : Number(String(rawId || ""));
      if (!Number.isFinite(id) || id <= 0) {
        sendJson(res, 400, { error: "invalid-id" });
        return true;
      }
      const role = auth.normalizeRole(data.role);
      updateUserRoleStmt.run(role, id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  if (safePath === "/api/admin/signup-requests") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
      return true;
    }
    const rows = listSignupRequestsStmt.all();
    const result = rows.map((row) => ({
      id: String(row.id),
      username: row.username,
      reason: row.reason,
      requestedAt: row.requested_at
    }));
    sendJson(res, 200, result);
    return true;
  }

  if (safePath === "/api/admin/signup-requests/approve") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
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
      const rawId = data.id;
      const id = typeof rawId === "number" ? rawId : Number(String(rawId || ""));
      if (!Number.isFinite(id) || id <= 0) {
        sendJson(res, 400, { error: "invalid-id" });
        return true;
      }

      const request = findSignupRequestByIdStmt.get(id);
      if (!request) {
        sendJson(res, 404, { error: "not-found" });
        return true;
      }
      try {
        insertUserStmt.run(
          request.username,
          request.password_hash,
          request.username,
          "user",
          new Date().toISOString()
        );
      } catch (error) {
        sendJson(res, 409, { error: "username-taken" });
        return true;
      }
      deleteSignupRequestByIdStmt.run(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  if (safePath === "/api/admin/signup-requests/reject") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }
    const session = auth.getSessionFromHeaders(req.headers);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }
    if (session.role !== "admin") {
      sendJson(res, 403, { error: "forbidden" });
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
      const rawId = data.id;
      const id = typeof rawId === "number" ? rawId : Number(String(rawId || ""));
      if (!Number.isFinite(id) || id <= 0) {
        sendJson(res, 400, { error: "invalid-id" });
        return true;
      }
      const request = findSignupRequestByIdStmt.get(id);
      if (!request) {
        sendJson(res, 404, { error: "not-found" });
        return true;
      }
      deleteSignupRequestByIdStmt.run(id);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "failed" });
    }
    return true;
  }

  return false;
};

export { handleAdminRoutes };
