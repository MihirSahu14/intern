"use client";

import { useState } from "react";
import type {
  ActionStatus,
  Draft,
  ProposedAction,
} from "@/lib/types";

const STATUS: Record<ActionStatus, { dot: string; text: string }> = {
  pending: { dot: "bg-k-action pulse-slow", text: "text-k-action" },
  approved: { dot: "bg-ok", text: "text-ok" },
  rejected: { dot: "bg-faint", text: "text-faint" },
};

export type Decision =
  | { decision: "approve"; edits?: Partial<Draft> }
  | { decision: "reject"; reason: string };

export default function Outbox({
  actions,
  onDecide,
}: {
  actions: ProposedAction[];
  onDecide: (id: string, decision: Decision) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const pending = actions.filter((a) => a.status === "pending");
  const rest = actions.filter((a) => a.status !== "pending");
  const shown = [...pending, ...rest.slice(0, 4)];

  return (
    <section className="flex max-h-[46%] min-h-0 shrink-0 flex-col border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">outbox</h2>
        <div className="flex items-center gap-2">
          <span className="border border-warn/40 px-1 text-warn">sandbox</span>
          <span
            className={`tabular-nums ${pending.length ? "text-k-action" : "text-faint"}`}
          >
            {pending.length} awaiting you
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="p-3 text-faint leading-relaxed">
            nothing waiting. your interns&rsquo; drafts land here. approving never
            sends anything, this is a sandbox.
          </p>
        ) : null}

        {shown.map((a) =>
          a.status === "pending" ? (
            <Pending
              key={a.id}
              action={a}
              expanded={open === a.id}
              onToggle={() => setOpen(open === a.id ? null : a.id)}
              onDecide={onDecide}
            />
          ) : (
            <Settled
              key={a.id}
              action={a}
              expanded={open === a.id}
              onToggle={() => setOpen(open === a.id ? null : a.id)}
            />
          ),
        )}
      </div>
    </section>
  );
}

/**
 * A draft awaiting a person.
 *
 * Everything is editable in place, and edits are sent alongside the approval
 * rather than replacing the draft. That is the point: rewriting a line here
 * teaches the intern something, where deleting the draft and writing your own
 * email teaches it nothing.
 */
