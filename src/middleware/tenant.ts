import type { NextFunction, Request, Response } from "express";

import { apps, type AppConfig } from "../config.js";
import { getTenantStore } from "../store/index.js";
import type { TenantStore } from "../store/types.js";

export type TenantRequest = Request & { tenantApp: AppConfig; appId: string; store: TenantStore };

export function getTenantApp(req: Request): AppConfig {
  return (req as TenantRequest).tenantApp;
}

export function getStore(req: Request): TenantStore {
  return (req as TenantRequest).store;
}

export function readAppId(req: Request): string {
  return String(req.header("x-app-id") ?? "").trim().toLowerCase();
}

// Every /auth/* request must identify its tenant so we know which database to use.
export async function tenantResolver(req: Request, res: Response, next: NextFunction) {
  const appId = readAppId(req);
  if (!appId) {
    return res.status(400).json({ ok: false, error: "Missing X-App-Id header" });
  }

  const app = apps.get(appId);
  if (!app) {
    return res.status(400).json({ ok: false, error: `Unknown app id: ${appId}` });
  }

  try {
    const store = await getTenantStore(appId);
    if (!store) {
      return res.status(400).json({ ok: false, error: `Unknown app id: ${appId}` });
    }

    const tenantReq = req as TenantRequest;
    tenantReq.tenantApp = app;
    tenantReq.appId = appId;
    tenantReq.store = store;
    next();
  } catch (err) {
    console.error(`[auth-service] Tenant database unavailable for ${appId}`, err);
    return res.status(503).json({ ok: false, error: "Auth database unavailable" });
  }
}
