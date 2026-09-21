"use client";

import { KIND_VAR } from "./theme";
import type { NodeKind } from "@/lib/types";

/**
 * A node kind, drawn the way the canvas draws it.
 *
 * The rail and the legend used to mark each kind with a 6px dot, so a person —
 * a diamond pinned to the rim of the graph — was announced by a circle. A key
 * that doesn't match the thing it is a key to is worse than none: this mirrors
 * the canvas exactly, translucent fill inside a solid edge, circle for the
 * work and the knowledge, diamond for a person.
 */
export default function KindGlyph({ kind, size = 14 }: { kind: NodeKind; size?: number }) {
  const color = KIND_VAR[kind];
  const c = size / 2;
  // A diamond inside the same radius covers about a third less area than the
  // circle beside it, so it reads smaller at a glance. Grow it until the two
  // weigh the same.
  const r = size * (kind === "contact" ? 0.46 : 0.36);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="shrink-0"
    >
      {kind === "contact" ? (
        <polygon
          points={`${c},${c - r} ${c + r},${c} ${c},${c + r} ${c - r},${c}`}
          fill={color}
          fillOpacity={0.55}
          stroke={color}
          strokeWidth={1}
        />
      ) : (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill={color}
          fillOpacity={0.55}
          stroke={color}
          strokeWidth={1}
        />
      )}
    </svg>
  );
}
