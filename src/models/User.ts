import { Schema } from "mongoose";

export type UserDoc = {
  email: string;
  username?: string;
  /** Plain YYYY-MM-DD, generic across every app rather than a per-app profile field. */
  birthDate?: string;
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

export const UserSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, trim: true, unique: true, sparse: true },
    birthDate: { type: String },
    passwordHash: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    verifyOtpHash: { type: String },
    verifyOtpExpiresAt: { type: Date },
    resetOtpHash: { type: String },
    resetOtpExpiresAt: { type: Date },
    authVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

UserSchema.index({ email: 1 }, { unique: true });
