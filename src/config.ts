import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

// In Cloud Run all config arrives via the environment / Secret Manager, so a missing
// .env file is normal rather than an error.
function loadEnvFile(): string | undefined {
  const explicit = process.env.AUTH_ENV_FILE?.trim();
  const candidates = explicit ? [explicit] : [`.env.${process.env.NODE_ENV ?? "development"}`, ".env"];

  for (const candidate of candidates) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    if (fs.existsSync(absolute)) {
      dotenv.config({ path: absolute });
      return absolute;
    }
  }
  return undefined;
}

loadEnvFile();

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** appId "media-viewer" -> "MEDIA_VIEWER", so env vars stay predictable. */
function envKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export type TokenMode = "cookie" | "bearer";
export type AppFeature = "entry-status";
export type SameSite = "none" | "lax" | "strict";
export type Driver = "mongodb" | "postgres";

export type AppConfig = {
  appId: string;
  displayName: string;
  tokenMode: TokenMode;
  driver: Driver;
  databaseUri: string;
  origins: string[];
  cookieSameSite: SameSite;
  features: ReadonlySet<AppFeature>;
};

// The deployment's own stage. Clients never choose this: a prod service only ever holds
// prod connection strings, so a caller cannot reach dev data (or vice versa) by header.
const deployEnv = (process.env.AUTH_ENV ?? (process.env.NODE_ENV === "production" ? "prod" : "dev")).trim();

const cookieSecure = process.env.AUTH_COOKIE_SECURE !== "false";
const defaultSameSite = (process.env.AUTH_COOKIE_SAMESITE ?? "lax") as SameSite;

// Accepted prefixes for a tenant's connection string, most specific first. These are
// naming conventions only: the actual driver is inferred from the URI scheme below, so a
// postgres URL in an ATLAS_URI_* variable still resolves to the postgres driver.
const URI_PREFIXES = ["ATLAS_URI", "NEON_URI", "DATABASE_URI", "MONGODB_URI"];

// Env-scoped names win over unscoped ones.
function resolveDatabaseUri(appId: string): string {
  const key = envKey(appId);
  const env = envKey(deployEnv);

  const candidates = [
    ...URI_PREFIXES.map((prefix) => `${prefix}_${key}_${env}`),
    ...URI_PREFIXES.map((prefix) => `${prefix}_${key}`),
  ];

  for (const name of candidates) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }

  throw new Error(
    `App "${appId}" is registered in AUTH_APP_IDS but has no database URI. ` +
      `Set ATLAS_URI_${key}_${env} or NEON_URI_${key}_${env}.`,
  );
}

function resolveSameSite(appId: string): SameSite {
  const value = (process.env[`AUTH_COOKIE_SAMESITE_${envKey(appId)}`]?.trim() ?? defaultSameSite) as SameSite;

  if (value !== "none" && value !== "lax" && value !== "strict") {
    throw new Error(`AUTH_COOKIE_SAMESITE_${envKey(appId)} must be none, lax, or strict, got "${value}"`);
  }
  // Browsers silently drop SameSite=None cookies that are not also Secure.
  if (value === "none" && !cookieSecure) {
    throw new Error(`App "${appId}" uses SameSite=none, which requires AUTH_COOKIE_SECURE=true`);
  }
  return value;
}

// Tenants can be backed by different engines, so the driver is inferred from the URI
// scheme rather than configured separately and left to drift.
function resolveDriver(appId: string, uri: string): Driver {
  if (/^mongodb(\+srv)?:\/\//i.test(uri)) return "mongodb";
  if (/^postgres(ql)?:\/\//i.test(uri)) return "postgres";

  throw new Error(
    `App "${appId}" has an unrecognised database URI scheme. ` +
      `Expected mongodb://, mongodb+srv://, postgres:// or postgresql://.`,
  );
}

// Only the Mongo store implements entry-status. Failing here beats a confusing 404 after
// the app is already deployed.
function validateFeatures(appId: string, driver: Driver, features: ReadonlySet<AppFeature>) {
  if (features.has("entry-status") && driver !== "mongodb") {
    throw new Error(`App "${appId}": feature "entry-status" is only supported on the mongodb driver`);
  }
}

function buildApp(appId: string): AppConfig {
  const key = envKey(appId);
  const tokenMode = (process.env[`AUTH_TOKEN_MODE_${key}`]?.trim() ?? "cookie") as TokenMode;

  if (tokenMode !== "cookie" && tokenMode !== "bearer") {
    throw new Error(`AUTH_TOKEN_MODE_${key} must be "cookie" or "bearer", got "${tokenMode}"`);
  }

  const mongoUri = resolveDatabaseUri(appId);
  const driver = resolveDriver(appId, mongoUri);
  const features = new Set(list(`AUTH_FEATURES_${key}`) as AppFeature[]);
  validateFeatures(appId, driver, features);

  return {
    appId,
    displayName: process.env[`AUTH_APP_NAME_${key}`]?.trim() || appId,
    tokenMode,
    driver,
    databaseUri: mongoUri,
    origins: list(`AUTH_ORIGINS_${key}`),
    cookieSameSite: resolveSameSite(appId),
    features,
  };
}

// Registering every tenant up front means a bad deploy fails at boot instead of
// surfacing as a 400 on the first real request.
const appIds = list("AUTH_APP_IDS").map((id) => id.toLowerCase());
if (!appIds.length) {
  throw new Error('AUTH_APP_IDS is required, e.g. AUTH_APP_IDS="spice,finances"');
}

export const apps: ReadonlyMap<string, AppConfig> = new Map(appIds.map((id) => [id, buildApp(id)]));

const jwtSecret = required("JWT_SECRET");
if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters");
}

export const config = {
  env: deployEnv,
  port: Number(process.env.PORT ?? 8080),
  trustProxy: process.env.TRUST_PROXY ?? true,
  dnsServers: list("AUTH_DNS_SERVERS"),
  jwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  cookieName: process.env.AUTH_COOKIE_NAME ?? "mv_auth",
  cookieSecure,
  mongoServerSelectionTimeoutMs: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
  pgConnectionTimeoutMs: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5000),
  pgMaxPoolSize: Number(process.env.PG_MAX_POOL_SIZE ?? 5),
  resendApiKey: process.env.RESEND_FULL_ACCESS_KEY,
  resendFrom: process.env.RESEND_FROM,
};
