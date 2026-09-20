"use client";

import { useCallback, useLayoutEffect, useState } from "react";

const KEY = "intern.theme";
type Choice = "system" | "light" | "dark";
const CYCLE: Choice[] = ["system", "light", "dark"];
const ICON: Record<Choice, string> = { system: "◐", light: "○", dark: "●" };

function read(): Choice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(choice: Choice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
}

export default function ThemeToggle() {
  // Starts at "system" — the only value SSR can render, since localStorage
  // doesn't exist on the server — so the first client render always matches
  // the server's, and hydration never has to discard this subtree. The real
  // value gets read and applied below, right after mount.
  const [choice, setChoice] = useState<Choice>("system");

  useLayoutEffect(() => {
    // The page's own theme never flashes: the inline script in app/layout.tsx
    // already set `data-theme` before paint. This re-derives from the same
    // source (localStorage) for two things a script alone can't do: showing
    // the right icon, and re-applying the attribute after React's dev-mode
    // Strict Mode remount clears it (a no-op in production).
    const stored = read();
    apply(stored);
    // Syncing display state from a client-only source SSR can't see; see above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChoice(stored);
  }, []);

  const cycle = useCallback(() => {
    const next = CYCLE[(CYCLE.indexOf(choice) + 1) % CYCLE.length];
    setChoice(next);
    apply(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // private window — theme still applies for this tab, it just won't persist
    }
  }, [choice]);

  return (
    <button
      type="button"
      onClick={cycle}
      title={`theme: ${choice}`}
      aria-label={`Theme: ${choice}. Click to switch.`}
      className="border border-line px-1.5 py-0.5 transition-colors hover:border-line-2 hover:text-fg"
    >
      {ICON[choice]}
    </button>
  );
}
