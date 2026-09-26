import { v } from "convex/values";
import { ISSUE_PAGES, ISSUE_PAGE_SIZE, githubHeaders, issuesUrl, readIssues, readRepo, readmePassages, readmeUrl, repoPath, repoUrl } from "../lib/github.ts";
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

/**
 * A repo's README and its latest 200 issues and PRs, one passage each, and
 * nothing else: whatever the last read had that this one doesn't goes.
 * Checked public on every read: one that has gone private since is failed
 * and its passages cleared.
 */
export const syncRepo = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    const path = src ? repoPath(src.externalId) : null;
    if (!src || src.kind !== "github_repo" || src.status === "removed" || !path) return null;
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      await ctx.runMutation(internal.sources.fail, { sourceId, error: "GitHub sources are not set up yet." });
      return null;
    }
    try {
      const get = (url: string, accept?: string) => fetch(url, { headers: githubHeaders(token, accept) });
      const repoRes = await get(repoUrl(path));
      // A private repo the token can't see reads back 404: gone private, so
      // its passages clear, same as a 200 that now reads back non-public. Any
      // other non-ok status (403 secondary rate limit, 429, 5xx) is GitHub
      // not answering, not the repo going private — that's the same
      // non-destructive failure the issues loop below throws into: the
      // source keeps its passages and the cron tries again tomorrow.
      // ponytail: doesn't abort the rest of refreshRepos's run on a 429/403
      // rate limit — each repo is scheduled independently, so add a shared
      // "stop the run" flag if the refresh starts tripping the daily limit.
      if (repoRes.status === 404) {
        await ctx.runMutation(internal.sources.fail, { sourceId, error: "Only public repos can be added.", clear: true });
        return null;
      }
      if (!repoRes.ok) throw new Error(`repo: ${repoRes.status}`);
      const repo = readRepo(await repoRes.json());
      if (!repo?.isPublic) {
        await ctx.runMutation(internal.sources.fail, { sourceId, error: "Only public repos can be added.", clear: true });
        return null;
      }
      const readmeRes = await get(readmeUrl(path), "application/vnd.github.raw+json");
      const passages = readmeRes.ok ? readmePassages(await readmeRes.text(), repo.htmlUrl, Date.now()) : [];
      for (let page = 1; page <= ISSUE_PAGES; page++) {
        const res = await get(issuesUrl(path, page));
        if (!res.ok) throw new Error(`issues page ${page}: ${res.status}`);
        const rows: unknown = await res.json();
        passages.push(...readIssues(rows));
        if (!Array.isArray(rows) || rows.length < ISSUE_PAGE_SIZE) break;
      }
      await ctx.runMutation(internal.sources.write, { sourceId, label: repo.fullName, passages, synced: true, prune: true });
    } catch (err) {
      console.log(`github: ${src.externalId} failed: ${errText(err)}`);
      await ctx.runMutation(internal.sources.fail, { sourceId, error: "Couldn't read this repo from GitHub." });
    }
    return null;
  },
});

/** Daily, from crons.ts: every repo read again, ten seconds apart (four calls each, far under 5,000 an hour). */
export const refreshRepos = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!process.env.GITHUB_TOKEN) return null;
    const ids: Id<"sources">[] = await ctx.runQuery(internal.sources.repos, {});
    for (const [i, sourceId] of ids.entries()) await ctx.scheduler.runAfter(i * 10_000, internal.ingest.syncRepo, { sourceId });
    return null;
  },
});
