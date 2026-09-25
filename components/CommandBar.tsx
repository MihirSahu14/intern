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
      const t = e.target as HTMLElement;
      // Typing a "/" in another field (the Outbox body, a URL) is just typing.
      const typing = t.matches?.("input, textarea, select") || t.isContentEditable;
      if (e.key === "/" && !typing) {
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
    // The primary control: it sits at the top of the centre column, so it
    // follows the theme rather than the terminal's dark inset.
    <div className="flex shrink-0 items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <span
        className={mode === "live" ? "text-ok" : "text-warn"}
        title={mode === "live" ? "brain connected" : "simulated brain"}
      >
        {mode === "live" ? "▲" : "◇"}
      </span>
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
        placeholder="brief an intern, e.g. Post in #all-intern-community: hi from Intern"
        title="/ to focus"
        className="min-w-0 flex-1 bg-transparent py-1 text-fg placeholder:text-faint/70"
      />
      <button
        type="button"
        onClick={submit}
        className="shrink-0 border border-accent/50 px-2 py-0.5 text-accent transition-colors hover:bg-accent/10"
      >
        run ⏎
      </button>
    </div>
  );
}
