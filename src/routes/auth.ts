import { Router } from "express";
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createUserEntryStatusRouter } from "@data/user-db";

import { config } from "../config.js";
import type { UserDoc } from "../models/User.js";
import type { TenantRequest } from "../middleware/tenant.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { makeOtpCode, sendPasswordResetEmail, sendVerifyEmail } from "../lib/email.js";
import { signAuthToken, verifyAuthToken } from "../lib/jwt.js";

export const authRouter = Router();

function models(req: Request) {
  return (req as TenantRequest).models;
}

type AuthUserRequest = Request & {
  authUserId?: string;
  authEmail?: string;
  authTokenVersion?: number;
};

function getUserDisplayName(user: { username?: string; email: string }): string {
  return user.username?.trim() || user.email;
}

function toSessionPayload(user: UserDoc) {
  return {
    authenticated: true,
    email: user.email,
    username: getUserDisplayName(user),
    emailVerified: user.emailVerified,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function getBodyValue(req: Request, name: string): string {
  return String(req.body?.[name] ?? "").trim();
}

function passwordValid(password: string): boolean {
  return password.length >= 8 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password);
}

function hashOtpCode(rawCode: string): string {
  return createHash("sha256").update(rawCode).digest("hex");
}

async function getVerificationTarget(req: AuthUserRequest): Promise<string | null> {
  if (req.authUserId) {
    const user = await models(req).User.findById(req.authUserId);
    return user?.email ?? null;
  }

  const email = getBodyValue(req, "email").toLowerCase();
  return email.includes("@") ? email : null;
}

function setAuthCookie(res: Response, token: string) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function clearAuthCookie(res: Response) {
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
  });
}

async function authGuard(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[config.cookieName] as string | undefined;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const payload = verifyAuthToken(token);
    const user = await models(req).User.findById(payload.sub);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (user.authVersion !== payload.tokenVersion) return res.status(401).json({ ok: false, error: "Unauthorized" });

    (req as AuthUserRequest).authUserId = String(user._id);
    (req as AuthUserRequest).authEmail = user.email;
    (req as AuthUserRequest).authTokenVersion = user.authVersion;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

authRouter.post("/signup", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");

  if (!email.includes("@")) return res.status(400).json({ ok: false, error: "Valid email required" });
  if (!passwordValid(password)) {
    return res.status(400).json({ ok: false, error: "Password must be 8+ chars and include lowercase, uppercase, and number" });
  }
  if (username && username.length < 3) return res.status(400).json({ ok: false, error: "Username must be at least 3 chars" });

  const existing = await models(req).User.findOne({ email });
  if (existing) return res.status(409).json({ ok: false, error: "Email already in use" });

  if (username) {
    const usernameTaken = await models(req).User.findOne({ username });
    if (usernameTaken) return res.status(409).json({ ok: false, error: "Username already in use" });
  }

  const passwordHash = await hashPassword(password);
  const { rawCode, hashedCode } = makeOtpCode();
  const verifyOtpExpiresAt = new Date(Date.now() + 1000 * 60 * 30);

  const user = await models(req).User.create({
    email,
    username: username || undefined,
    passwordHash,
    emailVerified: false,
    verifyOtpHash: hashedCode,
    verifyOtpExpiresAt,
  });

  await sendVerifyEmail(email, rawCode);

  return res.json({ ok: true, user: { email: user.email, username: getUserDisplayName(user), emailVerified: user.emailVerified } });
});

authRouter.post("/signin", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  const user = await models(req).User.findOne({ email });
  if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  if (!user.emailVerified) {
    return res.status(403).json({ ok: false, error: "Verify your email before signing in" });
  }

  const token = signAuthToken({ sub: String(user._id), email: user.email, tokenVersion: user.authVersion });
  setAuthCookie(res, token);

  return res.json({ ok: true, user: { email: user.email, username: getUserDisplayName(user), emailVerified: user.emailVerified } });
});

authRouter.post("/signout", async (_req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});

authRouter.get("/session", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId;
  const user = await models(req).User.findById(userId);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  return res.json({
    ok: true,
    session: toSessionPayload(user),
  });
});

authRouter.patch("/profile", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId;
  const user = await models(req).User.findById(userId);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const username = String(req.body?.username ?? "").trim();
  if (username && username.length < 3) {
    return res.status(400).json({ ok: false, error: "Username must be at least 3 chars" });
  }

  if (username) {
    const usernameTaken = await models(req).User.findOne({ username, _id: { $ne: user._id } });
    if (usernameTaken) return res.status(409).json({ ok: false, error: "Username already in use" });
  }

  user.username = username || undefined;
  await user.save();

  return res.json({ ok: true, session: toSessionPayload(user) });
});

authRouter.use("/entries", createUserEntryStatusRouter(authGuard, (req) => models(req).UserEntryStatus));

