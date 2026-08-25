// APP-SPECIFIC FEATURE for Spice -- Status of an Entry
//
// Long term this should be removed, and this service reduced to issuing and
// verifying identity tokens. See README "Roadmap".

import { Router, type NextFunction, type Request, type Response } from "express";
import { Schema, type Types } from "mongoose";

import type { EntryStatus, EntryStatusPatch, EntryStatusStore } from "../store/types.js";

export type UserEntryStatusDoc = {
  userId: Types.ObjectId;
  entryId: string;
  viewed: boolean;
  rating?: number;
  createdAt: Date;
  updatedAt: Date;
};

export const UserEntryStatusSchema = new Schema<UserEntryStatusDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    entryId: { type: String, required: true, trim: true, index: true },
    viewed: { type: Boolean, required: true, default: false },
    rating: { type: Number, min: 1, max: 5 },
  },
  { timestamps: true },
);

UserEntryStatusSchema.index({ userId: 1, entryId: 1 }, { unique: true });
UserEntryStatusSchema.index({ entryId: 1, userId: 1 });

type AuthGuard = (req: Request, res: Response, next: NextFunction) => unknown;
type AuthenticatedRequest = Request & { authUserId?: string };
type GetStore = (req: Request) => EntryStatusStore;

function getAuthUserId(req: Request): string | undefined {
  return (req as AuthenticatedRequest).authUserId;
}

function toEntryStatusPayload(row: EntryStatus) {
  return {
    entryId: row.entryId,
    viewed: row.viewed,
    rating: row.rating,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function defaultEntryStatusPayload(entryId: string) {
  return { entryId, viewed: false, rating: null, updatedAt: null };
}

export function createUserEntryStatusRouter(authGuard: AuthGuard, getStore: GetStore): Router {
  const router = Router();

  router.use(authGuard);

  router.get("/status", async (req, res) => {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const entryIds = String(req.query.entryIds ?? "")
      .split(",")
      .map((entryId) => entryId.trim())
      .filter(Boolean);

    if (!entryIds.length) return res.status(400).json({ ok: false, error: "entryIds required" });
    if (entryIds.length > 500) return res.status(400).json({ ok: false, error: "Too many entryIds (max 500)" });

    const rows = await getStore(req).findMany(userId, entryIds);
    const statuses = new Map(rows.map((row) => [row.entryId, toEntryStatusPayload(row)]));

    return res.json({
      ok: true,
      entries: entryIds.map((entryId) => statuses.get(entryId) ?? defaultEntryStatusPayload(entryId)),
    });
  });

  router.get("/:entryId/status", async (req, res) => {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const entryId = String(req.params.entryId ?? "").trim();
    if (!entryId) return res.status(400).json({ ok: false, error: "entryId required" });

    const row = await getStore(req).findOne(userId, entryId);
    return res.json({ ok: true, entry: row ? toEntryStatusPayload(row) : defaultEntryStatusPayload(entryId) });
  });

  router.patch("/:entryId/status", async (req, res) => {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const entryId = String(req.params.entryId ?? "").trim();
    if (!entryId) return res.status(400).json({ ok: false, error: "entryId required" });

    const hasViewed = Object.hasOwn(req.body ?? {}, "viewed");
    const hasRating = Object.hasOwn(req.body ?? {}, "rating");
    if (!hasViewed && !hasRating) return res.status(400).json({ ok: false, error: "viewed or rating required" });

    const patch: EntryStatusPatch = {};

    if (hasViewed) {
      if (typeof req.body.viewed !== "boolean") return res.status(400).json({ ok: false, error: "viewed must be boolean" });
      patch.viewed = req.body.viewed;
    }

    if (hasRating) {
      if (req.body.rating === null) {
        patch.rating = null;
      } else {
        const rating = Number(req.body.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          return res.status(400).json({ ok: false, error: "rating must be an integer from 1 to 5" });
        }
        patch.rating = rating;
      }
    }

    const row = await getStore(req).upsert(userId, entryId, patch);
    return res.json({ ok: true, entry: toEntryStatusPayload(row) });
  });

  return router;
}
