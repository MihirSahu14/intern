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

/** Deletes the account at Composio. Best-effort: our own row is already failed or gone. */
export async function forgetAccount(composioAccountId: string): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return;
  try {
    await deleteAccount(apiKey, composioAccountId);
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
    if (!apiKey) throw new ConvexError(`${c.label} is not set up yet.`);

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
      throw new ConvexError(`Couldn't reach Composio: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

type Finish = { ok: boolean; connector: ConnectorKey | null; reason?: string };

/**
 * After Composio confirmed `composioAccountId` belongs to `userId`: adopt it
 * if it is that member's own pending link from the last 15 minutes, retiring
 * any older grant. `forget` lists the Composio accounts to delete.
 */
export const activate = internalMutation({
  args: { userId: v.id("users"), composioAccountId: v.string(), toolkit: v.string() },
  handler: async (ctx, a): Promise<{ result: Finish; forget: string[] }> => {
    const c = CONNECTORS.find((x) => x.toolkit === a.toolkit);
    const rows = c
      ? await ctx.db
          .query("connections")
          .withIndex("by_userId_and_connector", (q) => q.eq("userId", a.userId).eq("connector", c.key))
          .take(50)
      : [];
    const row = rows.find((r) => r.composioAccountId === a.composioAccountId);
    if (!c || !row) {
      return { result: { ok: false, connector: c?.key ?? null, reason: "That connect link isn't one of yours." }, forget: [a.composioAccountId] };
    }
    if (row.status === "active") return { result: { ok: true, connector: c.key }, forget: [] };
    if (row.status !== "pending" || Date.now() - row.createdAt > FINISH_WINDOW) {
      await ctx.db.patch("connections", row._id, { status: "failed" });
      return { result: { ok: false, connector: c.key, reason: `That ${c.label} link expired. Try again.` }, forget: [a.composioAccountId] };
    }
    const forget: string[] = [];
    for (const o of rows) {
      if (o.status !== "active") continue;
      await ctx.db.patch("connections", o._id, { status: "failed" });
      if (o.composioAccountId) forget.push(o.composioAccountId);
    }
    await ctx.db.patch("connections", row._id, { status: "active" });
    return { result: { ok: true, connector: c.key }, forget };
  },
});

/**
 * Called by the cockpit with the `session_uri` Composio's verifier redirect
 * brought it. The member is whoever is signed in; there is no user id
 * argument to trust.
 */
export const finish = action({
  args: { sessionUri: v.string() },
  handler: async (ctx, { sessionUri }): Promise<Finish> => {
    const userId: Id<"users"> = await ctx.runQuery(internal.connections.member, {});
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new ConvexError("Connecting accounts is not set up yet.");

    let done: { accountId: string; toolkit: string };
    try {
      done = await completeAuth(apiKey, { sessionUri, userId });
    } catch (err) {
      const status = err instanceof ComposioError ? err.status : undefined;
      if (status === 400) {
        // Composio has already failed the connection. No address or token in the log.
        console.log(`connections.finish: Composio refused ${userId}'s identity for a verifier session`);
        return { ok: false, connector: null, reason: "Composio refused that link: it was started from another account." };
      }
      if (status === 404) return { ok: false, connector: null, reason: "That connect link expired or was already used." };
      return { ok: false, connector: null, reason: `Couldn't reach Composio: ${err instanceof Error ? err.message : String(err)}` };
    }

    const { result, forget } = await ctx.runMutation(internal.connections.activate, {
      userId,
      composioAccountId: done.accountId,
      toolkit: done.toolkit,
    });
    for (const id of forget) await forgetAccount(id);
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
    if (accountId) await forgetAccount(accountId);
    return null;
  },
});

/** Scheduled by `users.purge` for each live grant it deletes. */
export const forget = internalAction({
  args: { composioAccountId: v.string() },
  handler: async (_ctx, { composioAccountId }) => {
    await forgetAccount(composioAccountId);
    return null;
  },
});
