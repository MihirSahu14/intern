/**
 * Shared types for the Scout cockpit.
 *
 * The cockpit talks to a running Scout (the Python company-brain agent in
 * `scout/`). When Scout is unreachable the same shapes are produced by the
 * local simulator in `lib/sim.ts`, so the UI never has a dead state.
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
  meta?: Record<string, string | number | null>;
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

// ---------------------------------------------------------------------------
// The fact layer — observations in, citable facts out
//
// The log is the spine. Observations are immutable and never edited; facts are
// derived from them and disposable, so a bad extraction is fixed by promoting
// again rather than by migrating anything.
// ---------------------------------------------------------------------------

/** One immutable thing that was seen at a source. */
export type Observation = {
  id: string;
  /** Where it came from: `voice`, `slack`, `cockpit`, `intern:int-01`. */
  sourceId: string;
  /** Stable id *within* that source. `(sourceId, externalId)` is unique. */
  externalId: string;
  /** Who put it there — the person, not the intern. */
  actor: string;
  title: string;
  body: string;
  url?: string;
  observedAt: number;
  ingestedAt: number;
  /**
   * What extraction made of it. Carried on the observation so replaying the
   * log rebuilds the same facts instead of a pile of untyped notes.
   */
  hint?: {
    kind: FactKind;
    tags?: string[];
    subject?: string;
    /** Graph node ids the fact should hang off. See `Fact.links`. */
    links?: string[];
  };
};

export type FactKind =
  | "note"
  | "decision"
  | "preference"
  | "correction"
  | "answer"
  | "person"
  | "project";

/**
 * A promoted, deduplicated, citable claim. Facts supersede rather than
 * overwrite: a superseded fact keeps its body and gets `validTo`, so what was
 * true in February is still answerable in September.
 */
export type Fact = {
  id: string;
  kind: FactKind;
  title: string;
  body: string;
  tags: string[];
  /** Rises as independent observations corroborate it. Never reaches 1. */
  confidence: number;
  validFrom: number;
  validTo?: number;
  supersededBy?: string;
  /** Provenance. Never empty — a fact with no observation is a guess. */
  observations: string[];
  /** Who or what it is about. For a preference, the role it binds to. */
  subject?: string;
  /**
   * Graph node ids this fact was deliberately attached to — the project it is
   * about, the person who said it. Set when a human files it against something
   * they had selected, which is the only time anyone knows the connection for
   * certain; extraction guesses, so it leaves this empty and lets tags do the
   * joining instead.
   */
  links?: string[];
  /** Union of its observations' sources, e.g. `slack:C0192`, `company:public`. */
  scopes: string[];
};

export type JournalKind =
  | "observation"
  | "fact"
  | "supersede"
  | "spawn"
  | "handover"
  | "decision"
  | "question"
  | "answer"
  | "graduation"
  | "send";

/**
 * Append-only activity. Every entry carries the actor triple — which person,
 * via which intern, through which source — so one field serves provenance, the
 * live UI, and the record of who contributed.
 */
export type JournalEntry = {
  id: number;
  at: number;
  kind: JournalKind;
  actor: string;
  internId: string | null;
  sourceId: string | null;
  ref: string;
  detail: string;
};

export type BrainStats = {
  observations: number;
  facts: number;
  superseded: number;
  byKind: Record<string, number>;
  journal: number;
};

// ---------------------------------------------------------------------------
// Trust — earned per kind of action, not per kind of intern
//
// There used to be a roster here: researcher, correspondent, archivist,
// onboarder. It was fiction. A person does many kinds of task, and so does an
// intern; sorting them into job titles made the trust number mean nothing you
// could act on ("the correspondent is right 90% of the time" — at what?).
//
// What a person actually decides on is an outgoing action, and those have a
// real type: an email, a Slack post, a calendar invite. Tracking trust against
// that gives a true and useful statement — "8 of 9 Slack posts went out
// unedited" — and it maps exactly onto the thing graduation switches off.
// ---------------------------------------------------------------------------

/**
 * How often work of one kind is accepted with no edits, over everything a
 * person has decided on. Crossing the threshold *proposes* graduation; a person
 * confirms it. Graduation is never automatic.
 */
