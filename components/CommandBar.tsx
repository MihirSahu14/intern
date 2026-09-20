"use client";

import { useEffect, useRef, useState } from "react";

export const HELP = [
  "spawn <task>            brief an intern (bare text does the same)",
  "capture <what you know> teach the brain a fact (the + panel does it with a kind)",
  "kill <id>               stop your intern",
  "",
  "approve <id>            approve your draft as written (sandbox: nothing is sent)",
  "reject <id> <why>       reject it; the reason becomes a correction fact",
  "answer <id> <answer>    unblock your intern; the answer becomes a fact",
  "",
  "focus <id|all>          filter the stream",
  "clear                   clear your local lines",
  "help                    this",
];

export default function CommandBar({
  onSubmit,
  mode,
  busy,
}: {
  onSubmit: (raw: string) => void;
  mode: "live" | "sim";
  busy: number;
}) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement !== input.current) {
        e.preventDefault();
        input.current?.focus();
      }
      if (e.key === "Escape") input.current?.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const raw = value.trim();
    if (!raw) return;
    setHistory((h) => [raw, ...h].slice(0, 60));
    setCursor(-1);
    setValue("");
    onSubmit(raw);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-line bg-panel px-3">
      <span
        className={mode === "live" ? "text-ok" : "text-warn"}
        title={mode === "live" ? "brain connected" : "simulated brain"}
      >
        {mode === "live" ? "▲" : "◇"}
      </span>
      <span className="text-faint">intern</span>
      <span className="text-line-2">/</span>
      <span className="text-faint">{busy ? `${busy} working` : "idle"}</span>
      <span className="text-fg">❯</span>
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const next = Math.min(cursor + 1, history.length - 1);
            if (next >= 0) {
              setCursor(next);
              setValue(history[next]);
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const next = cursor - 1;
            setCursor(next);
            setValue(next >= 0 ? history[next] : "");
          }
        }}
        spellCheck={false}
        autoComplete="off"
        placeholder="brief an intern, e.g. draft a Slack post introducing Intern   ( / to focus )"
        className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-faint/70"
      />
      <button
        type="button"
        onClick={submit}
        className="shrink-0 border border-line px-2 py-0.5 text-faint transition-colors hover:border-line-2 hover:text-fg"
      >
        run ⏎
      </button>
    </div>
  );
}
