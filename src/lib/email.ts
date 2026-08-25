import { randomBytes, createHash } from "node:crypto";
import { Resend } from "resend";
import { config } from "../config.js";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export function makeEmailVerificationToken(): { rawToken: string; hashedToken: string } {
  const rawToken = randomBytes(32).toString("hex");
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  return { rawToken, hashedToken };
}

export function makeOtpCode(): { rawCode: string; hashedCode: string } {
  const rawCode = String(Math.floor(100000 + Math.random() * 900000));
  const hashedCode = createHash("sha256").update(rawCode).digest("hex");
  return { rawCode, hashedCode };
}

export async function sendVerifyEmail(email: string, verificationCode: string): Promise<void> {
  if (!resend || !config.resendFrom) {
    console.warn("[auth-service] Resend not configured. Skipping verify email for", email);
    return;
  }

  await resend.emails.send({
    from: config.resendFrom,
    to: email,
    subject: "Verify your account",
    html: `<p>Your verification code is:</p><p style=\"font-size:28px;font-weight:700;letter-spacing:0.18em;\">${verificationCode}</p><p>Enter this code in the Media Viewer app within 30 minutes.</p>`,
  });
}

export async function sendPasswordResetEmail(email: string, resetCode: string): Promise<void> {
  if (!resend || !config.resendFrom) {
    console.warn("[auth-service] Resend not configured. Skipping password reset email for", email);
    return;
  }

  await resend.emails.send({
    from: config.resendFrom,
    to: email,
    subject: "Reset your password",
    html: `<p>Your password reset code is:</p><p style=\"font-size:28px;font-weight:700;letter-spacing:0.18em;\">${resetCode}</p><p>Enter this code in the Media Viewer app within 30 minutes.</p>`,
  });
}
