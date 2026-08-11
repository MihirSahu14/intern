"use client";

import { useEffect, useRef } from "react";

/**
 * A miniature brain for the landing page.
 *
 * Seeded rather than fetched: the real graph is behind sign-in, and a public
 * page should not be waiting on a websocket to draw its own hero. The sizing
 * is the same rule the cockpit uses — radius and opacity from degree, not from
 * a stored weight — so what you see here is honestly what you get inside.
 */

const C = {
  source: "#8d97a3",
  contact: "#6ee7b7",
  project: "#7cb7ff",
  note: "#c0a6ff",
  followup: "#ffb473",
  wiki: "#5fd0d0",
  tag: "#565c65",
} as const;

type Kind = keyof typeof C;

const NODES: { id: string; label: string; kind: Kind }[] = [
  { id: "slack", label: "slack", kind: "source" },
  { id: "drive", label: "drive", kind: "source" },
  { id: "wiki", label: "wiki", kind: "source" },
  { id: "ramp", label: "ramp pilot", kind: "project" },
  { id: "billing", label: "billing rewrite", kind: "project" },
  { id: "onboard", label: "onboarding", kind: "project" },
  { id: "mara", label: "Mara", kind: "contact" },
  { id: "ana", label: "Ana", kind: "contact" },
  { id: "dev", label: "Dev", kind: "contact" },
  { id: "n1", label: "pilot is Slack-first", kind: "note" },
  { id: "n2", label: "no new dashboard", kind: "note" },
  { id: "n3", label: "invoices land Fridays", kind: "note" },
  { id: "n4", label: "design owns the wiki", kind: "note" },
  { id: "n5", label: "never open with “Following up”", kind: "note" },
  { id: "w1", label: "pilot runbook", kind: "wiki" },
  { id: "w2", label: "house style", kind: "wiki" },
  { id: "f1", label: "confirm rollout date", kind: "followup" },
  { id: "f2", label: "chase legal", kind: "followup" },
  { id: "t1", label: "#pilot", kind: "tag" },
  { id: "t2", label: "#design", kind: "tag" },
  { id: "t3", label: "#billing", kind: "tag" },
];

const EDGES: [string, string][] = [
  ["slack", "n1"], ["slack", "n2"], ["slack", "n5"], ["slack", "mara"],
  ["drive", "n3"], ["drive", "billing"], ["wiki", "w1"], ["wiki", "w2"],
  ["ramp", "n1"], ["ramp", "n2"], ["ramp", "w1"], ["ramp", "mara"],
  ["ramp", "t1"], ["ramp", "f1"], ["ramp", "dev"],
  ["billing", "n3"], ["billing", "t3"], ["billing", "f2"], ["billing", "ana"],
  ["onboard", "n4"], ["onboard", "t2"], ["onboard", "ana"],
  ["w2", "n5"], ["w2", "t2"], ["n4", "wiki"], ["mara", "t1"], ["dev", "t1"],
  ["ana", "t2"], ["n1", "t1"], ["n2", "t1"], ["f1", "mara"],
];

type Body = {
  id: string;
  label: string;
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  imp: number;
};

