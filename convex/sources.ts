import { ConvexError, v } from "convex/values";
import { passageFact, parseCitations } from "../lib/ingest.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation } from "./_generated/server";
import { requireMember, slackMember, visibleTo } from "./access";
import { factCapBlocked, insertFact } from "./facts";

/**
 * Sources and their passages: the archive interns recall from. Passages are
 * never drawn. People decide what becomes a fact — a 🧠 in the community
 * Slack, the promote button — and so does an approved draft that cited one.
 */

/** A member's source holds at most 220 passages (200 chunks, or a README's 20 plus 200 issues). */
export const PASSAGE_BATCH = 250;

const hasFact = async (ctx: MutationCtx, p: Doc<"passages">) => !!p.promotedFactId && !!(await ctx.db.get("facts", p.promotedFactId));

/**
 * The fact a passage becomes, once. `source` is the capture key a member's
 * own 🧠 through Composio files under (`slack:<channel>:<ts>`, see
 * inbound.ts): if that member already has that fact, the passage adopts it
 * instead of filing a twin, and Composio's later delivery reads as a duplicate.
 */
export async function promotePassage(
  ctx: MutationCtx,
  p: Doc<"passages">,
  by: { ownerId?: Id<"users">; visibility: "public" | "owner"; source?: string },
): Promise<Id<"facts">> {
  if (p.promotedFactId && (await ctx.db.get("facts", p.promotedFactId))) return p.promotedFactId;
  const { ownerId, source } = by;
  const twin =
    ownerId && source
      ? await ctx.db
          .query("facts")
          .withIndex("by_ownerId_and_source", (q) => q.eq("ownerId", ownerId).eq("source", source))
          .first()
      : null;
  const factId =
    twin?._id ??
    (await insertFact(ctx, {
      ...passageFact(p.text),
      kind: "note",
      ownerId,
      visibility: by.visibility === "owner" ? "owner" : undefined,
      source,
      fromPassageId: p._id,
    }));
  await ctx.db.patch("passages", p._id, { promotedFactId: factId });
  return factId;
}

/**
 * An approved draft vouches for the passages it cited: each `[p:…]` the
 * approver can see becomes a fact, visible like the passage, or owner-only
 * when the draft's own lesson is. Ids come from the model, so each is looked
 * up, never trusted. Returns how many were promoted just now.
 */
export async function promoteCited(
  ctx: MutationCtx,
  sources: string[],
  ownerId: Id<"users">,
  actionVisibility: "owner" | undefined,
): Promise<number> {
  let promoted = 0;
  for (const raw of parseCitations(sources)) {
    const id = ctx.db.normalizeId("passages", raw);
    const p = id ? await ctx.db.get("passages", id) : null;
    if (!p || !visibleTo(p, ownerId) || (await hasFact(ctx, p))) continue;
    await promotePassage(ctx, p, { ownerId, visibility: actionVisibility ?? p.visibility });
    promoted++;
  }
  return promoted;
}

/** A promoted fact still says exactly what promotion made from this passage text. */
export const factMatches = (f: Doc<"facts">, passageText: string) => {
  const made = passageFact(passageText);
  return f.title === made.title && f.body === made.body;
};

/**
 * A passage's new text. An unchanged promoted fact follows it, so deleting
 * the message later still finds it unchanged; a fact that isn't (a member's
 * own capture) is left alone.
 */
export async function rewritePassage(
  ctx: MutationCtx,
  p: Doc<"passages">,
  text: string,
  patch: Partial<Pick<Doc<"passages">, "author" | "authorHandle" | "url" | "at">> = {},
): Promise<void> {
  if (p.text !== text && p.promotedFactId) {
    const f = await ctx.db.get("facts", p.promotedFactId);
    if (f && factMatches(f, p.text)) {
      const made = passageFact(text);
      await ctx.db.patch("facts", f._id, { ...made, text: `${made.title}\n${made.body}` });
    }
  }
  await ctx.db.patch("passages", p._id, { ...patch, text });
}

