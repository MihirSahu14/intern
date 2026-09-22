import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { type Account, connect, deleteAccount, getAccount } from "../lib/composio.ts";
import { CONNECTORS, type ConnectorKey, connectorByKey, isConfigured } from "../lib/connectors.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  type QueryCtx,
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { requireMember } from "./access";
import { connectorKey } from "./schema";

/**
 * A member's accounts at Composio. One hop, inline: approve → Composio's
 * consent screen → `/composio/callback` → back to the cockpit, which calls
 * `finish` as the signed-in member. There is no settings page; the rail is the
 * only place to connect or disconnect.
 */

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

/** Records the account Composio made for this link: the only one the callback will accept. */
export const attach = internalMutation({
  args: { state: v.string(), composioAccountId: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", a.state)).unique();
    if (row?.status === "pending") await ctx.db.patch("connections", row._id, { composioAccountId: a.composioAccountId });
    return null;
  },
});

export const start = action({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }): Promise<string> => {
    const c = connectorByKey(connector);
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new ConvexError(`${c.label} is not set up yet.`);

    // Minted in an action, where randomness is real. Single use: the callback
    // only accepts a row that is still pending.
    const state = crypto.randomUUID();
    const userId: Id<"users"> = await ctx.runMutation(internal.connections.begin, { connector, state });
    try {
      const { redirectUrl, accountId } = await connect(apiKey, {
        userId,
        toolkit: c.toolkit,
        authConfigId: process.env[c.authConfigEnv] || undefined,
        callbackUrl: `${process.env.CONVEX_SITE_URL}/composio/callback?state=${state}`,
      });
      await ctx.runMutation(internal.connections.attach, { state, composioAccountId: accountId });
      return redirectUrl;
    } catch (err) {
      await ctx.runMutation(internal.connections.settle, { state, ok: false });
      throw new ConvexError(`Couldn't reach Composio: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export const byState = internalQuery({
  args: { state: v.string() },
  handler: async (ctx, { state }) =>
    await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", state)).unique(),
});

/**
 * Ends a pending row: active (retiring any older grant) or failed. Returns the
 * Composio accounts it retired, for the caller to delete there.
 */
export const settle = internalMutation({
  args: { state: v.string(), ok: v.boolean() },
  handler: async (ctx, a): Promise<string[]> => {
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", a.state)).unique();
    if (!row || row.status !== "pending") return [];
    if (!a.ok) {
      await ctx.db.patch("connections", row._id, { status: "failed" });
      return [];
    }
    const older = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", row.userId).eq("connector", row.connector))
      .take(50);
    const retired: string[] = [];
    for (const o of older) {
      if (o.status !== "active") continue;
      await ctx.db.patch("connections", o._id, { status: "failed" });
      if (o.composioAccountId && o.composioAccountId !== row.composioAccountId) retired.push(o.composioAccountId);
    }
    await ctx.db.patch("connections", row._id, { status: "active" });
    return retired;
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

/** How long a connect link stays finishable. */
const FINISH_WINDOW = 15 * 60_000;

type Finish = { ok: boolean; connector: ConnectorKey | null; reason?: string };

/** Fails a pending row and deletes its account at Composio: nobody may use that grant. */
async function refuse(ctx: MutationCtx, row: Doc<"connections">, reason: string): Promise<Finish> {
  await ctx.db.patch("connections", row._id, { status: "failed" });
  if (row.composioAccountId) {
    await ctx.scheduler.runAfter(0, internal.connections.forget, { composioAccountId: row.composioAccountId });
  }
  return { ok: false, connector: row.connector, reason };
}

/**
 * Called by the cockpit with the `state` the callback handed it. This is the
 * only way a connection goes active, and only for the signed-in member who
 * started it. That closes OAuth session fixation: if someone gets another
 * person to consent on their link, the consent lands in the other person's
 * browser, signed in as them (or not at all), and the grant is thrown away.
 */
export const finish = mutation({
  args: { state: v.string() },
  handler: async (ctx, { state }): Promise<Finish> => {
    const user = await requireMember(ctx);
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", state)).unique();
    if (!row) return { ok: false, connector: null, reason: "That connect link is unknown." };
    const label = connectorByKey(row.connector).label;
    if (row.userId !== user._id) {
      // Only a pending row: an active one is the owner's live grant, not ours to break.
      if (row.status !== "pending") return { ok: false, connector: row.connector, reason: "That connect link isn't yours." };
      console.log(`connections.finish: ${row._id} finished by another member; failing it and deleting its account`);
      return await refuse(ctx, row, `That ${label} link was started by someone else, so it was thrown away.`);
    }
    if (row.status === "active") return { ok: true, connector: row.connector };
    if (row.status === "failed") return { ok: false, connector: row.connector, reason: `Connecting ${label} didn't go through. Try again.` };
    if (Date.now() - row.createdAt > FINISH_WINDOW) {
      return await refuse(ctx, row, `That ${label} link expired. Try again.`);
    }
    await ctx.scheduler.runAfter(0, internal.connections.verify, { state });
    return { ok: true, connector: row.connector };
  },
});

/** Where the member's own link stands, so the cockpit can say how `finish` ended. */
export const outcome = query({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const userId = await getAuthUserId(ctx);
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", state)).unique();
    return row && row.userId === userId ? row.status : null;
  },
});

/**
 * Scheduled by `finish`. The account must be the one Composio made for this
 * row's link, and Composio's own record of it must say ACTIVE for the right
 * toolkit before anything goes active.
 */
export const verify = internalAction({
  args: { state: v.string() },
  handler: async (ctx, { state }) => {
    const row: Doc<"connections"> | null = await ctx.runQuery(internal.connections.byState, { state });
    if (!row || row.status !== "pending") return null;
    const apiKey = process.env.COMPOSIO_API_KEY;
    const accountId = row.composioAccountId;
    let account: Account | null = null;
    if (apiKey && accountId) {
      try {
        account = await getAccount(apiKey, accountId);
      } catch (err) {
        console.log(`composio get ${accountId} failed: ${String(err)}`);
      }
    }
    const c = connectorByKey(row.connector);
    // Composio no longer promises user_id here; when it does send one, it must be ours.
    const ok =
      !!account &&
      account.status === "ACTIVE" &&
      account.toolkit === c.toolkit &&
      (account.userId === undefined || account.userId === row.userId);

    const retired: string[] = await ctx.runMutation(internal.connections.settle, { state, ok });
    if (!ok && accountId) retired.push(accountId);
    for (const id of retired) await forgetAccount(id);
    return null;
  },
});

/**
 * GET /composio/callback?state=…&status=…&connected_account_id=…
 *
 * Writes nothing. The browser that lands here may not be the member who
 * started the link, and this endpoint can't see who is signed in, so it only
 * passes the `state` on to the cockpit, where `finish` checks who is asking.
 * Nothing else from the query string is read or passed on.
 */
export const callback = httpAction(async (ctx, req) => {
  const state = new URL(req.url).searchParams.get("state");
  const row: Doc<"connections"> | null = state ? await ctx.runQuery(internal.connections.byState, { state }) : null;
  const to = row?.status === "pending" && state ? `finish=${encodeURIComponent(state)}` : "connect_failed=1";
  return new Response(null, { status: 302, headers: { Location: `${process.env.SITE_URL}/app?${to}` } });
});