export default function LandingGraph() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hover = useRef<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const adj = new Map<string, Set<string>>();
    for (const [a, b] of EDGES) {
      if (!adj.has(a)) adj.set(a, new Set());
      if (!adj.has(b)) adj.set(b, new Set());
      adj.get(a)!.add(b);
      adj.get(b)!.add(a);
    }
    let maxDeg = 0;
    for (const n of NODES) maxDeg = Math.max(maxDeg, adj.get(n.id)?.size ?? 0);

    // Deterministic seeding — the same picture every load, so the page has a
    // composition rather than whatever a random ring happened to produce.
    const bodies: Body[] = NODES.map((n, i) => {
      const deg = adj.get(n.id)?.size ?? 0;
      const a = (i * 137.5 * Math.PI) / 180;
      return {
        ...n,
        x: Math.cos(a) * (40 + i * 4),
        y: Math.sin(a) * (40 + i * 4),
        vx: 0,
        vy: 0,
        r: Math.min(16, 2.4 + Math.sqrt(deg) * 2.9),
        imp: maxDeg ? Math.min(1, Math.sqrt(deg) / Math.sqrt(maxDeg)) : 0,
      };
    });
    const byId = new Map(bodies.map((b) => [b.id, b]));

    let w = 0;
    let h = 0;
    let dpr = 1;
    const size = () => {
      const rect = wrap.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);

    const step = () => {
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const f = Math.min(1400 / d2, 3);
          const d = Math.sqrt(d2);
          const ux = dx / d;
          const uy = dy / d;
          a.vx -= ux * f;
          a.vy -= uy * f;
          b.vx += ux * f;
          b.vy += uy * f;
        }
      }
      for (const [ai, bi] of EDGES) {
        const a = byId.get(ai)!;
        const b = byId.get(bi)!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const f = (d - (46 + a.r + b.r)) * 0.012;
        const ux = dx / d;
        const uy = dy / d;
        a.vx += ux * f;
        a.vy += uy * f;
        b.vx -= ux * f;
        b.vy -= uy * f;
      }
      for (const b of bodies) {
        b.vx += -b.x * 0.0022;
        b.vy += -b.y * 0.0022;
        b.x += b.vx;
        b.y += b.vy;
        b.vx *= 0.82;
        b.vy *= 0.82;
      }
    };

    for (let i = 0; i < 260; i++) step();

    const draw = () => {
      if (!reduced) step();
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const at = (b: Body) => ({ x: cx + b.x, y: cy + b.y });

      const hv = hover.current;
      const near = hv ? (adj.get(hv) ?? new Set<string>()) : null;
      const focus = (id: string) =>
        !hv ? 1 : id === hv ? 1 : near!.has(id) ? 0.9 : 0.12;

      for (const [ai, bi] of EDGES) {
        const a = byId.get(ai)!;
        const b = byId.get(bi)!;
        const f = Math.min(focus(a.id), focus(b.id));
        const pa = at(a);
        const pb = at(b);
        const strength = Math.max(a.imp, b.imp);
        ctx.lineWidth = 0.4 + strength * 0.8;
        ctx.strokeStyle = `rgba(255,255,255,${(0.04 + 0.1 * strength) * f})`;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }

      for (const b of bodies) {
        const f = focus(b.id);
        const p = at(b);
        const col = C[b.kind];

        if (b.imp > 0.5) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, b.r + 4 + b.imp * 5, 0, Math.PI * 2);
          ctx.fillStyle = hexA(col, 0.06 * b.imp * f);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = hexA(col, (0.1 + 0.55 * b.imp) * f);
        ctx.fill();
        ctx.lineWidth = b.id === hv ? 1.5 : 0.6 + b.imp * 0.9;
        ctx.strokeStyle = hexA(col, (0.3 + 0.55 * b.imp) * f);
        ctx.stroke();

        if (b.imp >= 0.55 || b.id === hv) {
          ctx.font = "10px var(--font-mono), ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = `rgba(200,205,211,${0.3 + 0.6 * f})`;
          ctx.fillText(b.label, p.x, p.y + b.r + 5);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    let raf = requestAnimationFrame(draw);

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - w / 2;
      const my = e.clientY - rect.top - h / 2;
      let best: string | null = null;
      let bestD = 20 * 20;
      for (const b of bodies) {
        const d2 = (b.x - mx) ** 2 + (b.y - my) ** 2;
        if (d2 < bestD) {
          bestD = d2;
          best = b.id;
        }
      }
      hover.current = best;
      canvas.style.cursor = best ? "pointer" : "default";
    };
    const onLeave = () => {
      hover.current = null;
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative h-[340px] w-full sm:h-[420px]"
      aria-label="An example company brain: sources, projects, people and notes, sized by how connected they are"
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
}

function hexA(hex: string, a: number) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
