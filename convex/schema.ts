import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The public community brain: private drafts, shared brain. Everyone reads
 * the public rows; owner-only facts and every draft's contents reach their
 * owner alone. Each row has one owner who alone can change it.
 */

export const factKind = v.union(
  v.literal("note"),
  v.literal("decision"),
  v.literal("preference"),
  v.literal("correction"),
  v.literal("answer"),
);

export const actionKind = v.union(v.literal("email"), v.literal("slack"), v.literal("calendar"));

export const actionStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  // Only a draft going out through a member's connected account reaches these.
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
  // A `failed` whose second Composio call never gave a clear answer — the
  // tool may already have run. Not resendable; `outbox.confirmUnsent` is the
  // owner clearing it to `failed` after checking their Sent folder.
  v.literal("unsure"),
);

export const connectorKey = v.union(v.literal("gmail"), v.literal("slack"));

/** Absent means public: every fact written before connectors existed. */
export const visibility = v.union(v.literal("public"), v.literal("owner"));

export const sourceKind = v.union(v.literal("slack_channel"), v.literal("document"), v.literal("github_repo"));

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
    visibility: v.optional(visibility),
    /** Set on facts captured from a member's own tools: the dedupe key for a redelivered event. */
    source: v.optional(v.string()),
    /** Set on a fact promoted from an archive passage: the graph hangs it off that passage's source. */
    fromPassageId: v.optional(v.id("passages")),
    text: v.string(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_ownerId_and_source", ["ownerId", "source"])
    .index("by_kind", ["kind"])
    .searchIndex("search_text", { searchField: "text" }),

  /**
   * Where passages come from: a public channel of the community Slack, a
   * member's document, or a public GitHub repo. A removed source keeps its
   * row, so it still counts toward its owner's day.
   */
  sources: defineTable({
    kind: sourceKind,
    label: v.string(),
    url: v.optional(v.string()),
    /** Slack channel id, a document's URL or `upload:<storageId>`, or `owner/repo` in lower case. */
    externalId: v.string(),
    /** Who added a document or repo. Slack channels belong to the community and have none. */
    ownerId: v.optional(v.id("users")),
    visibility,
    status: v.union(v.literal("active"), v.literal("failed"), v.literal("removed")),
    lastSyncedAt: v.optional(v.number()),
    /** Slack's `next_cursor` while a backfill is part-way. */
    cursor: v.optional(v.string()),
    /** Why the last read failed, in words the member can act on. */
    error: v.optional(v.string()),
    /**
     * A failed read dropped its passages (a repo gone private): until a read
     * succeeds again, none left over is recalled, listed or promoted.
     */
    cleared: v.optional(v.boolean()),
    /** An upload's file, deleted with the source. */
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_kind_and_externalId", ["kind", "externalId"])
    .index("by_ownerId", ["ownerId"]),

  /** One searchable piece of a source. Interns recall passages; only facts are drawn. */
  passages: defineTable({
    sourceId: v.id("sources"),
    /** `<channel>:<ts>`, a document chunk's index, or `readme` / `issue:N` / `pr:N`. */
    externalId: v.string(),
    text: v.string(),
    author: v.optional(v.string()),
    /** The member's GitHub handle, when the Slack author is a member who connected that account. */
    authorHandle: v.optional(v.string()),
    url: v.optional(v.string()),
    at: v.number(),
    visibility,
    ownerId: v.optional(v.id("users")),
    /** Set once: the fact this passage became, at least as visible as the passage. */
    promotedFactId: v.optional(v.id("facts")),
  })
    .index("by_sourceId_and_externalId", ["sourceId", "externalId"])
    .index("by_sourceId_and_at", ["sourceId", "at"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["visibility", "ownerId"] }),

  /** Slack display names, one row per Slack user, so each is asked for once. */
  slackUsers: defineTable({ slackUserId: v.string(), name: v.string() }).index("by_slackUserId", ["slackUserId"]),

  /**
   * A passage deleted in Slack, kept so a retried "message" delivery (the
   * original post, redelivered after the delete already landed) can't bring
   * it back. Slack channel sources are never removed, so nothing prunes this.
   */
  slackTombstones: defineTable({ sourceId: v.id("sources"), externalId: v.string() }).index(
    "by_sourceId_and_externalId",
    ["sourceId", "externalId"],
  ),

  interns: defineTable({
    ownerId: v.id("users"),
    /** The working prompt this run reads and recalls against — may quote a private Q&A. */
    task: v.string(),
    /** The original ask, safe to show a non-owner in place of `task`. Set only when `task` was assembled from a question's answer. */
    displayTask: v.optional(v.string()),
    status: internStatus,
    resumes: v.optional(v.id("interns")),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    /** False when the run died on the model being busy (429/503/529), so it isn't charged. */
    countsTowardCap: v.boolean(),
    // Eval fields, one row per run.
    promptVersion: v.optional(v.string()),
    recalledFactIds: v.optional(v.array(v.id("facts"))),
    recalledCorrection: v.optional(v.boolean()),
    /** True when any recalled fact was owner-only — this run's own fact blocks then file owner-only too. */
    recalledPrivate: v.optional(v.boolean()),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    /** "action" | "action_malformed:<why>" | "question" | "none" */
    parseOutcome: v.optional(v.string()),
    /** Which of the owner's accounts a draft could go out through when this run started: the brief's live-or-sandbox switch. */
    sendsFrom: v.optional(v.array(connectorKey)),
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
    status: actionStatus,
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
    /** Copied from the run: it read an owner-only fact, so the draft may quote one — and so may what's learned from it. */
    recalledPrivate: v.optional(v.boolean()),
    /**
     * The run was briefed for real sending on this draft's account. Absent: it
     * was drafted under the sandbox prompt, whose recipients are placeholders
     * (#general, name@example.com) — see `outbox.decide`.
     */
    draftedLive: v.optional(v.boolean()),
    decision: v.optional(
      v.union(v.literal("approved_unedited"), v.literal("edited"), v.literal("rejected")),
    ),
    editRatio: v.optional(v.number()),
    reason: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    /** Set when a connected account accepted the send. */
    sentAt: v.optional(v.number()),
    /** Composio's reason, when a send failed. */
    sendError: v.optional(v.string()),
    /** Which connected account it went through. Counts toward SENDS_PER_DAY. */
    connector: v.optional(connectorKey),
    /** Composio send calls made for this draft, the first included. `outbox.resend` stops at SEND_ATTEMPTS. */
    attempts: v.optional(v.number()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"])
    .index("by_internId", ["internId"])
    .index("by_ownerId_and_decidedAt", ["ownerId", "decidedAt"]),

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

  /**
   * A member's link to one account at Composio. `state` keys the row until
   * Composio's account id is known; after that `finish` finds it by
   * `composioAccountId`. The user id never comes from a URL.
   */
  connections: defineTable({
    userId: v.id("users"),
    connector: connectorKey,
    composioAccountId: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    /** The member's own id inside the tool (Slack user id): who a 🧠 must come from. */
    externalUserId: v.optional(v.string()),
    /**
     * A Gmail grant made only to read the `Intern` label, through its own
     * read-only auth config and its own consent. Absent: the send grant.
     */
    capture: v.optional(v.boolean()),
    /** The Composio trigger on this account, deleted with it. */
    triggerId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    state: v.string(),
    createdAt: v.number(),
  })
    .index("by_userId_and_connector", ["userId", "connector"])
    .index("by_userId_and_createdAt", ["userId", "createdAt"])
    .index("by_state", ["state"])
    .index("by_composioAccountId", ["composioAccountId"])
    .index("by_externalUserId", ["externalUserId"]),

  /** One row per UTC hour: how many broadcasts went out. */
  broadcasts: defineTable({
    hour: v.string(),
    count: v.number(),
  }).index("by_hour", ["hour"]),
});
