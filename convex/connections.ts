import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { ComposioError, completeAuth, connect, deleteAccount, deleteTrigger, execute, upsertTrigger } from "../lib/composio.ts";
import { CONNECTORS, type ConnectorKey, connectorByKey, isConfigured } from "../lib/connectors.ts";
import { GMAIL_TOOLS, SLACK_TOOLS, TRIGGERS, readGmailProfile, readWhoami } from "../lib/inbound.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { capExempt, requireMember } from "./access";
import { connectorKey } from "./schema";

/**
 * A member's accounts at Composio. One hop, inline: approve → Composio's
 * consent screen → the project's verifier URL, which is the cockpit → the
 * cockpit calls `finish` as the signed-in member. There is no settings page;
 * the rail is the only place to connect or disconnect.
 *
 * Why the verifier: whoever consents on a Connect Link becomes the account on
 * it, so an attacker could start a link and get someone else to consent
 * (OAuth session fixation). With callback identity verification, Composio
 * holds the connection until we redeem a single-use `session_uri`, which only
 * the consenting browser ever sees, with the id of the member signed in
 * there. A victim who consents on an attacker's link redeems it as
 * themselves, Composio refuses the mismatch, and the grant never activates.
 *
 * Inbound (Task 7): a Slack grant subscribes to its member's 🧠 as it goes
 * live. Gmail never reads mail on the send grant: the `Intern` label is an
 * opt-in second grant (`capture`), through its own read-only auth config and
 * its own consent screen, and switching it off deletes that grant.
 */

/** How long a connect link stays finishable. */
const FINISH_WINDOW = 15 * 60_000;

/**
 * Connect links one member may start in an hour. Each is a Composio call on a
 * tier the whole community shares.
 */
const STARTS_PER_HOUR = 5;

/** The member's live grant for one connector, if any: the send grant, or with `capture`, Gmail's read-only one. */
export async function activeConnection(
  ctx: QueryCtx,
  userId: Id<"users">,
  connector: ConnectorKey,
  capture = false,
): Promise<Doc<"connections"> | null> {
  return await ctx.db
    .query("connections")
    .withIndex("by_userId_and_connector", (q) => q.eq("userId", userId).eq("connector", connector))
    .order("desc")
    .filter((q) => q.and(q.eq(q.field("status"), "active"), q.eq(q.field("capture"), capture ? true : undefined)))
    .first();
}

/**
 * The Intern label can be offered: Gmail connects at all, the deployment has
 * a read-only auth config for it, and a webhook secret to receive its events.
 * Missing any of them, capture fails closed.
 */
const captureConfigured = (env: Record<string, string | undefined>) =>
  isConfigured(connectorByKey("gmail"), env) && !!env.COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE && !!env.COMPOSIO_WEBHOOK_SECRET;

type Forget = { composioAccountId: string; triggerId?: string; revoke: boolean };

/**
 * Deletes the account at Composio, its trigger first. Best-effort: our own
 * row is already failed or gone. `revoke` only when the member is done with
 * that account (disconnect, purge); see deleteAccount.
 */
export async function forgetAccount(composioAccountId: string, a: { revoke: boolean; triggerId?: string }): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return;
  if (a.triggerId) {
    try {
      await deleteTrigger(apiKey, a.triggerId);
    } catch (err) {
      console.log(`composio trigger delete ${a.triggerId} failed: ${String(err)}`);
    }
  }
  try {
    await deleteAccount(apiKey, composioAccountId, { revoke: a.revoke });
  } catch (err) {
    console.log(`composio delete ${composioAccountId} failed: ${String(err)}`);
  }
}

const forgetAll = async (rows: Forget[]) => {
  for (const r of rows) await forgetAccount(r.composioAccountId, r);
};

/** One row per connector for the rail. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return await Promise.all(
      CONNECTORS.map(async (c) => {
        const row = userId ? await activeConnection(ctx, userId, c.key) : null;
        const offered = c.key === "gmail" && captureConfigured(process.env);
        return {
          key: c.key,
          label: c.label,
          forKind: c.forKind,
          configured: isConfigured(c, process.env),
          connected: !!row,
          accountLabel: row?.accountLabel ?? null,
          /** The Intern label: null when not offered, else whether it's on. */
          capture: offered ? !!(userId && (await activeConnection(ctx, userId, c.key, true))) : null,
          disclosure: c.disclosure,
          enables: c.enables,
          /** Slack only: the community workspace's invite link. Only https, since the rail renders it as a link. */
          invite: c.key === "slack" && process.env.COMMUNITY_SLACK_INVITE_URL?.startsWith("https://")
            ? process.env.COMMUNITY_SLACK_INVITE_URL
            : null,
        };
      }),
    );
  },
});

