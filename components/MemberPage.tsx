"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import KindGlyph from "./KindGlyph";
import ThemeToggle from "./ThemeToggle";

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

const KIND_WORD = { slack_channel: "channel", document: "document", github_repo: "repo" } as const;

export default function MemberPage({ handle }: { handle: string }) {
  const m = useQuery(api.community.member, { handle });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-[20px] tracking-tight text-fg">
            intern<span className="text-accent">_</span>
          </Link>
          <ThemeToggle />
        </div>

        {m === undefined ? (
          <p className="mt-10 text-faint">loading…</p>
        ) : m === null ? (
          <div className="mt-16 flex flex-col items-center gap-4 text-center">
            <p className="text-faint">nobody here by that name.</p>
            <Link href="/" className="border border-line px-3 py-1 text-faint transition-colors hover:border-line-2 hover:text-fg">
              back to the brain
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-10 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {m.image ? <img src={m.image} alt="" className="size-10 rounded-full" /> : null}
              <div>
                <p className="text-lg text-fg">@{m.handle}</p>
                <p className="text-faint">
                  joined {day(m.joinedAt)} · {m.approved} drafts approved · {m.sent} sent
                </p>
              </div>
            </div>

            <p className="label mt-10">taught the brain</p>
            {m.facts.length ? (
              <ul className="mt-3">
                {m.facts.map((f) => (
                  <li key={f._id} className="flex items-start gap-2 border-b border-line/50 py-1.5">
                    <span className="mt-0.5">
                      <KindGlyph kind="fact" size={11} />
                    </span>
                    <span className="min-w-0 text-dim">
                      <span className="text-faint">{f.kind} · </span>
                      {f.title}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-faint">nothing yet.</p>
            )}

            <p className="label mt-10">added sources</p>
            {m.sources.length ? (
              <ul className="mt-3">
                {m.sources.map((s) => (
                  <li key={s._id} className="flex items-start gap-2 border-b border-line/50 py-1.5">
                    <span className="mt-0.5">
                      <KindGlyph kind="source" size={11} />
                    </span>
                    <span className="min-w-0 text-dim">
                      <span className="text-faint">{KIND_WORD[s.kind]} · </span>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="nofollow noopener noreferrer" className="hover:underline">
                          {s.label}
                        </a>
                      ) : (
                        s.label
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-faint">none yet.</p>
            )}

            <p className="label mt-10">interns</p>
            {m.interns.length ? (
              <ul className="mt-3">
                {m.interns.map((i) => (
                  <li key={i._id} className="flex gap-3 border-b border-line/50 py-1.5">
                    <span className="w-16 shrink-0 text-faint">{i.status}</span>
                    <span className="min-w-0 text-dim">{i.task}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-faint">none yet.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
