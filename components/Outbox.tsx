"use client";

import { useState } from "react";
import { CONNECTORS } from "@/lib/connectors";
import type {
  ActionKind,
  ActionStatus,
  Draft,
  ProposedAction,
} from "@/lib/types";

const STATUS: Record<ActionStatus, { dot: string; text: string }> = {
  pending: { dot: "bg-k-action pulse-slow", text: "text-k-action" },
  approved: { dot: "bg-ok", text: "text-ok" },
  rejected: { dot: "bg-faint", text: "text-faint" },
  sending: { dot: "bg-k-action pulse-slow", text: "text-k-action" },
  sent: { dot: "bg-ok", text: "text-ok" },
  failed: { dot: "bg-err", text: "text-err" },
  // Composio's execute call never gave a clear answer — it may already have
  // sent. Not the same as `failed`: see outbox.confirmUnsent. Task 5 gives
  // this its own retry/confirm affordance; this is the minimal render.
  unsure: { dot: "bg-warn pulse-slow", text: "text-warn" },
};

export type Decision =
  | { decision: "approve"; edits?: Partial<Draft> }
  | { decision: "reject"; reason: string };

export default function Outbox({
  actions,
  sendsVia,
  onDecide,
  onResend,
  onConfirmUnsent,
}: {
  actions: ProposedAction[];
  /** The connected account each draft kind goes out through. Empty means sandbox. */
  sendsVia: Partial<Record<ActionKind, string>>;
  onDecide: (id: string, decision: Decision) => void;
  onResend: (id: string) => void;
  onConfirmUnsent: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const live = Object.keys(sendsVia).length > 0;
  const pending = actions.filter((a) => a.status === "pending");
  const rest = actions.filter((a) => a.status !== "pending");
  const shown = [...pending, ...rest.slice(0, 4)];

  return (
    <section className="flex max-h-[46%] min-h-0 shrink-0 flex-col border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="label">outbox</h2>
        <div className="flex items-center gap-2">
          {live ? (
            <span
              className="border border-ok/40 px-1 text-ok"
              title="Approving sends from your connected account."
            >
              sends for real
            </span>
          ) : (
            <span className="border border-warn/40 px-1 text-warn">sandbox</span>
          )}
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
            nothing waiting. your interns&rsquo; drafts land here.{" "}
            {live ? "approving sends from your connected account." : "approving never sends anything, this is a sandbox."}
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
              via={sendsVia[a.kind]}
            />
          ) : (
            <Settled
              key={a.id}
              action={a}
              expanded={open === a.id}
              onToggle={() => setOpen(open === a.id ? null : a.id)}
              onResend={onResend}
              onConfirmUnsent={onConfirmUnsent}
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
  via,
}: {
  action: ProposedAction;
  expanded: boolean;
  onToggle: () => void;
  onDecide: (id: string, decision: Decision) => void;
  via?: string;
}) {
  // Start from any edits saved while the person went to connect their account.
  const start = action.accepted ?? action.draft;
  const [to, setTo] = useState(start.to.join(", "));
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const list = (v: string) =>
    v.split(",").map((s) => s.trim()).filter(Boolean);

  const changed: (keyof Draft)[] = [
    list(to).join(", ") !== action.draft.to.join(", ") ? "to" : null,
    subject.trim() !== action.draft.subject.trim() ? "subject" : null,
    body.trim() !== action.draft.body.trim() ? "body" : null,
  ].filter(Boolean) as (keyof Draft)[];

  // Sent whenever edits were saved earlier too: reverting those to the
  // original leaves `changed` empty, and sending nothing would let the server
  // fall back to the saved edit the person just undid.
  const approve = () =>
    onDecide(action.id, {
      decision: "approve",
      edits: changed.length || action.accepted ? { to: list(to), subject, body } : undefined,
    });
  // Drafted under the sandbox prompt, whose recipients may be placeholders
  // (#general, name@example.com) — unless every recipient is one the member
  // already typed in their own brief (`recipientsMatchBrief`, computed
  // server-side by `lib/recipients.ts`'s `recipientsInBrief`), in which case
  // it was never a placeholder to begin with. Once edited this round, it's
  // moot either way.
  const showPlaceholderNote = !!via && !action.draftedLive && !changed.includes("to");
  const briefAllows = !!action.recipientsMatchBrief;
  // The server refuses this too (outbox.decide) when neither is true.
  const blocked = showPlaceholderNote && !briefAllows;

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
          <p className="mt-1 truncate text-dim" title={start.to.join(", ")}>
            → {start.to.join(", ")}
          </p>
          <p className="truncate text-fg">{start.subject}</p>
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
          {showPlaceholderNote ? (
            <p className="border-l border-warn/50 pl-2 text-warn">
              This was drafted before {via} was connected, so it may use a placeholder recipient. Edit &ldquo;to&rdquo;
              {briefAllows ? ", or send as is if it's right." : "."}
            </p>
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
            onClick={blocked ? (expanded ? undefined : onToggle) : approve}
            disabled={blocked && expanded}
            className="flex-1 border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10 disabled:opacity-40"
          >
            {blocked
              ? `Written before you connected ${via} — check the recipient`
              : via
              ? `${changed.length ? "send with edits" : "approve & send"} via ${via}`
              : changed.length
                ? "approve with edits"
                : "approve (sandbox)"}
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
  onResend,
  onConfirmUnsent,
}: {
  action: ProposedAction;
  expanded: boolean;
  onToggle: () => void;
  onResend: (id: string) => void;
  onConfirmUnsent: (id: string) => void;
}) {
  const s = STATUS[action.status];
  const decided = action.accepted ?? action.draft;
  const edited = action.editedFields ?? [];
  const via = CONNECTORS.find((c) => c.key === action.connector)?.label ?? "account";

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

      {action.status === "approved" ? <p className="mt-1.5 text-faint">Approved. Sandbox: nothing was sent.</p> : null}
      {action.status === "rejected" && action.result ? (
        <p className="mt-1.5 text-faint">“{action.result}”</p>
      ) : null}
      {action.status === "sending" ? <p className="mt-1.5 text-k-action">sending…</p> : null}
      {action.status === "sent" ? <p className="mt-1.5 text-ok">Sent from your {via}.</p> : null}
      {action.status === "failed" ? (
        <div className="mt-1.5 space-y-1">
          <p className="text-err">{action.sendError ?? "send failed"}</p>
          <button
            type="button"
            onClick={() => onResend(action.id)}
            className="w-full border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10"
          >
            retry send
          </button>
        </div>
      ) : null}
      {action.status === "unsure" ? (
        <div className="mt-1.5 space-y-1">
          <p className="text-warn">{action.sendError ?? "This may have been sent. Check your Sent folder before trying again."}</p>
          <button
            type="button"
            onClick={() => onConfirmUnsent(action.id)}
            className="w-full border border-warn/40 py-0.5 text-warn transition-colors hover:bg-warn/10"
          >
            confirm it wasn&rsquo;t sent
          </button>
        </div>
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
