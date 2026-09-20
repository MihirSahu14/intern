"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

/** GitHub only: see convex/auth.ts for why. */
export default function SignIn() {
  const { signIn } = useAuthActions();
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[340px]">
        <div className="mb-6 flex items-baseline gap-3">
          <span className="tracking-[0.28em] text-fg">INTERN</span>
          <span className="text-line-2">|</span>
          <span className="text-faint">community brain</span>
        </div>
        <div className="border border-line bg-panel p-4">
          <p className="leading-relaxed text-dim">
            A public test brain. Everyone who signs in shares it: you&rsquo;ll see what others
            taught it, and they&rsquo;ll see what you do.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signIn("github", { redirectTo: "/app" });
            }}
            className="mt-4 w-full border border-accent/60 bg-accent/10 py-2 text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {busy ? "redirecting…" : "continue with GitHub"}
          </button>
        </div>
      </div>
    </div>
  );
}
