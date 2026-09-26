"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { UPLOAD_MAX_BYTES } from "@/lib/ingest";

/**
 * The rail's sources: adding one, and a source node's passages. Each shows
 * its own status line rather than echoing to the log, which is a tab behind
 * the graph the member is looking at.
 */

/** A ConvexError's message is the reason to show; anything else is a bug. Same rule as the cockpit's `why`. */
const why = (err: unknown) =>
  err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err);

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

type Note = { ok: boolean; text: string } | null;

const NoteLine = ({ note }: { note: Note }) =>
  note ? (
    <p role="status" className={`leading-snug ${note.ok ? "text-dim" : "text-err"}`}>
      {note.text}
    </p>
  ) : null;

/**
 * "Add a source": a link (a page, a text or markdown file, or a public
 * GitHub repo as owner/repo) or an upload. The server decides what a link
 * is and reads it in the background; its node appears when it's done.
 */
export function AddSource() {
  const setup = useQuery(api.sources.setup, {});
  const addLink = useMutation(api.sources.addLink);
  const uploadUrl = useMutation(api.sources.uploadUrl);
  const addUpload = useMutation(api.sources.addUpload);
  const [link, setLink] = useState("");
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const file = useRef<HTMLInputElement>(null);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await work() });
      setLink("");
    } catch (err) {
      setNote({ ok: false, text: why(err) });
    } finally {
      setBusy(false);
    }
  };

  const submitLink = () =>
    run(async () => {
      const input = link.trim();
      await addLink({ input, private: keepPrivate });
      return `reading ${input}…`;
    });

  const upload = (f: File) =>
    run(async () => {
      if (f.size > UPLOAD_MAX_BYTES) throw new Error(`Keep uploads under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
      const res = await fetch(await uploadUrl({}), {
        method: "POST",
        headers: { "content-type": f.type || "application/octet-stream" },
        body: f,
      });
      if (!res.ok) throw new Error("The upload didn't go through. Try again.");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await addUpload({ storageId, name: f.name, private: keepPrivate });
      return `reading ${f.name}…`;
    });

  return (
    <div className="space-y-1.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) void submitLink();
        }}
        className="flex gap-1"
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={setup?.github ? "https://… or owner/repo" : "https://…"}
          aria-label="link to add"
          spellCheck={false}
          className="min-w-0 flex-1 border border-line bg-transparent px-1.5 py-0.5 placeholder:text-faint/70"
        />
        <button
          type="submit"
          disabled={busy || !link.trim()}
          className="border border-line px-1.5 text-dim hover:border-line-2 hover:text-fg disabled:opacity-40"
        >
          add
        </button>
      </form>
      <div className="flex items-center gap-2 text-faint">
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="hover:text-fg disabled:opacity-40">
          upload .md .txt .pdf
        </button>
        <input
          ref={file}
          type="file"
          accept=".md,.markdown,.txt,.pdf,text/markdown,text/plain,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <label className="ml-auto flex items-center gap-1" title="documents only; repos are always public">
          <input type="checkbox" checked={keepPrivate} onChange={(e) => setKeepPrivate(e.target.checked)} />
          keep private
        </label>
      </div>
      {setup && !setup.github ? <p className="text-faint">github repos: not set up yet</p> : null}
      <NoteLine note={note} />
    </div>
  );
}

/** A source node's recent passages, each promotable to a fact. Passages are never drawn; this is where a person sees them. */
export function SourcePanel({ sourceId }: { sourceId: Id<"sources"> }) {
  const s = useQuery(api.sources.passages, { sourceId });
  const promote = useMutation(api.sources.promote);
  const remove = useMutation(api.sources.remove);
  const [note, setNote] = useState<Note>(null);
  const fail = (err: unknown) => setNote({ ok: false, text: why(err) });

  if (s === undefined) return <p className="text-faint">loading…</p>;
  if (s === null) return <p className="text-faint">this source is gone.</p>;

  const removeIt = () => {
    if (window.confirm(`Remove ${s.label}? Its passages go; facts already promoted from it stay.`)) {
      void remove({ sourceId }).catch(fail);
    }
  };

  return (
    <div className="space-y-1.5 pt-1">
      <p className="text-faint">
        {s.status === "failed" ? (
          <span className="text-err">failed: {s.error ?? "couldn't read it"}</span>
        ) : s.syncedAt ? (
          `read ${day(s.syncedAt)}`
        ) : (
          "reading…"
        )}
        {s.mine ? (
          <>
            {" · "}
            <button type="button" onClick={removeIt} className="hover:text-err">
              remove
            </button>
          </>
        ) : null}
      </p>
      <NoteLine note={note} />
      <p className="label">passages · {s.passages.length}</p>
      {s.passages.map((p) => (
        <div key={p._id} className="border-b border-line/50 pb-1.5">
          <p className="text-faint">{[p.author, day(p.at)].filter(Boolean).join(" · ")}</p>
          <p className="whitespace-pre-line break-words leading-snug text-dim">{p.text}</p>
          {p.promoted ? (
            <span className="text-faint">promoted</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNote(null);
                void promote({ passageId: p._id }).catch(fail);
              }}
              className="text-accent hover:underline"
            >
              promote
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
