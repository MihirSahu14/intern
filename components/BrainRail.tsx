"use client";

import { KIND_ORDER } from "./BrainGraph";
import KindGlyph from "./KindGlyph";
import { KIND_GLOSS, KIND_LABEL } from "./Legend";
import type { ConnectorKey } from "@/lib/connectors";
import type { ActionKind, Graph, GraphNode, NodeKind } from "@/lib/types";

export type ConnectorRow = {
  key: ConnectorKey;
  label: string;
  forKind: ActionKind;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
  /** Gmail's `Intern` label: null when this deployment doesn't offer it, else whether it's on. */
  capture: boolean | null;
  /** Shown under this connector's row: what its grant actually lets Composio do. */
  disclosure: string;
  /** The community workspace's invite link (Slack only), or null. */
  invite: string | null;
};

export default function BrainRail({
  graph,
  hidden,
  onToggleKind,
  selected,
  onSelect,
  connectors,
  onConnect,
  onDisconnect,
  onCapture,
}: {
  graph: Graph;
  hidden: Set<NodeKind>;
  onToggleKind: (k: NodeKind) => void;
  selected: GraphNode | null;
  onSelect: (n: GraphNode | null) => void;
  connectors: ConnectorRow[];
  onConnect: (key: ConnectorKey) => void;
  onDisconnect: (key: ConnectorKey) => void;
  onCapture: (on: boolean) => void;
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

      <Section title="accounts">
        {connectors.map((c) => (
          <div key={c.key}>
            <Row k={c.label.toLowerCase()}>
              {!c.configured ? (
                <span className="text-faint">not set up yet</span>
              ) : c.connected ? (
                <span className="text-dim">
                  connected as {c.accountLabel ?? c.label} ·{" "}
                  <button type="button" onClick={() => onDisconnect(c.key)} className="text-faint hover:text-err">
                    disconnect
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => onConnect(c.key)} className="text-accent hover:underline">
                  connect
                </button>
              )}
            </Row>
            {c.invite && !c.connected ? (
              <p className="pt-0.5 leading-snug">
                <a href={c.invite} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                  Join the community Slack first
                </a>
              </p>
            ) : null}
            {c.capture === null ? null : (
              // Off by default. On is its own read-only consent; the send grant never reads mail.
              <Row k="">
                <span className="text-dim">
                  <code>Intern</code> label → private facts ·{" "}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={c.capture}
                    onClick={() => onCapture(!c.capture)}
                    className={c.capture ? "text-accent hover:text-err" : "text-faint hover:text-accent"}
                  >
                    {c.capture ? "on" : "off"}
                  </button>
                </span>
              </Row>
            )}
            {c.configured ? <p className="pt-0.5 text-faint leading-snug">{c.disclosure}</p> : null}
          </div>
        ))}
      </Section>

      <Section title="layers">
        {KIND_ORDER.filter((k) => counts.get(k)).map((k) => {
          const off = hidden.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => onToggleKind(k)}
              className={`flex w-full items-start gap-2 py-1 text-left transition-opacity ${
                off ? "opacity-30" : ""
              } hover:opacity-100`}
              title={off ? "show these" : "hide these"}
            >
              <span className="mt-0.5">
                <KindGlyph kind={k} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-dim">{KIND_LABEL[k] ?? k}</span>
                {KIND_GLOSS[k] ? (
                  <span className="block text-faint leading-snug">{KIND_GLOSS[k]}</span>
                ) : null}
              </span>
              <span className="text-faint tabular-nums">
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
                <span className="mt-0.5">
                  <KindGlyph kind={selected.kind} />
                </span>
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
                        <KindGlyph kind={node.kind} size={11} />
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