authRouter.post("/verify/request", async (req, res) => {
  const email = await getVerificationTarget(req as AuthUserRequest);
  if (!email) return res.status(400).json({ ok: false, error: "Email required" });

  const user = await models(req).User.findOne({ email });
  if (!user) return res.json({ ok: true });

  const { rawCode, hashedCode } = makeOtpCode();
  user.verifyOtpHash = hashedCode;
  user.verifyOtpExpiresAt = new Date(Date.now() + 1000 * 60 * 30);
  await user.save();

  await sendVerifyEmail(user.email, rawCode);

  return res.json({ ok: true });
});

authRouter.post("/verify/confirm", async (req, res) => {
  const rawCode = getBodyValue(req, "code");
  const email = getBodyValue(req, "email").toLowerCase();
  if (!rawCode || !email) return res.status(400).json({ ok: false, error: "Invalid verification code" });

  const hashed = hashOtpCode(rawCode);
  const user = await models(req).User.findOne({
    email,
    verifyOtpHash: hashed,
    verifyOtpExpiresAt: { $gt: new Date() },
  });

  if (!user) return res.status(400).json({ ok: false, error: "Invalid or expired verification code" });

  user.emailVerified = true;
  user.verifyOtpHash = undefined;
  user.verifyOtpExpiresAt = undefined;
  await user.save();

  return res.json({ ok: true });
});

authRouter.post("/password-reset/request", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return res.status(400).json({ ok: false, error: "Email required" });

  const user = await models(req).User.findOne({ email });
  if (!user) return res.json({ ok: true });

  const { rawCode, hashedCode } = makeOtpCode();
  user.resetOtpHash = hashedCode;
  user.resetOtpExpiresAt = new Date(Date.now() + 1000 * 60 * 30);
  await user.save();

  await sendPasswordResetEmail(user.email, rawCode);

  return res.json({ ok: true });
});

authRouter.post("/password-reset/confirm", async (req, res) => {
  const rawCode = String(req.body?.code ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  if (!rawCode || !email || !passwordValid(password)) {
    return res.status(400).json({ ok: false, error: "Invalid reset submission" });
  }

  const hashed = hashOtpCode(rawCode);
  const user = await models(req).User.findOne({
    email,
    resetOtpHash: hashed,
    resetOtpExpiresAt: { $gt: new Date() },
  });

  if (!user) return res.status(400).json({ ok: false, error: "Invalid or expired reset code" });

  user.passwordHash = await hashPassword(password);
  user.resetOtpHash = undefined;
  user.resetOtpExpiresAt = undefined;
  user.authVersion += 1;
  await user.save();

  clearAuthCookie(res);
  return res.json({ ok: true });
});

authRouter.get("/progress/:appId/blob", authGuard, async (req, res) => {
  const userId = (req as Request & { authUserId: string }).authUserId;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const row = await models(req).UserAppBlob.findOne({ userId, appId });
  if (!row) {
    return res.json({ ok: true, blob: null });
  }

  return res.json({
    ok: true,
    blob: {
      encryptionSalt: row.encryptionSalt,
      blobIv: row.blobIv,
      blobTag: row.blobTag,
      blobCiphertext: row.blobCiphertext,
      blobVersion: row.blobVersion,
      updatedAt: row.updatedAt,
    },
  });
});

authRouter.put("/progress/:appId/blob", authGuard, async (req, res) => {
  const userId = (req as Request & { authUserId: string }).authUserId;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const encryptionSalt = String(req.body?.encryptionSalt ?? "");
  const blobIv = String(req.body?.blobIv ?? "");
  const blobTag = String(req.body?.blobTag ?? "");
  const blobCiphertext = String(req.body?.blobCiphertext ?? "");
  const blobVersion = Number(req.body?.blobVersion ?? 1);

  if (!encryptionSalt || !blobIv || !blobTag || !blobCiphertext) {
    return res.status(400).json({ ok: false, error: "Invalid blob payload" });
  }

  await models(req).UserAppBlob.findOneAndUpdate(
    { userId, appId },
    { encryptionSalt, blobIv, blobTag, blobCiphertext, blobVersion },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return res.json({ ok: true });
});

authRouter.get("/settings/:appId/content-root", authGuard, async (req, res) => {
  const userId = (req as Request & { authUserId: string }).authUserId;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const row = await models(req).UserAppSettings.findOne({ userId, appId });
  return res.json({ ok: true, contentRoot: row?.contentRoot ?? null });
});

authRouter.put("/settings/:appId/content-root", authGuard, async (req, res) => {
  const userId = (req as Request & { authUserId: string }).authUserId;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const raw = req.body?.contentRoot;
  if (raw !== null && typeof raw !== "string") {
    return res.status(400).json({ ok: false, error: "contentRoot must be a string or null" });
  }

  const contentRoot = typeof raw === "string" && raw.trim() ? raw.trim() : null;

  await models(req).UserAppSettings.findOneAndUpdate(
    { userId, appId },
    { contentRoot },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return res.json({ ok: true, contentRoot });
});
