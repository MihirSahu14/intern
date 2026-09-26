import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { stripLinks } from "../lib/broadcast.ts";
import { redactEmails, safeUrl } from "../lib/redact.ts";
import { query } from "./_generated/server";
import { ownerView, visibleTo } from "./access";

/** Newest 30 things anyone did, for the right rail. Public information only. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const [interns, facts, approved, sent, sources] = await Promise.all([
      ctx.db.query("interns").order("desc").take(30),
      ctx.db.query("facts").order("desc").take(30),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(15),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "sent")).order("desc").take(15),
      ctx.db.query("sources").order("desc").take(15),
    ]);
    const events: { at: number; ownerId: (typeof interns)[number]["ownerId"]; text: string }[] = [
      // A question-resumed `task` quotes the answer; `displayTask` (the
      // original ask) is what the feed shows instead — same rule as
      // `interns.list` / `facts.graph`.
      ...interns.map((i) => ({
        at: i._creationTime,
        ownerId: i.ownerId,
        text: `briefed an intern: ${redactEmails(i.displayTask ?? i.task).slice(0, 80)}`,
      })),
      ...facts
        .filter((f) => visibleTo(f, viewer))
        .flatMap((f) =>
          f.ownerId
            ? [{
                at: f._creationTime,
                ownerId: f.ownerId,
                text:
                  f.kind === "preference" || f.kind === "correction"
                    ? `corrected a draft → ${f.title.slice(0, 60)}`
                    : f.internId
                      ? `'s intern filed: ${f.title.slice(0, 60)}`
                      : `taught: ${f.title.slice(0, 60)}`,
              }]
            : [],
        ),
      // A member's public source, once it has been read: the line the broadcast posts.
      ...sources.flatMap((s) =>
        s.ownerId && s.visibility === "public" && s.status !== "removed" && s.lastSyncedAt
          ? [{ at: s.lastSyncedAt, ownerId: s.ownerId, text: `added a source: ${redactEmails(stripLinks(s.label))}` }]
          : [],
      ),
      ...[...approved, ...sent].map((a) => ({
        at: a.sentAt ?? a.decidedAt ?? a._creationTime,
        ownerId: a.ownerId,
        text: a.status === "sent" ? "✉ sent" : "approved ✉ a draft",
      })),
    ];
    events.sort((a, b) => b.at - a.at);
    return await Promise.all(
      events.slice(0, 30).map(async (e) => ({ at: e.at, text: e.text, ...(await ownerView(ctx, e.ownerId)) })),
    );
  },
});

/**
 * Landing-page counts. ponytail: bounded scans capped at 1,000 (the UI shows
 * "1000+"); swap for @convex-dev/aggregate if it ever says that.
 */
export const landing = query({
  args: {},
  handler: async (ctx) => {
    const cap = 1000;
    const [users, facts, approved, sent] = await Promise.all([
      ctx.db.query("users").take(cap),
      ctx.db.query("facts").take(cap),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).take(cap),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "sent")).take(cap),
    ]);
    return {
      people: users.filter((u) => u.acceptedAt).length,
      facts: facts.length,
      approved: approved.length + sent.length,
      cap,
    };
  },
});

/**
 * The three numbers on /stats. ponytail: last 1,000 runs and drafts.
 * "Edit rate" = share of decided drafts that were edited or rejected.
 */
export const evals = query({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db.query("interns").order("desc").take(1000);
    const drafts = (await ctx.db.query("actions").order("desc").take(1000)).filter((a) => a.decision);

    const withBlock = runs.filter((r) => r.parseOutcome?.startsWith("action"));
    const parsed = withBlock.filter((r) => r.parseOutcome === "action").length;

    const rate = (xs: typeof drafts) =>
      xs.length ? xs.filter((d) => d.decision !== "approved_unedited").length / xs.length : null;
    const recalled = drafts.filter((d) => d.recalledCorrection);
    const cold = drafts.filter((d) => !d.recalledCorrection);

    return {
      runs: runs.length,
      parseRate: withBlock.length ? parsed / withBlock.length : null,
      actionBlocks: withBlock.length,
      uneditedRate: drafts.length ? drafts.filter((d) => d.decision === "approved_unedited").length / drafts.length : null,
      decided: drafts.length,
      editRateWithCorrection: rate(recalled),
      withCorrection: recalled.length,
      editRateWithout: rate(cold),
      without: cold.length,
    };
  },
});

/**
 * One member's public page: what they taught the brain and what their
 * interns did. No private facts, drafts or recipients — this is what any
 * signed-out visitor sees, so it never scopes by viewer. Unknown, unconsented
 * or banned handles are null, and the page says so. Sources: public, not
 * removed; a private document never shows.
 *
 * ponytail: newest 200 facts filtered to 50 public ones; last 1,000 actions
 * for the counts. Aggregate if anyone outgrows that.
 */
export const member = query({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const u = await ctx.db.query("users").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
    if (!u || !u.acceptedAt || u.bannedAt) return null;
    const joinedAt = u.acceptedAt;
    const [facts, interns, actions, sources] = await Promise.all([
      ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).order("desc").take(200),
      ctx.db.query("interns").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).order("desc").take(50),
      ctx.db.query("actions").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).take(1000),
      ctx.db.query("sources").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).order("desc").take(50),
    ]);
    return {
      handle: u.handle ?? handle,
      image: u.image ?? null,
      joinedAt,
      facts: facts
        .filter((f) => f.visibility !== "owner")
        .slice(0, 50)
        .map((f) => ({ _id: f._id, title: f.title, kind: f.kind, at: f._creationTime })),
      // A question-resumed `task` quotes its answer and can carry private
      // facts, so it's swapped for `displayTask` before redaction — same rule
      // as `interns.list` / `facts.graph`.
      interns: interns.map((i) => ({ _id: i._id, task: redactEmails(i.displayTask ?? i.task), status: i.status, at: i._creationTime })),
      approved: actions.filter((a) => a.decision === "approved_unedited" || a.decision === "edited").length,
      sent: actions.filter((a) => a.status === "sent").length,
      sources: sources
        .filter((s) => s.visibility === "public" && s.status !== "removed")
        .map((s) => ({ _id: s._id, label: redactEmails(s.label), kind: s.kind, url: safeUrl(s.url), at: s._creationTime })),
    };
  },
});
