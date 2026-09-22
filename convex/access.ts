import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
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

/** What other visitors may see about a person: GitHub handle and avatar. */
export async function ownerView(ctx: QueryCtx, id: Id<"users">) {
  const u = await ctx.db.get("users", id);
  return { handle: u?.handle ?? u?.name ?? "someone", image: u?.image ?? null };
}

/** Owner-only facts reach their owner alone. Absent means public. */
export const visibleTo = (f: Doc<"facts">, viewer: Id<"users"> | null) =>
  f.visibility !== "owner" || (viewer !== null && f.ownerId === viewer);
