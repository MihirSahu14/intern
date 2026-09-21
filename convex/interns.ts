import { ConvexError, v } from "convex/values";
import { DAY_WINDOW, MAX_BRIEF_CHARS, costUsd, dayKey, dayStart, spawnBlocked, tooManyBriefs } from "../lib/caps.ts";
import { PROMPT_VERSION } from "../lib/brief.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { insertFact } from "./facts";
import { actionKind, draft, factKind, logLevel } from "./schema";

/** Caps, then insert, then schedule. Shared by spawn and by answering a question. */
export async function dispatch(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  task: string,
  resumes?: Id<"interns">,
): Promise<Id<"interns">> {
  if (!task) throw new ConvexError("Give the intern a task.");
  if (task.length > MAX_BRIEF_CHARS) {
    throw new ConvexError(`Keep the brief under ${MAX_BRIEF_CHARS} characters.`);
  }
  const now = Date.now();
  const today = await ctx.db
    .query("interns")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId).gte("_creationTime", dayStart(now)))
    .take(DAY_WINDOW + 1);
  // One row past the window means the day no longer fits in what's read here,
  // so neither count below can be believed: a run that fails with zero output
  // tokens is free, takes a second, and doesn't count toward the cap, so fifty
  // of them would otherwise switch both caps off for the rest of the day.
  if (today.length > DAY_WINDOW) throw new ConvexError(tooManyBriefs);
  const usage = await ctx.db.query("usage").withIndex("by_date", (q) => q.eq("date", dayKey(now))).unique();
  const blocked = spawnBlocked({
    briefsToday: today.filter((i) => i.countsTowardCap).length,
    // A cancelled run's in-flight action (start/finish/fail) hasn't reported
    // back yet — spawn→cancel→spawn must not evade the one-concurrent-intern
    // cap just because the row already reads "cancelled".
    active: today.some(
      (i) => i.status === "queued" || i.status === "running" || (i.status === "cancelled" && i.endedAt === undefined),
    ),
    spentToday: usage?.costUsd ?? 0,
  });
  if (blocked) throw new ConvexError(blocked);

  const internId = await ctx.db.insert("interns", {
    ownerId,
    task,
    status: "queued",
    resumes,
    countsTowardCap: true,
  });
  await ctx.scheduler.runAfter(0, internal.run.go, { internId });
  return internId;
}

export const spawn = mutation({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    const user = await requireMember(ctx);
    return await dispatch(ctx, user._id, task.trim());
  },
});

export const cancel = mutation({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const user = await requireMember(ctx);
    const i = await ctx.db.get("interns", internId);
    if (!i || i.ownerId !== user._id) throw new ConvexError("Only whoever briefed an intern can stop it.");
    if (i.status === "queued" || i.status === "running" || i.status === "waiting") {
      await ctx.db.patch("interns", internId, {
        status: "cancelled",
        // A queued/running intern's action is still in flight and reports its
        // own end via start/finish/fail (see dispatch's active check above); a
        // waiting intern has nothing left running, so it ends right here.
        ...(i.status === "waiting" ? { endedAt: Date.now() } : {}),
      });
      await ctx.db.insert("logs", { internId, level: "warn", text: "cancelled" });
      if (i.status === "waiting") {
        // Otherwise answering the open question later would file a fact and
        // dispatch a fresh intern for a run the owner already cancelled.
        const q = await ctx.db
          .query("questions")
          .withIndex("by_ownerId", (q) => q.eq("ownerId", user._id))
          .filter((q) => q.and(q.eq(q.field("internId"), internId), q.eq(q.field("status"), "open")))
          .first();
        if (q) await ctx.db.patch("questions", q._id, { status: "dismissed" });
      }
    }
    return null;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("interns").order("desc").take(40);
    return await Promise.all(rows.map(async (i) => ({ ...i, ...(await ownerView(ctx, i.ownerId)) })));
  },
});

export const logs = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("logs").order("desc").take(400)).reverse(),
});

// --- called by run.go ------------------------------------------------------

export const start = internalMutation({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const i = await ctx.db.get("interns", internId);
    if (!i) return null;
    if (i.status !== "queued") {
      // Cancelled before its scheduled run ever reached Gemini: no tokens
      // were spent, but dispatch's active check still needs a terminal
      // endedAt to release the concurrency slot.
      if (i.status === "cancelled" && i.endedAt === undefined) {
        await ctx.db.patch("interns", internId, { endedAt: Date.now() });
      }
      return null;
    }
    await ctx.db.patch("interns", internId, { status: "running", startedAt: Date.now(), promptVersion: PROMPT_VERSION });
    return { task: i.task };
  },
});

export const noteRecall = internalMutation({
  args: { internId: v.id("interns"), recalled: v.array(v.object({ id: v.id("facts"), kind: factKind })) },
  handler: async (ctx, { internId, recalled }) => {
    await ctx.db.patch("interns", internId, {
      recalledFactIds: recalled.map((r) => r.id),
      recalledCorrection: recalled.some((r) => r.kind === "preference" || r.kind === "correction"),
    });
    return null;
  },
});

