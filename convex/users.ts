import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireMember } from "./access";
import { broadcast } from "./broadcast";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const u = userId ? await ctx.db.get("users", userId) : null;
    if (!u) return null;
    return {
      userId: u._id,
      handle: u.handle ?? u.name ?? "you",
      image: u.image ?? null,
      accepted: !!u.acceptedAt,
      banned: !!u.bannedAt,
    };
  },
});

export const accept = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get("users", userId) : null;
    if (!user) throw new ConvexError("Sign in first.");
    if (user.acceptedAt) return null;
    await ctx.db.patch("users", user._id, { acceptedAt: Date.now() });
    if (!user.bannedAt) await broadcast(ctx, { type: "joined", handle: user.handle ?? user.name ?? "someone" });
    return null;
  },
});

/** "Delete everything I added." The account stays so the caps still apply. */
export const deleteMine = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireMember(ctx);
    await ctx.scheduler.runAfter(0, internal.users.purge, { userId: user._id });
    return null;
  },
});

const BATCH = 100;

/**
 * Deletes one batch per table and reschedules itself until nothing is left.
 * ponytail: an intern's logs are deleted with take(500); a run writes well
 * under 200 lines (4,096 output tokens / 160-char lines).
 */
export const purge = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    let more = false;

    const facts = await ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of facts) await ctx.db.delete("facts", r._id);

    const actions = await ctx.db.query("actions").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of actions) await ctx.db.delete("actions", r._id);

    const questions = await ctx.db.query("questions").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of questions) await ctx.db.delete("questions", r._id);

    const interns = await ctx.db.query("interns").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of interns) {
      const lines = await ctx.db.query("logs").withIndex("by_internId", (q) => q.eq("internId", r._id)).take(500);
      for (const l of lines) await ctx.db.delete("logs", l._id);
      await ctx.db.delete("interns", r._id);
    }

    const connections = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", userId))
      .take(BATCH);
    for (const r of connections) {
      // Our row goes now; Composio's copy of the grant goes with it.
      if (r.status === "active" && r.composioAccountId) {
        await ctx.scheduler.runAfter(0, internal.connections.forget, { composioAccountId: r.composioAccountId });
      }
      await ctx.db.delete("connections", r._id);
    }

    more = [facts, actions, questions, interns, connections].some((rows) => rows.length === BATCH);
    if (more) await ctx.scheduler.runAfter(0, internal.users.purge, { userId });
    return null;
  },
});

/** Admin, from the Convex dashboard's function runner: users:ban {"handle":"x"}. */
export const ban = internalMutation({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const user = await ctx.db.query("users").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
    if (!user) return { banned: false };
    await ctx.db.patch("users", user._id, { bannedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.users.purge, { userId: user._id });
    return { banned: true };
  },
});
