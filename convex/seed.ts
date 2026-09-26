import { internalMutation } from "./_generated/server";
import { insertFact } from "./facts";

/**
 * Run once per deployment: `npx convex run seed:run` (add --prod for prod).
 * Idempotent: skips if any ownerless fact exists.
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const any = await ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", undefined)).first();
    if (any) return { seeded: 0 };
    for (const f of SEED) await insertFact(ctx, { ...f, kind: "note" });
    return { seeded: SEED.length };
  },
});

/**
 * Run any time `SEED` changes after a deployment was already seeded:
 * `npx convex run seed:refresh` (add --prod for prod). Finds each ownerless
 * seed fact by title and patches `body`/`text` to the current `SEED` values
 * when they differ. Idempotent: a second run updates 0.
 */
export const refresh = internalMutation({
  args: {},
  handler: async (ctx) => {
    let updated = 0;
    for (const f of SEED) {
      const row = await ctx.db
        .query("facts")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", undefined))
        .filter((q) => q.eq(q.field("title"), f.title))
        .first();
      if (!row || row.body === f.body) continue;
      await ctx.db.patch(row._id, { body: f.body, text: `${f.title}\n${f.body}` });
      updated++;
    }
    return { updated };
  },
});

const SEED = [
  {
    title: "What Intern is",
    body: `We build Intern. Two halves that need each other.

The brain: one shared set of facts about how the community works — people, decisions, conventions, what was sent — drawn as a live graph. Everyone who signs in with GitHub reads the same brain and adds to it: by teaching a fact directly, or through what their interns file back. It also reads the community Slack's public channels, documents members add and public GitHub repos into a searchable archive interns recall from; a person promotes a passage into a fact.

The interns: agents anyone signed in can brief in one sentence of text. An intern reads the brain first — the facts that bear on the task, including past corrections — then drafts. Where a detail is missing it writes a [placeholder] for the person to fill in rather than guessing or stalling. A draft goes out through the requester's own connected Gmail or Slack, so it can only ever reach what that person could reach.

Anything that goes out stops and waits for a person, with the draft, the reasoning and the facts it used. Interns cannot send on their own. What the person changes before approving is saved as a fact the next intern reads first, which is the entire learning loop: no rule was written and there is no training job.

Interns are the write path to the brain. The graph is the read path.

What it is not: not a chatbot — the surface is a live graph and a work stream, not a message thread. Not Zapier — those need the workflow specified correctly up front, which is exactly the thing nobody has done. Not a personal assistant — a per-person brain would just be Obsidian; the claim is one brain the whole company contributes to, so hire one intern and every intern after it starts smarter.

Source: IDEA.md and docs/HLD.md in this repo.`,
  },
  {
    title: "Who Intern is for",
    body: `Companies where how the place actually works lives in a few people's heads, and where onboarding, outreach and recurring admin are done by hand each time.

The product only makes sense above one person. On a single connected account it looks identical to a personal tool — that is a known problem, recorded in IDEA.md as one of the three still-undecided items, and the reason the demo needs two people on one brain. A per-person brain would just be Obsidian.

They already run Slack and Google Workspace, because those are the connectors that exist. The brain is only as good as what it can read.

NOT YET DECIDED, and not to be stated as if it were: the headcount band, the buying role, the price. Billing, multi-org tenancy, an intern marketplace and mobile are all explicitly out of scope for now (docs/HLD.md, section 1), so there is no priced offer to sell yet. If a task needs a specific customer profile, ask — do not fill this in.`,
  },
  {
    title: "What makes a prospect viable",
    body: `Viable when all three hold:

1. More than one person contributes to the same context. The shared brain is the whole claim; one seat is indistinguishable from a personal note-taking tool.
2. Their work already lives in tools a connector can read — today that means Slack and Google Workspace. A brain with nothing feeding it has nothing to cite.
3. Someone is willing to sit at the approval gate. Interns never send; an intern that cannot hand over cannot do anything consequential, so a company that wants fully unattended automation is a bad fit until it has trust to graduate.

Not viable when: the context genuinely lives with one person; the work happens somewhere nothing can read it; or nobody will review outbound drafts.

The open risk that decides whether any of this works, per IDEA.md: entity resolution. The same human is a Slack handle, a Workspace address and an HR record, and if the brain cannot tell they are one person the graph silently fragments. Graph legibility past a few hundred facts is the second.

NOT YET DECIDED: any numeric qualification bar (headcount, spend, seat count). Ask rather than invent one.`,
  },
];
