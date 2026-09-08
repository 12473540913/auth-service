import { Router } from "express";
import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

import { config, type SameSite } from "../config.js";
import { createUserEntryStatusRouter } from "../features/entry-status.js";
import { getStore, getTenantApp } from "../middleware/tenant.js";
import type { UserRecord } from "../store/types.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { makeOtpCode, sendPasswordResetEmail, sendVerifyEmail } from "../lib/email.js";
import { signAuthToken, verifyAuthToken } from "../lib/jwt.js";

export const authRouter = Router();

type AuthUserRequest = Request & {
  authUserId?: string;
  authEmail?: string;
  authTokenVersion?: number;
};

function toSessionPayload(user: UserRecord) {
  return {
    authenticated: true,
    userId: user.id,
    email: user.email,
    username: user.username?.trim() || null,
    birthDate: user.birthDate ?? null,
    profilePhotoUrl: user.profilePhotoUrl ?? null,
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
    const user = await getStore(req).users.findById(req.authUserId);
    return user?.email ?? null;
  }

  const email = getBodyValue(req, "email").toLowerCase();
  return email.includes("@") ? email : null;
}

function setAuthCookie(res: Response, token: string, sameSite: SameSite, domain: string | undefined) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite,
    domain,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  });
}

function clearAuthCookie(req: Request, res: Response) {
  const app = getTenantApp(req);
  res.clearCookie(config.cookieName, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: app.cookieSameSite,
    domain: app.cookieDomain,
    path: "/",
  });
}

// Browser apps get an HttpOnly cookie. Native shells (Electron) have no usable cross-site
// cookie jar, so they receive the token in the body and send it as a Bearer header.
function issueSession(req: Request, res: Response, user: UserRecord): { token?: string } {
  const app = getTenantApp(req);
  const token = signAuthToken({
    sub: user.id,
    email: user.email,
    tokenVersion: user.authVersion,
    appId: app.appId,
  });

  if (app.tokenMode === "bearer") return { token };

  setAuthCookie(res, token, app.cookieSameSite, app.cookieDomain);
  return {};
}

function readToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || undefined;
  }
  return req.cookies?.[config.cookieName] as string | undefined;
}

async function authGuard(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const payload = verifyAuthToken(token, getTenantApp(req).appId);
    const user = await getStore(req).users.findById(payload.sub);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });
    if (user.authVersion !== payload.tokenVersion) return res.status(401).json({ ok: false, error: "Unauthorized" });

    (req as AuthUserRequest).authUserId = user.id;
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

  const existing = await getStore(req).users.findByEmail(email);
  if (existing) return res.status(409).json({ ok: false, error: "Email already in use" });

  if (username) {
    const usernameTaken = await getStore(req).users.findByUsername(username);
    if (usernameTaken) return res.status(409).json({ ok: false, error: "Username already in use" });
  }

  const passwordHash = await hashPassword(password);
  const { rawCode, hashedCode } = makeOtpCode();
  const verifyOtpExpiresAt = new Date(Date.now() + 1000 * 60 * 30);

  const user = await getStore(req).users.create({
    email,
    username: username || undefined,
    passwordHash,
    emailVerified: false,
    verifyOtpHash: hashedCode,
    verifyOtpExpiresAt,
  });

  await sendVerifyEmail(email, rawCode, getTenantApp(req).displayName);

  return res.json({ ok: true, user: { email: user.email, username: user.username?.trim() || null, emailVerified: user.emailVerified } });
});

authRouter.post("/signin", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  const user = await getStore(req).users.findByEmail(email);
  if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  if (!user.emailVerified) {
    return res.status(403).json({ ok: false, error: "Verify your email before signing in" });
  }

  const session = issueSession(req, res, user);

  return res.json({
    ok: true,
    ...session,
    user: { email: user.email, username: user.username?.trim() || null, emailVerified: user.emailVerified },
  });
});

authRouter.post("/signout", async (req, res) => {
  clearAuthCookie(req, res);
  return res.json({ ok: true });
});

authRouter.get("/session", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  const user = await getStore(req).users.findById(userId);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  return res.json({
    ok: true,
    session: toSessionPayload(user),
  });
});

authRouter.patch("/profile", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  const user = await getStore(req).users.findById(userId);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const username = String(req.body?.username ?? "").trim();
  if (username && username.length < 3) {
    return res.status(400).json({ ok: false, error: "Username must be at least 3 chars" });
  }

  if (username) {
    const usernameTaken = await getStore(req).users.findByUsernameExcluding(username, user.id);
    if (usernameTaken) return res.status(409).json({ ok: false, error: "Username already in use" });
  }

  let birthDate: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "birthDate")) {
    const raw = String(req.body?.birthDate ?? "").trim();
    if (raw && (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || new Date(raw) > new Date())) {
      return res.status(400).json({ ok: false, error: "Invalid birth date" });
    }
    birthDate = raw || null;
  }

  // Data-URL photos can be large; cap well under the 1mb JSON body limit so the error is friendly.
  let profilePhotoUrl: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "profilePhotoUrl")) {
    const raw = String(req.body?.profilePhotoUrl ?? "").trim();
    if (raw.length > 700_000) {
      return res.status(400).json({ ok: false, error: "Profile photo is too large" });
    }
    profilePhotoUrl = raw || null;
  }

  const updated = await getStore(req).users.update(user.id, {
    username: username || null,
    ...(birthDate !== undefined ? { birthDate } : {}),
    ...(profilePhotoUrl !== undefined ? { profilePhotoUrl } : {}),
  });
  if (!updated) return res.status(401).json({ ok: false, error: "Unauthorized" });

  return res.json({ ok: true, session: toSessionPayload(updated) });
});

