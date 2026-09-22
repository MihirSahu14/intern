import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { ComposioError, completeAuth, connect, deleteAccount } from "../lib/composio.ts";
import { CONNECTORS, type ConnectorKey, connectorByKey, isConfigured } from "../lib/connectors.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type QueryCtx, action, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { requireMember } from "./access";
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
 */

/** How long a connect link stays finishable. */
const FINISH_WINDOW = 15 * 60_000;

/** The member's live grant for one connector, if any. */
export async function activeConnection(
  ctx: QueryCtx,
  userId: Id<"users">,
  connector: ConnectorKey,
): Promise<Doc<"connections"> | null> {
  return await ctx.db
    .query("connections")
    .withIndex("by_userId_and_connector", (q) => q.eq("userId", userId).eq("connector", connector))
    .order("desc")
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();
}

/**
 * Deletes the account at Composio. Best-effort: our own row is already failed
 * or gone. `revoke` only when the member is done with that account
 * (disconnect, purge); see deleteAccount.
 */
export async function forgetAccount(composioAccountId: string, a: { revoke: boolean }): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return;
  try {
    await deleteAccount(apiKey, composioAccountId, a);
  } catch (err) {
    console.log(`composio delete ${composioAccountId} failed: ${String(err)}`);
  }
}

/** One row per connector for the rail. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return await Promise.all(
      CONNECTORS.map(async (c) => {
        const row = userId ? await activeConnection(ctx, userId, c.key) : null;
        return {
          key: c.key,
          label: c.label,
          forKind: c.forKind,
          configured: isConfigured(c, process.env),
          connected: !!row,
          accountLabel: row?.accountLabel ?? null,
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
  args: { connector: connectorKey, state: v.string() },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    await ctx.db.insert("connections", {
      userId: user._id,
      connector: a.connector,
      status: "pending",
      state: a.state,
      createdAt: Date.now(),
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

export const start = action({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }): Promise<string> => {
    const c = connectorByKey(connector);
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey || !isConfigured(c, process.env)) throw new ConvexError(`${c.label} is not set up yet.`);

    // Our key for the row while Composio's account id is still unknown.
    const state = crypto.randomUUID();
    const userId: Id<"users"> = await ctx.runMutation(internal.connections.begin, { connector, state });
    try {
      const { redirectUrl, accountId } = await connect(apiKey, {
        userId,
        toolkit: c.toolkit,
        authConfigId: process.env[c.authConfigEnv] || undefined,
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

type Finish = { ok: boolean; connector: ConnectorKey | null; reason?: string };

/**
 * After Composio confirmed `composioAccountId` for the signed-in member: adopt
 * it only if it is on that member's own pending link from the last 15 minutes,
 * retiring any older grant. Checks the member itself rather than trusting the
 * caller. `forget` lists the Composio accounts to delete, without revoking.
 */
export const activate = internalMutation({
  args: { composioAccountId: v.string() },
  handler: async (ctx, { composioAccountId }): Promise<{ result: Finish; forget: string[] }> => {
    const user = await requireMember(ctx);
    const row = await ctx.db
      .query("connections")
      .withIndex("by_composioAccountId", (q) => q.eq("composioAccountId", composioAccountId))
      .first();
    const refused = (reason: string) => ({
      result: { ok: false, connector: row?.connector ?? null, reason },
      forget: [composioAccountId],
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
    if (row.status === "active") return { result: { ok: true, connector: c.key }, forget: [] };
    if (row.status !== "pending" || Date.now() - row.createdAt > FINISH_WINDOW) {
      if (row.status === "pending") await ctx.db.patch("connections", row._id, { status: "failed" });
      return refused(`That ${c.label} link expired. Try again.`);
    }

    // Newest first, active only: however many attempts came before, the live
    // grant can't fall outside the read.
    const forget: string[] = [];
    const older = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", user._id).eq("connector", c.key))
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(10);
    for (const o of older) {
      await ctx.db.patch("connections", o._id, { status: "failed" });
      // No revoke on retire: same Google account, it would kill the grant just given.
      if (o.composioAccountId) forget.push(o.composioAccountId);
    }
    await ctx.db.patch("connections", row._id, { status: "active" });
    return { result: { ok: true, connector: c.key }, forget };
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
    try {
      ({ accountId } = await completeAuth(apiKey, { sessionUri, userId }));
    } catch (err) {
      const status = err instanceof ComposioError ? err.status : undefined;
      console.log(`connections.finish: complete_auth failed for ${userId}: ${String(err)}`);
      // 400: Composio refused the identity and has failed the connection itself.
      if (status === 400) return { ok: false, connector: null, reason: "Composio refused that link: it was started from another account." };
      if (status === 404) return { ok: false, connector: null, reason: "That connect link expired or was already used." };
      return { ok: false, connector: null, reason: "Couldn't reach Composio. Try again." };
    }

    const { result, forget } = await ctx.runMutation(internal.connections.activate, { composioAccountId: accountId });
    for (const id of forget) await forgetAccount(id, { revoke: false });
    return result;
  },
});

export const drop = internalMutation({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }) => {
    const user = await requireMember(ctx);
    const row = await activeConnection(ctx, user._id, connector);
    if (!row) return null;
    await ctx.db.patch("connections", row._id, { status: "failed" });
    return row.composioAccountId ?? null;
  },
});

export const disconnect = action({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }): Promise<null> => {
    const accountId: string | null = await ctx.runMutation(internal.connections.drop, { connector });
    if (accountId) await forgetAccount(accountId, { revoke: true });
    return null;
  },
});

/** Scheduled by `users.purge` for each live grant it deletes. */
export const forget = internalAction({
  args: { composioAccountId: v.string() },
  handler: async (_ctx, { composioAccountId }) => {
    await forgetAccount(composioAccountId, { revoke: true });
    return null;
  },
});
