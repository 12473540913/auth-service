import { Schema, type Types } from "mongoose";

export type UserAppSettingsDoc = {
  userId: Types.ObjectId;
  appId: string;
  contentRoot: string | null;
  updatedAt: Date;
};

export const UserAppSettingsSchema = new Schema<UserAppSettingsDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    appId: { type: String, required: true, index: true },
    contentRoot: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

UserAppSettingsSchema.index({ userId: 1, appId: 1 }, { unique: true });