/** The signed-in member, for actions: the same gate every write goes through. */
export const member = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"users">> => (await requireMember(ctx))._id,
});

/** The write behind `start`, so it goes through requireMember like every other write. */
export const begin = internalMutation({
  args: { connector: connectorKey, state: v.string(), capture: v.optional(v.literal(true)) },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const now = Date.now();
    const recent = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_createdAt", (q) => q.eq("userId", user._id).gte("createdAt", now - 60 * 60_000))
      .take(STARTS_PER_HOUR);
    if (recent.length >= STARTS_PER_HOUR && !(await capExempt(ctx, user._id))) {
      throw new ConvexError("Too many connect attempts this hour. Try again later.");
    }
    await ctx.db.insert("connections", {
      userId: user._id,
      connector: a.connector,
      capture: a.capture,
      status: "pending",
      state: a.state,
      createdAt: now,
    });
    return user._id;
  },
});

/** Records the account Composio made for this link: the only one `finish` will adopt. */
export const attach = internalMutation({
  args: { state: v.string(), composioAccountId: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", a.state)).unique();
    if (row?.status === "pending") await ctx.db.patch("connections", row._id, { composioAccountId: a.composioAccountId });
    return null;
  },
});

/** A link that never got going. */
export const fail = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", state)).unique();
    if (row?.status === "pending") await ctx.db.patch("connections", row._id, { status: "failed" });
    return null;
  },
});

/** `capture: true` is the Intern label's own consent: Gmail, read-only, never the send grant. */
export const start = action({
  args: { connector: connectorKey, capture: v.optional(v.boolean()) },
  handler: async (ctx, { connector, capture }): Promise<string> => {
    const c = connectorByKey(connector);
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey || !isConfigured(c, process.env)) throw new ConvexError(`${c.label} is not set up yet.`);
    if (capture && (c.key !== "gmail" || !captureConfigured(process.env))) {
      throw new ConvexError(`The Intern label for ${c.label} is not set up yet.`);
    }

    // Our key for the row while Composio's account id is still unknown.
    const state = crypto.randomUUID();
    const userId: Id<"users"> = await ctx.runMutation(internal.connections.begin, {
      connector,
      state,
      capture: capture ? true : undefined,
    });
    try {
      const { redirectUrl, accountId } = await connect(apiKey, {
        userId,
        toolkit: c.toolkit,
        authConfigId: (capture ? process.env.COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE : process.env[c.authConfigEnv]) || undefined,
      });
      await ctx.runMutation(internal.connections.attach, { state, composioAccountId: accountId });
      return redirectUrl;
    } catch (err) {
      await ctx.runMutation(internal.connections.fail, { state });
      console.log(`connections.start: ${String(err)}`);
      throw new ConvexError("Couldn't reach Composio. Try again.");
    }
  },
});

type Finish = { ok: boolean; connector: ConnectorKey | null; capture?: true; reason?: string };

/** A grant that just went live, for `finish` to subscribe. */
type Fresh = { rowId: Id<"connections">; connector: ConnectorKey; capture: boolean };

/**
 * After Composio confirmed `composioAccountId` for the signed-in member: adopt
 * it only if it is on that member's own pending link from the last 15 minutes,
 * retiring any older grant. Checks the member itself rather than trusting the
 * caller. `forget` lists the Composio accounts to delete, without revoking.
 */
