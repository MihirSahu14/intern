import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Archived } from "../lib/brief.ts";
import { DAY_WINDOW, MAX_FACT_CHARS, dayStart, teachBlocked, tooManyFacts } from "../lib/caps.ts";
import { PASSAGES_RECALLED } from "../lib/ingest.ts";
import { redactEmails } from "../lib/redact.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, internalQuery, mutation, query } from "./_generated/server";
import { capExempt, requireMember, visibleTo } from "./access";
import { broadcast } from "./broadcast";
import { factKind } from "./schema";

type FactKind = Doc<"facts">["kind"];

export async function insertFact(
  ctx: MutationCtx,
  f: {
    title: string;
    body: string;
    kind: FactKind;
    ownerId?: Id<"users">;
    internId?: Id<"interns">;
    visibility?: Doc<"facts">["visibility"];
    /**
     * Where it came from, e.g. `slack:C1:1726900000.000100`: one fact per
     * source per owner. `send:<actionId>` marks a send's write-back.
     */
    source?: string;
    /** The archive passage it was promoted from. */
    fromPassageId?: Id<"passages">;
  },
) {
  return await ctx.db.insert("facts", { ...f, text: `${f.title}\n${f.body}` });
}

/** Marks the fact a successful send writes back: the brain noting it, not the person teaching it. */
export const sendSource = (actionId: Id<"actions">) => `send:${actionId}`;

/** The 20-facts/day rule for anything a person adds, from the cockpit or from their own tools. */
export async function factCapBlocked(ctx: QueryCtx, ownerId: Id<"users">): Promise<string | null> {
  const today = await ctx.db
    .query("facts")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId).gte("_creationTime", dayStart(Date.now())))
    .take(DAY_WINDOW + 1);
  // Same guard as `dispatch`: run-filed facts, corrections and answers share
  // this window without counting, so an overflowed day can't be counted at
  // all — refuse rather than read the first fifty and call it twenty.
  // Write-backs still fill the window above, so the overflow guard stays
  // honest; they just aren't teaching, so they don't use up the twenty.
  if (today.length > DAY_WINDOW) return tooManyFacts;
  return teachBlocked(today.filter((f) => !f.source?.startsWith("send:")).length, await capExempt(ctx, ownerId));
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
    const blocked = await factCapBlocked(ctx, user._id);
    if (blocked) throw new ConvexError(blocked);
    const id = await insertFact(ctx, { title, body, kind: args.kind, ownerId: user._id });
    await broadcast(ctx, { type: "taught", handle: user.handle ?? user.name ?? "someone", title });
    return id;
  },
});

/** Convex search takes at most 16 terms. */
const searchTerms = (task: string) => task.split(/\s+/).filter(Boolean).slice(0, 16).join(" ");

/**
 * What an intern reads before it starts: the newest house-style lessons
 * (preferences and corrections, the learning loop), then the best full-text
 * matches for the task. Public facts plus the intern owner's own private ones.
 *
 * ponytail: over-read, then filter. Other people's private facts take slots
 * in these windows; index by visibility if recall starts coming back thin.
 */
export const recall = internalQuery({
  args: { task: v.string(), ownerId: v.id("users") },
  handler: async (ctx, { task, ownerId }) => {
    const usable = (rows: Doc<"facts">[], n: number) => rows.filter((f) => visibleTo(f, ownerId)).slice(0, n);
    const lessons = [
      ...usable(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "preference")).order("desc").take(12), 3),
      ...usable(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "correction")).order("desc").take(12), 3),
    ];
    const terms = searchTerms(task);
    const hits = terms
      ? usable(await ctx.db.query("facts").withSearchIndex("search_text", (q) => q.search("text", terms)).take(15), 5)
      : [];

    const seen = new Set<string>();
    // `visibility` rides along so the caller can tell whether this run touched
    // anything private, without a second query — see `interns.noteRecall`.
    const out: { id: Id<"facts">; title: string; body: string; kind: FactKind; visibility: Doc<"facts">["visibility"] }[] = [];
    for (const f of [...lessons, ...hits]) {
      if (seen.has(f._id)) continue;
      seen.add(f._id);
      out.push({ id: f._id, title: f.title, body: f.body.slice(0, 400), kind: f.kind, visibility: f.visibility });
    }
    return out;
  },
});

/**
 * Up to PASSAGES_RECALLED archive passages for a task: the best public
 * matches and the owner's own private ones, interleaved so neither crowds the
 * other out. Never another member's private passage. Full-text now; this is
 * the one function to swap for embeddings later.
 *
 * ponytail: over-reads twelve per search, so a stray passage of a removed
 * source can't thin the six.
 */
