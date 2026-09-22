import { v } from "convex/values";
import { BROADCASTS_PER_HOUR, type BroadcastEvent, broadcastText, discordBody, hourKey, slackBody } from "../lib/broadcast.ts";
import { internal } from "./_generated/api";
import { type MutationCtx, internalAction } from "./_generated/server";

/**
 * Queue one public line for the community's channels. Called from the
 * mutation that made the event, so it only happens if that commits.
 * Throttled per UTC hour; over the cap it's dropped with a log, not queued.
 */
export async function broadcast(ctx: MutationCtx, e: BroadcastEvent): Promise<void> {
  if (!process.env.BROADCAST_DISCORD_WEBHOOK_URL && !process.env.BROADCAST_SLACK_WEBHOOK_URL) return;
  const hour = hourKey(Date.now());
  const row = await ctx.db.query("broadcasts").withIndex("by_hour", (q) => q.eq("hour", hour)).unique();
  if ((row?.count ?? 0) >= BROADCASTS_PER_HOUR) {
    console.log(`broadcast dropped, over ${BROADCASTS_PER_HOUR}/hour: ${e.type} @${e.handle}`);
    return;
  }
  if (row) await ctx.db.patch("broadcasts", row._id, { count: row.count + 1 });
  else await ctx.db.insert("broadcasts", { hour, count: 1 });
  await ctx.scheduler.runAfter(0, internal.broadcast.post, { text: broadcastText(e, process.env.SITE_URL ?? "") });
}

/** POSTs the line to each configured webhook. A dead webhook is logged, never retried. */
export const post = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => {
    const targets: [string | undefined, unknown][] = [
      [process.env.BROADCAST_DISCORD_WEBHOOK_URL, discordBody(text)],
      [process.env.BROADCAST_SLACK_WEBHOOK_URL, slackBody(text)],
    ];
    await Promise.all(
      targets.map(async ([url, body]) => {
        if (!url) return;
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) console.log(`broadcast webhook ${res.status}`);
        } catch (err) {
          console.log(`broadcast webhook failed: ${String(err)}`);
        }
      }),
    );
    return null;
  },
});
