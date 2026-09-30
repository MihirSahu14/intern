/**
 * Shared types for the cockpit.
 */

export type Mode = "live" | "sim";

// ---------------------------------------------------------------------------
// Graph — the company brain
// ---------------------------------------------------------------------------

export type NodeKind =
  | "source"
  | "contact"
  | "project"
  | "note"
  | "followup"
  | "wiki"
  | "tag"
  | "intern"
  | "action"
  | "fact"
  | "question";

export type GraphNode = {
  id: string;
  label: string;
  kind: NodeKind;
  /** Rough importance — drives node radius. */
  weight?: number;
  detail?: string;
  meta?: Record<string, string | number | boolean | null>;
};

export type GraphEdge = {
  source: string;
  target: string;
  /** Free-form relation label, e.g. "tagged", "owns", "cites". */
  rel?: string;
};

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  mode: Mode;
  generatedAt: number;
};

export type FactKind =
  | "note"
  | "decision"
  | "preference"
  | "correction"
  | "answer"
  | "person"
  | "project";

// ---------------------------------------------------------------------------
// Interns — long-running subagents
// ---------------------------------------------------------------------------

export type InternStatus =
  | "queued"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";

export type Artifact = {
  kind: "note" | "wiki" | "contact" | "project" | "followup" | "answer";
  label: string;
  ref?: string;
};

export type Intern = {
  id: string;
  /**
   * The Convex user id of whoever dispatched it. An intern works one person's
   * inbox with one person's credentials, so it is theirs alone to see and to
   * stop — there is no ownerless intern.
   */
  ownerId: string;
  /** Short handle shown in the UI, e.g. `int-7f2`. */
  handle: string;
  task: string;
  /**
   * The member's own words, when they differ from `task` — set on a
   * question-resumed intern, whose `task` quotes the answer. Only present on
   * your own interns; show `displayTask ?? task` as the label everywhere.
   */
  displayTask?: string;
  status: InternStatus;
  mode: Mode;
  createdAt: number;
  /** Open question that parked it, if any. */
  blockedBy?: string;
  /** The intern this one is resuming, if it was spawned off an answer. */
  resumes?: string;
  startedAt?: number;
  endedAt?: number;
  /** Tools the intern has reached for, in order of first use. */
  tools: string[];
  toolCalls: number;
  /** Tool calls that came back an error. A run can finish with these > 0. */
  toolErrors: number;
  artifacts: Artifact[];
  summary?: string;
  error?: string;
  sessionId: string;
};

// ---------------------------------------------------------------------------
// Outbox — what interns propose, and a human approves
// ---------------------------------------------------------------------------

export type ActionKind = "email" | "slack" | "calendar";

/**
 * What `actions.status` stores. A sandbox approval stops at `approved`;
 * `sending`/`sent`/`failed`/`unsure` exist only for a draft going out through
 * a member's connected account. `unsure` is a `failed` whose second Composio
 * call (the one that may have already reached Gmail/Slack) never gave a
 * clear answer — a network drop or a 5xx — so it is never offered a plain
 * retry; `outbox.confirmUnsent` is the owner saying they checked and it's
 * safe to turn into an ordinary `failed`.
 */
export type ActionStatus = "pending" | "approved" | "rejected" | "sending" | "sent" | "failed" | "unsure";

export type Draft = {
  /** Email addresses, or Slack channel ids/names for a slack action. */
  to: string[];
  cc?: string[];
  /** Email subject, event title, or the bold first line of a Slack post. */
  subject: string;
  body: string;
  /** Calendar only. ISO 8601. */
  startsAt?: string;
  endsAt?: string;
};

/**
 * An outbound action an intern wants taken. Intern never sends — it proposes.
 * VoiceOS reads it aloud, the human says yes, VoiceOS sends with its own
 * credentials and reports back via `outbox_record_result`.
 */
export type ProposedAction = {
  id: string;
  internId: string | null;
  /** Whose intern proposed it — only they see it, only they decide it. */
  ownerId: string | null;
  /** What surface it goes out on. Trust is tracked against this. */
  kind: ActionKind;
  status: ActionStatus;
  /** One line, written to be spoken. */
  title: string;
  /** What the intern proposed. Immutable — this half is the training signal. */
  draft: Draft;
  /**
   * What the person actually approved, when they changed something. Kept
   * separate from `draft` on purpose: collapsing the two would throw away the
   * only record of what the intern got wrong.
   */
  accepted?: Draft;
  /** Which fields the person rewrote before approving. */
  editedFields?: (keyof Draft)[];
  /** Why the intern thinks this should go out. */
  rationale: string;
  /** Graph node ids / urls the draft was built from. */
  sources: string[];
  createdAt: number;
  decidedAt?: number;
  settledAt?: number;
  decidedVia?: "voice" | "cockpit" | "graduated";
  /** What the executor reported back. */
  result?: string;
  /** Which connected account it went out through, if it went out at all. */
  connector?: string;
  /** Composio's reason, when a send failed. */
  sendError?: string;
  /** Written knowing it could really go out. False: its recipients are sandbox placeholders. */
  draftedLive?: boolean;
  /**
   * Only set on a pending, non-`draftedLive` draft: whether every recipient
   * in `draft` already appears in the brief the owner typed, so it may go
   * live unedited (`lib/recipients.ts`'s `recipientsInBrief`).
   */
  recipientsMatchBrief?: boolean;
};

/** What would actually go out: the person's version if they wrote one. */
export const outgoing = (a: ProposedAction): Draft => a.accepted ?? a.draft;

export type LogLevel = "sys" | "in" | "out" | "tool" | "ok" | "warn" | "err";

export type LogLine = {
  id: number;
  /** null for cockpit-level lines that aren't owned by an intern. */
  internId: string | null;
  /**
   * Whose terminal this line belongs in. Inherited from the intern that wrote
   * it; null means a system line about the deployment,
   * not about anybody's work.
   */
  ownerId: string | null;
  ts: number;
  level: LogLevel;
  text: string;
};
