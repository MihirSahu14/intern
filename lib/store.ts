/**
 * Server-side cockpit state: intern registry, log ring buffer, brain graph,
 * and the fan-out bus that feeds `/api/events`.
 *
 * Held in module scope and pinned to `globalThis` so dev hot-reload doesn't
 * orphan running interns.
 */

import type {
  CockpitEvent,
  ContextStatus,
  Graph,
  GraphEdge,
  GraphNode,
  Intern,
  LogLevel,
  LogLine,
  ActionKind,
  ActionStatus,
  Draft,
  Fact,
  Mode,
  ProposedAction,
  Question,
  SystemState,
} from "./types";
import { outgoing } from "./types";
import { parseActionBlock } from "./action-block";
import * as gemini from "./gemini";
import * as scout from "./scout";
import {
  planSim,
  seedGraph,
  simOutboundDraft,
  simQuestion,
  simSummary,
} from "./sim";
import {
  DRY_RUN,
  connectorFor,
  connectorStatus,
  execute,
} from "./connectors";
import * as brain from "./brain";
import { notifyDone, notifyQuestion } from "./notify";
import * as trust from "./trust";

const LOG_CAP = 1200;
const MAX_CONCURRENT = 4;

type Subscriber = (e: CockpitEvent) => void;

/**
 * One open cockpit stream. The bus is process-wide and every signed-in person
 * shares it, so each listener carries the owner it is allowed to hear about —
 * filtering at the fan-out is what keeps one process from being one audience.
 */
type Listener = { fn: Subscriber; ownerId: string };

type Store = {
  interns: Map<string, Intern>;
  controllers: Map<string, AbortController>;
  queue: string[];
  running: number;
  log: LogLine[];
  logSeq: number;
  graph: Graph;
  system: SystemState;
  outbox: Map<string, ProposedAction>;
  questions: Map<string, Question>;
  /** The last graph read from Scout or seeded, before our facts are grafted on. */
  base: Graph;
  subs: Set<Listener>;
  probing: Promise<void> | null;
  lastProbe: number;
};

declare global {
  var __internCockpit: Partial<Store> | undefined;
}

function create(): Store {
  return {
    interns: new Map(),
    controllers: new Map(),
    queue: [],
    running: 0,
    log: [],
    logSeq: 0,
    graph: seedGraph(),
    system: {
      mode: "sim",
      scoutUrl: scout.SCOUT_URL,
      reachable: false,
      checkedAt: 0,
      contexts: [],
      note: "probing brain…",
    },
    outbox: new Map(),
    questions: new Map(),
    base: seedGraph(),
    subs: new Set(),
    probing: null,
    lastProbe: 0,
  };
}

/**
 * Hot reload keeps the old object, so a store created before a field existed
 * would come back missing it. Backfill anything absent instead of trusting the
 * shape — the maps stay identical, so in-flight interns keep writing to the
 * same place.
 */
const store: Store = Object.assign(create(), globalThis.__internCockpit ?? {});
globalThis.__internCockpit = store;

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export function subscribe(fn: Subscriber, ownerId: string): () => void {
  const listener: Listener = { fn, ownerId };
  store.subs.add(listener);
  return () => store.subs.delete(listener);
}

/**
 * Whose event this is, or null for the ones that belong to the deployment
 * rather than to a person — the graph, scout's reachability, trust levels,
 * brain stats. Anything derived from an intern carries that intern's owner.
 */
function ownerOf(e: CockpitEvent): string | null {
  switch (e.type) {
    case "intern":
      return e.intern.ownerId;
    case "log":
      return e.line.ownerId;
    case "action":
      return e.action.ownerId;
    case "question":
      return e.question.ownerId;
    default:
      return null;
  }
}

/**
 * The shared graph as one person may see it.
 *
 * Interns, the questions they park on and the drafts they propose are all
 * grafted in as nodes carrying their own text, so the graph — otherwise
 * deliberately shared — is where someone else's brief would show through.
 * Those three kinds are dropped unless they're the viewer's. Everything the
 * intern *learned* stays: facts, contacts, projects and wiki pages are the
 * company brain, and the whole point is that it is one brain.
 */
export function visibleGraph(graph: Graph, ownerId: string): Graph {
  const mine = (id: string, kind: GraphNode["kind"]) => {
    switch (kind) {
      case "intern":
        return store.interns.get(id)?.ownerId === ownerId;
      case "question":
        return store.questions.get(id)?.ownerId === ownerId;
      case "action":
        return store.outbox.get(id)?.ownerId === ownerId;
      default:
        return true;
    }
  };

  const hidden = new Set(
    graph.nodes.filter((n) => !mine(n.id, n.kind)).map((n) => n.id),
  );
  if (!hidden.size) return graph;

  return {
    ...graph,
    nodes: graph.nodes.filter((n) => !hidden.has(n.id)),
    edges: graph.edges.filter(
      (e) => !hidden.has(e.source) && !hidden.has(e.target),
    ),
  };
}

function emit(e: CockpitEvent) {
  const owner = ownerOf(e);
  for (const listener of store.subs) {
    if (owner !== null && listener.ownerId !== owner) continue;
    try {
      // The graph is shared but not identical: each listener gets its own
      // interns grafted in and nobody else's.
      listener.fn(
        e.type === "graph"
          ? { type: "graph", graph: visibleGraph(e.graph, listener.ownerId) }
          : e,
      );
    } catch {
      /* a dead subscriber must not take down the run */
    }
  }
}

/** The owner a line inherits: the intern's, or nobody's for system lines. */
const ownerOfIntern = (internId: string | null) =>
  internId ? (store.interns.get(internId)?.ownerId ?? null) : null;

/**
 * `owner` is only needed for lines that belong to a person but not to an
 * intern — the cockpit's own `ask` output, which is one person's answer to one
 * person's question. Everything else inherits from the intern, and a line with
 * neither is a system line the whole deployment can see.
 */
export function log(
  internId: string | null,
  level: LogLevel,
  text: string,
  owner?: string | null,
) {
  const line: LogLine = {
    id: ++store.logSeq,
    internId,
    ownerId: owner !== undefined ? owner : ownerOfIntern(internId),
    ts: Date.now(),
    level,
    text,
  };
  store.log.push(line);
  if (store.log.length > LOG_CAP) store.log.splice(0, store.log.length - LOG_CAP);
  emit({ type: "log", line });
}

function touch(intern: Intern) {
  store.interns.set(intern.id, intern);
  emit({ type: "intern", intern });
}

// ---------------------------------------------------------------------------
// Snapshot accessors
// ---------------------------------------------------------------------------

/**
 * What one person's cockpit opens with.
 *
 * Interns, their log lines, their drafts and their questions are filtered to
 * the owner; the graph, system state, trust and brain stats are the shared
 * company brain and are the same for everybody by design.
 */
