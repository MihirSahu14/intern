import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  DAY_WINDOW,
  MAX_FACT_CHARS,
  MAX_RECIPIENT_CHARS,
  MAX_RECIPIENTS,
  dayStart,
  sendBlocked,
  tooManySends,
} from "../lib/caps.ts";
import { type ConnectorKey, connectorByKey, connectorFor, isConfigured } from "../lib/connectors.ts";
import { changedFields, correctionFromEdit, correctionFromReject, editRatio } from "../lib/edits.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { activeConnection } from "./connections";
import { insertFact } from "./facts";

type Edits = {
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
};

/**
 * The one free-text input in this file a person, not an intern, types. Bound
 * it the same way every sibling path bounds its input (`teach`'s
 * MAX_FACT_CHARS, `dispatch`'s MAX_BRIEF_CHARS) — the accepted draft becomes a
 * fact body (`correctionFromEdit`), and an unbounded one can blow the 1MB
 * document limit after `actions` was already patched to approved. Bounding the
 * array length alone isn't enough: each element is a free-text string too, so
 * a single oversized recipient is capped the same way subject/body are.
 */
const capRecipients = (list: string[]) =>
  list.slice(0, MAX_RECIPIENTS).map((r) => r.trim().slice(0, MAX_RECIPIENT_CHARS)).filter(Boolean);

function capEdits(edits: Edits): Edits {
  const out: Edits = {};
  if (edits.to !== undefined) out.to = capRecipients(edits.to);
  if (edits.cc !== undefined) out.cc = capRecipients(edits.cc);
  if (edits.subject !== undefined) out.subject = edits.subject.slice(0, MAX_FACT_CHARS);
  if (edits.body !== undefined) out.body = edits.body.slice(0, MAX_FACT_CHARS);
  return out;
}

/**
 * The newest 30 drafts anyone owns, plus your own newest.
 *
 * The global window alone is a trap: the cockpit filters this to the viewer,
 * so once 30 other people's drafts land after yours, your own *pending* one
 * falls out of the only UI that can approve or reject it — permanently.
 * Signed-out callers just get the global window. `questions.list` does the
 * same, inlined rather than shared: one helper over both tables doesn't
 * survive Convex's generated index types.
 *
 * Other people's rows carry no draft, subject or recipient.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("actions").order("desc").take(30);
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const mine = await ctx.db
        .query("actions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
        .order("desc")
        .take(15);
      const seen = new Set(rows.map((r) => r._id));
      rows.push(...mine.filter((m) => !seen.has(m._id)));
      rows.sort((a, b) => b._creationTime - a._creationTime);
    }
    return await Promise.all(
      rows.map(async (a) => {
        const handle = (await ownerView(ctx, a.ownerId)).handle;
        // Private drafts, shared brain: the owner gets the draft, everyone
        // else only that one exists.
        if (a.ownerId === userId) return { ...a, handle };
        return { _id: a._id, _creationTime: a._creationTime, kind: a.kind, status: a.status, ownerId: a.ownerId, handle };
      }),
    );
  },
});

/**
 * SENDS_PER_DAY, counted from drafts decided today that went through a
 * connected account. Same overflow rule as `dispatch`: a day that doesn't
 * fit the read window is refused rather than miscounted.
 *
 * `excludeActionId` is the row being retried: it already carries today's
 * `decidedAt`/`connector` from its first attempt, so counting it here would
 * charge the same send twice.
 */
async function assertCanSend(ctx: MutationCtx, ownerId: Id<"users">, excludeActionId?: Id<"actions">) {
  const rows = await ctx.db
    .query("actions")
    .withIndex("by_ownerId_and_decidedAt", (q) => q.eq("ownerId", ownerId).gte("decidedAt", dayStart(Date.now())))
    .take(DAY_WINDOW + 1);
  const today = rows.filter((a) => a._id !== excludeActionId);
  if (today.length > DAY_WINDOW) throw new ConvexError(tooManySends);
  const blocked = sendBlocked(today.filter((a) => a.connector).length);
  if (blocked) throw new ConvexError(blocked);
}

