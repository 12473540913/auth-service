import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mock, test } from "node:test";
import express from "express";

process.env.AUTH_ENV_FILE = new URL("./unused-test-env", import.meta.url).pathname;
process.env.AUTH_APP_IDS = "signup-test";
process.env.DATABASE_URI_SIGNUP_TEST = "mongodb://127.0.0.1/signup-test";
process.env.JWT_SECRET = "signup-test-only-signing-key-not-for-production";

const freshCode = "654321";
const hash = (code) => createHash("sha256").update(code).digest("hex");
const sendVerifyEmail = mock.fn(async () => {});
mock.module("../src/lib/email.ts", {
  namedExports: {
    makeOtpCode: () => ({ rawCode: freshCode, hashedCode: hash(freshCode) }),
    sendVerifyEmail,
    sendPasswordResetEmail: async () => {},
  },
});

const { authRouter } = await import("../src/routes/auth.ts");
const { hashPassword } = await import("../src/lib/password.ts");
const password = "OriginalPassword1";
const passwordHash = await hashPassword(password);

async function fixture(t, verified = false) {
  sendVerifyEmail.mock.resetCalls();
  let user = {
    id: "existing-user", email: "pending@example.test", username: "original",
    passwordHash, emailVerified: verified, authVersion: 2,
    verifyOtpHash: hash("123456"),
    verifyOtpExpiresAt: new Date(Date.now() - 60_000),
  };
  const patches = [];
  const create = mock.fn(async () => { throw new Error("Must not create a duplicate user"); });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantApp = { appId: "signup-test", displayName: "Signup Test", tokenMode: "cookie" };
    req.store = { users: {
      findByEmail: async (email) => email === user.email ? { ...user } : null,
      findByOtp: async (_kind, email, otpHash, now) =>
        email === user.email && otpHash === user.verifyOtpHash && user.verifyOtpExpiresAt > now
          ? { ...user } : null,
      update: async (_id, patch) => {
        patches.push(patch);
        user = { ...user, ...patch };
        return { ...user };
      },
      create,
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
  return {
    user: () => user, patches, create,
    post: (path, body) => fetch(`http://127.0.0.1:${server.address().port}/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

test("signup retries send a fresh 30-minute code and preserve the existing account", async (t) => {
  const f = await fixture(t);
  const before = Date.now();
  const response = await f.post("signup", {
    email: " Pending@Example.Test ", password: "DifferentPassword2", username: "different",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true, user: { email: "pending@example.test", username: "original", emailVerified: false },
  });
  assert.equal(f.create.mock.callCount(), 0);
  assert.deepEqual(Object.keys(f.patches[0]).sort(), ["verifyOtpExpiresAt", "verifyOtpHash"]);
  assert.equal(f.user().passwordHash, passwordHash);
  assert.equal(f.user().authVersion, 2);
  assert.equal(f.user().verifyOtpHash, hash(freshCode));
  assert.ok(f.user().verifyOtpExpiresAt.getTime() >= before + 30 * 60_000);
  assert.ok(f.user().verifyOtpExpiresAt.getTime() <= Date.now() + 30 * 60_000);
  assert.deepEqual(sendVerifyEmail.mock.calls[0].arguments, ["pending@example.test", freshCode, "Signup Test"]);
  assert.equal((await f.post("verify/confirm", { email: f.user().email, code: "123456" })).status, 400);
  assert.equal((await f.post("verify/confirm", { email: f.user().email, code: freshCode })).status, 200);
  assert.equal(f.user().emailVerified, true);
});

test("verified accounts still reject signup without sending a code", async (t) => {
  const f = await fixture(t, true);
  const response = await f.post("signup", { email: f.user().email, password });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "Email already in use");
  assert.equal(f.patches.length, 0);
  assert.equal(sendVerifyEmail.mock.callCount(), 0);
});

test("unverified sign-in keeps its warning without sending a code", async (t) => {
  const f = await fixture(t);
  const response = await f.post("signin", { email: f.user().email, password });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Verify your email before signing in");
  assert.equal(f.patches.length, 0);
  assert.equal(sendVerifyEmail.mock.callCount(), 0);
});

test("invalid signup input does not resend a code", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post("signup", { email: f.user().email, password: "weak" })).status, 400);
  assert.equal(f.patches.length, 0);
  assert.equal(sendVerifyEmail.mock.callCount(), 0);
});