function Pending({
  action,
  expanded,
  onToggle,
  onDecide,
}: {
  action: ProposedAction;
  expanded: boolean;
  onToggle: () => void;
  onDecide: (id: string, decision: Decision) => void;
}) {
  const [to, setTo] = useState(action.draft.to.join(", "));
  const [subject, setSubject] = useState(action.draft.subject);
  const [body, setBody] = useState(action.draft.body);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const list = (v: string) =>
    v.split(",").map((s) => s.trim()).filter(Boolean);

  const changed: (keyof Draft)[] = [
    list(to).join(", ") !== action.draft.to.join(", ") ? "to" : null,
    subject.trim() !== action.draft.subject.trim() ? "subject" : null,
    body.trim() !== action.draft.body.trim() ? "body" : null,
  ].filter(Boolean) as (keyof Draft)[];

  const approve = () =>
    onDecide(action.id, {
      decision: "approve",
      edits: changed.length ? { to: list(to), subject, body } : undefined,
    });

  return (
    <article className="enter border-b border-line px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-k-action pulse-slow" />
        <span className="text-fg">{action.kind}</span>
        <span className="text-k-action">pending</span>
        <span className="ml-auto shrink-0 text-faint">{expanded ? "−" : "+"}</span>
      </button>

      {!expanded ? (
        <>
          <p className="mt-1 truncate text-dim" title={action.draft.to.join(", ")}>
            → {action.draft.to.join(", ")}
          </p>
          <p className="truncate text-fg">{action.draft.subject}</p>
          <p className="mt-1 text-faint">open it to read and edit before approving</p>
        </>
      ) : (
        <div className="mt-2 space-y-1.5">
          <Field label="to" value={to} onChange={setTo} />
          <Field label="subj" value={subject} onChange={setSubject} />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            rows={8}
            className="w-full resize-y border border-line bg-bg px-1.5 py-1 text-dim outline-none focus:border-line-2 focus:text-fg"
          />
          <p className="text-faint leading-relaxed">{action.rationale}</p>
          {action.sources.length ? (
            <p className="text-faint">from: {action.sources.join(", ")}</p>
          ) : null}
          {changed.length ? (
            <p className="border-l border-k-fact/50 pl-2 text-k-fact">
              {changed.join(" and ")} changed · approving files the difference as
              a preference the next intern reads
            </p>
          ) : null}
        </div>
      )}

      {rejecting ? (
        <div className="mt-2 space-y-1.5">
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && reason.trim()) {
                onDecide(action.id, { decision: "reject", reason: reason.trim() });
              }
              if (e.key === "Escape") setRejecting(false);
            }}
            placeholder="what should have happened instead?"
            spellCheck={false}
            className="w-full border border-line bg-bg px-1.5 py-1 text-fg outline-none placeholder:text-faint/70 focus:border-err/40"
          />
          <div className="flex gap-px">
            <button
              type="button"
              disabled={!reason.trim()}
              onClick={() =>
                onDecide(action.id, { decision: "reject", reason: reason.trim() })
              }
              className="flex-1 border border-err/40 py-0.5 text-err transition-colors hover:bg-err/10 disabled:opacity-40"
            >
              file it and stop
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              className="flex-1 border border-line py-0.5 text-faint hover:text-fg"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex gap-px">
          <button
            type="button"
            onClick={approve}
            className="flex-1 border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10"
          >
            {changed.length ? "approve with edits" : "approve (sandbox)"}
          </button>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            className="flex-1 border border-line py-0.5 text-faint transition-colors hover:border-err/40 hover:text-err"
          >
            reject
          </button>
        </div>
      )}
    </article>
  );
}

/** Anything already decided. Read-only, and shows both halves of an edit. */
function Settled({
  action,
  expanded,
  onToggle,
}: {
  action: ProposedAction;
  expanded: boolean;
  onToggle: () => void;
}) {
  const s = STATUS[action.status];
  const decided = action.accepted ?? action.draft;
  const edited = action.editedFields ?? [];

  return (
    <article className="enter border-b border-line px-3 py-2">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
        <span className="text-fg">{action.kind}</span>
        <span className={s.text}>{action.status}</span>
        {edited.length ? <span className="text-k-fact">edited</span> : null}
        <span className="ml-auto shrink-0 text-faint">{expanded ? "−" : "+"}</span>
      </button>

      <p className="mt-1 truncate text-dim" title={decided.to.join(", ")}>
        → {decided.to.join(", ")}
      </p>
      <p className="truncate text-fg">{decided.subject}</p>

      {expanded ? (
        <div className="mt-2 space-y-2">
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l border-line-2 pl-2 text-dim">
            {decided.body}
          </pre>
          {edited.length ? (
            <details className="text-faint">
              <summary className="cursor-pointer text-k-fact">
                what the intern originally wrote
              </summary>
              <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l border-k-fact/40 pl-2">
                {action.draft.subject}
                {"\n\n"}
                {action.draft.body}
              </pre>
            </details>
          ) : null}
          <p className="text-faint">{action.rationale}</p>
        </div>
      ) : null}

      {action.status === "approved" ? (
        <p className="mt-1.5 text-faint">Approved. Sandbox: nothing was sent.</p>
      ) : null}
      {action.status === "rejected" && action.result ? (
        <p className="mt-1.5 text-faint">“{action.result}”</p>
      ) : null}
    </article>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-9 shrink-0 text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-w-0 flex-1 border border-line bg-bg px-1.5 py-0.5 text-fg outline-none focus:border-line-2"
      />
    </div>
  );
}
