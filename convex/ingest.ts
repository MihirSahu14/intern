import { v } from "convex/values";
import { BACKFILL_DAYS } from "../lib/ingest.ts";
import { HISTORY_DELAY_MS, HISTORY_PAGE, SlackError, readChannels, readHistory, slackApi, slackPassage } from "../lib/slack.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { authorName } from "./slack";

/**
 * Reading sources that live elsewhere, in the default runtime over plain
 * fetch. No model calls. Documents are read in convex/documents.ts.
 */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Admin, from the Convex dashboard's function runner: `ingest:backfillSlack {}`.
 * Lists the community workspace's public channels and reads each one's last
 * 90 days, one channel after another. Safe to re-run: passages upsert, a
 * channel part-way through resumes from its source's cursor, and a channel
 * created since is joined.
 */
export const backfillSlack = internalAction({
  args: {},
  handler: async (ctx): Promise<{ channels: number }> => {
    const token = process.env.SLACK_BRAIN_BOT_TOKEN;
    if (!token) throw new Error("Set SLACK_BRAIN_BOT_TOKEN first.");
    const oldest = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86_400;
    const sourceIds: Id<"sources">[] = [];
    let cursor: string | undefined;
    // ponytail: conversations.list (Tier 2, 20+/min) is paged here unpaced, in
    // one action call — fine for a small community workspace's channel count.
    // Page it like backfillChannel (scheduler + delay) if that count grows.
    do {
      const page = readChannels(
        await slackApi(token, "conversations.list", { types: "public_channel", exclude_archived: true, limit: 200, cursor }),
      );
      for (const c of page.channels) sourceIds.push(await ctx.runMutation(internal.slack.ensureChannel, { channel: c.id, name: c.name }));
      cursor = page.next ?? undefined;
    } while (cursor);
    await ctx.scheduler.runAfter(0, internal.ingest.backfillChannel, { sourceIds, oldest });
    return { channels: sourceIds.length };
  },
});

/**
 * One page of the first channel in `sourceIds`, then itself again: the same
 * channel while there's more, else the next one. One Slack history call per
 * HISTORY_DELAY_MS whatever the workspace's size; a 429 waits Slack's
 * Retry-After and tries the same page again.
 */
export const backfillChannel = internalAction({
  args: { sourceIds: v.array(v.id("sources")), oldest: v.number() },
  handler: async (ctx, { sourceIds, oldest }) => {
    const [sourceId, ...rest] = sourceIds;
    const token = process.env.SLACK_BRAIN_BOT_TOKEN;
    if (!sourceId || !token) return null;
    const next = async (ids: Id<"sources">[], delayMs = HISTORY_DELAY_MS) => {
      if (ids.length) await ctx.scheduler.runAfter(delayMs, internal.ingest.backfillChannel, { sourceIds: ids, oldest });
    };
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    if (!src || src.kind !== "slack_channel" || src.status === "removed") {
      await next(rest);
      return null;
    }
    try {
      // Starting a channel: join it first. A bot reads history, and hears new
      // messages, only where it's a member; `channels:join` reaches public
      // channels only, and joining one it's already in is a no-op.
      if (!src.cursor) await slackApi(token, "conversations.join", { channel: src.externalId });
      const page = readHistory(
        await slackApi(token, "conversations.history", { channel: src.externalId, oldest, limit: HISTORY_PAGE, cursor: src.cursor }),
        src.externalId,
      );
      const names = new Map<string, string | undefined>();
      for (const m of page.messages) if (!names.has(m.user)) names.set(m.user, await authorName(ctx, token, m.user));
      await ctx.runMutation(internal.sources.write, {
        sourceId,
        passages: page.messages.map((m) => slackPassage(m, names.get(m.user))),
        cursor: page.next,
        synced: !page.next,
      });
      await next(page.next ? sourceIds : rest);
    } catch (err) {
      if (err instanceof SlackError && err.retryAfterS) {
        await next(sourceIds, err.retryAfterS * 1000);
        return null;
      }
      console.log(`backfill: ${src.externalId} failed: ${errText(err)}`);
      await ctx.runMutation(internal.sources.fail, { sourceId, error: "Couldn't read this channel's history." });
      await next(rest);
    }
    return null;
  },
});
