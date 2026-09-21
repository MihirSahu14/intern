import { ConvexError, v } from "convex/values";
import { MAX_FACT_CHARS, dayStart, teachBlocked } from "../lib/caps.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalQuery, mutation, query } from "./_generated/server";
import { requireMember } from "./access";
import { factKind } from "./schema";

type FactKind = Doc<"facts">["kind"];

export async function insertFact(
  ctx: MutationCtx,
  f: { title: string; body: string; kind: FactKind; ownerId?: Id<"users">; internId?: Id<"interns"> },
) {
  return await ctx.db.insert("facts", { ...f, text: `${f.title}\n${f.body}` });
}

export const teach = mutation({
  args: { title: v.string(), body: v.string(), kind: factKind },
  handler: async (ctx, args) => {
    const user = await requireMember(ctx);
    const title = args.title.trim().slice(0, 200);
    const body = args.body.trim();
    if (!title) throw new ConvexError("Say what you know first.");
    if (title.length + body.length > MAX_FACT_CHARS) {
      throw new ConvexError(`Keep a fact under ${MAX_FACT_CHARS} characters.`);
    }
    const today = await ctx.db
      .query("facts")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", user._id).gte("_creationTime", dayStart(Date.now())))
      .take(50);
    const blocked = teachBlocked(today.length);
    if (blocked) throw new ConvexError(blocked);
    return await insertFact(ctx, { title, body, kind: args.kind, ownerId: user._id });
  },
});

/**
 * What an intern reads before it starts: the newest house-style lessons
 * (preferences and corrections, the learning loop), then the best full-text
 * matches for the task.
 */
export const recall = internalQuery({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    const lessons = [
      ...(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "preference")).order("desc").take(3)),
      ...(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "correction")).order("desc").take(3)),
    ];
    // Convex search takes at most 16 terms.
    const terms = task.split(/\s+/).filter(Boolean).slice(0, 16).join(" ");
    const hits = terms
      ? await ctx.db.query("facts").withSearchIndex("search_text", (q) => q.search("text", terms)).take(5)
      : [];

    const seen = new Set<string>();
    const out: { id: Id<"facts">; title: string; body: string; kind: FactKind }[] = [];
    for (const f of [...lessons, ...hits]) {
      if (seen.has(f._id)) continue;
      seen.add(f._id);
      out.push({ id: f._id, title: f.title, body: f.body.slice(0, 400), kind: f.kind });
    }
    return out;
  },
});

/**
 * The shared graph, shaped for BrainGraph. Public: the whole brain is public
 * by design. Only GitHub handle and avatar are shown for people.
 *
 * ponytail: newest 400 facts / 60 interns / 60 drafts. Paginate if the
 * community outgrows one screen.
 */
export const graph = query({
  args: {},
  handler: async (ctx) => {
    const facts = await ctx.db.query("facts").order("desc").take(400);
    const interns = await ctx.db.query("interns").order("desc").take(60);
    const actions = await ctx.db.query("actions").order("desc").take(60);

    type Node = { id: string; label: string; kind: "fact" | "intern" | "action" | "contact" | "source"; weight: number; detail?: string; meta?: Record<string, string | number | null> };
    const nodes = new Map<string, Node>();
    const edges: { source: string; target: string; rel: string }[] = [];

    const person = async (id: Id<"users">) => {
      const key = `user:${id}`;
      if (!nodes.has(key)) {
        const u = await ctx.db.get("users", id);
        const handle = u?.handle ?? u?.name ?? "someone";
        nodes.set(key, { id: key, label: `@${handle}`, kind: "contact", weight: 5, meta: { image: u?.image ?? null } });
      }
      return key;
    };

    for (const i of interns) {
      nodes.set(i._id, { id: i._id, label: i.task.slice(0, 56), kind: "intern", weight: 5, detail: i.status });
      edges.push({ source: await person(i.ownerId), target: i._id, rel: "briefed" });
    }
    for (const f of facts) {
      nodes.set(f._id, { id: f._id, label: f.title.slice(0, 56), kind: "fact", weight: 3, detail: f.kind, meta: { kind: f.kind } });
      if (f.internId && nodes.has(f.internId)) edges.push({ source: f.internId, target: f._id, rel: "filed" });
      else if (f.ownerId) edges.push({ source: await person(f.ownerId), target: f._id, rel: "taught" });
      else {
        nodes.set("src:seed", { id: "src:seed", label: "seed", kind: "source", weight: 6 });
        edges.push({ source: "src:seed", target: f._id, rel: "seeded" });
      }
    }
    for (const a of actions) {
      nodes.set(a._id, { id: a._id, label: `✉ ${a.draft.subject || a.title}`.slice(0, 56), kind: "action", weight: 4, detail: a.status });
      if (nodes.has(a.internId)) edges.push({ source: a.internId, target: a._id, rel: "drafted" });
    }

    return {
      nodes: [...nodes.values()],
      edges: edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)),
      generatedAt: facts[0]?._creationTime ?? 0,
    };
  },
});
