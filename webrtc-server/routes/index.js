import { handleAuthRoutes } from "./authRoutes.js";
import { handleAdminRoutes } from "./adminRoutes.js";
import { handleClipRoutes } from "./clipRoutes.js";

const handleApiRequest = async (req, res, safePath, ctx) => {
  if (await handleAuthRoutes(req, res, safePath, ctx)) {
    return true;
  }
  if (await handleAdminRoutes(req, res, safePath, ctx)) {
    return true;
  }
  if (await handleClipRoutes(req, res, safePath, ctx)) {
    return true;
  }
  return false;
};

export { handleApiRequest };
