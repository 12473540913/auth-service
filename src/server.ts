import express from "express";
import cors, { type CorsOptions } from "cors";
import cookieParser from "cookie-parser";
import dns from "node:dns";

import { apps, config } from "./config.js";
import { closeAllTenantStores } from "./store/index.js";
import { readAppId, tenantResolver } from "./middleware/tenant.js";
import { authRouter } from "./routes/auth.js";

// A CORS preflight never carries X-App-Id (the browser only advertises it in
// Access-Control-Request-Headers), so fall back to matching the Origin against the
// registered apps. The real request is still tenant-checked by tenantResolver.
function findAppForRequest(req: express.Request) {
  const appId = readAppId(req);
  if (appId) return apps.get(appId);

  const origin = req.header("origin");
  if (!origin) return undefined;
  return [...apps.values()].find((candidate) => candidate.origins.includes(origin));
}

// Each app declares its own allowed origins, so CORS is resolved per request rather
// than from one global origin.
function corsOptionsFor(req: express.Request): CorsOptions {
  const origin = req.header("origin");

  // Native shells (Electron main process, CLI) send no Origin header. They authenticate
  // with a Bearer token rather than a cookie, so there is no CSRF surface to protect.
  if (!origin) return { origin: true, credentials: false };

  const app = findAppForRequest(req);
  if (!app) return { origin: false };

  return {
    origin: app.origins.includes(origin),
    credentials: app.tokenMode === "cookie",
    allowedHeaders: ["Content-Type", "Authorization", "X-App-Id"],
  };
}

function start() {
  if (config.dnsServers.length) {
    dns.setServers(config.dnsServers);
  }

  const app = express();

  // Cloud Run terminates TLS at its front end; without this Express sees the hop as
  // plain HTTP and refuses to set Secure cookies.
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(cors((req, done) => done(null, corsOptionsFor(req as express.Request))));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "auth-service",
      env: config.env,
      apps: [...apps.values()].map((entry) => ({ appId: entry.appId, driver: entry.driver })),
    });
  });

  app.use("/auth", tenantResolver, authRouter);

  app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // body-parser reports oversized/malformed bodies as regular errors with a status;
    // surface those as their real status instead of a generic 500.
    if (err.type === "entity.too.large") {
      return res.status(413).json({ ok: false, error: "Request body is too large" });
    }
    const status = err.status ?? err.statusCode;
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: "Invalid request" });
    }

    console.error("[auth-service] unhandled error", err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  });

  const server = app.listen(config.port, "0.0.0.0", () => {
    console.log(`[auth-service] env=${config.env} listening on 0.0.0.0:${config.port}`);
    console.log(
      `[auth-service] registered apps: ${[...apps.values()].map((entry) => `${entry.appId}(${entry.driver})`).join(", ")}`,
    );
  });

  // Cloud Run sends SIGTERM before reclaiming an instance; drain in-flight requests and
  // close database sockets so Mongo does not accumulate dead connections.
  const shutdown = (signal: string) => {
    console.log(`[auth-service] ${signal} received, shutting down`);
    server.close(async () => {
      await closeAllTenantStores();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  start();
} catch (err) {
  console.error("[auth-service] startup failed", err);
  process.exit(1);
}
