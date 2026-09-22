import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { DAY_WINDOW, MAX_BRIEF_CHARS, costUsd, dayKey, dayStart, spawnBlocked, tooManyBriefs } from "../lib/caps.ts";
import { PROMPT_VERSION } from "../lib/brief.ts";
import { redactEmails } from "../lib/redact.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { insertFact } from "./facts";
import { actionKind, draft, factKind, logLevel, visibility } from "./schema";

/**
 * Every rule about whether this person may start work right now. Shared by
 * dispatch and by retry, which spends exactly as much as a fresh brief does.
 */
async function assertWithinCaps(ctx: MutationCtx, ownerId: Id<"users">) {
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
}

/**
 * Caps, then insert, then schedule. Shared by spawn and by answering a
 * question. `displayTask` is the safe-to-show version of `task` — set when
 * `task` was assembled from a question and its answer, which can quote the
 * owner's private facts; a fresh brief has nothing to hide behind it.
 */
export async function dispatch(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  task: string,
  resumes?: Id<"interns">,
  displayTask?: string,
): Promise<Id<"interns">> {
  if (!task) throw new ConvexError("Give the intern a task.");
  if (task.length > MAX_BRIEF_CHARS) {
    throw new ConvexError(`Keep the brief under ${MAX_BRIEF_CHARS} characters.`);
  }
  await assertWithinCaps(ctx, ownerId);

  const internId = await ctx.db.insert("interns", {
    ownerId,
    task,
    displayTask,
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

/**
 * Run a finished-badly brief again, in place.
 *
 * The same intern goes back to `queued` and its log keeps going, because a
 * retry is the same piece of work — a second row would put a duplicate card in
 * the rail and a duplicate node on a graph everybody shares. Usually the reason
 * it failed has simply passed: the free model was busy.
 *
 * It costs what any brief costs: same caps, same budget.
 */
export const retry = mutation({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const user = await requireMember(ctx);
    const i = await ctx.db.get("interns", internId);
    if (!i || i.ownerId !== user._id) {
      throw new ConvexError("You can only retry your own brief.");
    }
    if (i.status !== "failed" && i.status !== "cancelled") {
      throw new ConvexError("Only a failed or cancelled brief can be run again.");
    }
    await assertWithinCaps(ctx, user._id);

    await ctx.db.patch("interns", internId, {
      status: "queued",
      countsTowardCap: true,
      // Clear what the last attempt concluded; the log keeps the history.
      error: undefined,
      summary: undefined,
      startedAt: undefined,
      endedAt: undefined,
      latencyMs: undefined,
      parseOutcome: undefined,
    });
    await ctx.db.insert("logs", { internId, level: "sys", text: "running it again" });
    await ctx.scheduler.runAfter(0, internal.run.go, { internId });
    return null;
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
    const viewer = await getAuthUserId(ctx);
    const rows = await ctx.db.query("interns").order("desc").take(40);
    return await Promise.all(
      rows.map(async (i) => ({
        ...i,
        ...(await ownerView(ctx, i.ownerId)),
        // A brief is public, an address in it isn't — and a question-resumed
        // `task` can quote the owner's private facts, so it's swapped for
        // `displayTask` (the original ask) before redaction. The report
        // (`summary`), the failure detail (`error`), which private facts were
        // recalled (`recalledFactIds`) and whether this run touched anything
        // private at all (`recalledPrivate`) are for the owner alone.
        ...(i.ownerId === viewer
          ? {}
          : {
              task: redactEmails(i.displayTask ?? i.task),
              summary: undefined,
              error: i.error ? "failed" : undefined,
              recalledFactIds: undefined,
              recalledPrivate: undefined,
            }),
      })),
    );
  },
});

/**
 * Oldest→newest, last 400. Other people's streamed output (`out`) is
 * withheld: it carries the draft and whatever the intern recalled from its
 * owner's private facts. An `err` line can likewise quote a rejected report
 * (see `run.go`'s catch), so non-owners get a fixed string instead of the
 * raw message. Their remaining lines come through with addresses redacted.
 */
export const logs = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const rows = (await ctx.db.query("logs").order("desc").take(400)).reverse();
    const owners = new Map<Id<"interns">, Id<"users"> | null>();
    const out: Doc<"logs">[] = [];
    for (const l of rows) {
      if (!owners.has(l.internId)) owners.set(l.internId, (await ctx.db.get("interns", l.internId))?.ownerId ?? null);
      const owner = owners.get(l.internId);
      if (viewer !== null && owner === viewer) out.push(l);
      else if (l.level === "out") continue;
      else if (l.level === "err") out.push({ ...l, text: "something went wrong" });
      else out.push({ ...l, text: redactEmails(l.text) });
    }
    return out;
  },
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
    return { task: i.task, ownerId: i.ownerId };
  },
});

export const noteRecall = internalMutation({
  args: {
    internId: v.id("interns"),
    recalled: v.array(v.object({ id: v.id("facts"), kind: factKind, visibility: v.optional(visibility) })),
  },
  handler: async (ctx, { internId, recalled }) => {
    const intern = await ctx.db.get("interns", internId);
    await ctx.db.patch("interns", internId, {
      recalledFactIds: recalled.map((r) => r.id),
      recalledCorrection: recalled.some((r) => r.kind === "preference" || r.kind === "correction"),
      // Computed once here, not re-derived by `finish`: a private fact this
      // run read from stays private in whatever it goes on to file. A
      // question-resumed run (`displayTask` set) is private by construction —
      // its `task` quotes the answer verbatim whether or not recall's capped
      // search happened to also surface the fact it came from — and this
      // runs on every attempt, including a retry, so that can't go stale.
      recalledPrivate: !!intern?.displayTask || recalled.some((r) => r.visibility === "owner"),
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
      // The question text is owner-only (questions.list); the public log line
      // never carries it.
      await log("warn", "asks a question");
      return null;
    }

    // A fact this run filed is owner-only whenever it recalled anything
    // private: an intern that read a private fact can restate it in its own
    // words, so the *filed* fact needs the same guard the recalled one had.
    const factVisibility: Doc<"facts">["visibility"] = intern.recalledPrivate ? "owner" : undefined;
    for (const f of a.facts) {
      await insertFact(ctx, { ...f, ownerId: intern.ownerId, internId: a.internId, visibility: factVisibility });
      await log("ok", factVisibility ? "filed a private fact" : `filed · ${f.title}`);
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
