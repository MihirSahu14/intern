"use client";

import { useEffect, useState } from "react";
import type { NodeKind } from "@/lib/types";

/**
 * DOM swatches (Legend, BrainRail) just want a CSS value they can drop into
 * `style={{ background }}` — the cascade resolves it, no JS re-render needed
 * when the theme flips.
 */
export const KIND_VAR: Record<NodeKind, string> = {
  source: "var(--color-k-source)",
  contact: "var(--color-k-contact)",
  project: "var(--color-k-project)",
  note: "var(--color-k-note)",
  followup: "var(--color-k-followup)",
  wiki: "var(--color-k-wiki)",
  tag: "var(--color-k-tag)",
  intern: "var(--color-k-intern)",
  action: "var(--color-k-action)",
  fact: "var(--color-k-fact)",
  question: "var(--color-k-question)",
};

const KIND_KEYS = Object.keys(KIND_VAR) as NodeKind[];

/** Canvas-only tokens — see app/globals.css for both themes' values. */
const CANVAS_KEYS = [
  "--canvas-bg",
  "--canvas-dot",
  "--canvas-edge-rgb",
  "--canvas-label-rgb",
  "--canvas-label-plate-rgb",
  "--canvas-tag-rgb",
  "--accent-rgb",
] as const;

/**
 * Plain (non-hook) read of the current theme tokens, straight off the
 * cascade. The canvas render loop calls this directly, once per frame,
 * instead of going through `useThemeTokens()`'s React state: a theme flip
 * needs to repaint the very next frame, and routing that through a
 * `matchMedia`/`MutationObserver` → `setState` → effect chain adds a step
 * that isn't guaranteed to fire promptly (some embedders — e.g. CDP-driven
 * colour-scheme emulation — change what `prefers-color-scheme` matches
 * without ever dispatching a `change` event on an existing
 * `MediaQueryList`). Reading a dozen custom properties once per
 * already-running rAF tick is not a meaningful cost next to the physics
 * simulation it sits beside.
 */
export function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const k of CANVAS_KEYS) out[k] = style.getPropertyValue(k).trim();
  for (const k of KIND_KEYS) out[`--color-k-${k}`] = style.getPropertyValue(`--color-k-${k}`).trim();
  return out;
}

function sameTokens(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/**
 * The canvas paints outside React on a rAF loop, so it can't afford to
 * re-read `getComputedStyle` every frame. This re-reads once per theme
 * change instead, and holds identity steady when the values didn't actually
 * change, so a consuming `useEffect([tokens])` doesn't fire on every unrelated
 * re-render.
 */
export function useThemeTokens(): Record<string, string> {
  const [tokens, setTokens] = useState<Record<string, string>>(() =>
    typeof window === "undefined" ? {} : readThemeTokens(),
  );

  useEffect(() => {
    const update = () => setTokens((prev) => {
      const next = readThemeTokens();
      return sameTokens(prev, next) ? prev : next;
    });
    update();

    // Explicit choice: the `data-theme` attribute on <html> (set by
    // ThemeToggle / the no-flash inline script).
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    // "system" choice: no attribute, so the OS preference decides — and can
    // change live while the tab is open.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  return tokens;
}