export const activate = internalMutation({
  args: { composioAccountId: v.string() },
  handler: async (ctx, { composioAccountId }): Promise<{ result: Finish; forget: Forget[]; fresh: Fresh | null }> => {
    const user = await requireMember(ctx);
    const row = await ctx.db
      .query("connections")
      .withIndex("by_composioAccountId", (q) => q.eq("composioAccountId", composioAccountId))
      .first();
    const refused = (reason: string) => ({
      result: { ok: false, connector: row?.connector ?? null, reason },
      forget: [{ composioAccountId, revoke: false }],
      fresh: null,
    });
    if (!row) return refused("That connect link isn't one of yours.");
    const c = connectorByKey(row.connector);
    if (row.userId !== user._id) {
      // Composio says it's this member's; our row says someone else started it.
      // Trust neither: nobody keeps this grant.
      if (row.status === "pending") await ctx.db.patch("connections", row._id, { status: "failed" });
      console.log(`connections.activate: ${row._id} confirmed for a different member; failing it`);
      return refused("That connect link isn't one of yours.");
    }
    if (row.status === "active") return { result: { ok: true, connector: c.key }, forget: [], fresh: null };
    if (row.status !== "pending" || Date.now() - row.createdAt > FINISH_WINDOW) {
      if (row.status === "pending") await ctx.db.patch("connections", row._id, { status: "failed" });
      return refused(`That ${c.label} link expired. Try again.`);
    }

    // Newest first, active only, same kind of grant (a capture grant never
    // retires the send grant): however many attempts came before, the live
    // grant can't fall outside the read.
    const forget: Forget[] = [];
    const older = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", user._id).eq("connector", c.key))
      .order("desc")
      .filter((q) => q.and(q.eq(q.field("status"), "active"), q.eq(q.field("capture"), row.capture)))
      .take(10);
    for (const o of older) {
      await ctx.db.patch("connections", o._id, { status: "failed" });
      // No revoke on retire: same Google account, it would kill the grant just given.
      if (o.composioAccountId) forget.push({ composioAccountId: o.composioAccountId, triggerId: o.triggerId, revoke: false });
    }
    await ctx.db.patch("connections", row._id, { status: "active" });
    return {
      result: row.capture ? { ok: true, connector: c.key, capture: true } : { ok: true, connector: c.key },
      forget,
      fresh: { rowId: row._id, connector: c.key, capture: !!row.capture },
    };
  },
});

/**
 * Called by the cockpit with the `session_uri` Composio's verifier redirect
 * brought it. The member is whoever is signed in; there is no user id
 * argument to trust. Composio's own error text goes to the log, never the
 * client.
 */
export const finish = action({
  args: { sessionUri: v.string() },
  handler: async (ctx, { sessionUri }): Promise<Finish> => {
    const userId: Id<"users"> = await ctx.runQuery(internal.connections.member, {});
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey || !CONNECTORS.some((c) => isConfigured(c, process.env))) {
      throw new ConvexError("Connecting accounts is not set up yet.");
    }

    let accountId: string;
    let toolkit: string;
    try {
      ({ accountId, toolkit } = await completeAuth(apiKey, { sessionUri, userId }));
    } catch (err) {
      const status = err instanceof ComposioError ? err.status : undefined;
      console.log(`connections.finish: complete_auth failed for ${userId}: ${String(err)}`);
      // 400: Composio refused the identity and has failed the connection itself.
      if (status === 400) return { ok: false, connector: null, reason: "Composio refused that link: it was started from another account." };
      if (status === 404) return { ok: false, connector: null, reason: "That connect link expired or was already used." };
      return { ok: false, connector: null, reason: "Couldn't reach Composio. Try again." };
    }

    // Slack names a reactor by Slack user id, so learn which one is this
    // member, and in which workspace. Before `activate`: with
    // COMMUNITY_SLACK_TEAM_ID set, another workspace (or one we couldn't
    // check) is refused without retiring the member's live grant. Revoked
    // only when it's known to be another workspace: providers revoke per app
    // grant, so an unchecked one might be the community grant itself.
    const community = process.env.COMMUNITY_SLACK_TEAM_ID;
    const refuseSlack = async (revoke: boolean): Promise<Finish> => {
      await forgetAccount(accountId, { revoke });
      return { ok: false, connector: "slack", reason: "Connect the Intern community Slack, not another workspace." };
    };
    let who: ReturnType<typeof readWhoami> | null = null;
    if (toolkit === "slack") {
      try {
        who = readWhoami(await execute(apiKey, SLACK_TOOLS.whoami, { userId, toolkit: "slack", accountId, arguments: {} }));
      } catch (err) {
        console.log(`connections.finish: slack whoami failed for ${userId}: ${String(err)}`);
      }
      if (community && who?.teamId !== community) return await refuseSlack(!!who?.teamId);
    }

    let activated: { result: Finish; forget: Forget[]; fresh: Fresh | null };
    try {
      activated = await ctx.runMutation(internal.connections.activate, { composioAccountId: accountId });
    } catch (err) {
      // Composio already verified the grant; with no row of ours live, nobody
      // would ever delete it. Not revoked: the member may hold another live
      // grant on the same account.
      console.log(`connections.finish: activate failed for ${userId}: ${String(err)}`);
      await forgetAccount(accountId, { revoke: false });
      throw err;
    }
    const { result, forget, fresh } = activated;
    await forgetAll(forget);
    if (!fresh) return result;

    if (fresh.capture) {
      // Capture is the trigger: a read grant without one is only a risk, so it goes.
      try {
        if (!process.env.COMPOSIO_WEBHOOK_SECRET) throw new Error("no COMPOSIO_WEBHOOK_SECRET");
        const triggerId = await upsertTrigger(apiKey, TRIGGERS.gmail.slug, { userId, accountId, config: TRIGGERS.gmail.config });
        await ctx.runMutation(internal.connections.settle, { rowId: fresh.rowId, triggerId });
        return result;
      } catch (err) {
        console.log(`connections.finish: gmail trigger failed for ${userId}: ${String(err)}`);
        await ctx.runMutation(internal.connections.retire, { rowId: fresh.rowId });
        await forgetAccount(accountId, { revoke: false });
        return { ok: false, connector: "gmail", reason: "Couldn't switch on the Intern label. Try again." };
      }
    }

    if (fresh.connector === "gmail") {
      // Which address this is, for the rail and for the member's own interns
      // ("email myself"). Best-effort: a grant that can send is worth keeping
      // without it. The address itself never reaches the log.
      try {
        const email = readGmailProfile(
          await execute(apiKey, GMAIL_TOOLS.profile, { userId, toolkit: "gmail", accountId, arguments: { user_id: "me" } }),
        );
        if (email) await ctx.runMutation(internal.connections.settle, { rowId: fresh.rowId, accountLabel: email });
      } catch (err) {
        console.log(`connections.finish: gmail profile failed for ${userId}: ${String(err)}`);
      }
    }

    if (fresh.connector === "slack") {
      // Composio named another toolkit, so the workspace was never checked: fail closed.
      if (community && !who) {
        await ctx.runMutation(internal.connections.retire, { rowId: fresh.rowId });
        return await refuseSlack(false);
      }
      // Then subscribe to their 🧠. Best-effort: an account that can send but
      // not listen is still worth connecting. No webhook secret, no
      // subscription: its events could never be verified.
      if (who) {
        try {
          const triggerId =
            who.userId && process.env.COMPOSIO_WEBHOOK_SECRET
              ? await upsertTrigger(apiKey, TRIGGERS.slack.slug, { userId, accountId, config: TRIGGERS.slack.config })
              : undefined;
          await ctx.runMutation(internal.connections.settle, {
            rowId: fresh.rowId,
            externalUserId: who.userId ?? undefined,
            accountLabel: who.label ?? undefined,
            triggerId,
          });
        } catch (err) {
          console.log(`connections.finish: slack subscribe failed for ${userId}: ${String(err)}`);
        }
      }
    }
    return result;
  },
});

