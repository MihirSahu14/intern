"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";

const ago = (at: number) => {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

export default function Feed() {
  const events = useQuery(api.community.feed, {});
  return (
    // Headed by the cockpit's activity tabs ("everyone").
    <section className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!events?.length ? (
          <p className="p-3 text-faint">nobody yet. you&rsquo;re first.</p>
        ) : (
          events.map((e, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-line/50 px-3 py-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {e.image ? <img src={e.image} alt="" className="mt-0.5 size-4 shrink-0 rounded-full" /> : null}
              <p className="min-w-0 text-dim leading-snug">
                <Link href={`/u/${encodeURIComponent(e.handle)}`} className="text-fg hover:underline">
                  @{e.handle}
                </Link>{" "}
                {e.text}
                <span className="ml-1 text-faint">· {ago(e.at)}</span>
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
