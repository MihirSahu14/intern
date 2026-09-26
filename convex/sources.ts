import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { SOURCES_PER_DAY, dayStart, sourceBlocked } from "../lib/caps.ts";
import { type RepoPath, repoPath } from "../lib/github.ts";
import { PASSAGE_EXCERPT, UPLOAD_MAX_BYTES, passageFact, parseCitations, urlProblem } from "../lib/ingest.ts";
import { redactEmails, safeUrl } from "../lib/redact.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { capExempt, ownerView, requireMember, slackMember, visibleTo } from "./access";
import { broadcast } from "./broadcast";
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
 *
 * A tombstoned key (see `slack.forget`) is never written, insert or rewrite,
 * whatever `insertOnly` is: a backfill page fetched before a delete lands can
 * still be written after it, and a retried delivery can't resurrect one.
 *
 * `insertOnly` (the Slack event path): an existing `(sourceId, externalId)`
 * is otherwise left exactly as it is — Slack's own edit/delete events are the
 * only way that changes.
 */
export const write = internalMutation({
  args: {
    sourceId: v.id("sources"),
    passages: v.array(passageInput),
    label: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    synced: v.optional(v.boolean()),
    insertOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const s = await ctx.db.get("sources", a.sourceId);
    if (!s || s.status === "removed") return null;
    const handles = new Map<string, string | undefined>();
    for (const { slackUser, ...row } of a.passages) {
      const gone = await ctx.db
        .query("slackTombstones")
        .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", s._id).eq("externalId", row.externalId))
        .unique();
      if (gone) continue;
      if (slackUser && !handles.has(slackUser)) handles.set(slackUser, (await slackMember(ctx, slackUser))?.handle);
      const authorHandle = slackUser ? handles.get(slackUser) : undefined;
      const existing = await ctx.db
        .query("passages")
        .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", s._id).eq("externalId", row.externalId))
        .unique();
      if (existing) {
        // A lookup that failed this time (Slack API down, no bot token) never
        // blanks an author already on file; it only ever fills one in.
        if (!a.insertOnly) {
          await rewritePassage(ctx, existing, row.text, {
            ...(row.author !== undefined ? { author: row.author } : {}),
            authorHandle,
            url: row.url,
            at: row.at,
          });
        }
        continue;
      }
      await ctx.db.insert("passages", { ...row, authorHandle, sourceId: s._id, visibility: s.visibility, ownerId: s.ownerId });
    }
    const patch: Partial<Pick<Doc<"sources">, "label" | "cursor" | "lastSyncedAt" | "status" | "error">> = {};
    if (a.label) patch.label = a.label.slice(0, 120);
    if (a.cursor !== undefined) patch.cursor = a.cursor ?? undefined;
    if (a.synced) {
      patch.lastSyncedAt = Date.now();
      patch.status = "active";
      patch.error = undefined;
    }
    // A member's public source is announced on its first read, under the
    // label it has by then (a page's title). Private ones never are.
    if (a.synced && !s.lastSyncedAt && s.ownerId && s.visibility === "public") {
      await broadcast(ctx, {
        type: "added_source",
        handle: (await ownerView(ctx, s.ownerId)).handle,
        label: redactEmails(a.label ?? s.label),
      });
    }
    // Skipped when there's nothing to patch: a busy channel's every message
    // would otherwise still write the source row, and contend over it.
    if (Object.keys(patch).length) await ctx.db.patch("sources", s._id, patch);
    return null;
  },
});

export const get = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => await ctx.db.get("sources", sourceId),
});

/** A read that failed, with a reason the member can act on. `clear` also drops its passages (a repo gone private). */
export const fail = internalMutation({
  args: { sourceId: v.id("sources"), error: v.string(), clear: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const s = await ctx.db.get("sources", a.sourceId);
    if (!s || s.status === "removed") return null;
    if (a.clear) await clearPassages(ctx, s._id);
    await ctx.db.patch("sources", s._id, { status: "failed", error: a.error.slice(0, 200) });
    return null;
  },
});

/** Every repo the daily refresh reads again: active or failed, never removed. ponytail: first 500. */
export const repos = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"sources">[]> =>
    (await ctx.db.query("sources").withIndex("by_kind_and_externalId", (q) => q.eq("kind", "github_repo")).take(500))
      .filter((s) => s.status !== "removed")
      .map((s) => s._id),
});

/** What this deployment can read, for the rail. Never a secret: only whether it's on. */
export const setup = query({
  args: {},
  handler: async () => ({ github: !!process.env.GITHUB_TOKEN }),
});

/** An upload's id is accepted only this long after the file landed. */
const UPLOAD_WINDOW_MS = 60 * 60_000;

/**
 * SOURCES_PER_DAY, counted from every source this member added today, removed
 * ones included. Skipped for CAP_EXEMPT_HANDLES, like every per-member cap.
 */
async function assertCanAdd(ctx: MutationCtx, ownerId: Id<"users">) {
  const today = await ctx.db
    .query("sources")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId).gte("_creationTime", dayStart(Date.now())))
    .take(SOURCES_PER_DAY);
  const blocked = sourceBlocked(today.length, await capExempt(ctx, ownerId));
  if (blocked) throw new ConvexError(blocked);
}

