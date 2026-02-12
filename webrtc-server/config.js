import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, "public");
const clipsDir = path.join(__dirname, "clips");
const dataDir = path.join(__dirname, "data");
const dbPath = process.env.DB_PATH || path.join(dataDir, "app.db");
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 0);

if (!fs.existsSync(clipsDir)) {
  fs.mkdirSync(clipsDir, { recursive: true });
}

if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

export {
  publicDir,
  clipsDir,
  dataDir,
  dbPath,
  sessionTtlSeconds
};
