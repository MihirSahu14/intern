import { query } from "./_generated/server";
import { ownerView } from "./access";

/** Newest 30 things anyone did, for the right rail. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const [interns, facts, actions] = await Promise.all([
      ctx.db.query("interns").order("desc").take(30),
      ctx.db.query("facts").order("desc").take(30),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(15),
    ]);
    const events: { at: number; ownerId: (typeof interns)[number]["ownerId"]; text: string }[] = [
      ...interns.map((i) => ({ at: i._creationTime, ownerId: i.ownerId, text: `briefed an intern: ${i.task.slice(0, 80)}` })),
      ...facts.flatMap((f) =>
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
      ...actions.map((a) => ({ at: a.decidedAt ?? a._creationTime, ownerId: a.ownerId, text: `approved a ${a.kind} draft` })),
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
    const [users, facts, approved] = await Promise.all([
      ctx.db.query("users").take(cap),
      ctx.db.query("facts").take(cap),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).take(cap),
    ]);
    return { people: users.filter((u) => u.acceptedAt).length, facts: facts.length, approved: approved.length, cap };
  },
});