/** A public GitHub repo: public to everyone, one per repo across the community. Checked public each time it's read (ingest.syncRepo). */
async function addRepo(ctx: MutationCtx, ownerId: Id<"users">, p: RepoPath): Promise<Id<"sources">> {
  if (!process.env.GITHUB_TOKEN) throw new ConvexError("GitHub sources are not set up yet.");
  const externalId = `${p.owner}/${p.repo}`.toLowerCase();
  const rows = await ctx.db
    .query("sources")
    .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "github_repo").eq("externalId", externalId))
    .take(20);
  if (rows.some((s) => s.status !== "removed")) throw new ConvexError("That repo is already in the brain.");
  await assertCanAdd(ctx, ownerId);
  const sourceId = await ctx.db.insert("sources", {
    kind: "github_repo",
    label: `${p.owner}/${p.repo}`,
    url: `https://github.com/${p.owner}/${p.repo}`,
    externalId,
    ownerId,
    visibility: "public",
    status: "active",
  });
  await ctx.scheduler.runAfter(0, internal.ingest.syncRepo, { sourceId });
  return sourceId;
}

/** A link a member pastes: a public GitHub repo, a web page, plain text or markdown. Read in the background. */
export const addLink = mutation({
  args: { input: v.string(), private: v.boolean() },
  handler: async (ctx, a): Promise<Id<"sources">> => {
    const user = await requireMember(ctx);
    // `owner/repo`, or a github.com link to one, is a repo; "keep private" doesn't apply.
    const repo = repoPath(a.input);
    if (repo) return await addRepo(ctx, user._id, repo);
    const problem = urlProblem(a.input);
    if (problem) throw new ConvexError(problem);
    const url = new URL(a.input.trim());
    const externalId = url.toString();
    // The member's own rows only: a match on someone else's private
    // document would tell them it exists.
    const mine = await ctx.db
      .query("sources")
      .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "document").eq("externalId", externalId))
      .take(50);
    if (mine.some((s) => s.ownerId === user._id && s.status !== "removed")) throw new ConvexError("You've already added that.");
    await assertCanAdd(ctx, user._id);
    const sourceId = await ctx.db.insert("sources", {
      kind: "document",
      label: `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120),
      url: externalId,
      externalId,
      ownerId: user._id,
      visibility: a.private ? "owner" : "public",
      status: "active",
    });
    await ctx.scheduler.runAfter(0, internal.documents.readUrl, { sourceId });
    return sourceId;
  },
});

/** Where the browser POSTs an upload. The day's cap is checked first, so a full day doesn't waste one. */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const user = await requireMember(ctx);
    await assertCanAdd(ctx, user._id);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * An uploaded markdown, text or PDF file, read in the background by
 * documents.readUpload. The storage id comes from the browser, so it's
 * checked, not trusted: the file landed in the last hour, is under 5 MB, and
 * no source has claimed it.
 * ponytail: an oversized file from a modified client stays in storage; the
 * cockpit never uploads one.
 */
export const addUpload = mutation({
  args: { storageId: v.id("_storage"), name: v.string(), private: v.boolean() },
  handler: async (ctx, a): Promise<Id<"sources">> => {
    const user = await requireMember(ctx);
    const externalId = `upload:${a.storageId}`;
    const file = await ctx.db.system.get("_storage", a.storageId);
    const claimed = await ctx.db
      .query("sources")
      .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "document").eq("externalId", externalId))
      .first();
    if (!file || claimed || Date.now() - file._creationTime > UPLOAD_WINDOW_MS) {
      throw new ConvexError("That upload expired. Upload it again.");
    }
    if (file.size > UPLOAD_MAX_BYTES) throw new ConvexError(`Keep uploads under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
    await assertCanAdd(ctx, user._id);
    const sourceId = await ctx.db.insert("sources", {
      kind: "document",
      label: a.name.trim().slice(0, 120) || "untitled",
      externalId,
      ownerId: user._id,
      visibility: a.private ? "owner" : "public",
      status: "active",
      storageId: a.storageId,
    });
    await ctx.scheduler.runAfter(0, internal.documents.readUpload, { sourceId });
    return sourceId;
  },
});

/**
 * A source node's recent passages, for the rail: newest 20, each redacted
 * (like every graph label) and cut to PASSAGE_EXCERPT, promotable. The id
 * comes from the client, so the source and every passage go through `visibleTo`.
 */
export const passages = query({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const viewer = await getAuthUserId(ctx);
    const s = await ctx.db.get("sources", sourceId);
    if (!s || s.status === "removed" || !visibleTo(s, viewer)) return null;
    const rows = (
      await ctx.db
        .query("passages")
        .withIndex("by_sourceId_and_at", (q) => q.eq("sourceId", sourceId))
        .order("desc")
        .take(20)
    ).filter((p) => visibleTo(p, viewer));
    return {
      label: redactEmails(s.label),
      kind: s.kind,
      url: safeUrl(s.url),
      status: s.status,
      error: s.error ?? null,
      syncedAt: s.lastSyncedAt ?? null,
      mine: viewer !== null && s.ownerId === viewer,
      passages: rows.map((p) => ({
        _id: p._id,
        // Redacted before the cut, so an address split at the edge can't slip through half-shown.
        text: redactEmails(p.text).slice(0, PASSAGE_EXCERPT),
        author: p.authorHandle ? `@${p.authorHandle}` : (p.author ?? null),
        at: p.at,
        url: safeUrl(p.url),
        promoted: !!p.promotedFactId,
      })),
    };
  },
});
