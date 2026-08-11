"use client";

import { KIND_COLOR, KIND_ORDER } from "./BrainGraph";
import Trust from "./Trust";
import type {
  BrainStats,
  ActionKind,
  ConnectorsState,
  Graph,
  GraphNode,
  NodeKind,
  SystemState,
  TrustRecord,
} from "@/lib/types";

export default function BrainRail({
  system,
  connectors,
  onConnect,
  trust,
  brain,
  onGraduate,
  graph,
  hidden,
  onToggleKind,
  selected,
  onSelect,
  onRefresh,
  refreshing,
}: {
  system: SystemState;
  connectors: ConnectorsState | null;
  onConnect: (kind: ActionKind) => void;
  trust: TrustRecord[];
  brain: BrainStats | null;
  onGraduate: (kind: ActionKind, confirmed: boolean) => void;
  graph: Graph;
  hidden: Set<NodeKind>;
  onToggleKind: (k: NodeKind) => void;
  selected: GraphNode | null;
  onSelect: (n: GraphNode | null) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const counts = new Map<NodeKind, number>();
  for (const n of graph.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);

  const neighbours = selected
    ? graph.edges
        .filter((e) => e.source === selected.id || e.target === selected.id)
        .map((e) => ({
          rel: e.rel ?? "linked",
          id: e.source === selected.id ? e.target : e.source,
        }))
    : [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  return (
    <aside className="flex min-h-0 w-[236px] shrink-0 flex-col border-r border-line bg-panel">
      <Section title="brain">
        {/* `mode`, not `reachable` — Gemini counts as thinking too. */}
        <Row k="mode">
          <span className={system.mode === "live" ? "text-ok" : "text-warn"}>
            {system.mode === "live" ? "LIVE" : "SIM"}
          </span>
        </Row>
        <Row k="brain">
          <span
            className="truncate text-dim"
            title={system.reachable ? system.scoutUrl : (system.note ?? "")}
          >
            {system.runner ?? system.scoutUrl.replace(/^https?:\/\//, "")}
          </span>
        </Row>
        <Row k="nodes">
          <span className="text-dim tabular-nums">{graph.nodes.length}</span>
        </Row>
        <Row k="edges">
          <span className="text-dim tabular-nums">{graph.edges.length}</span>
        </Row>
        {system.note ? (
          <p className="mt-2 border-l border-warn/40 pl-2 text-faint leading-relaxed">
            {system.note}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="mt-2 w-full border border-line py-1 text-faint transition-colors hover:border-line-2 hover:text-fg disabled:opacity-50"
        >
          {refreshing ? "reading…" : "re-read brain"}
        </button>
      </Section>

      <Section title="contexts">
        {system.contexts.length === 0 ? (
          <p className="text-faint">
            {system.reachable
              ? "no context providers registered"
              : "offline · showing seeded providers"}
          </p>
        ) : (
          system.contexts.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-0.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  c.ok ? "bg-ok" : "bg-err"
                }`}
              />
              <span className="truncate text-dim">{c.id}</span>
              <span className="ml-auto shrink-0 text-faint">
                {c.tools.length || ""}
              </span>
            </div>
          ))
        )}
      </Section>

      <Section title="senders">
        {!connectors ? (
          <p className="text-faint">checking…</p>
        ) : (
          <>
            {connectors.connectors.map((c) => (
              <div key={c.kind} className="flex items-center gap-2 py-0.5">
                {/*
                  Green means *you* can send on this surface — not that the
                  deployment has credentials somewhere. A dot that tracked
                  configuration was how an unconnected account still read as
                  ready, and a draft could report itself sent.
                */}
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    c.connected
                      ? "bg-ok"
                      : c.broken
                        ? "bg-err"
                        : "bg-line-2"
                  }`}
                />
                <span className="text-dim">{c.kind}</span>
                <span
                  className="ml-auto min-w-0 truncate text-faint"
                  title={
                    c.broken
                      ? `reconnect — ${c.brokenReason ?? "the grant is no longer valid"}`
                      : c.connected
                        ? `sends as ${c.account ?? "your connected account"}`
                        : c.configured
                          ? "you have not connected an account for this yet"
                          : `set ${c.missing.join(", ")} to enable`
                  }
                >
                  {c.connected ? (c.account ?? c.id ?? "connected") : ""}
                </span>
                {/*
                  A surface you can't send on is only useful if the fix is
                  right there. `configured` still gates it: when the deployment
                  has no client credentials there is nothing to hand off to,
                  and a button that always failed would be its own small lie.
                */}
                {c.connected ? null : c.configured ? (
                  <button
                    type="button"
                    onClick={() => onConnect(c.kind)}
                    className={`shrink-0 border px-1.5 transition-colors ${
                      c.broken
                        ? "border-err/50 text-err hover:bg-err/10"
                        : "border-line text-faint hover:border-line-2 hover:text-fg"
                    }`}
                    title={
                      c.broken
                        ? `reconnect — ${c.brokenReason ?? "the grant is no longer valid"}`
                        : "authorise your account for this surface"
                    }
                  >
                    {c.broken ? "reconnect" : "connect"}
                  </button>
                ) : (
                  <span className="shrink-0 text-faint" title={`set ${c.missing.join(", ")}`}>
                    —
                  </span>
                )}
              </div>
            ))}
            {connectors.dryRun ? (
              <p className="mt-1.5 border-l border-warn/40 pl-2 text-warn">
                dry run · approvals go through the whole path but nothing
                actually leaves
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section title="trust">
        <Trust trust={trust} brain={brain} onGraduate={onGraduate} />
      </Section>

      <Section title="layers">
        {KIND_ORDER.filter((k) => counts.get(k)).map((k) => {
          const off = hidden.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onToggleKind(k)}
              className={`flex w-full items-center gap-2 py-0.5 text-left transition-opacity ${
                off ? "opacity-30" : ""
              } hover:opacity-100`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: KIND_COLOR[k] }}
              />
              <span className="text-dim">{k}</span>
              <span className="ml-auto text-faint tabular-nums">
                {counts.get(k)}
              </span>
            </button>
          );
        })}
      </Section>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="node" flush>
          {!selected ? (
            <p className="text-faint">
              click a node to inspect it. drag to move, scroll to zoom.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: KIND_COLOR[selected.kind] }}
                />
                <div className="min-w-0">
                  <p className="break-words text-fg">{selected.label}</p>
                  <p className="text-faint">{selected.kind}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onSelect(null)}
                  className="ml-auto text-faint hover:text-fg"
                >
                  ✕
                </button>
              </div>
              {selected.detail ? (
                <p className="text-dim leading-relaxed">{selected.detail}</p>
              ) : null}
              {selected.meta
                ? Object.entries(selected.meta).map(([k, v]) => (
                    <Row key={k} k={k}>
                      <span className="truncate text-dim">{String(v)}</span>
                    </Row>
                  ))
                : null}
              {neighbours.length ? (
                <div className="pt-1">
                  <p className="label mb-1">links · {neighbours.length}</p>
                  {neighbours.slice(0, 24).map((n, i) => {
                    const node = byId.get(n.id);
                    if (!node) return null;
                    return (
                      <button
                        key={`${n.id}-${i}`}
                        type="button"
                        onClick={() => onSelect(node)}
                        className="flex w-full items-center gap-2 py-0.5 text-left hover:bg-raised"
                      >
                        <span className="w-14 shrink-0 text-faint">{n.rel}</span>
                        <span
                          className="h-1 w-1 shrink-0 rounded-full"
                          style={{ background: KIND_COLOR[node.kind] }}
                        />
                        <span className="truncate text-dim">{node.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
  flush,
}: {
  title: string;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className={flush ? "" : "border-b border-line"}>
      <h2 className="label px-3 pt-2.5 pb-1">{title}</h2>
      <div className="px-3 pb-2.5">{children}</div>
    </section>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-14 shrink-0 text-faint">{k}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
