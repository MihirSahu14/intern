import { v } from "convex/values";
import { execute } from "../lib/composio.ts";
import { type ConnectorKey, connectorByKey, sentFact } from "../lib/connectors.ts";
import type { Draft } from "../lib/types.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { activeConnection } from "./connections";
import { insertFact } from "./facts";

/**
 * One approved draft going out through its owner's own account. Plain fetch,
 * so no "use node". `outbox.decide` / `outbox.resend` set `sending` and
 * schedule `go`; `finish` records the outcome and the write-back fact in one
 * transaction.
 */

type Job = { ownerId: Id<"users">; connector: ConnectorKey; draft: Draft; composioAccountId: string | null };

export const load = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }): Promise<Job | null> => {
    const a = await ctx.db.get("actions", actionId);
    if (!a || a.status !== "sending" || !a.connector) return null;
    const conn = await activeConnection(ctx, a.ownerId, a.connector);
    return {
      ownerId: a.ownerId,
      connector: a.connector,
      draft: a.accepted ?? a.draft,
      composioAccountId: conn?.composioAccountId ?? null,
    };
  },
});

export const go = internalAction({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const job: Job | null = await ctx.runQuery(internal.send.load, { actionId });
    if (!job) return null;
    const c = connectorByKey(job.connector);
    const apiKey = process.env.COMPOSIO_API_KEY;

    // Only the Composio call is inside the try: if recording a success threw
    // and landed in the catch, the draft would read `failed` and a retry
    // would send it twice.
    let error: string | null = null;
    try {
      if (!apiKey || !job.composioAccountId) throw new Error(`${c.label} isn't connected any more. Reconnect it and retry.`);
      await execute(apiKey, c.sendTool, {
        userId: job.ownerId,
        toolkit: c.toolkit,
        accountId: job.composioAccountId,
        arguments: c.toArguments(job.draft),
      });
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
    await ctx.runMutation(internal.send.finish, error ? { actionId, ok: false, error } : { actionId, ok: true });
    return null;
  },
});

export const finish = internalMutation({
  args: { actionId: v.id("actions"), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.status !== "sending" || !action.connector) return null;
    const c = connectorByKey(action.connector);
    const log = (level: "ok" | "err", text: string) => ctx.db.insert("logs", { internId: action.internId, level, text });

    if (!a.ok) {
      const reason = a.error ?? "send failed";
      await ctx.db.patch("actions", action._id, { status: "failed", sendError: reason });
      await log("err", `send failed: ${reason}`);
      return null;
    }

    const now = Date.now();
    await ctx.db.patch("actions", action._id, { status: "sent", sentAt: now });
    // The brain updates the moment it goes out. Owner-only: it's their account.
    const fact = sentFact(c.key, action.accepted ?? action.draft, now);
    await insertFact(ctx, { ...fact, kind: "note", visibility: "owner", ownerId: action.ownerId, internId: action.internId });
    await log("ok", `Sent from your ${c.label}.`);
    return null;
  },
});
