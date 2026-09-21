import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * The caller, if they may write to the public brain: signed in, consented,
 * not banned. Every mutation that writes starts here.
 */
export async function requireMember(ctx: QueryCtx): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get("users", userId) : null;
  if (!user) throw new ConvexError("Sign in first.");
  if (user.bannedAt) throw new ConvexError("This account is blocked from the public brain.");
  if (!user.acceptedAt) throw new ConvexError("Accept the public-brain notice first.");
  return user;
}

/** What other visitors may see about a person: GitHub handle and avatar. */
export async function ownerView(ctx: QueryCtx, id: Id<"users">) {
  const u = await ctx.db.get("users", id);
  return { handle: u?.handle ?? u?.name ?? "someone", image: u?.image ?? null };
}
