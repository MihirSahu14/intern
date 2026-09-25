/**
 * Whether a sandbox-drafted send may go out unedited: every recipient the
 * intern drafted already appears, verbatim and as a whole word, in the brief
 * the member typed. The sandbox prompt tells the model to invent placeholders
 * (`#general`, `name@example.com`) that never appear in anyone's brief; a
 * recipient the member actually typed does, and that's the honest line
 * between "briefed for real" and "still a placeholder".
 *
 * Whole-token, not substring — `bob@x.com` must not match a brief that only
 * mentions `jimbob@x.com`. Trims the punctuation a sentence wraps a token in
 * (a trailing period, a comma) but never characters that can be part of the
 * token itself (`@`, `.`, `-`, `#`).
 */
const TOKEN_EDGE = /^[.,;:!?()'"<>]+|[.,;:!?()'"<>]+$/g;

function briefTokens(brief: string): Set<string> {
  return new Set(
    brief
      .split(/\s+/)
      .map((t) => t.replace(TOKEN_EDGE, "").toLowerCase())
      .filter(Boolean),
  );
}

export function recipientsInBrief(recipients: string[], brief: string): boolean {
  const tokens = briefTokens(brief);
  return recipients.every((r) => tokens.has(r.trim().toLowerCase()));
}
