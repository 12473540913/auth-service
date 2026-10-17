import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";

process.env.AUTH_ENV_FILE = new URL("./unused-test-env", import.meta.url).pathname;
process.env.AUTH_APP_IDS = "password-test";
process.env.DATABASE_URI_PASSWORD_TEST = "mongodb://127.0.0.1/password-test";
process.env.JWT_SECRET = "password-test-only-signing-key-not-for-production";
process.env.AUTH_COOKIE_SECURE = "false";
delete process.env.RESEND_FULL_ACCESS_KEY;

const { authRouter } = await import("../src/routes/auth.ts");
const { config } = await import("../src/config.ts");
const { hashPassword, verifyPassword } = await import("../src/lib/password.ts");
const { signAuthToken, verifyAuthToken } = await import("../src/lib/jwt.ts");

const originalPassword = "OriginalPassword1";
const originalHash = await hashPassword(originalPassword);

async function fixture(t, tokenMode = "bearer") {
  let user = {
    id: "test-user",
    email: "password-test@example.test",
    passwordHash: originalHash,
    emailVerified: true,
    authVersion: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let updates = 0;
  const tenantApp = {
    appId: "password-test",
    tokenMode,
    cookieSameSite: "lax",
  };
  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, _res, next) => {
    req.tenantApp = tenantApp;
    req.store = { users: {
      findById: async (id) => id === user.id ? { ...user } : null,
      update: async (_id, patch) => {
        updates += 1;
        user = { ...user, ...patch };
        return { ...user };
      },
    } };
    next();
  });
  app.use("/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/auth`;
  const token = signAuthToken({
    sub: user.id, email: user.email, tokenVersion: user.authVersion, appId: tenantApp.appId,
  });
  const headers = (sessionToken) => tokenMode === "bearer"
    ? { Authorization: `Bearer ${sessionToken}` }
    : { Cookie: `${config.cookieName}=${sessionToken}` };
  return {
    token,
    change: (body, authenticated = true) => fetch(`${base}/account/password`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(authenticated ? headers(token) : {}) },
      body: JSON.stringify(body),
    }),
    session: (sessionToken) => fetch(`${base}/session`, { headers: headers(sessionToken) }),
    user: () => user,
    updates: () => updates,
  };
}

for (const [name, body, status, error] of [
  ["missing current password", { password: "ReplacementPassword2" }, 400, "Current password is required"],
  ["incorrect current password", { currentPassword: "WrongPassword1", password: "ReplacementPassword2" }, 403, "Current password is incorrect"],
  ["invalid new password", { currentPassword: originalPassword, password: "weak" }, 400, "Password must be 8+ chars and include lowercase, uppercase, and number"],
]) {
  test(`rejects ${name} without changing the password or sessions`, async (t) => {
    const f = await fixture(t);
    const response = await f.change(body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, error);
    assert.equal(f.updates(), 0);
    assert.equal(f.user().passwordHash, originalHash);
    assert.equal((await f.session(f.token)).status, 200);
  });
}

test("requires an authenticated session", async (t) => {
  const f = await fixture(t);
  const response = await f.change({ currentPassword: originalPassword, password: "ReplacementPassword2" }, false);
  assert.equal(response.status, 401);
  assert.equal(f.updates(), 0);
});

for (const mode of ["cookie", "bearer"]) {
  test(`changes password and rotates the ${mode} session`, async (t) => {
    const f = await fixture(t, mode);
    const response = await f.change({ currentPassword: originalPassword, password: "ReplacementPassword2" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(f.updates(), 1);
    assert.equal(await verifyPassword("ReplacementPassword2", f.user().passwordHash), true);
    assert.equal(await verifyPassword(originalPassword, f.user().passwordHash), false);
    assert.equal(f.user().authVersion, 4);
    const replacement = mode === "bearer" ? payload.token
      : response.headers.getSetCookie().find((cookie) =>
        cookie.startsWith(`${config.cookieName}=`) && !cookie.startsWith(`${config.cookieName}=;`)
      )?.split(";")[0].slice(config.cookieName.length + 1);
    assert.ok(replacement);
    assert.equal(verifyAuthToken(replacement, "password-test").tokenVersion, 4);
    assert.equal((await f.session(f.token)).status, 401);
    assert.equal((await f.session(replacement)).status, 200);
  });
}