export const archive = internalQuery({
  args: { task: v.string(), ownerId: v.id("users") },
  handler: async (ctx, { task, ownerId }) => {
    const terms = searchTerms(task);
    if (!terms) return [];
    const window = PASSAGES_RECALLED * 2;
    const [pub, own] = await Promise.all([
      ctx.db
        .query("passages")
        .withSearchIndex("search_text", (q) => q.search("text", terms).eq("visibility", "public"))
        .take(window),
      ctx.db
        .query("passages")
        .withSearchIndex("search_text", (q) => q.search("text", terms).eq("visibility", "owner").eq("ownerId", ownerId))
        .take(window),
    ]);
    const merged: Doc<"passages">[] = [];
    for (let i = 0; i < window; i++) for (const p of [own[i], pub[i]]) if (p) merged.push(p);

    const out: (Archived & { visibility: Doc<"passages">["visibility"] })[] = [];
    const seen = new Set<string>();
    for (const p of merged) {
      if (out.length >= PASSAGES_RECALLED) break;
      if (seen.has(p._id) || !visibleTo(p, ownerId)) continue;
      seen.add(p._id);
      const s = await ctx.db.get("sources", p.sourceId);
      if (!s || s.status === "removed") continue;
      out.push({
        id: p._id,
        label: s.label,
        author: p.authorHandle ? `@${p.authorHandle}` : (p.author ?? null),
        at: p.at,
        text: p.text,
        visibility: p.visibility,
      });
    }
    return out;
  },
});

/**
 * The shared graph, shaped for BrainGraph. Public, minus what is private:
 * other people's owner-only facts are left out, and other people's drafts
 * show only that they exist. Only GitHub handle and avatar are shown for
 * people.
 *
 * ponytail: newest 400 facts / 60 interns / 60 drafts. Paginate if the
 * community outgrows one screen.
 */
export const graph = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const facts = (await ctx.db.query("facts").order("desc").take(400)).filter((f) => visibleTo(f, viewer));
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
        nodes.set(key, { id: key, label: redactEmails(`@${handle}`), kind: "contact", weight: 5, meta: { image: u?.image ?? null } });
      }
      return key;
    };

    // A question resumes as a fresh intern; on the graph the whole chain is
    // one node — the original ask, showing the newest run's status — so a
    // back-and-forth doesn't sprout a node per answer.
    const byId = new Map(interns.map((i) => [i._id as string, i]));
    const rootOf = (id: string) => {
      let r = byId.get(id);
      while (r?.resumes && byId.has(r.resumes)) r = byId.get(r.resumes);
      return r?._id;
    };
    // `interns` is newest first, so the first run seen for a root is the
    // chain's newest — that's the status (and cancelled-or-not) that decides
    // the node, even if an older run further back in the chain was cancelled.
    const seenRoots = new Set<string>();
    for (const i of interns) {
      const rootId = rootOf(i._id)!;
      if (seenRoots.has(rootId)) continue;
      seenRoots.add(rootId);
      // A cancelled chain is left off the map; its facts and drafts, if any,
      // attach to nothing and show up unlinked, same as any missing parent.
      if (i.status === "cancelled") continue;
      const root = byId.get(rootId)!;
      // The root's `task` is the member's own words; `displayTask` covers a
      // root whose parent fell outside the window — same rule as `interns.list`.
      // The graph is a public map even for its owner — addresses belong in
      // the outbox — so every label is redacted, not just other people's.
      const task = redactEmails(root.displayTask ?? root.task);
      nodes.set(rootId, { id: rootId, label: task.slice(0, 56), kind: "intern", weight: 5, detail: i.status });
      edges.push({ source: await person(root.ownerId), target: rootId, rel: "briefed" });
    }
    for (const f of facts) {
      // Answers to an intern's questions stay in recall, not on the map.
      if (f.kind === "answer") continue;
      nodes.set(f._id, { id: f._id, label: redactEmails(f.title).slice(0, 56), kind: "fact", weight: 3, detail: f.kind, meta: { kind: f.kind } });
      const filer = f.internId && rootOf(f.internId);
      if (filer) edges.push({ source: filer, target: f._id, rel: "filed" });
      else if (f.ownerId) edges.push({ source: await person(f.ownerId), target: f._id, rel: "taught" });
      else {
        nodes.set("src:seed", { id: "src:seed", label: "starter facts", kind: "source", weight: 6 });
        edges.push({ source: "src:seed", target: f._id, rel: "seeded" });
      }
    }
    for (const a of actions) {
      const label =
        a.ownerId === viewer ? `✉ ${a.draft.subject || a.title}` : a.status === "sent" ? "✉ sent" : "✉ a draft";
      nodes.set(a._id, { id: a._id, label: redactEmails(label).slice(0, 56), kind: "action", weight: 4, detail: a.status });
      const drafter = rootOf(a.internId);
      if (drafter) edges.push({ source: drafter, target: a._id, rel: "drafted" });
    }

    return {
      nodes: [...nodes.values()],
      edges: edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)),
      generatedAt: facts[0]?._creationTime ?? 0,
    };
  },
});
