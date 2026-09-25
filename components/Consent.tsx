"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

export const NOTICE =
  "Public test brain: briefs and facts are visible to everyone. Your drafts, questions and sends are private to you. Don't put anything private in a brief.";

export default function Consent() {
  const accept = useMutation(api.users.accept);
  const { signOut } = useAuthActions();
  const [checked, setChecked] = useState(false);

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[420px] border border-line bg-panel p-4">
        <p className="label">before you go in</p>
        <p className="mt-3 leading-relaxed text-fg">{NOTICE}</p>
        <label className="mt-4 flex items-start gap-2 text-dim">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1" />
          I understand, and I won&rsquo;t enter anything private.
        </label>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={!checked}
            onClick={() => void accept({})}
            className="flex-1 border border-accent/60 bg-accent/10 py-2 text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            enter the brain
          </button>
          <button type="button" onClick={() => void signOut()} className="border border-line px-3 text-faint hover:text-fg">
            leave
          </button>
        </div>
      </div>
    </div>
  );
}
