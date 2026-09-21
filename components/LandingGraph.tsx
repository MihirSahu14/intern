"use client";

import { useState } from "react";
import type { Graph, GraphNode, NodeKind } from "@/lib/types";
import BrainGraph from "./BrainGraph";
import Legend from "./Legend";

/**
 * A worked example, not the live brain.
 *
 * The real graph is behind sign-in, and the public page shouldn't pretend
 * otherwise — this is a fixed, made-up onboarding brief, drawn with the
 * exact renderer and tokens the cockpit uses (same shapes, same colours,
 * same physics) so what a visitor sees here is honestly what they'd get
 * inside. Only the three kinds actually drawn — no person, no draft — so
 * the legend below isn't naming something that isn't there.
 */
const EXAMPLE_GRAPH: Graph = {
  nodes: [
    { id: "slack", label: "slack", kind: "source", weight: 1 },
    { id: "wiki", label: "wiki", kind: "source", weight: 1 },
    { id: "f-monday", label: "new hires start on a Monday", kind: "fact", weight: 1 },
    { id: "f-pto", label: "PTO requests go through #hr", kind: "fact", weight: 1 },
    { id: "f-runbook", label: "the onboarding runbook", kind: "fact", weight: 1 },
    { id: "f-learned", label: "keep Slack posts to three lines", kind: "fact", weight: 2 },
    { id: "intern", label: "onboard Sarah Chen", kind: "intern", weight: 3 },
  ],
  edges: [
    { source: "slack", target: "f-monday", rel: "observed" },
    { source: "slack", target: "f-pto", rel: "observed" },
    { source: "wiki", target: "f-runbook", rel: "observed" },
    { source: "intern", target: "f-monday", rel: "read" },
    { source: "intern", target: "f-pto", rel: "read" },
    { source: "intern", target: "f-runbook", rel: "read" },
    { source: "intern", target: "f-learned", rel: "filed" },
  ],
  mode: "sim",
  generatedAt: 0,
};

const NONE = new Set<NodeKind>();
const LEGEND_KINDS: NodeKind[] = ["source", "fact", "intern"];

export default function LandingGraph() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex flex-col">
      <div className="relative h-[280px] sm:h-[360px]">
        <BrainGraph
          graph={EXAMPLE_GRAPH}
          selectedId={selectedId}
          onSelect={(n: GraphNode | null) => setSelectedId(n?.id ?? null)}
          query=""
          hidden={NONE}
          activeIds={[]}
        />
      </div>
      <Legend
        kinds={LEGEND_KINDS}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2"
      />
    </div>
  );
}
