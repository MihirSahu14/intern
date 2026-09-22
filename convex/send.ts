import { v } from "convex/values";
import { ComposioError, runSendTool, startSendSession } from "../lib/composio.ts";
import { type Connector, type ConnectorKey, connectorByKey, sentFact } from "../lib/connectors.ts";
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

/** What went out from Composio, told apart by whether a plain retry is safe. */
type Outcome = { ok: true } | { ok: false; unsure: boolean; error: string };

const UNSURE_MESSAGE = "This may have been sent. Check your Sent folder before trying again.";

/**
 * Composio's own words never reach an owner, a log line or a fact — only
 * `console.log` (server-side, this action's own log) and a fixed copy,
 * classed by whether the failure looks like a dead grant. Same rule
 * `connections.ts` follows for connect-time errors.
 */
function ownerMessage(err: unknown, label: string): string {
  const status = err instanceof ComposioError ? err.status : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  const deadGrant = status === 401 || status === 403 || /invalid_grant|unauthoriz|forbidden/i.test(msg);
  return deadGrant
    ? `${label} refused the send. Reconnect it and retry.`
    : "The send didn't go through. Retry, or reconnect if it keeps failing.";
}

/** A gateway/request timeout: Composio (or what's in front of it) gave up on the response, not on the request. */
const isTimeoutStatus = (status: number) => status === 408 || status === 499;

/**
 * The two Composio calls are tried separately: a session that never opened
 * can't have reached Gmail/Slack, so any failure there is always a safe
 * `failed`. Only the execute call — the one that may have already run the
 * tool — can leave real doubt: no answer at all (a network throw, or
 * `runSendTool`'s statusless "didn't confirm" ComposioError — see
 * `lib/composio.ts`), a 5xx, or a 408/499 timeout, all leave open that the
 * tool call reached the provider before the failure. A definite 4xx other
 * than a timeout means Composio looked at the request and refused it before
 * running anything.
 */
async function attempt(actionId: Id<"actions">, c: Connector, apiKey: string | undefined, job: Job): Promise<Outcome> {
  const fail = (err: unknown, unsure: boolean): Outcome => {
    console.log(`send.go ${actionId}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, unsure, error: unsure ? UNSURE_MESSAGE : ownerMessage(err, c.label) };
  };
  if (!apiKey || !job.composioAccountId) {
    // Not a Composio failure at all — the reconnect copy applies directly,
    // no need to pattern-match a message for it.
    console.log(`send.go ${actionId}: ${c.label} has no live connected account any more`);
    return { ok: false, unsure: false, error: `${c.label} refused the send. Reconnect it and retry.` };
  }
  let sessionId: string;
  try {
    sessionId = await startSendSession(apiKey, { userId: job.ownerId, toolkit: c.toolkit, accountId: job.composioAccountId, tool: c.sendTool });
  } catch (err) {
    return fail(err, false);
  }
  try {
    await runSendTool(apiKey, sessionId, c.sendTool, c.toArguments(job.draft));
    return { ok: true };
  } catch (err) {
    const status = err instanceof ComposioError ? err.status : undefined;
    return fail(err, status === undefined || status >= 500 || isTimeoutStatus(status));
  }
}

export const go = internalAction({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const job: Job | null = await ctx.runQuery(internal.send.load, { actionId });
    if (!job) return null;
    const c = connectorByKey(job.connector);
    // `attempt` is the only thing that sees a raw Composio error; everything
    // after this is already the fixed copy an owner may see.
    const outcome = await attempt(actionId, c, process.env.COMPOSIO_API_KEY, job);
    await ctx.runMutation(
      internal.send.finish,
      outcome.ok ? { actionId, ok: true } : { actionId, ok: false, unsure: outcome.unsure, error: outcome.error },
    );
    return null;
  },
});

export const finish = internalMutation({
  args: { actionId: v.id("actions"), ok: v.boolean(), unsure: v.optional(v.boolean()), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.status !== "sending" || !action.connector) return null;
    const c = connectorByKey(action.connector);
    const log = (level: "ok" | "err", text: string) => ctx.db.insert("logs", { internId: action.internId, level, text });

    if (!a.ok) {
      // Already the fixed, owner-safe copy `go` chose — never Composio's raw text.
      const reason = a.error ?? "The send didn't go through. Retry, or reconnect if it keeps failing.";
      const status = a.unsure ? "unsure" : "failed";
      await ctx.db.patch("actions", action._id, { status, sendError: reason });
      await log("err", status === "unsure" ? "send uncertain: check your Sent folder" : `send failed: ${reason}`);
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