authRouter.patch("/account/password", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  const user = await getStore(req).users.findById(userId);
  if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const password = String(req.body?.password ?? "");
  if (!passwordValid(password)) {
    return res.status(400).json({ ok: false, error: "Password must be 8+ chars and include lowercase, uppercase, and number" });
  }

  // Bumping authVersion invalidates every token issued before this change.
  await getStore(req).users.update(user.id, {
    passwordHash: await hashPassword(password),
    authVersion: user.authVersion + 1,
  });

  const refreshed = await getStore(req).users.findById(user.id);
  clearAuthCookie(req, res);
  const session = issueSession(req, res, refreshed!);
  return res.json({ ok: true, ...session });
});

authRouter.delete("/account", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  await getStore(req).users.deleteUser(userId);
  clearAuthCookie(req, res);
  return res.json({ ok: true });
});

// Domain feature, not auth: only mounted for apps that opt in via AUTH_FEATURES_<APP>.
authRouter.use("/entries", (req, res, next) => {
  if (!getStore(req).entryStatus) {
    return res.status(404).json({ ok: false, error: "entry-status is not enabled for this app" });
  }
  return next();
}, createUserEntryStatusRouter(authGuard, (req) => getStore(req).entryStatus!));

authRouter.post("/verify/request", async (req, res) => {
  const email = await getVerificationTarget(req as AuthUserRequest);
  if (!email) return res.status(400).json({ ok: false, error: "Email required" });

  const user = await getStore(req).users.findByEmail(email);
  if (!user) return res.json({ ok: true });

  const { rawCode, hashedCode } = makeOtpCode();
  await getStore(req).users.update(user.id, {
    verifyOtpHash: hashedCode,
    verifyOtpExpiresAt: new Date(Date.now() + 1000 * 60 * 30),
  });

  await sendVerifyEmail(user.email, rawCode, getTenantApp(req).displayName);

  return res.json({ ok: true });
});

authRouter.post("/verify/confirm", async (req, res) => {
  const rawCode = getBodyValue(req, "code");
  const email = getBodyValue(req, "email").toLowerCase();
  if (!rawCode || !email) return res.status(400).json({ ok: false, error: "Invalid verification code" });

  const user = await getStore(req).users.findByOtp("verify", email, hashOtpCode(rawCode), new Date());
  if (!user) return res.status(400).json({ ok: false, error: "Invalid or expired verification code" });

  await getStore(req).users.update(user.id, {
    emailVerified: true,
    verifyOtpHash: null,
    verifyOtpExpiresAt: null,
  });

  return res.json({ ok: true });
});

authRouter.post("/password-reset/request", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return res.status(400).json({ ok: false, error: "Email required" });

  const user = await getStore(req).users.findByEmail(email);
  if (!user) return res.json({ ok: true });

  const { rawCode, hashedCode } = makeOtpCode();
  await getStore(req).users.update(user.id, {
    resetOtpHash: hashedCode,
    resetOtpExpiresAt: new Date(Date.now() + 1000 * 60 * 30),
  });

  await sendPasswordResetEmail(user.email, rawCode, getTenantApp(req).displayName);

  return res.json({ ok: true });
});

authRouter.post("/password-reset/confirm", async (req, res) => {
  const rawCode = String(req.body?.code ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");

  if (!rawCode || !email || !passwordValid(password)) {
    return res.status(400).json({ ok: false, error: "Invalid reset submission" });
  }

  const user = await getStore(req).users.findByOtp("reset", email, hashOtpCode(rawCode), new Date());
  if (!user) return res.status(400).json({ ok: false, error: "Invalid or expired reset code" });

  // Bumping authVersion invalidates every token issued before the reset.
  await getStore(req).users.update(user.id, {
    passwordHash: await hashPassword(password),
    resetOtpHash: null,
    resetOtpExpiresAt: null,
    authVersion: user.authVersion + 1,
  });

  clearAuthCookie(req, res);
  return res.json({ ok: true });
});

authRouter.get("/progress/:appId/blob", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const blob = await getStore(req).blobs.get(userId, appId);
  return res.json({ ok: true, blob });
});

authRouter.put("/progress/:appId/blob", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
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

  await getStore(req).blobs.put(userId, appId, {
    encryptionSalt,
    blobIv,
    blobTag,
    blobCiphertext,
    blobVersion,
  });

  return res.json({ ok: true });
});

authRouter.get("/settings/:appId/content-root", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const contentRoot = await getStore(req).settings.getContentRoot(userId, appId);
  return res.json({ ok: true, contentRoot });
});

authRouter.put("/settings/:appId/content-root", authGuard, async (req, res) => {
  const userId = (req as AuthUserRequest).authUserId!;
  const appId = String(req.params.appId ?? "").trim();
  if (!appId) return res.status(400).json({ ok: false, error: "appId required" });

  const raw = req.body?.contentRoot;
  if (raw !== null && typeof raw !== "string") {
    return res.status(400).json({ ok: false, error: "contentRoot must be a string or null" });
  }

  const contentRoot = typeof raw === "string" && raw.trim() ? raw.trim() : null;

  await getStore(req).settings.setContentRoot(userId, appId, contentRoot);

  return res.json({ ok: true, contentRoot });
});
