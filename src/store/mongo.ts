import mongoose, { type Connection, type Model } from "mongoose";

import { UserSchema, type UserDoc } from "../models/User.js";
import { UserAppBlobSchema, type UserAppBlobDoc } from "../models/UserAppBlob.js";
import { UserAppSettingsSchema, type UserAppSettingsDoc } from "../models/UserAppSettings.js";
import { UserEntryStatusSchema, type UserEntryStatusDoc } from "../features/entry-status.js";
import type {
  AppBlob,
  EntryStatus,
  EntryStatusPatch,
  EntryStatusStore,
  NewUser,
  OtpKind,
  TenantStore,
  UserPatch,
  UserRecord,
} from "./types.js";

type WithId<T> = T & { _id: unknown };

function toUser(doc: WithId<UserDoc> | null): UserRecord | null {
  if (!doc) return null;
  return {
    id: String(doc._id),
    email: doc.email,
    username: doc.username,
    birthDate: doc.birthDate,
    profilePhotoUrl: doc.profilePhotoUrl,
    passwordHash: doc.passwordHash,
    emailVerified: doc.emailVerified,
    verifyOtpHash: doc.verifyOtpHash,
    verifyOtpExpiresAt: doc.verifyOtpExpiresAt,
    resetOtpHash: doc.resetOtpHash,
    resetOtpExpiresAt: doc.resetOtpExpiresAt,
    authVersion: doc.authVersion,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Mongo cannot store a "cleared" value as null for sparse-unique fields, so nulls in the
// patch become $unset while defined values become $set.
function toUpdate(patch: UserPatch) {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) unset[key] = "";
    else set[key] = value;
  }

  return {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  };
}

function toEntryStatus(doc: UserEntryStatusDoc): EntryStatus {
  return {
    entryId: doc.entryId,
    viewed: doc.viewed,
    rating: doc.rating ?? null,
    updatedAt: doc.updatedAt,
  };
}

// An invalid ObjectId makes Mongo throw a CastError; ids come from a signed token but may
// still be stale, so treat a malformed id as "not found".
function isValidId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export type MongoStoreOptions = {
  uri: string;
  serverSelectionTimeoutMS: number;
  withEntryStatus: boolean;
};

export async function createMongoStore(options: MongoStoreOptions): Promise<TenantStore> {
  const connection: Connection = mongoose.createConnection(options.uri, {
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS,
  });

  connection.on("error", (err) => {
    console.error("[auth-service] mongo connection error", err);
  });

  try {
    await connection.asPromise();
  } catch (err) {
    await connection.close().catch(() => undefined);
    throw err;
  }

  const Users = connection.model<UserDoc>("User", UserSchema);
  const Blobs = connection.model<UserAppBlobDoc>("UserAppBlob", UserAppBlobSchema);
  const Settings = connection.model<UserAppSettingsDoc>("UserAppSettings", UserAppSettingsSchema);

  // Registering a model also builds its indexes, so opt-in features are skipped entirely
  // for apps that do not use them.
  const Entries: Model<UserEntryStatusDoc> | undefined = options.withEntryStatus
    ? connection.model<UserEntryStatusDoc>("UserEntryStatus", UserEntryStatusSchema)
    : undefined;

  const entryStatus: EntryStatusStore | undefined = Entries && {
    async findMany(userId, entryIds) {
      const rows = await Entries.find({ userId, entryId: { $in: entryIds } }).lean();
      return rows.map(toEntryStatus);
    },
    async findOne(userId, entryId) {
      const row = await Entries.findOne({ userId, entryId }).lean();
      return row ? toEntryStatus(row) : null;
    },
    async upsert(userId, entryId, patch: EntryStatusPatch) {
      const set: Record<string, unknown> = {};
      const unset: Record<string, ""> = {};

      if (patch.viewed !== undefined) set.viewed = patch.viewed;
      if (patch.rating === null) unset.rating = "";
      else if (patch.rating !== undefined) set.rating = patch.rating;

      const row = await Entries.findOneAndUpdate(
        { userId, entryId },
        {
          ...(Object.keys(set).length ? { $set: set } : {}),
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();

      return toEntryStatus(row!);
    },
  };

  return {
    users: {
      async findById(id) {
        if (!isValidId(id)) return null;
        return toUser(await Users.findById(id).lean());
      },
      async findByEmail(email) {
        return toUser(await Users.findOne({ email }).lean());
      },
      async findByUsername(username) {
        return toUser(await Users.findOne({ username }).lean());
      },
      async findByUsernameExcluding(username, exceptUserId) {
        if (!isValidId(exceptUserId)) return null;
        return toUser(await Users.findOne({ username, _id: { $ne: exceptUserId } }).lean());
      },
      async findByOtp(kind: OtpKind, email, otpHash, now) {
        const hashField = kind === "verify" ? "verifyOtpHash" : "resetOtpHash";
        const expiryField = kind === "verify" ? "verifyOtpExpiresAt" : "resetOtpExpiresAt";
        return toUser(
          await Users.findOne({ email, [hashField]: otpHash, [expiryField]: { $gt: now } }).lean(),
        );
      },
      async create(user: NewUser) {
        const created = await Users.create({ ...user, authVersion: 0 });
        return toUser(created.toObject())!;
      },
      async update(id, patch) {
        if (!isValidId(id)) return null;
        const update = toUpdate(patch);
        if (!Object.keys(update).length) return toUser(await Users.findById(id).lean());
        return toUser(await Users.findByIdAndUpdate(id, update, { new: true }).lean());
      },
      async deleteUser(id) {
        if (!isValidId(id)) return;
        await Promise.all([
          Users.deleteOne({ _id: id }),
          Blobs.deleteMany({ userId: id }),
          Settings.deleteMany({ userId: id }),
          Entries?.deleteMany({ userId: id }),
        ]);
      },
    },

    blobs: {
      async get(userId, appId) {
        if (!isValidId(userId)) return null;
        const row = await Blobs.findOne({ userId, appId }).lean();
        if (!row) return null;
        return {
          encryptionSalt: row.encryptionSalt,
          blobIv: row.blobIv,
          blobTag: row.blobTag,
          blobCiphertext: row.blobCiphertext,
          blobVersion: row.blobVersion,
          updatedAt: row.updatedAt,
        } satisfies AppBlob;
      },
      async put(userId, appId, blob) {
        await Blobs.findOneAndUpdate({ userId, appId }, blob, {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        });
      },
    },

    settings: {
      async getContentRoot(userId, appId) {
        if (!isValidId(userId)) return null;
        const row = await Settings.findOne({ userId, appId }).lean();
        return row?.contentRoot ?? null;
      },
      async setContentRoot(userId, appId, contentRoot) {
        await Settings.findOneAndUpdate({ userId, appId }, { contentRoot }, {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        });
      },
    },

    entryStatus,

    async close() {
      await connection.close();
    },
  };
}