export const snapshot = (ownerId: string) => ({
  interns: [...store.interns.values()]
    .filter((i) => i.ownerId === ownerId)
    .sort((a, b) => b.createdAt - a.createdAt),
  log: store.log
    .filter((l) => l.ownerId === null || l.ownerId === ownerId)
    .slice(-400),
  system: store.system,
  graph: visibleGraph(store.graph, ownerId),
  outbox: listActions(undefined, ownerId),
  questions: listQuestions(undefined, ownerId),
  trust: trust.all(),
  brain: brain.stats(),
});

export const getGraph = () => store.graph;
export const getSystem = () => store.system;

// ---------------------------------------------------------------------------
// Graph mutation
//
// Two things feed the picture: whatever Scout projects (or the seed, offline)
// and the facts we hold ourselves. The second must survive a re-read of the
// first, so `base` is kept aside and our projection is grafted back on top
// every time the base changes. Otherwise a `graph refresh` would quietly erase
// everything captured since the last one.
// ---------------------------------------------------------------------------

function setBase(next: Graph) {
  store.base = next;
  const facts = brain.projection();

  // The seed exists so the UI is never dead on arrival. The moment the brain
  // holds anything real that reason is gone, and showing invented people
  // beside real ones is worse than showing nothing — so real facts replace the
  // seed rather than joining it. LIVE is untouched: Scout's graph is real too,
  // so there both halves are kept.
  const seeded = next.mode === "sim" && facts.nodes.length > 0;
  const baseNodes = seeded ? [] : next.nodes;
  const baseEdges = seeded ? [] : next.edges;

  const byId = new Map(baseNodes.map((n) => [n.id, n]));
  for (const n of facts.nodes) byId.set(n.id, n);

  const seen = new Set(baseEdges.map((e) => `${e.source}->${e.target}`));
  const edges = [...baseEdges];
  for (const e of facts.edges) {
    const key = `${e.source}->${e.target}`;
    if (seen.has(key) || !byId.has(e.source) || !byId.has(e.target)) continue;
    seen.add(key);
    edges.push(e);
  }

  store.graph = {
    ...next,
    nodes: [...byId.values()],
    edges,
    generatedAt: Date.now(),
  };
  emit({ type: "graph", graph: store.graph });
  emit({ type: "brain", brain: brain.stats() });
}

function setGraph(next: Graph) {
  store.graph = next;
  emit({ type: "graph", graph: next });
}

function graft(nodes: GraphNode[], edges: GraphEdge[]) {
  const byId = new Map(store.graph.nodes.map((n) => [n.id, n]));
  for (const n of nodes) byId.set(n.id, n);
  const seen = new Set(store.graph.edges.map((e) => `${e.source}->${e.target}`));
  const nextEdges = [...store.graph.edges];
  for (const e of edges) {
    const key = `${e.source}->${e.target}`;
    if (!seen.has(key) && byId.has(e.source) && byId.has(e.target)) {
      seen.add(key);
      nextEdges.push(e);
    }
  }
  setGraph({
    ...store.graph,
    nodes: [...byId.values()],
    edges: nextEdges,
    generatedAt: Date.now(),
  });

  // The same nodes go to Convex, so the other person's cockpit draws them too.
  // Without this an intern only ever existed on the laptop that spawned it, and
  // "one shared brain" was true of facts and of nothing else.
  void brain.share(nodes, edges);
}

// ---------------------------------------------------------------------------
// Scout probe
// ---------------------------------------------------------------------------

export async function probe(force = false): Promise<SystemState> {
  // Replaying the log is idempotent and only ever happens once, but every
  // entry point goes through here, so this is the one place it needs to be.
  await brain.ready();
  const fresh = Date.now() - store.lastProbe < 15_000;
  if (!force && fresh) return store.system;
  if (store.probing) {
    await store.probing;
    return store.system;
  }

  store.probing = (async () => {
    const reachable = await scout.health();
    let contexts: ContextStatus[] = [];
    if (reachable) contexts = await scout.contexts();

    // LIVE means an intern will actually think, which is true of Gemini as
    // much as of Scout. Reporting SIM purely because Scout is down would have
    // labelled every real run as simulated.
    const thinking = reachable || gemini.available();
    const mode: Mode = thinking ? "live" : "sim";
    const prev = store.system;
    store.system = {
      mode,
      scoutUrl: scout.SCOUT_URL,
      reachable,
      checkedAt: Date.now(),
      contexts,
      note: reachable
        ? undefined
        : gemini.available()
          ? `scout unreachable — interns running on ${gemini.describe()}`
          : `no brain at ${scout.SCOUT_URL} and no GEMINI_API_KEY — running simulated`,
    };
    store.lastProbe = Date.now();
    emit({ type: "system", system: store.system });

    if (reachable && prev.mode !== "live") {
      log(null, "ok", `brain online at ${scout.SCOUT_URL} · switching to LIVE`);
      await refreshGraph();
    } else if (!reachable && prev.mode === "live") {
      log(null, "warn", `lost brain at ${scout.SCOUT_URL} · falling back to SIM`);
      setBase(seedGraph());
    }
  })();

  try {
    await store.probing;
  } finally {
    store.probing = null;
  }
  return store.system;
}

export async function refreshGraph(): Promise<Graph> {
  if (store.system.reachable) {
    const g = await scout.graph();
    if (g) {
      setBase(g);
      return store.graph;
    }
    log(null, "warn", "brain returned no graph — keeping what we have");
    return store.graph;
  }
  setBase(seedGraph());
  return store.graph;
}

// ---------------------------------------------------------------------------
// Interns
// ---------------------------------------------------------------------------

// Seeded from what is already there: hot reload replaces this module but keeps
// the store on `globalThis`, so a counter starting from zero would hand out ids
// that already belong to something.
let counter = store.interns.size;

