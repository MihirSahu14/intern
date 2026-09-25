"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { collapseBlocks, stripCites } from "@/lib/log-view";
import type { Intern, LogLine, LogLevel } from "@/lib/types";

// This stream always reads as a dark terminal inset, in both themes — see
// the `--color-term-*` tokens in app/globals.css. Every colour class below
// is one of those, not the theme-following bg-panel/text-dim/etc.
const LEVEL: Record<LogLevel, { glyph: string; className: string }> = {
  sys: { glyph: "·", className: "text-term-faint" },
  in: { glyph: ">", className: "text-term-fg" },
  out: { glyph: " ", className: "text-term-dim" },
  tool: { glyph: "→", className: "text-term-k-project" },
  ok: { glyph: "✓", className: "text-term-ok" },
  warn: { glyph: "!", className: "text-term-warn" },
  err: { glyph: "✗", className: "text-term-err" },
};

const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString("en-GB", { hour12: false });

export default function Terminal({
  log,
  interns,
  filter,
  onFilter,
}: {
  log: LogLine[];
  interns: Intern[];
  filter: string | null;
  onFilter: (id: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [raw, setRaw] = useState(false);

  const filtered = filter ? log.filter((l) => l.internId === filter) : log;
  const lines = raw ? filtered : collapseBlocks(filtered).map((l) => ({ ...l, text: stripCites(l.text) }));
  // Each line is tagged with its intern's ask, not its id: an id means nothing to a person.
  const askOf = new Map(interns.map((i) => [i.id, i.displayTask ?? i.task]));

  useLayoutEffect(() => {
    if (!follow) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, follow]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setFollow(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const active = interns.filter(
    (i) => i.status === "running" || i.status === "queued",
  );

  return (
    <section style={{ colorScheme: "dark" }} className="flex min-h-0 flex-1 flex-col bg-term-panel">
      <header className="flex h-8 shrink-0 items-center gap-3 border-b border-term-line px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <Tab active={filter === null} onClick={() => onFilter(null)}>
          all
        </Tab>
        {interns.slice(0, 8).map((i) => {
          const label = i.displayTask ?? i.task;
          return (
            <Tab
              key={i.id}
              active={filter === i.id}
              onClick={() => onFilter(i.id)}
              title={label}
              dot={
                i.status === "running"
                  ? "bg-term-ok pulse-slow"
                  : i.status === "failed"
                    ? "bg-term-err"
                    : i.status === "cancelled"
                      ? "bg-term-faint"
                      : i.status === "queued"
                        ? "bg-term-warn"
                        : "bg-term-line-2"
              }
            >
              {label.length > 20 ? `${label.slice(0, 20)}…` : label}
            </Tab>
          );
        })}
        </div>
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-term-faint">
          <span>
            {active.length} active · {lines.length} lines
          </span>
          <button
            type="button"
            onClick={() => setRaw((r) => !r)}
            className={`transition-colors hover:text-term-fg ${
              raw ? "text-term-ok" : "text-term-faint"
            }`}
            title="show the uncollapsed stream"
          >
            {raw ? "◉ raw" : "○ raw"}
          </button>
          <button
            type="button"
            onClick={() => {
              setFollow(true);
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className={`transition-colors hover:text-term-fg ${
              follow ? "text-term-ok" : "text-term-faint"
            }`}
            title="follow tail"
          >
            {follow ? "◉ follow" : "○ paused"}
          </button>
        </div>
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5"
      >
        {lines.length === 0 ? (
          <p className="px-1 py-2 text-term-faint">
            no output yet. dispatch an intern below.
          </p>
        ) : null}
        {lines.map((line, i) => {
          const meta = LEVEL[line.level];
          // collapseBlocks can split one LogLine into several adjacent rows
          // sharing its id; number them so keys stay unique and stable.
          let part = 0;
          while (i - part > 0 && lines[i - part - 1].id === line.id) part++;
          return (
            <div
              key={`${line.id}:${part}`}
              className="enter flex items-start gap-2 whitespace-pre-wrap break-words px-1 leading-[1.55]"
            >
              <span className="shrink-0 whitespace-nowrap text-term-faint tabular-nums">
                {clock(line.ts)}
              </span>
              {filter === null ? (
                <button
                  type="button"
                  onClick={() => onFilter(line.internId)}
                  title={line.internId ? askOf.get(line.internId) : undefined}
                  className="w-[96px] shrink-0 truncate whitespace-nowrap text-left text-term-faint transition-colors hover:text-term-dim"
                >
                  {line.internId ? (askOf.get(line.internId) ?? "an intern") : "cockpit"}
                </button>
              ) : null}
              <span className={`shrink-0 ${meta.className}`}>{meta.glyph}</span>
              <span className={`min-w-0 flex-1 ${meta.className}`}>
                {line.text}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Tab({
  children,
  active,
  onClick,
  dot,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  dot?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2 py-0.5 transition-colors ${
        active
          ? "bg-term-raised text-term-fg"
          : "text-term-faint hover:bg-term-raised/60 hover:text-term-dim"
      }`}
    >
      {dot ? <span className={`h-1 w-1 rounded-full ${dot}`} /> : null}
      {children}
    </button>
  );
}
