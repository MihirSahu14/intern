"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export default function Stats() {
  const s = useQuery(api.community.evals, {});
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="label">evals · live from every public run</p>
        {!s ? (
          <p className="mt-6 text-faint">loading…</p>
        ) : (
          <dl className="mt-6 space-y-6">
            <Stat k="action-block parse rate" v={pct(s.parseRate)} n={`${s.actionBlocks} drafts attempted · ${s.runs} runs`} />
            <Stat k="approved unedited" v={pct(s.uneditedRate)} n={`${s.decided} drafts decided`} />
            <Stat
              k="edit rate: recalled a correction vs not"
              v={`${pct(s.editRateWithCorrection)} vs ${pct(s.editRateWithout)}`}
              n={`${s.withCorrection} vs ${s.without} drafts · lower on the left means the brain is learning`}
            />
          </dl>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, n }: { k: string; v: string; n: string }) {
  return (
    <div className="border border-line bg-panel p-4">
      <dt className="text-faint">{k}</dt>
      <dd className="mt-1 text-2xl text-fg tabular-nums">{v}</dd>
      <dd className="mt-1 text-faint">{n}</dd>
    </div>
  );
}
