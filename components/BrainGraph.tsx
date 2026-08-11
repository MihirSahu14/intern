"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph, GraphNode, NodeKind } from "@/lib/types";

export const KIND_COLOR: Record<NodeKind, string> = {
  source: "#8d97a3",
  contact: "#6ee7b7",
  project: "#7cb7ff",
  note: "#c0a6ff",
  followup: "#ffb473",
  wiki: "#5fd0d0",
  tag: "#565c65",
  intern: "#f2f4f6",
  action: "#e8788a",
  fact: "#e3c877",
  question: "#ff8ad8",
};

export const KIND_ORDER: NodeKind[] = [
  "source",
  "contact",
  "project",
  "note",
  "followup",
  "wiki",
  "tag",
  "intern",
  "action",
  "fact",
  "question",
];

type Body = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 0..1 — how connected this node is relative to the busiest one. */
  imp: number;
  node: GraphNode;
  fixed: boolean;
};

/**
 * Kinds that live on the window's border rather than in the pile.
 *
 * People are drawn around the edge as diamonds: the middle belongs to the work
 * — facts, projects, whatever an intern is touching — and an org reads better
 * standing around its work than tangled in it. The simulation still decides
 * *where* on the rim each person sits, by the angle their links pull them to;
 * this only fixes the distance.
 */
const RIM_KINDS: ReadonlySet<string> = new Set(["contact"]);
const RIM_INSET = 30;

/** Cast a ray from the viewport centre out to the border rectangle. */
function pinToBorder(x: number, y: number, w: number, h: number) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  let dy = y - cy;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) dy = -1;

  const halfW = Math.max(20, w / 2 - RIM_INSET);
  const halfH = Math.max(20, h / 2 - RIM_INSET);
  const t = Math.min(
    halfW / Math.max(Math.abs(dx), 0.001),
    halfH / Math.max(Math.abs(dy), 0.001),
  );
  return { x: cx + dx * t, y: cy + dy * t };
}

type Props = {
  graph: Graph;
  selectedId: string | null;
  onSelect: (node: GraphNode | null) => void;
  query: string;
  hidden: Set<NodeKind>;
  /** Ids currently doing work — rendered with an expanding ring. */
  activeIds: string[];
};

/** Everything the render loop needs, kept in a ref so the loop never restarts. */
type Live = {
  graph: Graph;
  selectedId: string | null;
  adjacency: Map<string, Set<string>>;
  visible: Set<string>;
  matches: Set<string> | null;
  active: Set<string>;
};

/**
 * Size is connectivity, not the `weight` field.
 *
 * `weight` is optional and most nodes arrive without one, so sizing by it put
 * almost every node at the same radius and the graph read as an undifferentiated
 * mesh — you could not tell a hub from a leaf. Degree is always known and is the
 * thing a reader actually wants: how much of the brain hangs off this.
 *
 * `weight` still contributes where it exists, as a nudge rather than the driver.
 * Square root keeps a 40-link hub from dwarfing the canvas while still making it
 * unmistakably larger than a 2-link leaf — roughly 3px to 21px across.
 */
const MAX_R = 21;
const radiusOf = (n: GraphNode, degree: number) =>
  Math.min(MAX_R, 2.6 + Math.sqrt(degree + (n.weight ?? 0) * 0.6) * 2.9);

/** Relative standing, for opacity, label priority and edge strength. */
const impOf = (degree: number, maxDegree: number) =>
  maxDegree <= 0 ? 0 : Math.min(1, Math.sqrt(degree) / Math.sqrt(maxDegree));

