"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { connectorByKey } from "@/lib/connectors";
import type { Graph, GraphNode, Intern, LogLevel, LogLine, NodeKind, ProposedAction, Question } from "@/lib/types";
import BrainGraph from "./BrainGraph";
import BrainRail from "./BrainRail";
import CommandBar, { HELP } from "./CommandBar";
import { NOTICE } from "./Consent";
import Feed from "./Feed";
import InternRail from "./InternRail";
import Outbox, { type Decision } from "./Outbox";
import Questions from "./Questions";
import Teach, { type TeachInput } from "./Teach";
import Terminal from "./Terminal";
import ThemeToggle from "./ThemeToggle";

export type Me = { userId: Id<"users">; handle: string; image: string | null };

const EXAMPLES = [
  "Draft a Slack post introducing Intern to a new teammate",
  "Write a follow-up email to someone who asked what Intern does",
  "What has the community taught the brain today? Summarise it.",
];

/** A ConvexError's message is the reason to show; anything else is a bug. */
const why = (err: unknown) =>
  err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err);

export default function Cockpit({ me }: { me: Me }) {
  const internRows = useQuery(api.interns.list, {});
  const logRows = useQuery(api.interns.logs, {});
  const actionRows = useQuery(api.outbox.list, {});
  const questionRows = useQuery(api.questions.list, {});
  const graphData = useQuery(api.facts.graph, {});

  const spawnM = useMutation(api.interns.spawn);
  const cancelM = useMutation(api.interns.cancel);
  const retryM = useMutation(api.interns.retry);
  const decideM = useMutation(api.outbox.decide);
  const answerM = useMutation(api.questions.answer);
  const dismissM = useMutation(api.questions.dismiss);
  const teachM = useMutation(api.facts.teach);
  const deleteMineM = useMutation(api.users.deleteMine);
  const finishM = useMutation(api.connections.finish);

  const [local, setLocal] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const [termHeight, setTermHeight] = useState(280);

  const localSeq = useRef(0);
  const echo = useCallback((level: LogLevel, text: string) => {
    setLocal((prev) => [...prev, { id: -++localSeq.current, internId: null, ownerId: null, ts: Date.now(), level, text }]);
  }, []);

  // --- back from Composio's consent screen -----------------------------------
  // The callback only hands us the link's state; finishing it as the signed-in
  // member is what makes the connection live (connections.finish).
  const [finishing, setFinishing] = useState<{ state: string; label: string } | null>(null);
  const finishOutcome = useQuery(api.connections.outcome, finishing ? { state: finishing.state } : "skip");
  const finishedOnce = useRef(false);
  useEffect(() => {
    if (finishedOnce.current) return;
    finishedOnce.current = true;
    const url = new URL(window.location.href);
    const state = url.searchParams.get("finish");
    const failed = url.searchParams.has("connect_failed");
    if (!state && !failed) return;
    url.searchParams.delete("finish");
    url.searchParams.delete("connect_failed");
    window.history.replaceState(null, "", url);
    if (!state) return echo("err", "that connect link is unknown or was already used. try again.");
    finishM({ state })
      .then((r) => {
        const label = r.connector ? connectorByKey(r.connector).label : "account";
        if (!r.ok) return echo("err", r.reason ?? `connecting ${label} didn't go through.`);
        echo("sys", `connecting ${label}…`);
        setFinishing({ state, label });
      })
      .catch((err) => echo("err", why(err)));
  }, [echo, finishM]);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!finishing || !finishOutcome || finishOutcome === "pending" || reported.current === finishing.state) return;
    reported.current = finishing.state;
    if (finishOutcome === "active") echo("ok", `${finishing.label} connected`);
    else echo("err", `${finishing.label} didn't connect: Composio didn't confirm the account. try again.`);
  }, [echo, finishing, finishOutcome]);

  // --- server rows → the shapes the existing components take ---------------
  const interns = useMemo<Intern[]>(
    () =>
      (internRows ?? []).map((i) => ({
        id: i._id,
        ownerId: i.ownerId,
        handle: `@${i.handle} ${i._id.slice(-4)}`,
        task: i.task,
        status: i.status,
        mode: "live",
        createdAt: i._creationTime,
        startedAt: i.startedAt,
        endedAt: i.endedAt,
        tools: [],
        toolCalls: 0,
        toolErrors: 0,
        artifacts: [],
        summary: i.summary,
        error: i.error,
        sessionId: "",
      })),
    [internRows],
  );

  const log = useMemo<LogLine[]>(
    () =>
      [
        ...(logRows ?? []).map((l, idx) => ({
          id: idx,
          internId: l.internId,
          ownerId: null,
          ts: l._creationTime,
          level: l.level,
          text: l.text,
        })),
        ...local,
      ].sort((a, b) => a.ts - b.ts),
    [logRows, local],
  );

  // Your own drafts and questions only: only you can act on them, and only
  // your own rows carry their contents.
  const outbox = useMemo<ProposedAction[]>(
    () =>
      (actionRows ?? []).flatMap((a) =>
        "draft" in a && a.ownerId === me.userId
          ? [{
              id: a._id,
              internId: a.internId,
              ownerId: a.ownerId,
              kind: a.kind,
              status: a.status,
              title: a.title,
              draft: a.draft,
              accepted: a.accepted,
              editedFields: a.editedFields as ProposedAction["editedFields"],
              rationale: a.rationale,
              sources: a.sources,
              createdAt: a._creationTime,
              decidedAt: a.decidedAt,
              decidedVia: "cockpit" as const,
              result: a.reason,
              connector: a.connector,
              sendError: a.sendError,
            }]
          : [],
      ),
    [actionRows, me.userId],
  );

  const questions = useMemo<Question[]>(
    () =>
      (questionRows ?? []).flatMap((q) =>
        "question" in q && q.ownerId === me.userId
          ? [{
              id: q._id,
              internId: q.internId,
              ownerId: q.ownerId,
              question: q.question,
              context: q.context,
              status: q.status,
              answer: q.answer,
              askedAt: q._creationTime,
              resumedBy: q.resumedBy,
            }]
          : [],
      ),
    [questionRows, me.userId],
  );

  const graph = useMemo<Graph>(
    () => ({
      nodes: (graphData?.nodes ?? []) as GraphNode[],
      edges: graphData?.edges ?? [],
      mode: "live",
      generatedAt: graphData?.generatedAt ?? 0,
    }),
    [graphData],
  );

  const selected = useMemo(() => graph.nodes.find((n) => n.id === selectedId) ?? null, [graph.nodes, selectedId]);
  const select = useCallback((node: GraphNode | null) => setSelectedId(node?.id ?? null), []);

  // Running interns pulse, and so do the facts they recalled.
  const activeIds = useMemo(
    () =>
      (internRows ?? [])
        .filter((i) => i.status === "running" || i.status === "queued")
        .flatMap((i) => [i._id as string, ...(i.recalledFactIds ?? [])]),
    [internRows],
  );

  // --- actions -------------------------------------------------------------
  const spawn = useCallback(
    async (task: string) => {
      try {
        await spawnM({ task });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [spawnM, echo],
  );

  const retry = useCallback(
    async (id: string) => {
      try {
        await retryM({ internId: id as Id<"interns"> });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [retryM, echo],
  );

  const kill = useCallback(
    async (id: string) => {
      try {
        await cancelM({ internId: id as Id<"interns"> });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [cancelM, echo],
  );

  const decide = useCallback(
    async (id: string, d: Decision) => {
      try {
        if (d.decision === "approve") {
          const { to, cc, subject, body } = d.edits ?? {};
          await decideM({ actionId: id as Id<"actions">, decision: "approve", edits: d.edits ? { to, cc, subject, body } : undefined });
        } else {
          await decideM({ actionId: id as Id<"actions">, decision: "reject", reason: d.reason });
        }
      } catch (err) {
        echo("err", why(err));
      }
    },
    [decideM, echo],
  );

  const answer = useCallback(
    async (id: string, text: string) => {
      try {
        const r = await answerM({ questionId: id as Id<"questions">, answer: text });
        if (!r.resumed && r.reason) echo("warn", `answer saved as a fact, but the intern didn't resume: ${r.reason}`);
      } catch (err) {
        echo("err", why(err));
      }
    },
    [answerM, echo],
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await dismissM({ questionId: id as Id<"questions"> });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [dismissM, echo],
  );

  const teach = useCallback(
    async (input: TeachInput) => {
      const [head, ...rest] = input.text.split(/\n|(?<=[.!?])\s+/);
      const kind = input.kind === "person" || input.kind === "project" ? "note" : input.kind;
      try {
        await teachM({ title: head.slice(0, 200), body: rest.join(" ").trim(), kind });
        return true;
      } catch (err) {
        echo("err", why(err));
        return false;
      }
    },
    [teachM, echo],
  );

  const deleteMine = useCallback(async () => {
    if (!window.confirm("Delete every brief, fact, draft and question you added? This can't be undone.")) return;
    try {
      await deleteMineM({});
      echo("ok", "deleting everything you added…");
    } catch (err) {
      echo("err", why(err));
    }
  }, [deleteMineM, echo]);

  const run = useCallback(
    (raw: string) => {
      const [verb, ...rest] = raw.split(/\s+/);
      const arg = rest.join(" ").trim();
      echo("in", raw);
      switch (verb.toLowerCase()) {
        case "help":
          for (const l of HELP) echo("out", l);
          return;
        case "clear":
          setLocal([]);
          return;
        case "focus":
          setFilter(!arg || arg === "all" ? null : arg);
          return;
        case "kill":
          if (!arg) return echo("err", "usage: kill <id>");
          void kill(arg);
          return;
        case "reject": {
          const [target, ...reason] = arg.split(/\s+/);
          if (!target) return echo("err", "usage: reject <draft-id> [reason]");
          void decide(target, { decision: "reject", reason: reason.join(" ") || "rejected from the command bar" });
          return;
        }
        case "approve":
          if (!arg) return echo("err", "usage: approve <draft-id>");
          void decide(arg, { decision: "approve" });
          return;
        case "answer": {
          const [target, ...text] = arg.split(/\s+/);
          if (!target || !text.length) return echo("err", "usage: answer <question-id> <answer>");
          void answer(target, text.join(" "));
          return;
        }
        case "capture":
          if (!arg) return echo("err", "usage: capture <what you know>");
          void teach({ text: arg, kind: "note" });
          return;
        case "spawn":
          if (!arg) return echo("err", "usage: spawn <task>");
          void spawn(arg);
          return;
        default:
          void spawn(raw);
      }
    },
    [answer, decide, echo, kill, spawn, teach],
  );

  const toggleKind = (k: NodeKind) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const mine = interns.filter((i) => i.ownerId === me.userId);

  // --- terminal resize: keep the existing `dragging` ref + useEffect block unchanged ---
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const h = window.innerHeight - e.clientY - 40;
      setTermHeight(Math.max(90, Math.min(window.innerHeight - 220, h)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header me={me} interns={interns} onDeleteMine={deleteMine} />
      <div className="shrink-0 border-b border-warn/30 bg-warn/5 px-3 py-1 text-warn">{NOTICE}</div>

      <div className="flex min-h-0 flex-1">
        <BrainRail graph={graph} hidden={hidden} onToggleKind={toggleKind} selected={selected} onSelect={select} />

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <BrainGraph
              graph={graph}
              selectedId={selectedId}
              onSelect={select}
              query={query}
              hidden={hidden}
              activeIds={activeIds}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
              <div className="pointer-events-auto flex items-center gap-2 border border-line bg-panel/90 px-2 py-1 backdrop-blur">
                <span className="text-faint">⌕</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter nodes"
                  spellCheck={false}
                  className="w-44 bg-transparent placeholder:text-faint/70"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="text-faint hover:text-fg"
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <div className="border border-line bg-panel/90 px-2 py-1 text-faint backdrop-blur">
                {graph.nodes.length} nodes · {graph.edges.length} edges
              </div>
            </div>
          </div>

          <div
            onMouseDown={() => {
              dragging.current = true;
              document.body.style.userSelect = "none";
            }}
            className="h-[5px] shrink-0 cursor-row-resize border-t border-line bg-panel transition-colors hover:bg-line-2"
          />

          <div style={{ height: termHeight }} className="flex min-h-0 shrink-0">
            <div className="flex min-h-0 flex-1 flex-col">
              <Terminal
                log={log}
                interns={interns}
                filter={filter}
                onFilter={setFilter}
              />
            </div>
          </div>

          {mine.length === 0 ? (
            <div className="flex shrink-0 flex-wrap gap-2 border-t border-line bg-panel px-3 py-2">
              <span className="text-faint">try:</span>
              {EXAMPLES.map((e) => (
                <button key={e} type="button" onClick={() => void spawn(e)} className="border border-line px-2 text-dim hover:border-line-2 hover:text-fg">
                  {e}
                </button>
              ))}
            </div>
          ) : null}

          <CommandBar onSubmit={run} mode="live" busy={activeIds.length} />
        </main>

        <aside className="flex min-h-0 w-[268px] shrink-0 flex-col border-l border-line">
          <Teach onTeach={teach} />
          <Questions
            questions={questions}
            onAnswer={answer}
            onDismiss={dismiss}
          />
          <Outbox actions={outbox} onDecide={decide} />
          <Feed />
          <InternRail
            interns={interns}
            filter={filter}
            onFilter={setFilter}
            onKill={kill}
            onRetry={retry}
            mineId={me.userId}
          />
        </aside>
      </div>
    </div>
  );
}

function Header({ me, interns, onDeleteMine }: { me: Me; interns: Intern[]; onDeleteMine: () => void }) {
  const { signOut } = useAuthActions();
  const working = interns.filter((i) => i.status === "running" || i.status === "queued").length;
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <span className="tracking-[0.28em] text-fg">INTERN</span>
      <span className="text-line-2">|</span>
      <span className="text-faint">community brain</span>
      <div className="ml-auto flex items-center gap-4 text-faint">
        <span>{working} working</span>
        <ThemeToggle />
        <a
          href="/stats"
          className="border border-line px-1.5 py-0.5 transition-colors hover:border-line-2 hover:text-fg"
        >
          stats
        </a>
        <button
          type="button"
          onClick={onDeleteMine}
          className="border border-line px-1.5 py-0.5 transition-colors hover:border-err/50 hover:text-err"
        >
          delete my stuff
        </button>
        <span className="flex items-center gap-1.5">
          {me.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={me.image} alt="" className="size-4 rounded-full" />
          ) : null}
          @{me.handle}
        </span>
        <button type="button" onClick={() => void signOut()} className="hover:text-fg" title="sign out">⏻</button>
      </div>
    </header>
  );
}
