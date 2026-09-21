import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The public community brain. Everyone reads everything; each row has one
 * owner who alone can change it.
 */

export const factKind = v.union(
  v.literal("note"),
  v.literal("decision"),
  v.literal("preference"),
  v.literal("correction"),
  v.literal("answer"),
);

export const actionKind = v.union(v.literal("email"), v.literal("slack"), v.literal("calendar"));

export const draft = v.object({
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  subject: v.string(),
  body: v.string(),
});

export const logLevel = v.union(
  v.literal("sys"),
  v.literal("in"),
  v.literal("out"),
  v.literal("tool"),
  v.literal("ok"),
  v.literal("warn"),
  v.literal("err"),
);

export const internStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export default defineSchema({
  ...authTables,

  /** Convex Auth's users table plus the GitHub profile and the two gates. */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    handle: v.optional(v.string()),
    githubId: v.optional(v.string()),
    acceptedAt: v.optional(v.number()),
    bannedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_handle", ["handle"]),

  /** One claim. Seed facts have no owner. `text` = title + body, for search. */
  facts: defineTable({
    title: v.string(),
    body: v.string(),
    kind: factKind,
    ownerId: v.optional(v.id("users")),
    internId: v.optional(v.id("interns")),
    text: v.string(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_kind", ["kind"])
    .searchIndex("search_text", { searchField: "text" }),

  interns: defineTable({
    ownerId: v.id("users"),
    task: v.string(),
    status: internStatus,
    resumes: v.optional(v.id("interns")),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    /** False when the run died on Gemini's free-tier 429, so it isn't charged. */
    countsTowardCap: v.boolean(),
    // Eval fields, one row per run.
    promptVersion: v.optional(v.string()),
    recalledFactIds: v.optional(v.array(v.id("facts"))),
    recalledCorrection: v.optional(v.boolean()),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    /** "action" | "action_malformed:<why>" | "question" | "none" */
    parseOutcome: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"]),

  logs: defineTable({
    internId: v.id("interns"),
    level: logLevel,
    text: v.string(),
  }).index("by_internId", ["internId"]),

  actions: defineTable({
    ownerId: v.id("users"),
    internId: v.id("interns"),
    kind: actionKind,
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    title: v.string(),
    /** What the intern proposed. Never overwritten. */
    draft,
    /** What the person approved, when they changed something. */
    accepted: v.optional(draft),
    editedFields: v.optional(v.array(v.string())),
    rationale: v.string(),
    sources: v.array(v.string()),
    /** Copied from the run: did it recall a preference/correction? Drives /stats. */
    recalledCorrection: v.boolean(),
    decision: v.optional(
      v.union(v.literal("approved_unedited"), v.literal("edited"), v.literal("rejected")),
    ),
    editRatio: v.optional(v.number()),
    reason: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"])
    .index("by_internId", ["internId"]),

  questions: defineTable({
    ownerId: v.id("users"),
    internId: v.id("interns"),
    question: v.string(),
    context: v.string(),
    status: v.union(v.literal("open"), v.literal("answered"), v.literal("dismissed")),
    answer: v.optional(v.string()),
    resumedBy: v.optional(v.id("interns")),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"]),

  /** One row per UTC day. The global budget reads this. */
  usage: defineTable({
    date: v.string(),
    costUsd: v.number(),
    runs: v.number(),
  }).index("by_date", ["date"]),
});
