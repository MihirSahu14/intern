import { v } from "convex/values";
import { BRAIN_REACTION } from "../lib/inbound.ts";
import { readChannelName, readSlackEvent, readUserName, slackApi, slackPassage, verifySlack } from "../lib/slack.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, type QueryCtx, httpAction, internalMutation, internalQuery } from "./_generated/server";
import { memberProblem, slackLinkedUser } from "./access";
import { factMatches, promotePassage, rewritePassage } from "./sources";

/**
 * POST /slack/events: the community workspace, read into the brain through
 * its own "Intern Brain" app. It's a separate app from the "Intern" one
 * members connect through Composio because a Slack app delivers its events
 * to one Request URL: Intern's go to Composio, Intern Brain's come here.
 *
 * Public channels only. Nothing is parsed before the signature checks out.
 * Anything signed that it ignores still gets a 200, so Slack doesn't retry
 * it. Logs name the event id and kind, never a message's text.
 */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function channelSource(ctx: QueryCtx, channelId: string) {
  return await ctx.db
    .query("sources")
    .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "slack_channel").eq("externalId", channelId))
    .unique();
}

async function passageAt(ctx: QueryCtx, channelId: string, ts: string) {
  const src = await channelSource(ctx, channelId);
  if (!src) return null;
  return await ctx.db
    .query("passages")
    .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", src._id).eq("externalId", `${channelId}:${ts}`))
    .unique();
}

export const knownChannel = internalQuery({
  args: { channel: v.string() },
  handler: async (ctx, a): Promise<Id<"sources"> | null> => (await channelSource(ctx, a.channel))?._id ?? null,
});

