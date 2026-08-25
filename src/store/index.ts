import { apps, config, type AppConfig } from "../config.js";
import { createMongoStore } from "./mongo.js";
import { createPostgresStore } from "./postgres.js";
import type { TenantStore } from "./types.js";

const stores = new Map<string, Promise<TenantStore>>();

function open(app: AppConfig): Promise<TenantStore> {
  if (app.driver === "postgres") {
    return createPostgresStore({
      uri: app.databaseUri,
      connectionTimeoutMillis: config.pgConnectionTimeoutMs,
      maxPoolSize: config.pgMaxPoolSize,
    });
  }

  return createMongoStore({
    uri: app.databaseUri,
    serverSelectionTimeoutMS: config.mongoServerSelectionTimeoutMs,
    withEntryStatus: app.features.has("entry-status"),
  });
}

// Returns null when the app id is not registered in AUTH_APP_IDS.
export async function getTenantStore(appId: string): Promise<TenantStore | null> {
  const app = apps.get(appId);
  if (!app) return null;

  const existing = stores.get(appId);
  if (existing) return existing;

  const ready = open(app).catch((err) => {
    // Drop the cached rejection so the next request can retry a transient failure.
    stores.delete(appId);
    throw err;
  });

  stores.set(appId, ready);
  return ready;
}

export async function closeAllTenantStores(): Promise<void> {
  const pending = [...stores.values()];
  stores.clear();

  await Promise.allSettled(
    pending.map(async (ready) => {
      const store = await ready;
      await store.close();
    }),
  );
}
