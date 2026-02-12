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

const applyCors = (req, res) => {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Id");
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

export {
  parseCookies,
  applyCors,
  readRequestBody,
  sendJson
};
