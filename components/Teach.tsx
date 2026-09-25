"use client";

import { useEffect, useRef, useState } from "react";
import type { FactKind } from "@/lib/types";

/**
 * Put something into the brain by hand.
 *
 * The rest of the cockpit fills the graph by asking: an intern parks on a
 * question and waits for someone to answer it. That only ever covers what an
 * intern happened to get stuck on, so everything a person already knows and was
 * never asked about stays outside the brain. This is the other direction —
 * unprompted, and the same landing path as an answered question, so a fact
 * typed here is indistinguishable from one an answer produced.
 *
 * Text and kind, and nothing else: that is exactly what `facts.teach` stores.
 * Tags, a subject and an "attach to the selected node" toggle used to be
 * collected here and silently dropped on the way to the mutation.
 *
 * Collapsed to a single line at rest, at the foot of the right rail: the
 * questions and drafts above it are what stops interns, and those have to stay
 * the loudest things in the column.
 */

const KINDS: FactKind[] = [
  "note",
  "decision",
  "preference",
  "correction",
  "answer",
  "person",
  "project",
];

/** What a kind is for, one line, shown under the picker. */
const ABOUT: Record<FactKind, string> = {
  note: "something true worth citing later",
  decision: "what was settled, and by whom",
  preference: "how the work should be done",
  correction: "what an intern got wrong",
  answer: "the answer to something nobody asked yet",
  person: "who someone is and what they own — filed as a note",
  project: "what a piece of work is — filed as a note",
};

export type TeachInput = {
  text: string;
  kind: FactKind;
};

export default function Teach({
  onTeach,
}: {
  onTeach: (input: TeachInput) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<FactKind>("note");
  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  // A confirmation nobody dismissed is noise ten seconds later.
  useEffect(() => {
    if (!filed) return;
    const t = setTimeout(() => setFiled(null), 6000);
    return () => clearTimeout(t);
  }, [filed]);

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    const ok = await onTeach({ text: body, kind });
    setBusy(false);
    if (!ok) return;
    setText("");
    setFiled("filed into the brain");
    box.current?.focus();
  };

  if (!open) {
    return (
      <section className="shrink-0 border-t border-line bg-panel">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-8 w-full items-center gap-2 px-3 text-left text-faint transition-colors hover:text-fg"
        >
          <span className="text-k-fact">+</span>
          <span className="label shrink-0 whitespace-nowrap">add a fact</span>
          <span className="ml-auto min-w-0 truncate text-faint">goes straight into the brain</span>
        </button>
      </section>
    );
  }

  return (
    <section className="shrink-0 border-t border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">add a fact</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-faint hover:text-fg"
          title="collapse"
        >
          ✕
        </button>
      </header>

      <div className="px-3 py-2">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
            if (e.key === "Escape") setOpen(false);
          }}
          rows={3}
          spellCheck={false}
          placeholder="the ramp pilot ships behind a flag — first line becomes the title"
          className="w-full resize-y border border-line bg-bg px-1.5 py-1 text-fg placeholder:text-faint/70 focus:border-k-fact/50"
        />

        <div className="mt-1.5 flex flex-wrap gap-px">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`border px-1.5 py-0.5 transition-colors ${
                kind === k
                  ? "border-k-fact/50 text-k-fact"
                  : "border-line text-faint hover:border-line-2 hover:text-dim"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <p className="mt-1 text-faint">{ABOUT[kind]}</p>

        <button
          type="button"
          disabled={!text.trim() || busy}
          onClick={() => void submit()}
          className="mt-1.5 w-full border border-k-fact/40 py-0.5 text-k-fact transition-colors hover:bg-k-fact/10 disabled:opacity-40"
        >
          {busy ? "filing…" : "file it  ⌘⏎"}
        </button>

        {filed ? <p className="mt-1 text-ok">{filed}</p> : null}
      </div>
    </section>
  );
}
