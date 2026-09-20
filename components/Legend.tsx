"use client";

import { KIND_VAR } from "./theme";
import type { NodeKind } from "@/lib/types";

/**
 * What the dots mean, in the corner of the canvas.
 *
 * The rail already lists node kinds, but by their internal names — "action",
 * "contact" — which is the vocabulary of the schema, not of someone who
 * arrived thirty seconds ago. This says it in the words the product uses.
 *
 * Only the five kinds this app actually produces are listed: a legend for
 * nodes that never appear is furniture.
 */
const ENTRIES: { kind: NodeKind; label: string; gloss: string }[] = [
  { kind: "contact", label: "person", gloss: "signed in" },
  { kind: "intern", label: "intern", gloss: "a brief someone ran" },
  { kind: "action", label: "draft", gloss: "waiting for approval" },
  { kind: "fact", label: "fact", gloss: "something the brain knows" },
  { kind: "source", label: "source", gloss: "where a fact came from" },
];

export const KIND_LABEL: Partial<Record<NodeKind, string>> = Object.fromEntries(
  ENTRIES.map((e) => [e.kind, e.label]),
);

const OVERLAY_CLASS =
  "pointer-events-none flex flex-wrap items-center gap-x-3 gap-y-1 border border-line bg-panel/90 px-2 py-1 backdrop-blur";

export default function Legend({
  kinds,
  className = OVERLAY_CLASS,
}: {
  /** Restrict to these kinds — for a graph (e.g. the landing illustration)
   * that doesn't draw every kind the cockpit can. Omit to show all five. */
  kinds?: NodeKind[];
  /** Overrides the default floating-overlay chrome, e.g. for a legend that
   * sits inline as its own strip instead of on top of the canvas. */
  className?: string;
}) {
  const entries = kinds ? ENTRIES.filter((e) => kinds.includes(e.kind)) : ENTRIES;
  return (
    <div className={className}>
      {entries.map((e) => (
        <span key={e.kind} className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 ${e.kind === "contact" ? "rotate-45" : "rounded-full"}`}
            style={{ background: KIND_VAR[e.kind] }}
          />
          <span className="text-dim">{e.label}</span>
          <span className="text-faint">{e.gloss}</span>
        </span>
      ))}
    </div>
  );
}
