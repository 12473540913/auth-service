// Driver-agnostic data access. Routes talk to these interfaces only, so a tenant can be
// backed by MongoDB (Atlas) or Postgres (Neon) without the route layer knowing which.
//
// Ids are opaque strings: an ObjectId hex string on Mongo, a uuid on Postgres.

export type UserRecord = {
  id: string;
  email: string;
  username?: string;
  passwordHash: string;
  emailVerified: boolean;
  verifyOtpHash?: string;
  verifyOtpExpiresAt?: Date;
  resetOtpHash?: string;
  resetOtpExpiresAt?: Date;
  authVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type NewUser = {
  email: string;
  username?: string;
  passwordHash: string;
  emailVerified: boolean;
  verifyOtpHash?: string;
  verifyOtpExpiresAt?: Date;
};

// Explicit nulls clear a field; undefined leaves it untouched.
export type UserPatch = {
  username?: string | null;
  passwordHash?: string;
  emailVerified?: boolean;
  verifyOtpHash?: string | null;
  verifyOtpExpiresAt?: Date | null;
  resetOtpHash?: string | null;
  resetOtpExpiresAt?: Date | null;
  authVersion?: number;
};

export type OtpKind = "verify" | "reset";

export interface UserStore {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  findByUsername(username: string): Promise<UserRecord | null>;
  /** Used to check whether a username is taken by someone other than `exceptUserId`. */
  findByUsernameExcluding(username: string, exceptUserId: string): Promise<UserRecord | null>;
  /** Matches only unexpired codes, so expiry is enforced by the query itself. */
  findByOtp(kind: OtpKind, email: string, otpHash: string, now: Date): Promise<UserRecord | null>;
  create(user: NewUser): Promise<UserRecord>;
  update(id: string, patch: UserPatch): Promise<UserRecord | null>;
}

export type AppBlob = {
  encryptionSalt: string;
  blobIv: string;
  blobTag: string;
  blobCiphertext: string;
  blobVersion: number;
  updatedAt: Date;
};

export interface BlobStore {
  get(userId: string, appId: string): Promise<AppBlob | null>;
  put(userId: string, appId: string, blob: Omit<AppBlob, "updatedAt">): Promise<void>;
}

export interface SettingsStore {
  getContentRoot(userId: string, appId: string): Promise<string | null>;
  setContentRoot(userId: string, appId: string, contentRoot: string | null): Promise<void>;
}

export type EntryStatus = {
  entryId: string;
  viewed: boolean;
  rating: number | null;
  updatedAt: Date;
};

export type EntryStatusPatch = {
  viewed?: boolean;
  /** null clears the rating. */
  rating?: number | null;
};

export interface EntryStatusStore {
  findMany(userId: string, entryIds: string[]): Promise<EntryStatus[]>;
  findOne(userId: string, entryId: string): Promise<EntryStatus | null>;
  upsert(userId: string, entryId: string, patch: EntryStatusPatch): Promise<EntryStatus>;
}

export interface TenantStore {
  users: UserStore;
  blobs: BlobStore;
  settings: SettingsStore;
  /** Present only for apps with the "entry-status" feature enabled. */
  entryStatus?: EntryStatusStore;
  close(): Promise<void>;
}
