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
 * sends/day, connect-starts/hour. Never the shared $5/day budget, the
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

/**
 * The member who connected this Slack user id through Composio and may still
 * write to the brain, or null. Maps a community-Slack author to an @handle
 * and a 🧠 to its member.
 */
export async function slackMember(ctx: QueryCtx, slackUserId: string): Promise<Doc<"users"> | null> {
  const rows = await ctx.db
    .query("connections")
    .withIndex("by_externalUserId", (q) => q.eq("externalUserId", slackUserId))
    .take(10);
  for (const c of rows) {
    if (c.connector !== "slack" || c.status !== "active") continue;
    const u = await ctx.db.get("users", c.userId);
    if (u && !memberProblem(u)) return u;
  }
  return null;
}