/** Deletes up to PASSAGE_BATCH of a source's passages; true once none are left. Promoted facts stay. */
export async function clearPassages(ctx: MutationCtx, sourceId: Id<"sources">): Promise<boolean> {
  const rows = await ctx.db
    .query("passages")
    .withIndex("by_sourceId_and_at", (q) => q.eq("sourceId", sourceId))
    .take(PASSAGE_BATCH);
  for (const r of rows) await ctx.db.delete("passages", r._id);
  return rows.length < PASSAGE_BATCH;
}

/** The promote button. The caller must be able to see the passage; the 20 facts/day cap applies here and only here. */
export const promote = mutation({
  args: { passageId: v.id("passages") },
  handler: async (ctx, { passageId }): Promise<Id<"facts">> => {
    const user = await requireMember(ctx);
    const p = await ctx.db.get("passages", passageId);
    if (!p || !visibleTo(p, user._id)) throw new ConvexError("That passage isn't there any more.");
    if (p.promotedFactId && (await ctx.db.get("facts", p.promotedFactId))) return p.promotedFactId;
    const blocked = await factCapBlocked(ctx, user._id);
    if (blocked) throw new ConvexError(blocked);
    return await promotePassage(ctx, p, { ownerId: user._id, visibility: p.visibility });
  },
});

/**
 * Deletes a source's passages and file; facts already promoted from it stay.
 * The row stays too (`removed`), so it still counts toward today's five.
 * ponytail: one batch clears it; see PASSAGE_BATCH.
 */
export const remove = mutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const user = await requireMember(ctx);
    const s = await ctx.db.get("sources", sourceId);
    if (!s || s.ownerId !== user._id || s.status === "removed") {
      throw new ConvexError("Only whoever added a source can remove it.");
    }
    await clearPassages(ctx, sourceId);
    if (s.storageId) await ctx.storage.delete(s.storageId);
    await ctx.db.patch("sources", sourceId, { status: "removed", storageId: undefined, cursor: undefined });
    return null;
  },
});

export const passageInput = v.object({
  externalId: v.string(),
  text: v.string(),
  author: v.optional(v.string()),
  /** A Slack author's user id, resolved here to a linked member's @handle. Not stored. */
  slackUser: v.optional(v.string()),
  url: v.optional(v.string()),
  at: v.number(),
});

/**
 * The one way passages get in. Upserts by `(sourceId, externalId)`, so a
 * redelivered event or a re-run sync never duplicates one, and writes nothing
 * to a source that was removed (or purged) meanwhile. A passage takes its
 * source's visibility and owner. `label`/`cursor` update the source;
 * `synced` marks a read finished.
 */
export const write = internalMutation({
  args: {
    sourceId: v.id("sources"),
    passages: v.array(passageInput),
    label: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    synced: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const s = await ctx.db.get("sources", a.sourceId);
    if (!s || s.status === "removed") return null;
    const handles = new Map<string, string | undefined>();
    for (const { slackUser, ...row } of a.passages) {
      if (slackUser && !handles.has(slackUser)) handles.set(slackUser, (await slackMember(ctx, slackUser))?.handle);
      const authorHandle = slackUser ? handles.get(slackUser) : undefined;
      const existing = await ctx.db
        .query("passages")
        .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", s._id).eq("externalId", row.externalId))
        .unique();
      if (existing) await rewritePassage(ctx, existing, row.text, { author: row.author, authorHandle, url: row.url, at: row.at });
      else await ctx.db.insert("passages", { ...row, authorHandle, sourceId: s._id, visibility: s.visibility, ownerId: s.ownerId });
    }
    await ctx.db.patch("sources", s._id, {
      ...(a.label ? { label: a.label.slice(0, 120) } : {}),
      ...(a.cursor !== undefined ? { cursor: a.cursor ?? undefined } : {}),
      ...(a.synced ? { lastSyncedAt: Date.now(), status: "active" as const, error: undefined } : {}),
    });
    return null;
  },
});
