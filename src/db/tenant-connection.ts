import mongoose, { type Connection } from "mongoose";

type TenantConnectionState = {
  connection: Connection;
  ready: Promise<Connection>;
};

const connections = new Map<string, TenantConnectionState>();

// Convention: appId "media-viewer" -> env var MONGODB_URI_MEDIA_VIEWER. Lets new tenants
// be registered by adding an env var, no code change required.
function envVarNameForAppId(appId: string): string {
  const normalized = appId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `MONGODB_URI_${normalized}`;
}

// Returns null when the app id has no configured cluster (unknown/unregistered tenant).
export async function getTenantConnection(appId: string): Promise<Connection | null> {
  const existing = connections.get(appId);
  if (existing) return existing.ready;

  const uri = process.env[envVarNameForAppId(appId)];
  if (!uri) return null;

  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5000),
  });
  connection.on("error", (err) => {
    console.error(`[auth-service] Mongo connection error for ${appId}`, err);
  });

  const ready = connection.asPromise().catch((err) => {
    connections.delete(appId);
    void connection.close().catch(() => undefined);
    throw err;
  });

  connections.set(appId, { connection, ready });
  return ready;
}