export default function BrainGraph({
  graph,
  selectedId,
  onSelect,
  query,
  hidden,
  activeIds,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const bodies = useRef<Map<string, Body>>(new Map());
  const view = useRef({ k: 1, tx: 0, ty: 0 });
  const alpha = useRef(1);
  const size = useRef({ w: 1, h: 1 });
  const pointer = useRef({
    down: false,
    moved: false,
    dragId: null as string | null,
    lastX: 0,
    lastY: 0,
  });
  const hoverId = useRef<string | null>(null);
  /** Once the user pans/zooms/drags, auto-framing stops fighting them. */
  const userMoved = useRef(false);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [graph.edges]);

  const visible = useMemo(() => {
    const set = new Set<string>();
    for (const n of graph.nodes) if (!hidden.has(n.kind)) set.add(n.id);
    return set;
  }, [graph.nodes, hidden]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const set = new Set<string>();
    for (const n of graph.nodes) {
      if (
        n.label.toLowerCase().includes(q) ||
        n.kind.includes(q) ||
        (n.detail ?? "").toLowerCase().includes(q)
      ) {
        set.add(n.id);
      }
    }
    return set;
  }, [graph.nodes, query]);

  const live = useRef<Live>({
    graph,
    selectedId,
    adjacency,
    visible,
    matches,
    active: new Set(activeIds),
  });

  useEffect(() => {
    live.current = {
      graph,
      selectedId,
      adjacency,
      visible,
      matches,
      active: new Set(activeIds),
    };
  }, [graph, selectedId, adjacency, visible, matches, activeIds]);

  // --- sync bodies with the incoming graph, preserving positions ----------
  useEffect(() => {
    const map = bodies.current;
    const next = new Set(graph.nodes.map((n) => n.id));
    for (const id of map.keys()) if (!next.has(id)) map.delete(id);

    // One pass for the busiest node, so importance is relative to this brain
    // rather than to an absolute that goes wrong at both small and large sizes.
    let maxDegree = 0;
    for (const n of graph.nodes) {
      const d = adjacency.get(n.id)?.size ?? 0;
      if (d > maxDegree) maxDegree = d;
    }

    let added = false;
    graph.nodes.forEach((n, i) => {
      const degree = adjacency.get(n.id)?.size ?? 0;
      const existing = map.get(n.id);
      if (existing) {
        existing.node = n;
        existing.r = radiusOf(n, degree);
        existing.imp = impOf(degree, maxDegree);
        return;
      }
      added = true;
      // Seed new nodes next to a neighbour so grafted nodes grow out of the
      // brain instead of flying in from a corner.
      const anchor = [...(adjacency.get(n.id) ?? [])]
        .map((id) => map.get(id))
        .find(Boolean);
      const angle = (i * 137.5 * Math.PI) / 180;
      const spread = 40 + Math.sqrt(graph.nodes.length) * 14;
      map.set(n.id, {
        id: n.id,
        x: (anchor?.x ?? 0) + Math.cos(angle) * (anchor ? 22 : spread),
        y: (anchor?.y ?? 0) + Math.sin(angle) * (anchor ? 22 : spread),
        vx: 0,
        vy: 0,
        r: radiusOf(n, degree),
        imp: impOf(degree, maxDegree),
        node: n,
        fixed: false,
      });
    });
    if (added) alpha.current = Math.max(alpha.current, 0.75);
  }, [graph.nodes, adjacency]);

  // Reheat whenever the brain changes shape.
  useEffect(() => {
    alpha.current = Math.max(alpha.current, 0.6);
  }, [graph.generatedAt]);

  // --- framing ------------------------------------------------------------
  /** Camera that would frame every visible node, or null if there are none. */
  const computeFit = useCallback(() => {
    const bs = [...bodies.current.values()].filter((b) =>
      live.current.visible.has(b.id),
    );
    if (!bs.length) return null;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const b of bs) {
      minX = Math.min(minX, b.x);
      maxX = Math.max(maxX, b.x);
      minY = Math.min(minY, b.y);
      maxY = Math.max(maxY, b.y);
    }
    const { w, h } = size.current;
    const pad = 56;
    const k = Math.min(
      2.4,
      Math.max(
        0.15,
        Math.min(
          (w - pad * 2) / (maxX - minX || 1),
          (h - pad * 2) / (maxY - minY || 1),
        ),
      ),
    );
    return {
      k,
      tx: w / 2 - ((minX + maxX) / 2) * k,
      ty: h / 2 - ((minY + maxY) / 2) * k,
    };
  }, []);

  const fit = useCallback(() => {
    const target = computeFit();
    if (!target) return;
    userMoved.current = false;
    view.current = target;
  }, [computeFit]);

  const fitRef = useRef(computeFit);
  useEffect(() => {
    fitRef.current = computeFit;
  }, [computeFit]);

  // --- simulation + render loop (mounted once) ----------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let measured = false;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.current = { w: rect.width, h: rect.height };
      if (!measured && rect.width > 0) {
        // World origin starts at the middle of the canvas, not the corner.
        measured = true;
        view.current.tx = rect.width / 2;
        view.current.ty = rect.height / 2;
      }
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    ro.observe(wrap);

    const REPULSION = 2400;
    const SPRING = 0.035;
    const LINK_LEN = 74;
    const GRAVITY = 0.011;
    const DAMP = 0.84;

    /**
     * People sit on the rim, not in the pile.
     *
     * Everything else falls toward the centre; these fall toward a ring
     * instead. It reads as an org standing around its work rather than being
     * tangled in it, and it keeps the middle for what is actually moving —
     * facts, projects and whatever an intern is touching right now.
     */
    const RIM: ReadonlySet<string> = new Set(["contact"]);
    const RIM_PULL = 1.7;

    const step = () => {
      const bs = [...bodies.current.values()];
      if (!bs.length) return;
      const a = alpha.current;
      if (a < 0.005) return;

      for (let i = 0; i < bs.length; i++) {
        const p = bs[i];
        for (let j = i + 1; j < bs.length; j++) {
          const q = bs[j];
          let dx = q.x - p.x;
          let dy = q.y - p.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) {
            dx = (Math.random() - 0.5) * 0.6;
            dy = (Math.random() - 0.5) * 0.6;
            d2 = dx * dx + dy * dy;
          }
          if (d2 > 160000) continue; // far enough apart to ignore
          const d = Math.sqrt(d2);
          const f = (REPULSION / d2) * a;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          p.vx -= fx;
          p.vy -= fy;
          q.vx += fx;
          q.vy += fy;
        }
      }

      for (const e of live.current.graph.edges) {
        const p = bodies.current.get(e.source);
        const q = bodies.current.get(e.target);
        if (!p || !q) continue;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const target = LINK_LEN + p.r + q.r;
        const f = (d - target) * SPRING * a;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        p.vx += fx;
        p.vy += fy;
        q.vx -= fx;
        q.vy -= fy;
      }

      // Scales with the graph so the rim stays clear of the middle as the
      // brain grows, rather than being a radius that only suits one size.
      const rim = 150 + Math.sqrt(bs.length) * 26;

      for (const b of bs) {
        if (b.fixed) {
          b.vx = 0;
          b.vy = 0;
          continue;
        }
        if (RIM.has(b.node.kind)) {
          const d = Math.hypot(b.x, b.y) || 0.001;
          const pull = (d - rim) * GRAVITY * RIM_PULL * a;
          b.vx -= (b.x / d) * pull;
          b.vy -= (b.y / d) * pull;
        } else {
          b.vx -= b.x * GRAVITY * a;
          b.vy -= b.y * GRAVITY * a;
        }
        b.vx *= DAMP;
        b.vy *= DAMP;
        b.x += Math.max(-14, Math.min(14, b.vx));
        b.y += Math.max(-14, Math.min(14, b.vy));
      }

      alpha.current = a * 0.985;
    };

    const fontFamily = getComputedStyle(document.body).fontFamily;

    const draw = () => {
      const { w, h } = size.current;
      const { k, tx, ty } = view.current;
      const { graph: g, selectedId: sel, adjacency: adj, visible: vis, matches: mt, active } =
        live.current;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#08090a";
      ctx.fillRect(0, 0, w, h);

      // dot grid, panning with the world
      const gap = 26 * k;
      if (gap > 9) {
        ctx.fillStyle = "rgba(255,255,255,0.035)";
        const ox = ((tx % gap) + gap) % gap;
        const oy = ((ty % gap) + gap) % gap;
        for (let x = ox; x < w; x += gap) {
          for (let y = oy; y < h; y += gap) ctx.fillRect(x, y, 1, 1);
        }
      }

      const neighbours = sel ? (adj.get(sel) ?? new Set<string>()) : null;

      const focusOf = (id: string): number => {
        if (!vis.has(id)) return 0;
        if (mt && !mt.has(id)) return 0.12;
        if (sel) {
          if (id === sel) return 1;
          if (neighbours?.has(id)) return 0.85;
          return 0.14;
        }
        return 1;
      };

      const sx = (x: number) => x * k + tx;
      const sy = (y: number) => y * k + ty;

      // Resolve every body once — people land on the border, everything else
      // wherever the simulation put it — so edges and nodes agree.
      const at = new Map<string, { x: number; y: number }>();
      for (const b of bodies.current.values()) {
        const x = sx(b.x);
        const y = sy(b.y);
        at.set(b.id, RIM_KINDS.has(b.node.kind) ? pinToBorder(x, y, w, h) : { x, y });
      }

      for (const e of g.edges) {
        const p = bodies.current.get(e.source);
        const q = bodies.current.get(e.target);
        if (!p || !q) continue;
        const f = Math.min(focusOf(p.id), focusOf(q.id));
        if (f <= 0) continue;
        const pp = at.get(p.id)!;
        const qq = at.get(q.id)!;
        const lit = sel && (p.id === sel || q.id === sel);
        // An edge is only as loud as the busier thing it connects, so the
        // spine of the graph reads first and the fringe settles behind it.
        const strength = Math.max(p.imp, q.imp);
        ctx.lineWidth = Math.max(0.4, (0.4 + strength * 0.9) * k);
        ctx.strokeStyle = lit
          ? "rgba(78,201,165,0.5)"
          : `rgba(255,255,255,${(0.04 + 0.11 * strength) * f})`;
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y);
        ctx.lineTo(qq.x, qq.y);
        ctx.stroke();
      }

      const labelled: Body[] = [];
      const now = Date.now();
      for (const b of bodies.current.values()) {
        const f = focusOf(b.id);
        if (f <= 0) continue;
        const rim = RIM_KINDS.has(b.node.kind);
        const { x, y } = at.get(b.id)!;
        const r = b.r * Math.max(0.55, Math.min(k, 1.7));
        // Pinned nodes are always on screen; only cull the ones that aren't.
        if (!rim && (x < -40 || y < -40 || x > w + 40 || y > h + 40)) continue;

        const color = KIND_COLOR[b.node.kind];

        if (active.has(b.id)) {
          const t = (now % 1600) / 1600;
          ctx.beginPath();
          ctx.arc(x, y, r + 3 + t * 9, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(78,201,165,${(1 - t) * 0.5})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Hubs carry a faint halo. It is what stops a busy graph reading flat:
        // depth has to come from somewhere, and size alone plateaus once the
        // biggest nodes hit the cap.
        if (b.imp > 0.5 && !rim) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4 + b.imp * 5, 0, Math.PI * 2);
          ctx.fillStyle = withAlpha(color, 0.06 * b.imp * f);
          ctx.fill();
        }

        ctx.beginPath();
        if (rim) {
          // A person is a diamond. Different shape as well as different place,
          // so the rim reads as a different class of thing at a glance.
          const d = r + 2.5;
          ctx.moveTo(x, y - d);
          ctx.lineTo(x + d, y);
          ctx.lineTo(x, y + d);
          ctx.lineTo(x - d, y);
          ctx.closePath();
        } else {
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        // Opacity and rim weight track importance for the same reason size
        // does — a leaf should recede, not just be smaller.
        ctx.fillStyle = withAlpha(
          color,
          b.id === sel ? 1 : (0.1 + 0.55 * b.imp) * f,
        );
        ctx.fill();
        ctx.lineWidth =
          b.id === sel || b.id === hoverId.current ? 1.5 : 0.6 + b.imp * 0.9;
        ctx.strokeStyle = withAlpha(
          color,
          b.id === sel ? 1 : (0.3 + 0.55 * b.imp) * f,
        );
        ctx.stroke();

        const important =
          b.imp >= 0.5 ||
          b.id === sel ||
          b.id === hoverId.current ||
          neighbours?.has(b.id) ||
          (mt?.has(b.id) ?? false);
        // People on the rim keep their names at any zoom — a nameless diamond
        // on the border is not information.
        if (rim || (k > 0.62 && important) || k > 1.25) labelled.push(b);
      }

      // labels last so they sit above the mesh, and never on top of each other
      ctx.font = `10px ${fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      labelled.sort((a, b) => {
        const rank = (n: Body) =>
          n.id === sel ? 3 : n.id === hoverId.current ? 2 : 0;
        // When labels collide the busier node keeps its name.
        return rank(b) - rank(a) || b.imp - a.imp;
      });
      const taken: [number, number, number, number][] = [];
      for (const b of labelled) {
        const f = focusOf(b.id);
        const p = at.get(b.id)!;
        const x = p.x;
        const y = p.y + b.r * Math.max(0.55, Math.min(k, 1.7)) + 4;
        const label = truncate(b.node.label, 26);
        const wText = ctx.measureText(label).width;
        const box: [number, number, number, number] = [
          x - wText / 2 - 2,
          y - 1,
          wText + 4,
          12,
        ];
        const clash = taken.some(
          ([tx0, ty0, tw, th]) =>
            box[0] < tx0 + tw &&
            box[0] + box[2] > tx0 &&
            box[1] < ty0 + th &&
            box[1] + box[3] > ty0,
        );
        if (clash && b.id !== sel && b.id !== hoverId.current) continue;
        taken.push(box);
        ctx.fillStyle = `rgba(8,9,10,${0.72 * f})`;
        ctx.fillRect(box[0], box[1], box[2], box[3]);
        ctx.fillStyle =
          b.id === sel
            ? "#e4e6e9"
            : `rgba(${b.node.kind === "tag" ? "120,126,134" : "200,205,211"},${
                0.35 + 0.6 * f
              })`;
        ctx.fillText(label, x, y);
      }
    };

    // While the user hasn't taken the camera, ease it toward a frame that
    // holds the whole brain — so a graph that is still growing stays visible.
    const autoFrame = () => {
      if (userMoved.current) return;
      const target = fitRef.current();
      if (!target) return;
      const v = view.current;
      const ease = 0.07;
      v.k += (target.k - v.k) * ease;
      v.tx += (target.tx - v.tx) * ease;
      v.ty += (target.ty - v.ty) * ease;
    };

    let raf = 0;
    const tick = () => {
      step();
      autoFrame();
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // --- interaction --------------------------------------------------------
  const toWorld = (cx: number, cy: number) => {
    const { k, tx, ty } = view.current;
    return { x: (cx - tx) / k, y: (cy - ty) / k };
  };

  /** Where a body is actually drawn — rim kinds are pinned to the border. */
  const screenPos = (b: Body) => {
    const { k, tx, ty } = view.current;
    const x = b.x * k + tx;
    const y = b.y * k + ty;
    if (!RIM_KINDS.has(b.node.kind)) return { x, y };
    const { w, h } = size.current;
    return pinToBorder(x, y, w, h);
  };

  // Screen space, so a pinned person is clickable where you can see it rather
  // than where the simulation thinks it is.
  const hitTest = (cx: number, cy: number): Body | null => {
    let best: Body | null = null;
    let bestD = Infinity;
    for (const b of bodies.current.values()) {
      if (!live.current.visible.has(b.id)) continue;
      const p = screenPos(b);
      const d = Math.hypot(p.x - cx, p.y - cy);
      const radius = Math.max(b.r * view.current.k + 5, 9);
      if (d < radius && d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  };

  const local = (e: React.PointerEvent<HTMLDivElement> | React.WheelEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const { cx, cy } = local(e);
    const hit = hitTest(cx, cy);
    pointer.current = {
      down: true,
      moved: false,
      dragId: hit?.id ?? null,
      lastX: cx,
      lastY: cy,
    };
    if (hit) hit.fixed = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const { cx, cy } = local(e);
    const p = pointer.current;

    if (!p.down) {
      const hit = hitTest(cx, cy);
      const id = hit?.id ?? null;
      if (id !== hoverId.current) {
        hoverId.current = id;
        setHoverLabel(hit ? `${hit.node.kind} · ${hit.node.label}` : null);
      }
      return;
    }

    const dx = cx - p.lastX;
    const dy = cy - p.lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) p.moved = true;
    p.lastX = cx;
    p.lastY = cy;

    userMoved.current = true;
    if (p.dragId) {
      const b = bodies.current.get(p.dragId);
      if (b) {
        b.x += dx / view.current.k;
        b.y += dy / view.current.k;
        alpha.current = Math.max(alpha.current, 0.4);
      }
    } else {
      view.current.tx += dx;
      view.current.ty += dy;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (p.dragId) {
      const b = bodies.current.get(p.dragId);
      if (b) b.fixed = false;
    }
    if (!p.moved) {
      const { cx, cy } = local(e);
      const hit = hitTest(cx, cy);
      onSelect(hit ? hit.node : null);
    }
    pointer.current = {
      down: false,
      moved: false,
      dragId: null,
      lastX: 0,
      lastY: 0,
    };
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const { cx, cy } = local(e);
    userMoved.current = true;
    const v = view.current;
    const factor = Math.exp(-e.deltaY * 0.0016);
    const k = Math.max(0.12, Math.min(4.5, v.k * factor));
    v.tx = cx - ((cx - v.tx) / v.k) * k;
    v.ty = cy - ((cy - v.ty) / v.k) * k;
    v.k = k;
  };

  const zoomBy = (factor: number) => {
    userMoved.current = true;
    const v = view.current;
    const { w, h } = size.current;
    const k = Math.max(0.12, Math.min(4.5, v.k * factor));
    v.tx = w / 2 - ((w / 2 - v.tx) / v.k) * k;
    v.ty = h / 2 - ((h / 2 - v.ty) / v.k) * k;
    v.k = k;
  };

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div
        className="absolute inset-0 touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ cursor: hoverLabel ? "pointer" : "grab" }}
      />

      {hoverLabel ? (
        <div className="pointer-events-none absolute bottom-3 left-3 border border-line bg-panel/90 px-2 py-1 text-dim backdrop-blur">
          {hoverLabel}
        </div>
      ) : null}

      <div className="absolute right-3 bottom-3 flex gap-px border border-line bg-panel">
        <GraphBtn onClick={() => zoomBy(1.25)} title="zoom in">
          +
        </GraphBtn>
        <GraphBtn onClick={() => zoomBy(0.8)} title="zoom out">
          −
        </GraphBtn>
        <GraphBtn onClick={fit} title="fit to view">
          ⤢
        </GraphBtn>
      </div>
    </div>
  );
}

function GraphBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-6 w-6 text-faint transition-colors hover:bg-raised hover:text-fg"
    >
      {children}
    </button>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function withAlpha(hex: string, a: number) {
  const v = hex.replace("#", "");
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
