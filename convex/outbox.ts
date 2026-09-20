import { ConvexError, v } from "convex/values";
import { changedFields, correctionFromEdit, correctionFromReject, editRatio } from "../lib/edits.ts";
import { mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { insertFact } from "./facts";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("actions").order("desc").take(30);
    return await Promise.all(rows.map(async (a) => ({ ...a, handle: (await ownerView(ctx, a.ownerId)).handle })));
  },
});

/**
 * Approve (optionally edited) or reject. Sandbox: nothing is ever sent. An edit
 * becomes a preference fact and a rejection becomes a correction fact, which
 * the next intern recalls. That is the learning loop.
 */
export const decide = mutation({
  args: {
    actionId: v.id("actions"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    edits: v.optional(
      v.object({
        to: v.optional(v.array(v.string())),
        cc: v.optional(v.array(v.string())),
        subject: v.optional(v.string()),
        body: v.optional(v.string()),
      }),
    ),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can decide on its draft.");
    }
    if (action.status !== "pending") throw new ConvexError("Already decided.");
    const now = Date.now();
    const log = (level: "ok" | "warn", text: string) =>
      ctx.db.insert("logs", { internId: action.internId, level, text });

    if (a.decision === "reject") {
      const reason = (a.reason ?? "").trim().slice(0, 500) || "no reason given";
      await ctx.db.patch("actions", action._id, { status: "rejected", decision: "rejected", reason, decidedAt: now });
      const c = correctionFromReject(action.kind, action.draft, reason);
      await insertFact(ctx, { ...c, kind: "correction", ownerId: user._id, internId: action.internId });
      await log("warn", `rejected · learned: ${c.title}`);
      return null;
    }

    const accepted = { ...action.draft, ...a.edits };
    const fields = changedFields(action.draft, accepted);
    await ctx.db.patch("actions", action._id, {
      status: "approved",
      decision: fields.length ? "edited" : "approved_unedited",
      editRatio: editRatio(action.draft, accepted),
      decidedAt: now,
      ...(fields.length ? { accepted, editedFields: fields } : {}),
    });
    if (fields.length) {
      const c = correctionFromEdit(action.kind, action.draft, accepted, fields);
      await insertFact(ctx, { ...c, kind: "preference", ownerId: user._id, internId: action.internId });
      await log("ok", `learned: ${c.title}`);
    }
    await log("ok", "Approved. Sandbox: nothing was sent.");
    return null;
  },
});