/** What `finish` learned after a grant went live. Only onto a row that's still live. */
export const settle = internalMutation({
  args: {
    rowId: v.id("connections"),
    externalUserId: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    triggerId: v.optional(v.string()),
  },
  handler: async (ctx, { rowId, ...patch }) => {
    const row = await ctx.db.get("connections", rowId);
    if (row?.status === "active") await ctx.db.patch("connections", rowId, patch);
    return null;
  },
});

export const retire = internalMutation({
  args: { rowId: v.id("connections") },
  handler: async (ctx, { rowId }) => {
    await ctx.db.patch("connections", rowId, { status: "failed" });
    return null;
  },
});

/**
 * Every live grant for the connector, the Intern label's included: done with
 * Gmail means done reading it too. With `capture`, only the Intern label's.
 * The send grant is revoked; a capture grant is only deleted, since with the
 * same OAuth app revoking one revokes both.
 */
export const drop = internalMutation({
  args: { connector: connectorKey, capture: v.optional(v.literal(true)) },
  handler: async (ctx, a): Promise<Forget[]> => {
    const user = await requireMember(ctx);
    const rows = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", user._id).eq("connector", a.connector))
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(10);
    const forget: Forget[] = [];
    for (const r of rows) {
      if (a.capture && !r.capture) continue;
      await ctx.db.patch("connections", r._id, { status: "failed" });
      if (r.composioAccountId) forget.push({ composioAccountId: r.composioAccountId, triggerId: r.triggerId, revoke: !r.capture });
    }
    return forget;
  },
});

export const disconnect = action({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }): Promise<null> => {
    await forgetAll(await ctx.runMutation(internal.connections.drop, { connector }));
    return null;
  },
});

/** Switches the Intern label off: its trigger and its read grant go; sending stays. */
export const stopCapture = action({
  args: {},
  handler: async (ctx): Promise<null> => {
    await forgetAll(await ctx.runMutation(internal.connections.drop, { connector: "gmail", capture: true }));
    return null;
  },
});

/** Scheduled by `users.purge` for each live grant it deletes. */
export const forget = internalAction({
  args: { composioAccountId: v.string(), triggerId: v.optional(v.string()) },
  handler: async (_ctx, { composioAccountId, triggerId }) => {
    await forgetAccount(composioAccountId, { revoke: true, triggerId });
    return null;
  },
});