export type TrustRecord = {
  kind: ActionKind;
  decisions: number;
  unedited: number;
  edited: number;
  rejected: number;
  rate: number;
  graduated: boolean;
  /** Threshold crossed, waiting on a person. */
  proposed: boolean;
};

// ---------------------------------------------------------------------------
// Questions — missing context becomes an ask, never a guess
// ---------------------------------------------------------------------------

export type QuestionStatus = "open" | "answered" | "dismissed";

export type Question = {
  id: string;
  internId: string | null;
  /** Whose intern got stuck — the question goes back to them, not the room. */
  ownerId: string | null;
  question: string;
  /** What the intern was doing when it got stuck. */
  context: string;
  status: QuestionStatus;
  answer?: string;
  askedAt: number;
  answeredAt?: number;
  /** The intern spawned to pick the work back up once answered. */
  resumedBy?: string;
};

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

/** Every surface work can go out on — and so every surface trust is earned on. */
export const ACTION_KINDS: ActionKind[] = ["email", "slack", "calendar"];

export type ActionStatus =
  | "pending"
  | "approved"
  | "sent"
  | "rejected"
  | "failed";

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
};

/** What would actually go out: the person's version if they wrote one. */
export const outgoing = (a: ProposedAction): Draft => a.accepted ?? a.draft;

export type ConnectorStatus = {
  kind: ActionKind;
  /** null when nothing is configured for this surface. */
  id: string | null;
  label: string;
  /**
   * The plumbing is in place — an operator has set what this deployment needs.
   * Says nothing about whether *you* can send, which is `connected`.
   */
  configured: boolean;
  /**
   * You, specifically, have a live grant for this surface.
   *
   * Kept apart from `configured` because collapsing the two is what let the
   * panel show a green light off nothing but environment variables, while the
   * viewer had never linked an account.
   */
  connected: boolean;
  /** Which account it would go out as, when connected. */
  account?: string;
  /** Connected once, but the grant is dead — revoked, expired. Reconnect. */
  broken?: boolean;
  brokenReason?: string;
  requires: string[];
  missing: string[];
};

export type ConnectorsState = {
  dryRun: boolean;
  connectors: ConnectorStatus[];
};

export type LogLevel = "sys" | "in" | "out" | "tool" | "ok" | "warn" | "err";

export type LogLine = {
  id: number;
  /** null for cockpit-level lines that aren't owned by an intern. */
  internId: string | null;
  /**
   * Whose terminal this line belongs in. Inherited from the intern that wrote
   * it; null means a system line — "scout unreachable", "brain replayed" —
   * which is about the deployment, not about anybody's work.
   */
  ownerId: string | null;
  ts: number;
  level: LogLevel;
  text: string;
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export type ContextStatus = {
  id: string;
  name: string;
  ok: boolean;
  detail?: string;
  tools: string[];
};

export type SystemState = {
  mode: Mode;
  scoutUrl: string;
  reachable: boolean;
  checkedAt: number;
  contexts: ContextStatus[];
  note?: string;
  /**
   * What is actually doing the thinking, for display. Scout's URL alone stopped
   * answering that question once Gemini could run an intern — in a deployment
   * with no Scout it reads `localhost:8000`, which is both wrong and the first
   * thing anyone asks about.
   */
  runner?: string;
};

// ---------------------------------------------------------------------------
// Event stream (SSE)
// ---------------------------------------------------------------------------

export type CockpitEvent =
  | {
      type: "snapshot";
      interns: Intern[];
      log: LogLine[];
      system: SystemState;
      outbox: ProposedAction[];
      questions: Question[];
      trust: TrustRecord[];
      brain: BrainStats;
    }
  | { type: "log"; line: LogLine }
  | { type: "intern"; intern: Intern }
  | { type: "graph"; graph: Graph }
  | { type: "system"; system: SystemState }
  | { type: "action"; action: ProposedAction }
  | { type: "question"; question: Question }
  | { type: "trust"; trust: TrustRecord[] }
  | { type: "brain"; brain: BrainStats };
