import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dns from "node:dns";

import { config } from "./config.js";
import { tenantResolver } from "./middleware/tenant.js";
import { authRouter } from "./routes/auth.js";

async function start() {
  if (config.dnsServers.length) {
    dns.setServers(config.dnsServers);
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(
    cors({
      origin: config.authOrigin,
      credentials: true,
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "auth-service" });
  });

  app.use("/auth", tenantResolver, authRouter);

  app.listen(config.port, () => {
    console.log(`[auth-service] listening on port ${config.port}`);
  });
}

start().catch((err) => {
  console.error("[auth-service] startup failed", err);
  process.exit(1);
});