/**
 * Approve (optionally edited) or reject. An edit becomes a preference fact and
 * a rejection becomes a correction fact, which the next intern recalls. That
 * is the learning loop.
 *
 * Sandbox unless this kind of draft has a connector the deployment is set up
 * for. Then: no connected account → `{ needsConnect }` and the draft waits
 * with its edits saved; a connected account → `sending`, and `send.go` takes it.
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
  handler: async (ctx, a): Promise<null | { needsConnect: ConnectorKey }> => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can decide on its draft.");
    }
    if (action.status !== "pending") throw new ConvexError("Already decided.");
    const now = Date.now();
    const log = (level: "ok" | "warn", text: string) =>
      ctx.db.insert("logs", { internId: action.internId, level, text });

    const connector = connectorFor(action.kind);
    const live = connector && isConfigured(connector, process.env) ? connector : null;
    const connection = live ? await activeConnection(ctx, user._id, live.key) : null;
    // A draft that can reach a real person may name one, so what's learned
    // from it stays with its owner. A sandbox draft only ever had placeholders.
    const visibility = connection ? ("owner" as const) : undefined;

    if (a.decision === "reject") {
      const reason = (a.reason ?? "").trim().slice(0, 500) || "no reason given";
      await ctx.db.patch("actions", action._id, { status: "rejected", decision: "rejected", reason, decidedAt: now });
      const c = correctionFromReject(action.kind, action.draft, reason);
      await insertFact(ctx, { ...c, kind: "correction", visibility, ownerId: user._id, internId: action.internId });
      await log("warn", visibility ? "rejected · learned a correction, private to you" : `rejected · learned: ${c.title}`);
      return null;
    }

    // No edits this time means: keep the ones saved while the person went to
    // connect their account.
    const accepted = a.edits ? { ...action.draft, ...capEdits(a.edits) } : (action.accepted ?? action.draft);
    const fields = changedFields(action.draft, accepted);
    // `fields` is recomputed from `action.draft` every call: if edits saved
    // on an earlier `needsConnect` round are then approved with edits that
    // restore the original, `fields` comes back empty here and any earlier
    // `accepted`/`editedFields` must be cleared — left alone, `send.go` would
    // still read the stale edit off the row.
    const acceptedPatch = fields.length ? { accepted, editedFields: fields } : { accepted: undefined, editedFields: undefined };

    if (live && !connection) {
      // Approving is the intent; sending waits for the account.
      await ctx.db.patch("actions", action._id, acceptedPatch);
      return { needsConnect: live.key };
    }
    if (live) await assertCanSend(ctx, user._id);

    await ctx.db.patch("actions", action._id, {
      status: live ? "sending" : "approved",
      decision: fields.length ? "edited" : "approved_unedited",
      editRatio: editRatio(action.draft, accepted),
      decidedAt: now,
      ...(live ? { connector: live.key } : {}),
      ...acceptedPatch,
    });
    if (fields.length) {
      const c = correctionFromEdit(action.kind, action.draft, accepted, fields);
      await insertFact(ctx, { ...c, kind: "preference", visibility, ownerId: user._id, internId: action.internId });
      await log("ok", visibility ? "learned a preference from your edit, private to you" : `learned: ${c.title}`);
    }
    if (live) {
      await ctx.scheduler.runAfter(0, internal.send.go, { actionId: action._id });
      await log("ok", `Approved. Sending from your ${live.label}…`);
    } else {
      await log("ok", "Approved. Sandbox: nothing was sent.");
    }
    return null;
  },
});

/** A failed send, tried again as it was approved. Costs a send like any other. */
export const resend = mutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can send its draft.");
    }
    // `unsure` never lands here: it isn't `failed`, so a plain retry can't
    // double-send a message Composio already may have delivered.
    if (action.status !== "failed" || !action.connector) throw new ConvexError("Only a failed send can be retried.");
    const c = connectorByKey(action.connector);
    if (!isConfigured(c, process.env) || !(await activeConnection(ctx, user._id, c.key))) {
      throw new ConvexError(`Connect ${c.label} first.`);
    }
    await assertCanSend(ctx, user._id, actionId);
    await ctx.db.patch("actions", actionId, { status: "sending", sendError: undefined, decidedAt: Date.now() });
    await ctx.db.insert("logs", { internId: action.internId, level: "ok", text: `Retrying from your ${c.label}…` });
    await ctx.scheduler.runAfter(0, internal.send.go, { actionId });
    return null;
  },
});

/**
 * The owner's word, after checking their Sent folder, that an `unsure` send
 * never went out: clears it to an ordinary `failed`, which `resend` will
 * take. There is no automatic path from `unsure` to `failed` — only the
 * person who might have gotten a duplicate can say it's safe.
 */
export const confirmUnsent = mutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can confirm this.");
    }
    if (action.status !== "unsure") throw new ConvexError("Only an uncertain send can be confirmed unsent.");
    await ctx.db.patch("actions", actionId, { status: "failed" });
    return null;
  },
});
