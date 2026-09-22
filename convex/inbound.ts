import { v } from "convex/values";
import { execute } from "../lib/composio.ts";
import {
  BRAIN_REACTION,
  SLACK_TOOLS,
  gmailFact,
  isPublicChannel,
  mayBePublic,
  readEnvelope,
  readHistoryText,
  slackFact,
  slackHistoryArgs,
  slackInfoArgs,
  toCapture,
  verifyWebhook,
} from "../lib/inbound.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { memberProblem, ownerView } from "./access";
import { broadcast } from "./broadcast";
import { factCapBlocked, insertFact } from "./facts";
import { connectorKey, visibility } from "./schema";

/**
 * POST /composio/webhook: members adding to the brain from their own tools.
 * 🧠 on a Slack message → a fact. Public (and broadcast) only for the
 * member's own words in a channel Slack confirms is public; anything else
 * they 🧠 (a DM, a private channel, someone else's message) is saved for
 * them alone: they meant to keep it, not to publish it.
 * The `Intern` label on an email → an owner-only fact (it's their mail), and
 * only through the opt-in capture grant (see connections.ts).
 *
 * Nothing is read before the signature checks out. Replies 200 to anything
 * signed that it ignores, so Composio doesn't retry it. Logs name ids and
 * outcomes, never the payload.
 */

type Member = { userId: Id<"users">; composioAccountId: string; externalUserId: string | null };

/**
 * The payload's user id, trusted only through `connections`: Composio's
 * account must be a live grant of ours, of the right kind for this trigger,
 * belonging to that very user, who may still write to the brain.
 */
export const member = internalQuery({
  args: { userId: v.string(), accountId: v.string(), connector: connectorKey },
  handler: async (ctx, a): Promise<Member | null> => {
    const conn = await ctx.db
      .query("connections")
      .withIndex("by_composioAccountId", (q) => q.eq("composioAccountId", a.accountId))
      .first();
    if (!conn || conn.status !== "active" || conn.connector !== a.connector || conn.userId !== a.userId) return null;
    // Gmail events count only on the Intern label's own grant; Slack's only on the ordinary one.
    if (!!conn.capture !== (a.connector === "gmail")) return null;
    if (memberProblem(await ctx.db.get("users", conn.userId))) return null;
    return { userId: conn.userId, composioAccountId: a.accountId, externalUserId: conn.externalUserId ?? null };
  },
});

/** requireMember's rules, one fact per source, and the 20 facts/day cap, all inside the write. */
export const capture = internalMutation({
  args: { userId: v.id("users"), title: v.string(), body: v.string(), visibility, source: v.string() },
  handler: async (ctx, a): Promise<{ stored: boolean; reason: string | null }> => {
    const problem = memberProblem(await ctx.db.get("users", a.userId));
    if (problem) return { stored: false, reason: problem };
    const dup = await ctx.db
      .query("facts")
      .withIndex("by_ownerId_and_source", (q) => q.eq("ownerId", a.userId).eq("source", a.source))
      .first();
    if (dup) return { stored: false, reason: "duplicate" };
    const blocked = await factCapBlocked(ctx, a.userId);
    if (blocked) return { stored: false, reason: "over the daily cap" };
    await insertFact(ctx, {
      title: a.title,
      body: a.body,
      kind: "note",
      ownerId: a.userId,
      visibility: a.visibility === "owner" ? "owner" : undefined,
      source: a.source,
    });
    // Owner-only captures are never announced.
    if (a.visibility === "public") {
      await broadcast(ctx, { type: "taught", handle: (await ownerView(ctx, a.userId)).handle, title: a.title });
    }
    return { stored: true, reason: null };
  },
});

export const webhook = httpAction(async (ctx, req) => {
  const body = await req.text();
  const signedOk = await verifyWebhook(
    process.env.COMPOSIO_WEBHOOK_SECRET ?? "",
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    body,
  );
  if (!signedOk) return new Response("bad signature", { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const done = (why: string) => new Response(why, { status: 200 });

  const envelope = readEnvelope(json);
  const cap = envelope ? toCapture(envelope) : null;
  // Other project events (connection expiry, triggers we don't use) land here too.
  if (!envelope || !cap) return done("ignored");
  const who: Member | null = await ctx.runQuery(internal.inbound.member, {
    userId: envelope.userId,
    accountId: envelope.accountId,
    connector: cap.connector,
  });
  if (!who) {
    console.log(`inbound: ${envelope.trigger} for ${envelope.accountId} matches no live member grant`);
    return done("not a member");
  }

  let fact: { title: string; body: string } | null;
  let source: string;
  let isPublic = false;
  if (cap.connector === "slack") {
    // Only the member's own 🧠 puts a message in the public brain.
    if (cap.reaction !== BRAIN_REACTION || !who.externalUserId || cap.reactor !== who.externalUserId) return done("ignored");
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) return done("not connected");
    source = `slack:${cap.channel}:${cap.ts}`;
    try {
      // Reaction events carry no text: read it with the member's own grant.
      const data = await execute(apiKey, SLACK_TOOLS.history, {
        userId: who.userId,
        toolkit: "slack",
        accountId: who.composioAccountId,
        arguments: slackHistoryArgs(cap.channel, cap.ts),
      });
      const text = readHistoryText(data, cap.ts);
      fact = text ? slackFact(text) : null;
    } catch (err) {
      // Composio's error names the tool and its reason, never the message text.
      console.log(`inbound: slack history lookup failed for ${who.userId}: ${String(err)}`);
      return done("lookup failed");
    }
    if (fact && mayBePublic(cap, who.externalUserId)) {
      try {
        const info = await execute(apiKey, SLACK_TOOLS.info, {
          userId: who.userId,
          toolkit: "slack",
          accountId: who.composioAccountId,
          arguments: slackInfoArgs(cap.channel),
        });
        isPublic = isPublicChannel(info);
      } catch (err) {
        // Can't confirm the channel is public, so it isn't: saved owner-only.
        console.log(`inbound: slack channel lookup failed for ${who.userId}: ${String(err)}`);
      }
    }
  } else {
    // Only Gmail's own id: a delivery id changes on every re-poll, so it can't dedupe the mail.
    if (!cap.messageId) {
      console.log(`inbound: gmail event ${envelope.id ?? "(no id)"} has no message id; dropped`);
      return done("no message id");
    }
    source = `gmail:${cap.messageId}`;
    fact = gmailFact(cap);
  }
  if (!fact) return done("empty");

  const r: { stored: boolean; reason: string | null } = await ctx.runMutation(internal.inbound.capture, {
    userId: who.userId,
    ...fact,
    visibility: isPublic ? "public" : "owner",
    source,
  });
  console.log(`inbound: ${envelope.trigger} for ${who.userId}: ${r.stored ? `captured ${isPublic ? "public" : "owner-only"}` : r.reason}`);
  return done(r.stored ? "captured" : (r.reason ?? "dropped"));
});