/** The channel's source, made on first sight. A known name replaces a bare id. */
export const ensureChannel = internalMutation({
  args: { channel: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Id<"sources">> => {
    const label = `#${a.name ?? a.channel}`;
    const row = await channelSource(ctx, a.channel);
    if (!row) {
      return await ctx.db.insert("sources", { kind: "slack_channel", label, externalId: a.channel, visibility: "public", status: "active" });
    }
    if (a.name && row.label !== label) await ctx.db.patch("sources", row._id, { label });
    return row._id;
  },
});

export const cachedName = internalQuery({
  args: { slackUserId: v.string() },
  handler: async (ctx, a): Promise<string | null> =>
    (await ctx.db.query("slackUsers").withIndex("by_slackUserId", (q) => q.eq("slackUserId", a.slackUserId)).unique())?.name ?? null,
});

export const rememberName = internalMutation({
  args: { slackUserId: v.string(), name: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("slackUsers").withIndex("by_slackUserId", (q) => q.eq("slackUserId", a.slackUserId)).unique();
    if (row) await ctx.db.patch("slackUsers", row._id, { name: a.name });
    else await ctx.db.insert("slackUsers", a);
    return null;
  },
});

/** A Slack user's display name: cached, else asked for once. Never throws; a name is decoration. */
export async function authorName(ctx: ActionCtx, token: string | undefined, slackUserId: string): Promise<string | undefined> {
  const cached: string | null = await ctx.runQuery(internal.slack.cachedName, { slackUserId });
  if (cached !== null || !token) return cached ?? undefined;
  try {
    const name = readUserName(await slackApi(token, "users.info", { user: slackUserId }));
    if (name) await ctx.runMutation(internal.slack.rememberName, { slackUserId, name });
    return name ?? undefined;
  } catch (err) {
    console.log(`slack: users.info for ${slackUserId} failed: ${errText(err)}`);
    return undefined;
  }
}

async function channelName(token: string, channelId: string): Promise<string | undefined> {
  try {
    return readChannelName(await slackApi(token, "conversations.info", { channel: channelId })) ?? undefined;
  } catch (err) {
    console.log(`slack: conversations.info for ${channelId} failed: ${errText(err)}`);
    return undefined;
  }
}

/** An edit in Slack. Only a passage already in the brain changes. */
export const edit = internalMutation({
  args: { channel: v.string(), ts: v.string(), text: v.string() },
  handler: async (ctx, a) => {
    const p = await passageAt(ctx, a.channel, a.ts);
    if (p) await rewritePassage(ctx, p, a.text);
    return null;
  },
});

/**
 * Deleted in Slack means deleted in the brain: the passage, and its promoted
 * fact if nobody has changed it. A tombstone stays behind (keyed the same as
 * the passage was) so a retried "message" delivery — the original post,
 * redelivered after this delete already landed — can't bring it back; only
 * `write`'s insert path ever checks it, so it costs nothing elsewhere.
 */
export const forget = internalMutation({
  args: { channel: v.string(), ts: v.string() },
  handler: async (ctx, a) => {
    const src = await channelSource(ctx, a.channel);
    if (!src) return null;
    const externalId = `${a.channel}:${a.ts}`;
    const p = await ctx.db
      .query("passages")
      .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", src._id).eq("externalId", externalId))
      .unique();
    if (p) {
      const f = p.promotedFactId ? await ctx.db.get("facts", p.promotedFactId) : null;
      if (f && factMatches(f, p.text)) await ctx.db.delete("facts", f._id);
      await ctx.db.delete("passages", p._id);
    }
    const tomb = await ctx.db
      .query("slackTombstones")
      .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", src._id).eq("externalId", externalId))
      .unique();
    if (!tomb) await ctx.db.insert("slackTombstones", { sourceId: src._id, externalId });
    return null;
  },
});

/**
 * 🧠 on a message: a public fact, attributed to the reactor if they're a
 * member who linked this Slack account, owned by nobody otherwise. Filed
 * under the same key a member's own Composio 🧠 uses, so the two never twin.
 * A reactor linked to a member who may not currently write (banned, not yet
 * consented) promotes nothing at all — never falls through to anonymous, or
 * a blocked member's own reaction would credit a stranger.
 */
export const react = internalMutation({
  args: { channel: v.string(), ts: v.string(), user: v.string() },
  handler: async (ctx, a) => {
    const p = await passageAt(ctx, a.channel, a.ts);
    if (!p) return null;
    const linked = await slackLinkedUser(ctx, a.user);
    if (linked && memberProblem(linked)) return null;
    await promotePassage(
      ctx,
      p,
      linked ? { ownerId: linked._id, visibility: "public", source: `slack:${a.channel}:${a.ts}` } : { visibility: "public" },
    );
    return null;
  },
});

export const events = httpAction(async (ctx, req) => {
  const body = await req.text();
  const signedOk = await verifySlack(
    process.env.SLACK_BRAIN_SIGNING_SECRET ?? "",
    { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") },
    body,
  );
  if (!signedOk) return new Response("bad signature", { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const e = readSlackEvent(json);
  if (e.kind === "challenge") return new Response(e.challenge, { status: 200, headers: { "content-type": "text/plain" } });
  const done = (why: string) => new Response(why, { status: 200 });
  console.log(`slack: ${e.eventId ?? "(no id)"} ${e.kind === "ignore" ? `ignored ${e.type}` : e.kind}`);
  // The same var connections.finish enforces on connect: one community workspace.
  const team = process.env.COMMUNITY_SLACK_TEAM_ID;
  if (e.kind === "ignore" || !team || e.teamId !== team) return done("ignored");

  if (e.kind === "delete") {
    await ctx.runMutation(internal.slack.forget, { channel: e.channel, ts: e.ts });
    return done("deleted");
  }
  if (e.kind === "edit") {
    await ctx.runMutation(internal.slack.edit, { channel: e.channel, ts: e.ts, text: e.text });
    return done("edited");
  }
  if (e.kind === "reaction") {
    if (e.reaction !== BRAIN_REACTION) return done("ignored");
    await ctx.runMutation(internal.slack.react, { channel: e.channel, ts: e.ts, user: e.user });
    return done("promoted");
  }
  const token = process.env.SLACK_BRAIN_BOT_TOKEN;
  const known: Id<"sources"> | null = await ctx.runQuery(internal.slack.knownChannel, { channel: e.channel });
  const sourceId: Id<"sources"> =
    known ??
    (await ctx.runMutation(internal.slack.ensureChannel, {
      channel: e.channel,
      name: token ? await channelName(token, e.channel) : undefined,
    }));
  // A new message only ever inserts: a redelivered original after a later
  // edit or delete must never revert or resurrect it — those are the only
  // ways an existing Slack passage changes.
  await ctx.runMutation(internal.sources.write, {
    sourceId,
    passages: [slackPassage(e, await authorName(ctx, token, e.user))],
    insertOnly: true,
  });
  return done("stored");
});
