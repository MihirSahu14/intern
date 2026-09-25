/**
 * Whether a sandbox-drafted send may go out unedited: every recipient the
 * intern drafted already appears, verbatim and as a whole word, in the brief
 * the member typed. The sandbox prompt tells the model to invent placeholders
 * (`#general`, `name@example.com`) that never appear in anyone's brief; a
 * recipient the member actually typed does, and that's the honest line
 * between "briefed for real" and "still a placeholder".
 *
 * Whole-token, not substring — `bob@x.com` must not match a brief that only
 * mentions `jimbob@x.com`. Splits on whitespace, commas and semicolons — the
 * ways a person actually lists several recipients in one sentence
 * (`ann@x.com, bob@x.com` / `ann@x.com; bob@x.com`) — and trims the
 * punctuation left at a token's edges (a trailing period, a wrapping quote)
 * but never characters that can be part of the token itself (`@`, `.`, `-`,
 * `#`).
 */
const DELIMITER = /[\s,;]+/;
const TOKEN_EDGE = /^[.,;:!?()'"<>]+|[.,;:!?()'"<>]+$/g;

const normalize = (token: string) => token.replace(TOKEN_EDGE, "").toLowerCase();

function briefTokens(brief: string): Set<string> {
  return new Set(brief.split(DELIMITER).map(normalize).filter(Boolean));
}

export function recipientsInBrief(recipients: string[], brief: string): boolean {
  const tokens = briefTokens(brief);
  return recipients.every((r) => tokens.has(normalize(r.trim())));
}
