import { randomBytes, randomInt, createHash } from "node:crypto";
import { Resend } from "resend";
import { config } from "../config.js";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export function makeEmailVerificationToken(): { rawToken: string; hashedToken: string } {
  const rawToken = randomBytes(32).toString("hex");
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, hashedToken };
}

// randomInt is CSPRNG-backed. Math.random() is predictable from prior outputs, which for
// a code that gates password reset would allow account takeover.
export function makeOtpCode(): { rawCode: string; hashedCode: string } {
  const rawCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const hashedCode = createHash("sha256").update(rawCode).digest("hex");
  return { rawCode, hashedCode };
}

function codeEmailHtml(intro: string, code: string, appName: string): string {
  return [
    `<p>${intro}</p>`,
    `<p style="font-size:28px;font-weight:700;letter-spacing:0.18em;">${code}</p>`,
    `<p>Enter this code in ${appName} within 30 minutes.</p>`,
  ].join("");
}

export async function sendVerifyEmail(email: string, verificationCode: string, appName: string): Promise<void> {
  if (!resend || !config.resendFrom) {
    console.warn("[auth-service] Resend not configured. Skipping verify email for", email);
    return;
  }

  await resend.emails.send({
    from: config.resendFrom,
    to: email,
    subject: `Verify your ${appName} account`,
    html: codeEmailHtml("Your verification code is:", verificationCode, appName),
  });
}

export async function sendPasswordResetEmail(email: string, resetCode: string, appName: string): Promise<void> {
  if (!resend || !config.resendFrom) {
    console.warn("[auth-service] Resend not configured. Skipping password reset email for", email);
    return;
  }

  await resend.emails.send({
    from: config.resendFrom,
    to: email,
    subject: `Reset your ${appName} password`,
    html: codeEmailHtml("Your password reset code is:", resetCode, appName),
  });
}