export const appendLog = internalMutation({
  args: { internId: v.id("interns"), level: logLevel, text: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.insert("logs", { ...a, text: a.text.slice(0, 2000) });
    return null;
  },
});

async function addUsage(ctx: MutationCtx, tokensIn: number, tokensOut: number) {
  const date = dayKey(Date.now());
  const row = await ctx.db.query("usage").withIndex("by_date", (q) => q.eq("date", date)).unique();
  const cost = costUsd(tokensIn, tokensOut);
  if (row) await ctx.db.patch("usage", row._id, { costUsd: row.costUsd + cost, runs: row.runs + 1 });
  else await ctx.db.insert("usage", { date, costUsd: cost, runs: 1 });
}

/** Every write a finished run makes, in one transaction. */
export const finish = internalMutation({
  args: {
    internId: v.id("interns"),
    report: v.string(),
    tokensIn: v.number(),
    tokensOut: v.number(),
    latencyMs: v.number(),
    facts: v.array(v.object({ title: v.string(), body: v.string(), kind: factKind })),
    action: v.optional(
      v.object({ kind: actionKind, title: v.string(), draft, rationale: v.string(), sources: v.array(v.string()) }),
    ),
    actionError: v.optional(v.string()),
    question: v.optional(v.object({ question: v.string(), context: v.string() })),
    questionError: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const intern = await ctx.db.get("interns", a.internId);
    if (!intern) return null;
    // The tokens were spent whatever happens next.
    await addUsage(ctx, a.tokensIn, a.tokensOut);

    const base = {
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      latencyMs: a.latencyMs,
      summary: a.report.slice(0, 600),
      endedAt: Date.now(),
    };
    const log = (level: "ok" | "warn" | "err", text: string) =>
      ctx.db.insert("logs", { internId: a.internId, level, text });

    if (intern.status === "cancelled") {
      await ctx.db.patch("interns", a.internId, base);
      return null;
    }

    if (a.question) {
      await ctx.db.insert("questions", {
        ownerId: intern.ownerId,
        internId: a.internId,
        question: a.question.question,
        context: a.question.context,
        status: "open",
      });
      await ctx.db.patch("interns", a.internId, { ...base, status: "waiting", parseOutcome: "question" });
      await log("warn", `asks: ${a.question.question}`);
      return null;
    }

    for (const f of a.facts) {
      await insertFact(ctx, { ...f, ownerId: intern.ownerId, internId: a.internId });
      await log("ok", `filed · ${f.title}`);
    }

    let parseOutcome = "none";
    if (a.action) {
      await ctx.db.insert("actions", {
        ...a.action,
        ownerId: intern.ownerId,
        internId: a.internId,
        status: "pending",
        recalledCorrection: intern.recalledCorrection ?? false,
      });
      await log("warn", `drafted a ${a.action.kind} · waiting for approval`);
      parseOutcome = "action";
    } else if (a.actionError) {
      await log("err", `${a.actionError}. Nothing was queued.`);
      parseOutcome = `action_malformed:${a.actionError}`;
    } else if (a.questionError) {
      // A dropped intent is indistinguishable from no intent unless it's
      // surfaced — same argument as actionError above.
      await log("err", `${a.questionError}. No question was asked.`);
      parseOutcome = `question_malformed:${a.questionError}`;
    }

    await ctx.db.patch("interns", a.internId, { ...base, status: "done", parseOutcome });
    await log("ok", `finished in ${(a.latencyMs / 1000).toFixed(1)}s`);
    return null;
  },
});

export const fail = internalMutation({
  args: {
    internId: v.id("interns"),
    error: v.string(),
    countsTowardCap: v.boolean(),
    tokensIn: v.number(),
    tokensOut: v.number(),
  },
  handler: async (ctx, a) => {
    const intern = await ctx.db.get("interns", a.internId);
    if (!intern) return null;
    // The tokens were spent whatever happens next — a stream that dies
    // mid-way (empty report, network error, a `finish` validator rejection)
    // was still billed by Google.
    await addUsage(ctx, a.tokensIn, a.tokensOut);

    if (intern.status === "cancelled") {
      // Marks when the in-flight action actually ended, distinct from when
      // cancellation was requested — dispatch's active check waits for this.
      await ctx.db.patch("interns", a.internId, { endedAt: Date.now(), tokensIn: a.tokensIn, tokensOut: a.tokensOut });
      return null;
    }

    await ctx.db.patch("interns", a.internId, {
      status: "failed",
      error: a.error,
      endedAt: Date.now(),
      countsTowardCap: a.countsTowardCap,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
    });
    await ctx.db.insert("logs", { internId: a.internId, level: "err", text: a.error });
    return null;
  },
});
