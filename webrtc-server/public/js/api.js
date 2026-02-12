const apiHost = location.hostname || "localhost";
const apiPort = location.port || "3000";
const apiProtocol = location.protocol === "https:" ? "https:" : "http:";
const apiBase = location.protocol === "file:"
  ? "http://localhost:3000"
  : `${apiProtocol}//${apiHost}:${apiPort}`;
const wsProtocol = apiProtocol === "https:" ? "wss" : "ws";

const getSessionId = () => sessionStorage.getItem("session_id") || "";

const apiFetch = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  const sessionId = getSessionId();
  if (sessionId) {
    headers.set("X-Session-Id", sessionId);
  }
  return fetch(`${apiBase}${path}`,
    {
      credentials: "include",
      ...options,
      headers
    }
  );
};

const buildWsUrl = () => {
  const sid = getSessionId();
  const suffix = sid ? `&sid=${encodeURIComponent(sid)}` : "";
  return `${wsProtocol}://${apiHost}:${apiPort}/ws?viewer${suffix}`;
};

export {
  apiHost,
  apiPort,
  apiProtocol,
  apiBase,
  wsProtocol,
  getSessionId,
  apiFetch,
  buildWsUrl
};
