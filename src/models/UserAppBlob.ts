import { Schema, type Types } from "mongoose";

export type UserAppBlobDoc = {
  userId: Types.ObjectId;
  appId: string;
  encryptionSalt: string;
  blobIv: string;
  blobTag: string;
  blobCiphertext: string;
  blobVersion: number;
  updatedAt: Date;
};

export const UserAppBlobSchema = new Schema<UserAppBlobDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    appId: { type: String, required: true, index: true },
    encryptionSalt: { type: String, required: true },
    blobIv: { type: String, required: true },
    blobTag: { type: String, required: true },
    blobCiphertext: { type: String, required: true },
    blobVersion: { type: Number, required: true, default: 1 },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

UserAppBlobSchema.index({ userId: 1, appId: 1 }, { unique: true });