export function spawn(
  task: string,
  opts: { ownerId: string; resumes?: string },
): Intern {
  const n = ++counter;
  const id = `int-${n.toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const intern: Intern = {
    id,
    ownerId: opts.ownerId,
    handle: id,
    task,
    status: "queued",
    mode: store.system.reachable ? "live" : "sim",
    createdAt: Date.now(),
    resumes: opts.resumes,
    tools: [],
    toolCalls: 0,
    toolErrors: 0,
    artifacts: [],
    sessionId: `cockpit-${id}`,
  };
  store.interns.set(id, intern);

  // The intern is a first-class node in the brain while it works.
  graft(
    [
      {
        id,
        label: id,
        kind: "intern",
        weight: 5,
        detail: task.slice(0, 70),
      },
    ],
    [{ source: "brain", target: id, rel: "dispatched" }],
  );

  emit({ type: "intern", intern });
  log(id, "sys", `spawned · ${task}`);
  brain.note({
    kind: "spawn",
    actor: "you",
    internId: id,
    sourceId: null,
    ref: id,
    detail: task.slice(0, 120),
  });

  store.queue.push(id);
  pump();
  return intern;
}

export function cancel(id: string, ownerId: string): boolean {
  const intern = store.interns.get(id);
  // Not yours reads the same as not there — you can only stop your own work.
  if (!intern || intern.ownerId !== ownerId) return false;
  if (intern.status === "done" || intern.status === "failed") return false;

  store.controllers.get(id)?.abort();
  store.queue = store.queue.filter((q) => q !== id);
  if (intern.status === "queued") {
    intern.status = "cancelled";
    intern.endedAt = Date.now();
    touch(intern);
    log(id, "warn", "cancelled before start");
  }
  return true;
}

function pump() {
  while (store.running < MAX_CONCURRENT && store.queue.length) {
    const id = store.queue.shift()!;
    const intern = store.interns.get(id);
    if (!intern || intern.status !== "queued") continue;
    store.running++;
    void run(intern).finally(() => {
      store.running--;
      pump();
    });
  }
}

async function run(intern: Intern) {
  const ctl = new AbortController();
  store.controllers.set(intern.id, ctl);

  intern.status = "running";
  intern.startedAt = Date.now();
  // Scout first where it exists — it has tools Gemini here does not. Gemini
  // second, which is every deployment right now. The script only when there is
  // genuinely nothing that can think, and it says SIM when that happens.
  const runner = store.system.reachable
    ? runLive
    : gemini.available()
      ? runGemini
      : runSim;
  intern.mode = runner === runSim ? "sim" : "live";
  touch(intern);

  try {
    await runner(intern, ctl.signal);
    if (intern.status === "running") {
      intern.status = "done";
      intern.endedAt = Date.now();
      touch(intern);
      log(intern.id, "ok", `finished in ${elapsed(intern)}`);
    }
  } catch (err) {
    if (ctl.signal.aborted) {
      intern.status = "cancelled";
      intern.endedAt = Date.now();
      touch(intern);
      log(intern.id, "warn", "cancelled");
    } else {
      intern.status = "failed";
      intern.error = err instanceof Error ? err.message : String(err);
      intern.endedAt = Date.now();
      touch(intern);
      log(intern.id, "err", intern.error);
    }
  } finally {
    store.controllers.delete(intern.id);
    // Whatever happened, whoever asked for it hears about it. A long run is
    // one you walked away from, so the cockpit is the wrong place to leave the
    // only copy of the answer.
    //
    // Cancelled runs are skipped: you cancelled it, you already know.
    if (intern.status !== "cancelled") void announce(intern);
  }
}

/**
 * DM the owner that their intern is done.
 *
 * Never throws and never awaited by the run: the work is finished and filed by
 * this point, so a Slack outage must not turn a successful run into a failed
 * one. It reports into the intern's own log either way, so a notification that
 * didn't land is visible rather than silent.
 */
async function announce(intern: Intern): Promise<void> {
  if (!intern.ownerId) return;
  try {
    const { delivered, detail } = await notifyDone({
      userId: intern.ownerId,
      internId: intern.id,
      task: intern.task,
      status: intern.status,
      summary: intern.summary ?? intern.error,
      artifacts: intern.artifacts.map((a) => a.label),
      took: elapsed(intern),
    });
    log(
      intern.id,
      delivered ? "ok" : "warn",
      delivered ? `result sent to slack · ${detail}` : `could not slack the result · ${detail}`,
    );
  } catch {
    /* announcing is best-effort by design */
  }
}

const elapsed = (i: Intern) =>
  `${(((i.endedAt ?? Date.now()) - (i.startedAt ?? i.createdAt)) / 1000).toFixed(1)}s`;

/**
 * Everything the brain has learned about how this role should work, rendered
 * for the brief.
 *
 * This is the entire learning loop and it is deliberately this small: a person
 * corrects a draft, the correction becomes a fact, the next brief retrieves it,
 * behaviour changes. Nobody wrote a rule and there is no training job.
 */
function recalled(intern: Intern): { text: string; facts: Fact[] } {
  const preferences = brain.preferences(5);
  const context = brain.recall(intern.task, { limit: 4 }).filter(
    (f) => !preferences.some((p) => p.id === f.id),
  );
  const facts = [...preferences, ...context];
  if (!facts.length) return { text: "", facts };

  const lines = facts.map(
    (f) => `- [${f.id}] ${f.title}${f.body ? `\n    ${f.body.replace(/\n+/g, " ").slice(0, 400)}` : ""}`,
  );
  return {
    text: `
WHAT THE BRAIN ALREADY KNOWS — earned from earlier work, follow it:
${lines.join("\n")}
`,
    facts,
  };
}

const BRIEF = (intern: Intern, learned: string) =>
  `You are an intern working a long-running task for the team.

TASK: ${intern.task}
${learned}
Work it end to end. Navigate the sources you need — do not guess. When you have
something durable, file it: prose and decisions into the knowledge wiki via
update_knowledge, structured facts (people, projects, notes, follow-ups) into the
CRM via update_crm. Link what you write to what already exists. Finish with a
short report of what you found and what you filed.

If the task implies something should go OUT to a person — an email, a Slack
message, a meeting invite — do not send it and do not claim you sent it. You
have no send tool. Instead, draft it and end your report with exactly one
fenced block, using query_voice first so the draft is in the house style:

\`\`\`action
{"kind":"email","to":["someone@example.com"],"subject":"…","body":"…",
 "rationale":"why this should go out","sources":["what you based it on"]}
\`\`\`

For Slack the recipient still goes in "to", as the channel id, and there is no
subject — a Slack post does not have one:

\`\`\`action
{"kind":"slack","to":["C0BP0HJC6DU"],"body":"…",
 "rationale":"why this should go out","sources":["what you based it on"]}
\`\`\`

Always "to". Not "channel", not "channel_id" — a block without "to" is dropped
and the work is wasted.

A human approves it before anything is sent.

If something the task left out cannot be resolved from the brain — who someone
reports to, which of two people was meant, a date nobody stated — do NOT pick
the likely one. Stop and ask, with exactly one fenced block:

\`\`\`question
{"question":"the one thing you need answered","context":"what you were doing and what you already tried"}
\`\`\`

A wrong guess quietly poisons everything downstream of it; a question costs
someone ten seconds. Ask at most one per run, and only when you are genuinely
blocked.`;

async function runLive(intern: Intern, signal: AbortSignal) {
  const out = scout.lanes((text) => log(intern.id, "out", text));
  /** Everything the *top-level* agent said. Sub-agent chatter is not the answer. */
  let said = "";
  /**
   * The final report, whole.
   *
   * Kept apart from `intern.summary`, which is clipped to 600 characters for
   * the rail. Parsing used to read the clipped copy, so a report whose prose
   * ran past ~350 characters lost the closing fence of its ```action block —
   * the regex then matched nothing, the draft was dropped, and because the
   * block looked absent rather than broken not even the "why" line fired. A
   * display limit must never decide what the intern is allowed to have said.
   */
  let report = "";

  const learned = recalled(intern);
  if (learned.facts.length) {
    log(
      intern.id,
      "sys",
      `recalled ${learned.facts.length} fact${learned.facts.length === 1 ? "" : "s"} from the brain · ${learned.facts
        .map((f) => f.id)
        .join(" ")}`,
    );
  }

  for await (const ev of scout.runStream(BRIEF(intern, learned.text), {
    sessionId: intern.sessionId,
    signal,
  })) {
    const kind = String(ev.event ?? "");

    if (kind.includes("ToolCallStarted") || kind === "tool_call_started") {
      out.flush(ev);
      const name =
        ev.tool?.tool_name ?? ev.tools?.[0]?.tool_name ?? "tool";
      intern.toolCalls++;
      if (!intern.tools.includes(name)) intern.tools.push(name);
      touch(intern);
      log(intern.id, "tool", `${name}(…)`);
      continue;
    }

    if (kind.includes("ToolCallCompleted") || kind === "tool_call_completed") {
      const name = ev.tool?.tool_name ?? "tool";
      const result = ev.tool?.result;
      const preview =
        typeof result === "string"
          ? result.replace(/\s+/g, " ").slice(0, 240)
          : "";
      // A failed tool used to be logged at "ok" like any other, so the stream
      // showed `web_search → Error: Timed out` behind a green tick. Whether a
      // step worked is the one thing the line has to get right.
      const failed =
        ev.tool?.tool_call_error === true || /^Error:/.test(preview.trim());
      if (failed) intern.toolErrors++;
      log(intern.id, failed ? "err" : "ok", `${name} → ${preview || "ok"}`);
      if (name.startsWith("update_")) {
        const artifact = {
          kind: name.includes("knowledge") ? ("wiki" as const) : ("note" as const),
          label: preview.slice(0, 80) || name,
        };
        intern.artifacts.push(artifact);
        touch(intern);
      }
      continue;
    }

    // Completion is checked before the generic content branch on purpose.
    // RunCompleted carries the final answer in `ev.content`, so when the
    // content branch came first it swallowed the event and `continue`d — the
    // run finished with every tool call logged and no summary at all, which
    // meant nothing was ever parsed out of it and nothing reached the brain.
    if (kind.includes("RunCompleted") || kind === "run_completed") {
      const content = typeof ev.content === "string" ? ev.content : "";
      const lane = out.lane(ev);
      if (content) {
        lane.text += content;
        if (lane.main) said += content;
      }
      out.flush(ev);
      // Every context provider completes too, and each one carries its own
      // answer. Taking them all meant the summary was whichever sub-agent
      // happened to finish last rather than what the intern concluded.
      if (!lane.main) continue;
      // Fall back to everything streamed: some runs deliver the answer as
      // deltas and complete with an empty payload.
      const final = (content || said).trim();
      if (final) {
        report = final;
        intern.summary = final.slice(0, 600);
      }
      continue;
    }

    if (typeof ev.content === "string" && ev.content) {
      const lane = out.lane(ev);
      lane.text += ev.content;
      if (lane.main) said += ev.content;
      // Flush on sentence-ish boundaries so the terminal reads like a stream
      // of thoughts rather than one wall of text at the end.
      if (lane.text.length > 160 || /[.\n]$/.test(lane.text)) out.flush(ev);
      continue;
    }

    if (kind.includes("RunError") || kind.includes("Error")) {
      out.flushAll();
      throw new Error(String(ev.content ?? "scout run error"));
    }
  }

  out.flushAll();

  if (report) {
    // A question outranks a proposal: an intern that asked and also drafted
    // built that draft on the assumption it just said it could not make.
    const asked = parseQuestion(report, intern);
    if (asked) {
      park(intern, asked);
      return;
    }
    const proposed = parseProposedAction(report, intern);
    if (proposed) {
      intern.artifacts.push({
        kind: "answer",
        label: `proposed ${proposed.kind}: ${proposed.draft.subject}`,
        ref: proposed.id,
      });
      touch(intern);
    }
  }
  if (intern.artifacts.length) await refreshGraph();
}

/**
 * The brief for a Scout-less intern.
 *
 * Deliberately not `BRIEF`: that one promises `update_knowledge`, `update_crm`
 * and `query_voice`, which are Scout's tools. Handing a model tool names it
 * cannot call is how you get a confident report claiming it filed things it
 * never filed. This one gives it a way to file — a fenced block, parsed the
 * same way the action and question blocks already are — and is honest that
 * it cannot browse.
 */
const GEMINI_BRIEF = (intern: Intern, learned: string) =>
  `You are an intern working a task for the team.

TASK: ${intern.task}
${learned}
You have no browser and no tools. Work from what the brain gave you above and
what you already know. Do not invent people, systems, dates or numbers — if a
detail matters and you do not have it, ask rather than filling it in.

Write a short report of what you concluded. Plain prose, no headings.

For anything durable worth keeping, add a fenced block per fact — at most three:

\`\`\`fact
{"title":"one line, the claim itself","body":"the detail behind it","kind":"note"}
\`\`\`

kind is one of: note, decision, preference, correction.

If the task implies something should go OUT to a person — an email, a Slack
message — do not claim you sent it. You have no send tool. Draft it as exactly
one fenced block and a human approves it:

\`\`\`action
{"kind":"email","to":["someone@example.com"],"subject":"…","body":"…",
 "rationale":"why this should go out","sources":["what you based it on"]}
\`\`\`

For Slack the channel id goes in "to" and there is no subject. Always "to" —
never "channel".

If something the task left out cannot be resolved from what you were given, do
NOT pick the likely one. Stop and ask, with exactly one fenced block:

\`\`\`question
{"question":"the one thing you need answered","context":"what you were doing and what you already tried"}
\`\`\`

A wrong guess quietly poisons everything downstream; a question costs someone
ten seconds. At most one per run, and only when genuinely blocked.`;

/** Fenced ```fact blocks, in order, ignoring ones that aren't valid JSON. */
function parseFactBlocks(
  report: string,
): { title: string; body: string; kind?: Fact["kind"] }[] {
  const out: { title: string; body: string; kind?: Fact["kind"] }[] = [];
  const re = /```fact\s*\n([\s\S]*?)```/g;
  for (const m of report.matchAll(re)) {
    try {
      const parsed = JSON.parse(m[1].trim()) as {
        title?: string;
        body?: string;
        kind?: Fact["kind"];
      };
      if (parsed.title?.trim()) {
        out.push({
          title: parsed.title.trim(),
          body: (parsed.body ?? "").trim(),
          kind: parsed.kind,
        });
      }
    } catch {
      /* a malformed block is dropped rather than failing the run */
    }
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * A real intern run without Scout: one streamed Gemini call, then the same
 * parse-and-file the live path does.
 */
async function runGemini(intern: Intern, signal: AbortSignal) {
  const learned = recalled(intern);
  if (learned.facts.length) {
    log(
      intern.id,
      "sys",
      `recalled ${learned.facts.length} fact${learned.facts.length === 1 ? "" : "s"} from the brain · ${learned.facts
        .map((f) => f.id)
        .join(" ")}`,
    );
  }
  log(intern.id, "sys", `thinking · ${gemini.describe()}`);

  let report = "";
  let pending = "";
  for await (const chunk of gemini.stream(GEMINI_BRIEF(intern, learned.text), {
    signal,
  })) {
    if (!chunk.text) continue;
    report += chunk.text;
    pending += chunk.text;
    // Same cadence as the live path — flush on sentence-ish boundaries so the
    // terminal reads as a stream of thought rather than one wall at the end.
    if (pending.length > 160 || /[.\n]$/.test(pending)) {
      const line = pending.trim();
      if (line) log(intern.id, "out", line);
      pending = "";
    }
  }
  const tail = pending.trim();
  if (tail) log(intern.id, "out", tail);

  report = report.trim();
  if (!report) throw new Error("gemini returned an empty report");
  intern.summary = report.slice(0, 600);
  touch(intern);

  // A question outranks everything else: an intern that asked and also filed
  // built that on the assumption it just said it could not make.
  const asked = parseQuestion(report, intern);
  if (asked) {
    park(intern, asked);
    return;
  }

  for (const f of parseFactBlocks(report)) {
    try {
      const { fact } = await capture({
        title: f.title,
        body: f.body,
        kind: f.kind ?? "note",
        sourceId: "intern",
        externalId: `${intern.id}:${f.title.slice(0, 60)}`,
        actor: intern.id,
        ownerId: intern.ownerId ?? "",
      });
      intern.artifacts.push({ kind: "note", label: fact.title, ref: fact.id });
      log(intern.id, "ok", `filed ${fact.id} · ${fact.title}`);
    } catch (err) {
      log(
        intern.id,
        "warn",
        `could not file "${f.title}" · ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const proposed = parseProposedAction(report, intern);
  if (proposed) {
    intern.artifacts.push({
      kind: "answer",
      label: `proposed ${proposed.kind}: ${proposed.draft.subject}`,
      ref: proposed.id,
    });
  }
  touch(intern);
  if (intern.artifacts.length) await refreshGraph();
}

async function runSim(intern: Intern, signal: AbortSignal) {
  const learned = recalled(intern);
  if (learned.facts.length) {
    log(
      intern.id,
      "sys",
      `recalled ${learned.facts.length} fact${learned.facts.length === 1 ? "" : "s"} from the brain · ${learned.facts
        .map((f) => f.id)
        .join(" ")}`,
    );
  }

  const question = simQuestion(intern.task);
  const steps = planSim(intern.task, intern.id);
  for (const step of steps) {
    await sleep(step.delay, signal);
    if (signal.aborted) throw new Error("aborted");

    if (step.tool) {
      intern.toolCalls++;
      if (!intern.tools.includes(step.tool)) intern.tools.push(step.tool);
      touch(intern);
    }
    log(intern.id, step.level, step.text);

    if (step.artifact) {
      intern.artifacts.push(step.artifact);
      touch(intern);
    }
    if (step.graft) graft(step.graft.nodes, step.graft.edges);

    // The simulated intern hits the thing it cannot resolve part-way through,
    // the same as a real one would, and stops there rather than at the end.
    if (question && step.level === "ok" && !intern.blockedBy) {
      park(intern, askQuestion(intern, question.question, question.context));
      return;
    }
  }
  intern.summary = simSummary(intern.task);

  const outbound = simOutboundDraft(intern.task);
  if (outbound) {
    const proposed = proposeAction({
      internId: intern.id,
      ...outbound,
    });
    intern.artifacts.push({
      kind: "answer",
      label: `proposed email: ${proposed.draft.subject}`,
      ref: proposed.id,
    });
    touch(intern);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Questions — the other kind of handover
//
// An approval gate is a handover whose recipient happens to be a person. So is
// a question. The only difference is which way the information flows, which is
// why they share the parking, the graph node and the resume path.
//
// Parked means parked: there is no timeout that eventually guesses.
// ---------------------------------------------------------------------------

let questionCounter = store.questions.size;

export const listQuestions = (
  status?: Question["status"],
  ownerId?: string,
): Question[] => {
  const all = [...store.questions.values()]
    .filter((q) => ownerId === undefined || q.ownerId === ownerId)
    .sort((a, b) => b.askedAt - a.askedAt);
  return status ? all.filter((q) => q.status === status) : all;
};

export const getQuestion = (id: string, ownerId?: string) => {
  const row = store.questions.get(id) ?? null;
  if (row && ownerId !== undefined && row.ownerId !== ownerId) return null;
  return row;
};

export function askQuestion(
  intern: Intern,
  question: string,
  context: string,
): Question {
  const id = `ask-${(++questionCounter).toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const row: Question = {
    id,
    internId: intern.id,
    ownerId: intern.ownerId,
    question: question.slice(0, 500),
    context: context.slice(0, 1000),
    status: "open",
    askedAt: Date.now(),
  };
  store.questions.set(id, row);
  emit({ type: "question", question: row });
  log(intern.id, "warn", `asks: ${row.question}`);
  brain.note({
    kind: "question",
    actor: "system",
    internId: intern.id,
    sourceId: null,
    ref: id,
    detail: row.question,
  });

  graft(
    [
      {
        id,
        label: `? ${row.question}`.slice(0, 56),
        kind: "question",
        weight: 4,
        detail: "waiting on a person",
      },
    ],
    [{ source: intern.id, target: id, rel: "asks" }],
  );

  // Go and find the person. Parked used to mean "stalled until somebody
  // happened to open the cockpit"; this is what makes it mean "waiting on a
  // reply". Deliberately not awaited — the intern has already stopped, and how
  // long Slack takes is not the parked work's problem.
  void notifyQuestion({
    userId: intern.ownerId,
    questionId: id,
    internId: intern.id,
    question: row.question,
    context: row.context,
  }).then((result) => {
    log(
      intern.id,
      result.delivered ? "ok" : "warn",
      result.delivered
        ? `asked on slack · ${result.detail} — reply in the thread`
        : `no slack DM (${result.detail}) · answer it in the cockpit`,
    );
  });

  return row;
}

/** Stop the intern where it stands and hand the work to a person. */
function park(intern: Intern, question: Question) {
  intern.status = "waiting";
  intern.blockedBy = question.id;
  intern.endedAt = Date.now();
  touch(intern);
  log(intern.id, "sys", `parked · waiting on ${question.id}`);
}

/**
 * Answer a question. The answer becomes a fact first — so it is there for
 * every future task, not just this one — and only then is the parked work
 * picked back up.
 */
/**
 * `ownerId` is the caller asserting whose question this is. Omitted only on
 * internal paths that have no person behind them; from an API route it is
 * always passed, and a mismatch reads exactly like a question that isn't open.
 */
export function answerQuestion(
  id: string,
  answer: string,
  actor = "you",
  ownerId?: string,
): { question: Question; resumed: Intern | null } | null {
  const question = store.questions.get(id);
  if (!question || question.status !== "open") return null;
  if (ownerId !== undefined && question.ownerId !== ownerId) return null;

  question.status = "answered";
  question.answer = answer.slice(0, 2000);
  question.answeredAt = Date.now();

  const fact = brain.learn({
    kind: "answer",
    title: question.question,
    body: answer,
    actor,
    tags: ["answered"],
    internId: question.internId,
  });
  log(question.internId, "ok", `${id} answered · filed as ${fact.id}`);
  brain.note({
    kind: "answer",
    actor,
    internId: question.internId,
    sourceId: null,
    ref: id,
    detail: answer.slice(0, 160),
  });

  // Re-project first so the new fact is a node the edge can actually attach to.
  setBase(store.base);
  graft(
    [
      {
        id,
        label: `? ${question.question}`.slice(0, 56),
        kind: "question",
        weight: 4,
        detail: `answered · ${answer.slice(0, 60)}`,
      },
    ],
    [{ source: id, target: fact.id, rel: "answered" }],
  );

  // Resume by dispatching a fresh intern that inherits the answer. A run that
  // has already ended cannot be rewound, and pretending otherwise would mean
  // replaying tool calls that already happened.
  let resumed: Intern | null = null;
  const parked = question.internId ? store.interns.get(question.internId) : null;
  if (parked && parked.status === "waiting") {
    parked.status = "done";
    parked.blockedBy = undefined;
    touch(parked);
    resumed = spawn(
      `${parked.task}\n\nYou asked: ${question.question}\nThe answer is: ${answer}\nCarry on from there.`,
      { ownerId: parked.ownerId, resumes: parked.id },
    );
    question.resumedBy = resumed.id;
    graft([], [{ source: id, target: resumed.id, rel: "resumed" }]);
  }

  emit({ type: "question", question });
  emit({ type: "brain", brain: brain.stats() });
  return { question, resumed };
}

/** The question doesn't need answering after all. The work stays stopped. */
export function dismissQuestion(id: string, ownerId?: string): Question | null {
  const question = store.questions.get(id);
  if (!question || question.status !== "open") return null;
  if (ownerId !== undefined && question.ownerId !== ownerId) return null;
  question.status = "dismissed";
  question.answeredAt = Date.now();
  const parked = question.internId ? store.interns.get(question.internId) : null;
  if (parked && parked.status === "waiting") {
    parked.status = "cancelled";
    parked.blockedBy = undefined;
    touch(parked);
  }
  emit({ type: "question", question });
  log(question.internId, "warn", `${id} dismissed`);
  return question;
}

/**
 * Pull a question out of an intern's final report — same fenced-block trick as
 * the action block, and for the same reason: one deterministic parse beats
 * asking a model to reliably signal intent in prose.
 */
export function parseQuestion(report: string, intern: Intern): Question | null {
  const match = report.match(/```question\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1].trim()) as {
      question?: string;
      context?: string;
    };
    if (!raw.question) return null;
    return askQuestion(intern, raw.question, raw.context ?? intern.task);
  } catch {
    log(intern.id, "warn", "final report had a question block that wasn't valid JSON");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture — the pushed ingestion path
//
// Someone points at something and says "add this to the brain". The channel's
// own agent reads it and calls this; no OAuth of ours is involved, which is
// exactly why this path exists before any connector does.
//
// Idempotent by construction: the same thing captured twice is one observation
// with one fact, so a retry, a double-tap or two people forwarding the same
// message all land the same way.
// ---------------------------------------------------------------------------

export async function capture(input: {
  sourceId?: string;
  externalId?: string;
  actor?: string;
  title: string;
  body: string;
  url?: string;
  tags?: string[];
  kind?: Fact["kind"];
  /** What it is about — for a preference, the role it binds to. */
  subject?: string;
  /** Graph node ids to attach it to, so it lands wired in rather than loose. */
  links?: string[];
  /**
   * A person typed this, rather than a client forwarding something it read.
   * Worth more than an overheard claim, so it starts at the confidence an
   * answered question gets — see `brain.learn`.
   */
  stated?: boolean;
  /** Also put an archivist on writing it into the wiki properly. */
  file?: boolean;
  /**
   * Whoever captured. The fact itself lands in the shared brain — that is the
   * point of capturing — but the archivist dispatched to file it is an intern
   * like any other, and belongs to the person who asked for it.
   */
  ownerId: string;
}): Promise<{ fact: Fact; fresh: boolean; merged: boolean; intern: Intern | null }> {
  await brain.ready();

  const hint = {
    kind: input.kind ?? ("note" as const),
    tags: input.tags,
    subject: input.subject,
    links: input.links?.length ? input.links : undefined,
  };
  const { observation, fresh } = brain.record({
    sourceId: input.sourceId ?? "capture",
    externalId: input.externalId,
    actor: input.actor ?? "you",
    title: input.title,
    body: input.body,
    url: input.url,
    hint,
  });
  const { fact, merged } = brain.promote(observation, hint);
  if (input.stated) fact.confidence = Math.max(fact.confidence, 0.9);

  log(
    null,
    fresh ? "ok" : "sys",
    fresh
      ? `captured ${observation.id} → ${merged ? `corroborates ${fact.id}` : `new fact ${fact.id}`} · ${fact.title}`
      : `already had that one · ${observation.id} → ${fact.id}`,
  );

  setBase(store.base);

  let intern: Intern | null = null;
  if (input.file && fresh) {
    intern = spawn(
      `File this into the knowledge wiki and link it to what already exists.\n\nTITLE: ${input.title}\n\n${input.body}${
        input.url ? `\n\nSOURCE: ${input.url}` : ""
      }`,
      { ownerId: input.ownerId },
    );
  }

  return { fact, fresh, merged, intern };
}

// ---------------------------------------------------------------------------
// One-shot ask (not an intern — a direct question to the brain)
// ---------------------------------------------------------------------------

export async function ask(question: string, ownerId: string): Promise<void> {
  // One person asked; the answer belongs in their terminal and nobody else's.
  const say = (level: LogLevel, text: string) => log(null, level, text, ownerId);

  say("in", `? ${question}`);
  await probe();

  if (!store.system.reachable) {
    // Facts first: they are the citable layer, and unlike graph nodes they
    // carry provenance, so the answer can say where it came from.
    const facts = brain.recall(question, { limit: 5 });
    const first = question.toLowerCase().split(/\s+/)[0] ?? "";
    const hits = store.graph.nodes
      .filter(
        (n) =>
          n.kind !== "fact" &&
          first.length > 1 &&
          n.label.toLowerCase().includes(first),
      )
      .slice(0, 6);

    say("warn", "SIM · answering from the local brain index only");
    for (const f of facts) {
      say(
        "out",
        `${f.kind.padEnd(11)} ${f.title}  [${f.id} · ${f.observations.length} obs · ${Math.round(f.confidence * 100)}%]`,
      );
    }
    for (const h of hits) say("out", `${h.kind.padEnd(11)} ${h.label}`);
    if (!facts.length && !hits.length) {
      say("out", "nothing on that yet. spawn an intern, or capture what you know.");
    }
    return;
  }

  // Same interleaving as a live intern run — one lane per run, not one buffer.
  const out = scout.lanes((text) => say("out", text));

  try {
    for await (const ev of scout.runStream(question, {
      sessionId: "cockpit-ask",
    })) {
      const kind = String(ev.event ?? "");
      if (kind.includes("ToolCallStarted")) {
        out.flush(ev);
        say("tool", `${ev.tool?.tool_name ?? "tool"}(…)`);
      } else if (typeof ev.content === "string" && ev.content) {
        const lane = out.lane(ev);
        lane.text += ev.content;
        if (lane.text.length > 160 || /[.\n]$/.test(lane.text)) out.flush(ev);
      }
    }
    out.flushAll();
  } catch (err) {
    say("err", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Outbox
//
// Interns never send anything. They propose, a human approves out loud, and
// whoever holds the credentials (VoiceOS) executes and reports back. The whole
// point of the split: the draft is written from web pages, Slack messages and
// documents the intern read — untrusted text — so nothing derived from it
// leaves the building without a person saying yes.
// ---------------------------------------------------------------------------

let actionCounter = store.outbox.size;

export function listActions(
  status?: ActionStatus,
  ownerId?: string,
): ProposedAction[] {
  const all = [...store.outbox.values()]
    .filter((a) => ownerId === undefined || a.ownerId === ownerId)
    .sort((a, b) => b.createdAt - a.createdAt);
  return status ? all.filter((a) => a.status === status) : all;
}

export const getAction = (id: string, ownerId?: string) => {
  const row = store.outbox.get(id) ?? null;
  if (row && ownerId !== undefined && row.ownerId !== ownerId) return null;
  return row;
};

export function proposeAction(input: {
  internId: string | null;
  /** Explicit only for drafts with no intern behind them; otherwise inherited. */
  ownerId?: string | null;
  kind: ActionKind;
  title: string;
  draft: Draft;
  rationale: string;
  sources?: string[];
}): ProposedAction {
  const id = `act-${(++actionCounter).toString(36).padStart(2, "0")}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  const action: ProposedAction = {
    id,
    internId: input.internId,
    ownerId:
      input.ownerId !== undefined
        ? input.ownerId
        : (input.internId ? store.interns.get(input.internId)?.ownerId : null) ?? null,
    kind: input.kind,
    status: "pending",
    title: input.title,
    draft: input.draft,
    rationale: input.rationale,
    sources: input.sources ?? [],
    createdAt: Date.now(),
  };
  store.outbox.set(id, action);
  emit({ type: "action", action });
  log(
    input.internId,
    "warn",
    `proposed ${input.kind} · "${input.draft.subject}" → ${input.draft.to.join(", ")} · awaiting approval (${id})`,
  );
  brain.note({
    kind: "handover",
    actor: "system",
    internId: input.internId,
    sourceId: null,
    ref: id,
    detail: `proposed ${input.kind}: ${input.draft.subject}`,
  });

  const nodes: GraphNode[] = [
    {
      id,
      label: `✉ ${input.draft.subject}`.slice(0, 60),
      kind: "action",
      weight: 4,
      detail: `pending · to ${input.draft.to.join(", ")}`,
    },
  ];
  const edges: GraphEdge[] = [{ source: "brain", target: id, rel: "proposed" }];
  if (input.internId) {
    edges.push({ source: input.internId, target: id, rel: "drafted" });
  }
  graft(nodes, edges);

  // A graduated role has already been judged on this kind of work often enough
  // that a person said to stop reviewing it. Honouring that is the whole point
  // of graduation — but it happens loudly, in the same stream as everything
  // else, so nobody discovers it after the fact.
  if (trust.isGraduated(input.kind)) {
    log(input.internId, "sys", `${input.kind} is graduated · ${id} goes without review`);
    void approveAndSend(id, "graduated");
  }
  return action;
}

function settle(action: ProposedAction, detail: string) {
  store.outbox.set(action.id, action);
  emit({ type: "action", action });
  brain.note({
    kind: "decision",
    actor: action.decidedVia === "graduated" ? "system" : "you",
    internId: action.internId,
    sourceId: null,
    ref: action.id,
    detail,
  });
  graft(
    [
      {
        id: action.id,
        label: `✉ ${outgoing(action).subject}`.slice(0, 60),
        kind: "action",
        weight: 4,
        detail,
      },
    ],
    [],
  );
}

const FIELDS: (keyof Draft)[] = ["to", "cc", "subject", "body", "startsAt", "endsAt"];

const render = (v: Draft[keyof Draft]): string =>
  Array.isArray(v) ? v.join(", ") : (v ?? "");

/** Which fields the person actually rewrote. Whitespace-only changes don't count. */
function changedFields(proposed: Draft, accepted: Draft): (keyof Draft)[] {
  return FIELDS.filter(
    (f) => render(proposed[f]).trim() !== render(accepted[f]).trim(),
  );
}

export type Decision = "voice" | "cockpit" | "graduated";

/**
 * Approve a draft, optionally rewriting it first.
 *
 * The edited version is stored beside the original, never over it. That pair —
 * what the intern wrote, what the person was willing to send — is the only
 * honest signal the system gets about how good the work actually was, and it
 * is the reason the next draft is better. Collapsing them into one field would
 * make the outbox tidier and the product pointless.
 */
export function approveAction(
  id: string,
  via: Decision,
  edits?: Partial<Draft>,
  ownerId?: string,
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action || action.status !== "pending") return null;
  // Only the person whose intern wrote it can send it — the From header is
  // theirs, so the yes has to be theirs too.
  if (ownerId !== undefined && action.ownerId !== ownerId) return null;

  const accepted: Draft = { ...action.draft, ...edits };
  const edited = edits ? changedFields(action.draft, accepted) : [];

  action.status = "approved";
  action.decidedAt = Date.now();
  action.decidedVia = via;
  if (edited.length) {
    action.accepted = accepted;
    action.editedFields = edited;
  }

  settle(action, edited.length ? `approved with edits via ${via}` : `approved via ${via}`);
  log(
    action.internId,
    "ok",
    edited.length
      ? `${id} approved via ${via} with edits to ${edited.join(", ")}`
      : `${id} approved via ${via} · handed to the executor`,
  );

  // Graduated work is not supervised, so it is not evidence about supervision.
  // Counting it would let a role's rate drift up on decisions nobody made.
  if (via !== "graduated") {
    recordDecision(action, edited.length ? "edited" : "unedited");
  }
  if (edited.length) learnFromEdit(action, accepted, edited);

  return action;
}

/**
 * "Not like this." The task halts and the reason is filed as a correction, so
 * the next intern on this kind of work reads it before it starts.
 */
export function rejectAction(
  id: string,
  reason: string,
  via: Decision,
  ownerId?: string,
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action || (action.status !== "pending" && action.status !== "approved")) {
    return null;
  }
  if (ownerId !== undefined && action.ownerId !== ownerId) return null;
  // Rejecting work that went out unsupervised is the single most important
  // signal there is, and it never passes through `pending` — graduation
  // approves it on arrival. Counting only pending rejections would make
  // graduation permanent in practice, whatever the revocation rule said.
  const unreviewed =
    action.status === "pending" || action.decidedVia === "graduated";

  action.status = "rejected";
  action.decidedAt = Date.now();
  action.decidedVia = via;
  action.result = reason;
  settle(action, `rejected · ${reason}`.slice(0, 60));
  log(action.internId, "warn", `${id} rejected via ${via}${reason ? ` · ${reason}` : ""}`);

  if (unreviewed) recordDecision(action, "rejected");

  const fact = brain.learn({
    kind: "correction",
    title: `do not send: ${action.draft.subject}`,
    body: `An intern drafted a ${action.kind} to ${action.draft.to.join(", ")} and a person rejected it.\n\nReason given: ${reason}\n\nWhat was drafted:\n${action.draft.body}`,
    subject: action.kind,
    tags: ["rejected", action.kind],
    internId: action.internId,
  });
  log(action.internId, "sys", `filed the reason as ${fact.id} · the next intern reads it first`);
  emit({ type: "brain", brain: brain.stats() });
  return action;
}

/** Fold the decision into the role's record, and say so if a line was crossed. */
function recordDecision(
  action: ProposedAction,
  outcome: "unedited" | "edited" | "rejected",
) {
  const { trust: record, proposed, revoked } = trust.record(
    action.kind,
    action.id,
    outcome,
  );
  emit({ type: "trust", trust: trust.all() });

  if (revoked) {
    log(null, "warn", `${action.kind} un-graduated · back to supervised on every draft`);
  }
  if (proposed) {
    log(
      null,
      "ok",
      `${action.kind} is ready to graduate · ${record.unedited} of ${record.decisions} accepted unedited · run "graduate ${action.kind}" to confirm`,
    );
  }
}

/**
 * Turn one edit into a preference the next brief will carry.
 *
 * The before and after are both kept in full. A summary of what changed would
 * be smaller and would lose the thing that matters — how the person actually
 * writes, as opposed to how they'd describe the way they write.
 */
function learnFromEdit(
  action: ProposedAction,
  accepted: Draft,
  edited: (keyof Draft)[],
) {
  const fact = brain.learn({
    kind: "preference",
    title: `${action.kind}: ${edited.join(" and ")} rewritten before sending`,
    body: [
      `An intern drafted a ${action.kind}; a person rewrote it before approving.`,
      "",
      ...edited.flatMap((field) => [
        `${String(field).toUpperCase()} — proposed:`,
        render(action.draft[field]),
        `${String(field).toUpperCase()} — accepted:`,
        render(accepted[field]),
        "",
      ]),
      "Write it the accepted way next time.",
    ].join("\n"),
    subject: action.kind,
    tags: ["voice", action.kind],
    internId: action.internId,
  });
  log(
    action.internId,
    "sys",
    `learned ${fact.id} from your edit · every intern from now on starts with it`,
  );
  emit({ type: "brain", brain: brain.stats() });
}

// ---------------------------------------------------------------------------
// Graduation
// ---------------------------------------------------------------------------

export function graduateKind(kind: ActionKind, confirmed: boolean) {
  const record = trust.graduate(kind, confirmed);
  emit({ type: "trust", trust: trust.all() });
  log(
    null,
    confirmed ? "ok" : "sys",
    confirmed
      ? `${kind} graduated · those drafts now go without review, and one rejection takes it back`
      : `${kind} stays supervised`,
  );
  return record;
}

export const trustRecords = () => trust.all();

/** The executor (VoiceOS) tells us what actually happened. */
export function recordActionResult(
  id: string,
  status: "sent" | "failed",
  detail?: string,
): ProposedAction | null {
  const action = store.outbox.get(id);
  if (!action) return null;
  if (status === "sent" && action.status !== "approved") return null;
  action.status = status;
  action.settledAt = Date.now();
  action.result = detail;
  settle(action, status === "sent" ? "sent" : `failed · ${detail ?? ""}`.slice(0, 60));
  log(
    action.internId,
    status === "sent" ? "ok" : "err",
    `${id} ${status}${detail ? ` · ${detail}` : ""}`,
  );

  // What actually left the building is itself something the company now knows.
  // Without this the brain would have no record that the email exists, and the
  // next intern would happily draft it again.
  if (status === "sent") {
    const sent = outgoing(action);
    const { observation } = brain.record({
      sourceId: `sent:${action.kind}`,
      externalId: action.id,
      actor: "you",
      title: `${action.kind} sent to ${sent.to.join(", ")}: ${sent.subject}`,
      body: sent.body,
      hint: { kind: "note", tags: ["sent", action.kind] },
    });
    brain.promote(observation, { kind: "note", tags: ["sent", action.kind] });
    setBase(store.base);
  }
  return action;
}

/**
 * Pull a proposed action out of an intern's final report.
 *
 * The brief asks for a fenced ```action block of JSON when the task implies
 * something outbound. Parsing one block is deterministic; asking the model to
 * "just say if you want to send an email" is not.
 */
export function parseProposedAction(
  report: string,
  intern: Intern,
): ProposedAction | null {
  const parsed = parseActionBlock(report);
  if (!parsed) return null;

  // An unusable block used to return null with nothing said, so a run that
  // drafted a Slack post and had it dropped over a field name looked exactly
  // like one that decided there was nothing to send — right down to "finished"
  // in the stream. Whatever else happens, this gets said out loud.
  if ("error" in parsed) {
    log(intern.id, "err", `${parsed.error} — nothing was queued to send`);
    return null;
  }

  return proposeAction({ internId: intern.id, ...parsed });
}

// ---------------------------------------------------------------------------
// Execution
//
// The only path from an approved draft to something actually leaving. Splitting
// approve from execute keeps the gate honest: approveAction records a human
// decision, executeAction acts on it, and neither can happen out of order.
// ---------------------------------------------------------------------------

export async function executeAction(id: string): Promise<ProposedAction | null> {
  const action = store.outbox.get(id);
  if (!action || action.status !== "approved") return null;

  const connector = connectorFor(action.kind);
  if (!connector) {
    log(
      action.internId,
      "warn",
      `${id} approved but no ${action.kind} connector is configured — waiting for an external sender`,
    );
    return action;
  }

  log(action.internId, "tool", `${connector.id}.send(${id})${DRY_RUN ? " · DRY RUN" : ""}`);
  const result = await execute(action);

  // Nothing was attempted, because the approver has no account linked for this
  // surface. The draft stays `approved` and keeps its place in the outbox: it
  // is not sent, and it is not broken either. Recording "sent" here is exactly
  // the lie this path used to tell, and "failed" would be a different one.
  if (result.notConnected) {
    action.result = result.detail;
    store.outbox.set(id, action);
    emit({ type: "action", action });
    log(action.internId, "warn", `${id} not sent · ${result.detail}`);
    return action;
  }

  return recordActionResult(id, result.ok ? "sent" : "failed", result.detail);
}

/**
 * Approve and, if the approver's own account can carry it, send it.
 *
 * `dispatched` means the thing actually left — not that a connector existed
 * and we had a go. The cockpit shows a success line off this flag, so anything
 * looser turns "we tried" into "it's sent" on screen, which is the whole class
 * of bug this path had.
 */
export async function approveAndSend(
  id: string,
  via: Decision,
  edits?: Partial<Draft>,
  ownerId?: string,
): Promise<{ action: ProposedAction | null; dispatched: boolean }> {
  const approved = approveAction(id, via, edits, ownerId);
  if (!approved) return { action: null, dispatched: false };

  const connector = connectorFor(approved.kind);
  if (!connector) return { action: approved, dispatched: false };

  const settled = await executeAction(id);
  const action = settled ?? approved;
  return { action, dispatched: action.status === "sent" };
}

export { connectorStatus };
