"use client";

import { useEffect, useState } from "react";
import type { Intern, InternStatus } from "@/lib/types";

const STATUS: Record<InternStatus, { dot: string; text: string; label: string }> =
  {
    queued: { dot: "bg-warn", text: "text-warn", label: "queued" },
    running: { dot: "bg-ok pulse-slow", text: "text-ok", label: "running" },
    waiting: {
      dot: "bg-k-question pulse-slow",
      text: "text-k-question",
      label: "waiting on you",
    },
    done: { dot: "bg-line-2", text: "text-dim", label: "done" },
    failed: { dot: "bg-err", text: "text-err", label: "failed" },
    cancelled: { dot: "bg-faint", text: "text-faint", label: "cancelled" },
  };

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export default function InternRail({
  interns,
  filter,
  onFilter,
  onKill,
  onRetry,
  mineId,
}: {
  interns: Intern[];
  filter: string | null;
  onFilter: (id: string | null) => void;
  onKill: (id: string) => void;
  /** Run this same intern again, in place. Only offered on your own runs. */
  onRetry: (id: string) => void;
  mineId: string;
}) {
  const live = interns.some(
    (i) => i.status === "running" || i.status === "queued",
  );
  const now = useNow(live);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">interns</h2>
        <span className="text-faint tabular-nums">
          {interns.filter((i) => i.status === "running").length}/
          {interns.length}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {interns.length === 0 ? (
          <p className="p-3 text-faint leading-relaxed">
            no interns yet.
            <br />
            <br />
            an intern takes one long-running brief, navigates whatever sources
            it needs, and files what it learns back into the brain.
          </p>
        ) : null}

        {interns.map((i) => {
          const s = STATUS[i.status];
          const end = i.endedAt ?? now;
          const secs = i.startedAt ? (end - i.startedAt) / 1000 : 0;
          const selected = filter === i.id;
          return (
            <article
              key={i.id}
              onClick={() => onFilter(selected ? null : i.id)}
              className={`enter cursor-pointer border-b border-line px-3 py-2 transition-colors ${
                selected ? "bg-raised" : "hover:bg-raised/50"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                <span className="text-fg">{i.handle}</span>
                <span className={`${s.text}`}>{s.label}</span>
                <span className="ml-auto tabular-nums text-faint">
                  {secs ? `${secs.toFixed(1)}s` : "—"}
                </span>
                {i.status === "running" || i.status === "queued" ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onKill(i.id);
                    }}
                    className="text-faint transition-colors hover:text-err"
                    title="kill"
                  >
                    ✕
                  </button>
                ) : null}
                {/*
                  A failed run usually failed for a reason that has since
                  passed — the free model was busy — so the fix is the same
                  brief again. It runs *this* intern again rather than making
                  a second one: same card, same node, same log.
                */}
                {(i.status === "failed" || i.status === "cancelled") &&
                i.ownerId === mineId ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetry(i.id);
                    }}
                    className="text-faint transition-colors hover:text-fg"
                    title="run this brief again"
                  >
                    ↻
                  </button>
                ) : null}
              </div>

              <p className="mt-1 line-clamp-3 text-dim leading-relaxed">
                {i.task}
              </p>

              {i.tools.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {i.tools.map((t) => (
                    <span
                      key={t}
                      className="border border-line px-1 text-faint"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}

              {i.artifacts.length ? (
                <div className="mt-1.5 space-y-0.5">
                  {i.artifacts.map((a, idx) => (
                    <div key={idx} className="flex items-baseline gap-1.5">
                      <span className="text-ok">+</span>
                      <span className="w-14 shrink-0 text-faint">{a.kind}</span>
                      <span className="min-w-0 flex-1 truncate text-dim">
                        {a.label}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {i.error ? (
                <p className="mt-1.5 text-err">{i.error}</p>
              ) : null}

              <div className="mt-1.5 flex items-center gap-2 text-faint">
                <span>{i.mode === "live" ? "live" : "sim"}</span>
                <span>·</span>
                <span>{i.toolCalls} calls</span>
                {i.resumes ? (
                  <span className="ml-auto" title={`picked up from ${i.resumes}`}>
                    ↻ {i.resumes}
                  </span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
