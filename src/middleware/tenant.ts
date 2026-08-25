import type { NextFunction, Request, Response } from "express";

import { getTenantConnection } from "../db/tenant-connection.js";
import { getModelsForConnection, type TenantModels } from "../models/registry.js";

export type TenantRequest = Request & { appId: string; models: TenantModels };

// Every /auth/* request must identify its tenant so we know which Mongo cluster to use.
export async function tenantResolver(req: Request, res: Response, next: NextFunction) {
  const appId = String(req.header("x-app-id") ?? "").trim().toLowerCase();
  if (!appId) {
    return res.status(400).json({ ok: false, error: "Missing X-App-Id header" });
  }

  try {
    const conn = await getTenantConnection(appId);
    if (!conn) {
      return res.status(400).json({ ok: false, error: `Unknown app id: ${appId}` });
    }

    (req as TenantRequest).appId = appId;
    (req as TenantRequest).models = getModelsForConnection(conn);
    next();
  } catch (err) {
    console.error(`[auth-service] Tenant database unavailable for ${appId}`, err);
    return res.status(503).json({ ok: false, error: "Auth database unavailable" });
  }
}
