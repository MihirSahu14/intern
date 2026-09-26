import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { isCapExempt } from "../lib/caps.ts";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** Why this person may not write to the brain, or null if they may. */
export function memberProblem(user: Doc<"users"> | null): string | null {
  if (!user) return "Sign in first.";
  if (user.bannedAt) return "This account is blocked from the public brain.";
  if (!user.acceptedAt) return "Accept the public-brain notice first.";
  return null;
}

/**
 * The caller, if they may write to the public brain: signed in, consented,
 * not banned. Every mutation that writes starts here; the inbound webhook,
 * which has no session, applies `memberProblem` itself.
 */
export async function requireMember(ctx: QueryCtx): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get("users", userId) : null;
  const problem = memberProblem(user);
  if (problem !== null || !user) throw new ConvexError(problem ?? "Sign in first.");
  return user;
}

/**
 * `CAP_EXEMPT_HANDLES` (comma-separated, case-insensitive — see
 * `lib/caps.ts`'s `isCapExempt`), for the deployment owner's own testing.
 * Skips PER-MEMBER caps only: briefs/day, one-concurrent-intern, facts/day,
 * sends/day, sources/day, connect-starts/hour. Never the shared $5/day budget, the
 * DAY_WINDOW overflow guard (a safety check against miscounting, not a
 * quota), or the resend-attempts cap (it protects recipients from a
 * duplicate send, not the member from a limit) — every cap site passes this
 * in as `exempt` and still runs those unconditionally.
 */
export async function capExempt(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const user = await ctx.db.get("users", userId);
  return isCapExempt(user?.handle, process.env.CAP_EXEMPT_HANDLES);
}

/** What other visitors may see about a person: GitHub handle and avatar. */
export async function ownerView(ctx: QueryCtx, id: Id<"users">) {
  const u = await ctx.db.get("users", id);
  return { handle: u?.handle ?? u?.name ?? "someone", image: u?.image ?? null };
}

/** Owner-only rows (facts, passages, sources) reach their owner alone. Absent means public. */
export const visibleTo = (row: { visibility?: "public" | "owner"; ownerId?: Id<"users"> }, viewer: Id<"users"> | null) =>
  row.visibility !== "owner" || (viewer !== null && row.ownerId === viewer);

/** A source whose passages still count: there, not removed, not cleared by a failed read. */
export const live = (s: Doc<"sources"> | null): s is Doc<"sources"> => !!s && s.status !== "removed" && !s.cleared;

async function firstActiveSlackConnection(ctx: QueryCtx, slackUserId: string) {
  const rows = await ctx.db
    .query("connections")
    .withIndex("by_externalUserId", (q) => q.eq("externalUserId", slackUserId))
    .take(10);
  return rows.find((c) => c.connector === "slack" && c.status === "active") ?? null;
}

/**
 * The member linked to this Slack user id through Composio, regardless of
 * their standing — even banned or not yet consented. A 🧠 from a linked
 * account that can't write must promote nothing, never fall through to
 * anonymous, so callers that decide that check this before `memberProblem`.
 */
export async function slackLinkedUser(ctx: QueryCtx, slackUserId: string): Promise<Doc<"users"> | null> {
  const conn = await firstActiveSlackConnection(ctx, slackUserId);
  return conn ? await ctx.db.get("users", conn.userId) : null;
}

/**
 * The member who connected this Slack user id through Composio and may still
 * write to the brain, or null. Maps a community-Slack author to an @handle
 * and a 🧠 to its member.
 */
export async function slackMember(ctx: QueryCtx, slackUserId: string): Promise<Doc<"users"> | null> {
  const u = await slackLinkedUser(ctx, slackUserId);
  return u && !memberProblem(u) ? u : null;
}
