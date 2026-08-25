import type { Connection, Model } from "mongoose";
import type { UserEntryStatusDoc } from "@data/user-db";
import { UserEntryStatusSchema } from "@data/user-db";

import { UserSchema, type UserDoc } from "./User.js";
import { UserAppBlobSchema, type UserAppBlobDoc } from "./UserAppBlob.js";
import { UserAppSettingsSchema, type UserAppSettingsDoc } from "./UserAppSettings.js";

export type TenantModels = {
  User: Model<UserDoc>;
  UserAppBlob: Model<UserAppBlobDoc>;
  UserAppSettings: Model<UserAppSettingsDoc>;
  UserEntryStatus: Model<UserEntryStatusDoc>;
};

const modelsByConnection = new WeakMap<Connection, TenantModels>();

// Each tenant connection registers its own model instances off the same schemas.
export function getModelsForConnection(conn: Connection): TenantModels {
  const cached = modelsByConnection.get(conn);
  if (cached) return cached;

  const models: TenantModels = {
    User: conn.model<UserDoc>("User", UserSchema),
    UserAppBlob: conn.model<UserAppBlobDoc>("UserAppBlob", UserAppBlobSchema),
    UserAppSettings: conn.model<UserAppSettingsDoc>("UserAppSettings", UserAppSettingsSchema),
    UserEntryStatus: conn.model<UserEntryStatusDoc>("UserEntryStatus", UserEntryStatusSchema),
  };

  modelsByConnection.set(conn, models);
  return models;
}
