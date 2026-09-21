"use client";

import { KIND_COLOR, KIND_ORDER } from "./BrainGraph";
import type { Graph, GraphNode, NodeKind } from "@/lib/types";

export default function BrainRail({
  graph,
  hidden,
  onToggleKind,
  selected,
  onSelect,
}: {
  graph: Graph;
  hidden: Set<NodeKind>;
  onToggleKind: (k: NodeKind) => void;
  selected: GraphNode | null;
  onSelect: (n: GraphNode | null) => void;
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
        <Row k="nodes"><span className="text-dim tabular-nums">{graph.nodes.length}</span></Row>
        <Row k="edges"><span className="text-dim tabular-nums">{graph.edges.length}</span></Row>
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
