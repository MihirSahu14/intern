import type { Draft } from "./types";

/**
 * What a person changed before approving. The pair (proposed, accepted) is the
 * training signal; these helpers size it and turn it into a fact.
 */

const FIELDS = ["to", "cc", "subject", "body"] as const;
export type Field = (typeof FIELDS)[number];

const render = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v.join(", ") : (v ?? "")).trim();

export const changedFields = (proposed: Draft, accepted: Draft): Field[] =>
  FIELDS.filter((f) => render(proposed[f]) !== render(accepted[f]));

/**
 * Share of characters changed across all fields, 0..1.
 *
 * ponytail: common prefix/suffix, not Levenshtein. It ranks small edits vs
 * rewrites, which is all /stats needs. Swap in a real diff if the number gets
 * reported as more than a trend.
 */
export function editRatio(proposed: Draft, accepted: Draft): number {
  let changed = 0;
  let total = 0;
  for (const f of FIELDS) {
    const a = render(proposed[f]);
    const b = render(accepted[f]);
    if (a === b) continue;
    const longest = Math.max(a.length, b.length);
    total += longest;
    const { pre, suf } = commonEnds(a, b);
    changed += longest - pre - suf;
  }
  return total ? changed / total : 0;
}

/** How many characters two texts share at the start and at the end, never overlapping. */
function commonEnds(a: string, b: string) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) suf++;
  return { pre, suf };
}

/**
 * The whole lines of one field that changed, and where. A lesson names the
 * edit itself: quoting both drafts in full put the change past the
 * RECALLED_BODY_CHARS cut `facts.recall` makes, so the next intern never saw it.
 */
function changedLines(a: string, b: string) {
  const { pre, suf } = commonEnds(a, b);
  const start = pre ? a.lastIndexOf("\n", pre - 1) + 1 : 0;
  const nl = a.indexOf("\n", a.length - suf);
  const endA = nl === -1 ? a.length : nl;
  // Everything after endA is shared suffix, so it sits the same distance from b's end.
  const endB = b.length - (a.length - endA);
  const where = start === 0 && endA === a.length ? "" : start === 0 ? "at the start" : endA === a.length ? "at the end" : "in the middle";
  const was = a.slice(start, endA).trim();
  const now = b.slice(start, endB).trim();
  // Text only added around what was there ("Intern · " before a subject, a
  // link after the last line) reads as an addition, not as a rewrite of it.
  if (was && now !== was && now.startsWith(was)) return { was: "", now: now.slice(was.length).trim(), where: where || "at the end" };
  if (was && now !== was && now.endsWith(was)) return { was: "", now: now.slice(0, -was.length).trim(), where: where || "at the start" };
  return { was, now, where };
}

export const correctionFromEdit = (
  kind: string,
  proposed: Draft,
  accepted: Draft,
  fields: Field[],
) => ({
  title: `${kind}: ${fields.join(" and ")} rewritten before approval`,
  body: [
    `An intern drafted a ${kind}; a person rewrote it before approving.`,
    "",
    ...fields.flatMap((f) => {
      const c = changedLines(render(proposed[f]), render(accepted[f]));
      const change = !c.was ? [`added: ${c.now}`] : !c.now ? [`removed: ${c.was}`] : [`was: ${c.was}`, `now: ${c.now}`];
      return [`${f.toUpperCase()}${c.where ? `, ${c.where}` : ""}:`, ...change, ""];
    }),
    "Make the same change in new drafts, whatever they are about.",
  ].join("\n"),
});

export const correctionFromReject = (kind: string, draft: Draft, reason: string) => ({
  title: `do not send: ${draft.subject || draft.body.slice(0, 60)}`,
  body: `An intern drafted a ${kind} to ${draft.to.join(", ")} and a person rejected it.\n\nReason: ${reason}\n\nWhat was drafted:\n${draft.body}`,
});

/**
 * A `[bracketed placeholder]` the intern left for the person to fill in
 * (lib/brief.ts tells it to). The lookahead spares a markdown link's
 * `[text](url)`; the length cap and no-newline keep prose brackets out; two
 * or more characters with at least one letter spare footnotes and indexes
 * (`[1]`, `arr[0]`) and checkboxes (`[ ]`, `[x]`).
 */
const PLACEHOLDER = /\[(?=[^\]\n]*\p{L})[^\]\n]{2,60}\](?!\()/u;

export const UNFILLED = "Fill in the [bracketed] parts before sending.";

/** Whether any field of a draft about to go out still holds a placeholder. */
export const hasPlaceholder = (d: Draft): boolean => FIELDS.some((f) => PLACEHOLDER.test(render(d[f])));
