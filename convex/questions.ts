import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { MAX_BRIEF_CHARS } from "../lib/caps.ts";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./access";
import { insertFact } from "./facts";
import { dispatch } from "./interns";

/** Your own newest questions merged into the global window — see `outbox.list`. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("questions").order("desc").take(30);
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const mine = await ctx.db
        .query("questions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
        .order("desc")
        .take(15);
      const seen = new Set(rows.map((r) => r._id));
      rows.push(...mine.filter((m) => !seen.has(m._id)));
      rows.sort((a, b) => b._creationTime - a._creationTime);
    }
    // A question can quote the owner's private facts; others see only that it exists.
    return rows.map((q) =>
      q.ownerId === userId ? q : { _id: q._id, _creationTime: q._creationTime, ownerId: q.ownerId, internId: q.internId, status: q.status },
    );
  },
});

/** The answer becomes a fact first, then the work resumes as a fresh intern (subject to caps). */
export const answer = mutation({
  args: { questionId: v.id("questions"), answer: v.string() },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const q = await ctx.db.get("questions", a.questionId);
    if (!q || q.ownerId !== user._id || q.status !== "open") throw new ConvexError("That question isn't open for you.");
    const answer = a.answer.trim().slice(0, 1000);
    if (!answer) throw new ConvexError("Type an answer first.");

    await insertFact(ctx, { title: q.question, body: answer, kind: "answer", ownerId: user._id, internId: q.internId });
    const parked = await ctx.db.get("interns", q.internId);
    if (parked?.status === "waiting") await ctx.db.patch("interns", parked._id, { status: "done" });

    const task = `You asked: ${q.question}\nThe answer is: ${answer}\n\nOriginal task: ${parked?.task ?? ""}`.slice(0, MAX_BRIEF_CHARS);
    let resumedBy;
    let reason: string | null = null;
    try {
      // dispatch checks every cap before writing, so catching here leaves no partial intern.
      resumedBy = await dispatch(ctx, user._id, task, q.internId);
    } catch (err) {
      reason = err instanceof ConvexError ? String(err.data) : "could not resume";
    }
    await ctx.db.patch("questions", q._id, { status: "answered", answer, resumedBy });
    return { resumed: !!resumedBy, reason };
  },
});

export const dismiss = mutation({
  args: { questionId: v.id("questions") },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const q = await ctx.db.get("questions", a.questionId);
    if (!q || q.ownerId !== user._id || q.status !== "open") throw new ConvexError("That question isn't open for you.");
    await ctx.db.patch("questions", q._id, { status: "dismissed" });
    const parked = await ctx.db.get("interns", q.internId);
    if (parked?.status === "waiting") await ctx.db.patch("interns", parked._id, { status: "cancelled", endedAt: Date.now() });
    return null;
  },
});
