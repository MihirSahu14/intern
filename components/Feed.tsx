"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const ago = (at: number) => {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

export default function Feed() {
  const events = useQuery(api.community.feed, {});
  return (
    <section className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center border-b border-line px-3">
        <h2 className="label">community</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!events?.length ? (
          <p className="p-3 text-faint">nobody yet. you&rsquo;re first.</p>
        ) : (
          events.map((e, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-line/50 px-3 py-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {e.image ? <img src={e.image} alt="" className="mt-0.5 size-4 shrink-0 rounded-full" /> : null}
              <p className="min-w-0 text-dim leading-snug">
                <span className="text-fg">@{e.handle}</span> {e.text}
                <span className="ml-1 text-faint">· {ago(e.at)}</span>
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
