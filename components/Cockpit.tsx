"use client";

import { useAuthActions, useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import BrainGraph from "./BrainGraph";
import BrainRail from "./BrainRail";
import CommandBar, { HELP } from "./CommandBar";
import InternRail from "./InternRail";
import Outbox, { type Decision } from "./Outbox";
import Questions from "./Questions";
import Teach, { type TeachInput } from "./Teach";
import Terminal from "./Terminal";
import type {
  BrainStats,
  CockpitEvent,
  Graph,
  GraphNode,
  ActionKind,
  Intern,
  LogLevel,
  LogLine,
  ConnectorsState,
  NodeKind,
  ProposedAction,
  Question,
  SystemState,
  TrustRecord,
} from "@/lib/types";

const EMPTY_GRAPH: Graph = {
  nodes: [],
  edges: [],
  mode: "sim",
  generatedAt: 0,
};

const EMPTY_SYSTEM: SystemState = {
  mode: "sim",
  scoutUrl: "",
  reachable: false,
  checkedAt: 0,
  contexts: [],
  note: "connecting…",
};

export default function Cockpit() {
  const [interns, setInterns] = useState<Intern[]>([]);
  const [log, setLog] = useState<LogLine[]>([]);
  const [streamGraph, setStreamGraph] = useState<Graph>(EMPTY_GRAPH);
  const [system, setSystem] = useState<SystemState>(EMPTY_SYSTEM);
  const [streamOutbox, setStreamOutbox] = useState<ProposedAction[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [trust, setTrust] = useState<TrustRecord[]>([]);
  const [brain, setBrain] = useState<BrainStats | null>(null);
  const [connectors, setConnectors] = useState<ConnectorsState | null>(null);
  const [connected, setConnected] = useState(false);
  const token = useAuthToken();
  const startConnection = useMutation(api.connections.start);
  const convexGraph = useQuery(api.brain.graph, {});
  const convexOutbox = useQuery(api.outbox.list, {});

  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [termHeight, setTermHeight] = useState(280);

  const localSeq = useRef(0);
  const echo = useCallback((level: LogLevel, text: string) => {
    setLog((prev) => [
      ...prev,
      {
        id: -++localSeq.current,
        internId: null,
        // Typed as a stream line but never came from the stream — it is echoed
        // straight into this one terminal and no server ever sees it.
        ownerId: null,
        ts: Date.now(),
        level,
        text,
      },
    ]);
  }, []);

  /**
   * Every call to the Node half carries the same token the Convex client uses,
   * because those routes now answer as somebody rather than as everybody.
   */
  const authFetch = useCallback(
    (input: string, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: {
          ...init?.headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }),
    [token],
  );

  // --- event stream -------------------------------------------------------
  //
  // `fetch`, not `EventSource`. The stream is scoped to whoever is signed in,
  // so it has to carry the auth token, and EventSource cannot set headers —
  // the only alternative is a token in the query string, which lands in every
  // access log on the way. Same SSE wire format, read by hand; reconnection is
  // ours to do too, since that came free with EventSource and doesn't here.
  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const dispatch = (e: CockpitEvent | { type: "ping" }) => {
      switch (e.type) {
        case "snapshot":
          setInterns(e.interns);
          setLog(e.log);
          setSystem(e.system);
          setStreamOutbox(e.outbox);
          setQuestions(e.questions);
          setTrust(e.trust);
          setBrain(e.brain);
          setConnected(true);
          break;
        case "question":
          setQuestions((prev) => {
            const rest = prev.filter((q) => q.id !== e.question.id);
            return [e.question, ...rest].sort((a, b) => b.askedAt - a.askedAt);
          });
          break;
        case "trust":
          setTrust(e.trust);
          break;
        case "brain":
          setBrain(e.brain);
          break;
        case "action":
          setStreamOutbox((prev) => {
            const rest = prev.filter((a) => a.id !== e.action.id);
            return [e.action, ...rest].sort((a, b) => b.createdAt - a.createdAt);
          });
          break;
        case "log":
          setLog((prev) => {
            const next = [...prev, e.line];
            return next.length > 1500 ? next.slice(-1200) : next;
          });
          break;
        case "intern":
          setInterns((prev) => {
            const rest = prev.filter((i) => i.id !== e.intern.id);
            return [e.intern, ...rest].sort((a, b) => b.createdAt - a.createdAt);
          });
          break;
        case "graph":
          setStreamGraph(e.graph);
          break;
        case "system":
          setSystem(e.system);
          break;
      }
    };

    const read = async () => {
      try {
        const res = await fetch("/api/events", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setConnected(true);

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;

          // SSE frames are separated by a blank line; anything after the last
          // one is a partial frame and has to wait for the next chunk.
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim())
              .join("\n");
            if (!data) continue;
            try {
              dispatch(JSON.parse(data) as CockpitEvent);
            } catch {
              /* a malformed frame is not worth dropping the stream over */
            }
          }
        }
      } catch {
        /* fall through to the reconnect below */
      }

      if (stopped) return;
      setConnected(false);
      retry = setTimeout(read, 2000);
    };

    void read();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      controller.abort();
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    authFetch("/api/connectors")
      // This route can answer 401 now, and an error body is still valid JSON —
      // storing one would put `{error}` where the rail expects a state object,
      // and its `!connectors` guard doesn't catch a truthy wrong shape. Leave
      // it null instead: the rail already renders "checking…" for that.
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ConnectorsState | null) => {
        if (alive && d && Array.isArray(d.connectors)) setConnectors(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token, authFetch]);

  const graph = useMemo<Graph>(() => {
    if (!convexGraph?.nodes.length) return streamGraph;

    // Seed suppression lives in `setBase` (lib/store.ts), not here — one rule,
    // one place, so the stream's own node count never disagrees with the
    // canvas. This is a plain union.
    const baseEdges = streamGraph.edges;
    const nodes = new Map(streamGraph.nodes.map((n) => [n.id, n]));
    for (const n of convexGraph.nodes) {
      nodes.set(n.id, {
        id: n.id,
        label: n.label,
        kind: n.kind,
        weight: n.weight ?? undefined,
        detail: n.detail ?? undefined,
        meta: n.meta ?? undefined,
      });
    }

    const seen = new Set(
      baseEdges.map((e) => `${e.source}|${e.target}|${e.rel ?? ""}`),
    );
    const edges = [...baseEdges];
    for (const e of convexGraph.edges) {
      const key = `${e.source}|${e.target}|${e.rel ?? ""}`;
      if (seen.has(key)) continue;
      // Both ends have to exist here. Fact edges always arrived with their own
      // nodes, but an intern's edges are written the moment it spawns and can
      // land before the node they point at — and a d3 force layout throws on an
      // endpoint it cannot find, which takes the whole canvas down rather than
      // dropping one line.
      if (!nodes.has(e.source) || !nodes.has(e.target)) continue;
      seen.add(key);
      edges.push({ source: e.source, target: e.target, rel: e.rel ?? undefined });
    }

    return {
      ...streamGraph,
      nodes: [...nodes.values()],
      edges,
      generatedAt: Math.max(streamGraph.generatedAt, convexGraph.generatedAt),
    };
  }, [streamGraph, convexGraph]);

  const outbox = useMemo<ProposedAction[]>(() => {
    if (!convexOutbox?.length) return streamOutbox;

    const byId = new Map(streamOutbox.map((a) => [a.id, a]));
    for (const row of convexOutbox) {
      byId.set(row.handle, {
        id: row.handle,
        internId: row.internHandle,
        // `api.outbox.list` only ever returns this viewer's rows, so anything
        // arriving here is already theirs.
        ownerId: row.ownerId ?? null,
        kind: row.kind,
        status: row.status,
        title: row.title,
        draft: row.draft,
        accepted: row.accepted,
        editedFields: row.editedFields as ProposedAction["editedFields"],
        rationale: row.rationale,
        sources: row.sources,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        settledAt: row.settledAt,
        decidedVia: row.decidedVia,
        result: row.result,
      });
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [streamOutbox, convexOutbox]);

  // Derived, not stored — the brain mutates under the inspector constantly.
  const selected = useMemo(
    () => graph.nodes.find((n) => n.id === selectedId) ?? null,
    [graph.nodes, selectedId],
  );
  const select = useCallback(
    (node: GraphNode | null) => setSelectedId(node?.id ?? null),
    [],
  );

  // --- actions ------------------------------------------------------------
  const spawn = useCallback(
    async (task: string) => {
      const res = await authFetch("/api/interns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      if (!res.ok) echo("err", `spawn failed: ${res.status}`);
    },
    [echo, authFetch],
  );

  const kill = useCallback(
    async (id: string) => {
      const res = await authFetch(`/api/interns/${id}`, { method: "DELETE" });
      if (!res.ok) echo("err", `no such intern: ${id}`);
    },
    [echo, authFetch],
  );

  const decide = useCallback(
    async (id: string, decision: Decision) => {
      const res = await authFetch(`/api/outbox/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      });
      if (!res.ok) {
        echo("err", `could not ${decision.decision} ${id}`);
        return;
      }
      const data = (await res.json()) as {
        dispatched?: boolean;
        action?: { result?: string };
      };
      if (decision.decision === "approve" && !data.dispatched) {
        // The server knows *why* it didn't go — usually that this person has
        // no account linked for that surface. Repeating a guess about missing
        // connectors on top of it is how "approved" got read as "sent".
        echo(
          "warn",
          data.action?.result
            ? `${id} approved but NOT sent · ${data.action.result}`
            : `${id} approved — no connector wired, waiting on an external sender`,
        );
      }
    },
    [echo, authFetch],
  );

  const answer = useCallback(
    async (id: string, text: string) => {
      const res = await authFetch(`/api/questions/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: text }),
      });
      if (!res.ok) echo("err", `could not answer ${id}`);
    },
    [echo, authFetch],
  );

  const dismiss = useCallback(
    async (id: string) => {
      const res = await authFetch(`/api/questions/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismiss: true }),
      });
      if (!res.ok) echo("err", `could not drop ${id}`);
    },
    [echo, authFetch],
  );

  /**
   * Start an OAuth handshake for a surface that isn't connected yet.
   *
   * The state row is minted by an authenticated mutation, so the browser never
   * has to be trusted about who is connecting — by the time the provider
   * redirects back, the user is already bound to that state string. We only
   * carry the opaque state to `/oauth/start`, which holds the client id.
   */
  const connect = useCallback(
    async (kind: ActionKind) => {
      const provider = kind === "slack" ? "slack" : "google";
      const site = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
      if (!site) {
        echo("err", "NEXT_PUBLIC_CONVEX_SITE_URL unset — cannot start the handshake");
        return;
      }
      try {
        const state = await startConnection({
          provider,
          redirectTo: window.location.href,
        });
        // Full page navigation, not the router: this leaves the app entirely
        // for Convex and then the provider's consent screen. The lint rule
        // below is about internal routes, which this deliberately is not.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = `${site}/oauth/start?provider=${provider}&state=${state}`;
      } catch (err) {
        echo("err", err instanceof Error ? err.message : `could not connect ${provider}`);
      }
    },
    [echo, startConnection],
  );

  const graduate = useCallback(
    async (kind: ActionKind, confirmed: boolean) => {
      const res = await authFetch("/api/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, confirmed }),
      });
      if (!res.ok) echo("err", `could not change ${kind}`);
    },
    [echo, authFetch],
  );

  const captureText = useCallback(
    async (text: string) => {
      const [head, ...rest] = text.split(/\n|(?<=[.!?])\s+/);
      const res = await authFetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "cockpit",
          title: head.slice(0, 120),
          body: rest.join(" ").trim() || text,
          stated: true,
        }),
      });
      if (!res.ok) echo("err", "capture failed");
    },
    [echo, authFetch],
  );

  /**
   * File a fact nobody was asked for.
   *
   * Same route the `capture` verb uses, with the two things the verb has no
   * grammar for: what kind of fact it is, and the node it hangs off. Resolves
   * false when nothing landed, so the panel can keep the text rather than
   * clearing a box the person would have to retype.
   */
  const teach = useCallback(
    async (input: TeachInput) => {
      const [head, ...rest] = input.text.split(/\n|(?<=[.!?])\s+/);
      const res = await authFetch("/api/capture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "cockpit",
          title: head.slice(0, 120),
          body: rest.join(" ").trim() || input.text,
          kind: input.kind,
          tags: input.tags,
          subject: input.subject,
          links: input.links,
          stated: true,
        }),
      });
      if (!res.ok) {
        echo("err", "could not file that");
        return false;
      }
      return true;
    },
    [echo, authFetch],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    echo("sys", "re-reading brain…");
    try {
      const res = await authFetch("/api/brain?refresh=1");
      // An error body parses as JSON perfectly well; `data.graph` would then
      // be undefined and the canvas would take the crash instead of the log.
      if (!res.ok) throw new Error(`brain ${res.status}`);
      const data = (await res.json()) as { graph: Graph };
      setStreamGraph(data.graph);
      echo(
        "ok",
        `brain: ${data.graph.nodes.length} nodes, ${data.graph.edges.length} edges (${data.graph.mode})`,
      );
    } catch {
      echo("err", "brain refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [echo, authFetch]);

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
          setLog([]);
          return;
        case "focus":
          if (!arg || arg === "all") {
            setFilter(null);
            echo("sys", "stream: all");
          } else {
            setFilter(arg);
            echo("sys", `stream: ${arg}`);
          }
          return;
        case "kill":
          if (!arg) return echo("err", "usage: kill <id>");
          void kill(arg);
          return;
        case "graph":
          if (arg === "refresh" || arg === "") return void refresh();
          echo("err", "usage: graph refresh");
          return;
        case "ask": {
          if (!arg) return echo("err", "usage: ask <question>");
          void authFetch("/api/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: arg }),
          });
          return;
        }
        case "outbox": {
          const pending = outbox.filter((a) => a.status === "pending");
          if (!pending.length) return echo("out", "outbox empty");
          for (const a of pending) {
            echo("out", `${a.id}  ${a.kind} → ${a.draft.to.join(", ")}  ${a.draft.subject}`);
          }
          return;
        }
        case "approve":
          if (!arg) return echo("err", "usage: approve <action-id>");
          // Approving from the command bar sends the draft as written — the
          // rail is where you edit before saying yes.
          void decide(arg, { decision: "approve" });
          return;
        case "reject": {
          const [target, ...why] = arg.split(/\s+/);
          if (!target) return echo("err", "usage: reject <action-id> [reason]");
          void decide(target, {
            decision: "reject",
            reason: why.join(" ") || "rejected from the command bar",
          });
          return;
        }
        case "asks": {
          const open = questions.filter((q) => q.status === "open");
          if (!open.length) return echo("out", "nothing parked");
          for (const q of open) {
            echo("out", `${q.id}  ${q.internId ?? "—"}  ${q.question}`);
          }
          return;
        }
        case "answer": {
          const [target, ...text] = arg.split(/\s+/);
          if (!target || !text.length) {
            return echo("err", "usage: answer <ask-id> <your answer>");
          }
          void answer(target, text.join(" "));
          return;
        }
        case "capture":
          if (!arg) return echo("err", "usage: capture <what you know>");
          void captureText(arg);
          return;
        case "trust":
          for (const t of trust) {
            echo(
              "out",
              `${t.kind.padEnd(10)} ${
                t.decisions
                  ? `${t.unedited} of ${t.decisions} approved unedited`
                  : "no decisions yet"
              }${t.graduated ? " · unsupervised" : ""}${
                t.proposed ? " · ready to graduate" : ""
              }`,
            );
          }
          return;
        case "graduate":
        case "supervise": {
          const kind = arg.trim() as ActionKind;
          if (!trust.some((t) => t.kind === kind)) {
            return echo(
              "err",
              `usage: ${verb.toLowerCase()} <${trust.map((t) => t.kind).join("|")}>`,
            );
          }
          void graduate(kind, verb.toLowerCase() === "graduate");
          return;
        }
        case "spawn": {
          if (!arg) return echo("err", "usage: spawn <task>");
          void spawn(arg);
          return;
        }
        default:
          void spawn(raw);
      }
    },
    [
      authFetch,
      answer,
      captureText,
      decide,
      echo,
      graduate,
      kill,
      outbox,
      questions,
      refresh,
      spawn,
      trust,
    ],
  );

  const toggleKind = (k: NodeKind) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const activeIds = useMemo(
    () =>
      interns
        .filter((i) => i.status === "running" || i.status === "queued")
        .map((i) => i.id),
    [interns],
  );

  // --- terminal resize ----------------------------------------------------
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
      <Header system={system} connected={connected} interns={interns} />

      <div className="flex min-h-0 flex-1">
        <BrainRail
          system={system}
          connectors={connectors}
          onConnect={connect}
          trust={trust}
          brain={brain}
          onGraduate={graduate}
          graph={graph}
          hidden={hidden}
          onToggleKind={toggleKind}
          selected={selected}
          onSelect={select}
          onRefresh={refresh}
          refreshing={refreshing}
        />

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

          <CommandBar
            onSubmit={run}
            mode={system.reachable ? "live" : "sim"}
            busy={activeIds.length}
          />
        </main>

        <aside className="flex min-h-0 w-[268px] shrink-0 flex-col border-l border-line">
          <Teach selected={selected} onTeach={teach} />
          <Questions
            questions={questions}
            onAnswer={answer}
            onDismiss={dismiss}
          />
          <Outbox actions={outbox} connectors={connectors} onDecide={decide} />
          <InternRail
            interns={interns}
            filter={filter}
            onFilter={setFilter}
            onKill={kill}
          />
        </aside>
      </div>
    </div>
  );
}

function Header({
  system,
  connected,
  interns,
}: {
  system: SystemState;
  connected: boolean;
  interns: Intern[];
}) {
  const [clock, setClock] = useState("");
  useEffect(() => {
    const t = setInterval(
      () =>
        setClock(new Date().toLocaleTimeString("en-GB", { hour12: false })),
      1000,
    );
    return () => clearInterval(t);
  }, []);

  const { signOut } = useAuthActions();
  const done = interns.filter((i) => i.status === "done").length;

  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <span className="tracking-[0.28em] text-fg">INTERN</span>
      <span className="text-line-2">|</span>
      <span className="text-faint">company brain</span>

      <div className="ml-auto flex items-center gap-4 text-faint">
        <span>{done} filed</span>
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected ? "bg-ok" : "bg-err"
            }`}
          />
          {connected ? "stream" : "reconnecting"}
        </span>
        {/*
          Reads `system.mode`, not `system.reachable`. Those stopped being the
          same thing when interns gained a second way to think: Scout being
          down no longer means the work is simulated, and the badge saying SIM
          over a real Gemini run is the most misleading thing on the screen.
        */}
        <span
          className={`border px-1.5 ${
            system.mode === "live"
              ? "border-ok/40 text-ok"
              : "border-warn/40 text-warn"
          }`}
          title={system.note ?? `brain online at ${system.scoutUrl}`}
        >
          {system.mode === "live" ? "LIVE" : "SIM"}
        </span>
        <span className="tabular-nums">{clock}</span>
        <button
          type="button"
          onClick={() => void signOut()}
          className="text-faint transition-colors hover:text-fg"
          title="sign out"
        >
          ⏻
        </button>
      </div>
    </header>
  );
}
