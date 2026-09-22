import { getAuthUserId } from "@convex-dev/auth/server";
import { redactEmails } from "../lib/redact.ts";
import { query } from "./_generated/server";
import { ownerView, visibleTo } from "./access";

/** Newest 30 things anyone did, for the right rail. Public information only. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const [interns, facts, approved, sent] = await Promise.all([
      ctx.db.query("interns").order("desc").take(30),
      ctx.db.query("facts").order("desc").take(30),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(15),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "sent")).order("desc").take(15),
    ]);
    const events: { at: number; ownerId: (typeof interns)[number]["ownerId"]; text: string }[] = [
      ...interns.map((i) => ({ at: i._creationTime, ownerId: i.ownerId, text: `briefed an intern: ${redactEmails(i.task).slice(0, 80)}` })),
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
