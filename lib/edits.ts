import { redactEmails } from "./redact.ts";
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

/** How many items two sequences (strings, or arrays of lines) share at the start and at the end, never overlapping. */
function commonEnds(a: ArrayLike<unknown>, b: ArrayLike<unknown>) {
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

/** Longer than this, a was/now pair is cut down to the change and some words either side. */
const LONG = 150;
const CONTEXT = 30;

/** `was` and `now` cut to the words around where they differ, so a one-word edit in a long paragraph stays short. */
function around(was: string, now: string) {
  if (was.length <= LONG && now.length <= LONG) return { was, now };
  const { pre, suf } = commonEnds(was, now);
  const cut = (s: string) => {
    // Out to the whole word either side: an address is never split.
    const from = pre > CONTEXT ? s.slice(0, pre - CONTEXT).search(/\S*$/) : 0;
    const end = s.length - suf + CONTEXT;
    const to = end < s.length ? end + s.slice(end).search(/\s|$/) : s.length;
    return `${from ? "…" : ""}${s.slice(from, to).trim()}${to < s.length ? "…" : ""}`;
  };
  return { was: cut(was), now: cut(now) };
}

const squash = (s: string) => s.replace(/\s+/g, " ");
/** A recipient added to a list reads "added: [email]", not "added: , [email]". */
const trimSeparators = (s: string) => s.replace(/^[\s,;]+|[\s,;]+$/g, "");

/**
 * The whole lines of one field that changed, and where. A lesson names the
 * edit itself: quoting both drafts in full put the change past the
 * RECALLED_BODY_CHARS cut `facts.recall` makes, so the next intern never saw it.
 */
function changedLines(a: string, b: string): { where: string; change: [string, string][] } {
  const A = a.split("\n");
  const B = b.split("\n");
  const { pre, suf } = commonEnds(A, B);
  const where = !pre && !suf ? "" : !pre ? "at the start" : !suf ? "at the end" : "in the middle";
  const was = A.slice(pre, A.length - suf).join("\n").trim();
  const now = B.slice(pre, B.length - suf).join("\n").trim();
  if (squash(was) === squash(now)) return { where, change: [] };
  if (!was) return { where, change: [["added", now]] };
  if (!now) return { where, change: [["removed", was]] };
  // Text only added around what was there ("Intern · " before a subject, a
  // recipient after the others), or only cut from around it, reads as that,
  // not as a rewrite. Only at a word or list boundary, so "ann" becoming
  // "ann@acme.com" stays a was/now of whole addresses.
  for (const [long, short, verb] of [[now, was, "added"], [was, now, "removed"]]) {
    const after = long.slice(short.length);
    const before = long.slice(0, long.length - short.length);
    if (long.startsWith(short) && /^[\s,;]/.test(after)) return { where: where || "at the end", change: [[verb, trimSeparators(after)]] };
    if (long.endsWith(short) && /[\s,;]$/.test(before)) return { where: where || "at the start", change: [[verb, trimSeparators(before)]] };
  }
  const w = around(was, now);
  return { where, change: [["was", w.was], ["now", w.now]] };
}

/**
 * What full-text search indexes for a lesson: its topic and the changed text,
 * not the fixed wording around them. Convex search matches any one term, so
 * "email", "drafted" or "about" in every lesson made every "Email…" brief
 * match every lesson. Addresses go entirely; "[email]" would match too.
 */
const searchText = (parts: string[]) => redactEmails(parts.filter(Boolean).join("\n")).replaceAll("[email]", " ");

export function correctionFromEdit(kind: string, proposed: Draft, accepted: Draft, fields: Field[]) {
  const changes = fields.map((f) => ({ f, ...changedLines(render(proposed[f]), render(accepted[f])) }));
  return {
    title: `${kind}: ${fields.join(" and ")} rewritten before approval`,
    body: [
      `An intern drafted a ${kind}; a person rewrote it before approving.`,
      "",
      ...changes.flatMap((c) => [
        `${c.f.toUpperCase()}${c.where ? `, ${c.where}` : ""}:`,
        ...(c.change.length ? c.change.map(([label, text]) => `${label}: ${text}`) : ["only whitespace changed"]),
        "",
      ]),
      "Make the same change in new drafts, whatever they are about.",
    ].join("\n"),
    search: searchText([proposed.subject, ...changes.flatMap((c) => c.change.map(([, text]) => text))]),
  };
}

export const correctionFromReject = (kind: string, draft: Draft, reason: string) => ({
  title: `do not send: ${draft.subject || draft.body.slice(0, 60)}`,
  body: `An intern drafted a ${kind} to ${draft.to.join(", ")} and a person rejected it.\n\nReason: ${reason}\n\nWhat was drafted:\n${draft.body}`,
  search: searchText([draft.subject, reason, draft.body]),
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
