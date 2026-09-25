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
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (
      suf < a.length - pre &&
      suf < b.length - pre &&
      a[a.length - 1 - suf] === b[b.length - 1 - suf]
    ) suf++;
    changed += longest - pre - suf;
  }
  return total ? changed / total : 0;
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
    ...fields.flatMap((f) => [
      `${f.toUpperCase()}, proposed:`,
      render(proposed[f]),
      `${f.toUpperCase()}, accepted:`,
      render(accepted[f]),
      "",
    ]),
    "Write it the accepted way next time.",
  ].join("\n"),
});

export const correctionFromReject = (kind: string, draft: Draft, reason: string) => ({
  title: `do not send: ${draft.subject || draft.body.slice(0, 60)}`,
  body: `An intern drafted a ${kind} to ${draft.to.join(", ")} and a person rejected it.\n\nReason: ${reason}\n\nWhat was drafted:\n${draft.body}`,
});

/**
 * A `[bracketed placeholder]` the intern left for the person to fill in
 * (lib/brief.ts tells it to). The lookahead spares a markdown link's
 * `[text](url)`; the length cap and no-newline keep prose brackets out.
 */
const PLACEHOLDER = /\[[^\]\n]{1,60}\](?!\()/;

export const UNFILLED = "Fill in the [bracketed] parts before sending.";

/** Whether any field of a draft about to go out still holds a placeholder. */
export const hasPlaceholder = (d: Draft): boolean => FIELDS.some((f) => PLACEHOLDER.test(render(d[f])));
