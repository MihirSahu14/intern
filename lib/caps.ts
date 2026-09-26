/**
 * Limits for the public instance. Pure, so the arithmetic is tested here and
 * the Convex mutations only count rows and ask.
 *
 * Checked inside mutations, which Convex runs serializably, so two tabs racing
 * the fifth brief cannot both win.
 */

export const BRIEFS_PER_DAY = 5;
export const FACTS_PER_DAY = 20;
/**
 * How many of a person's rows a mutation reads to judge their day. Rows that
 * don't count toward a cap (a failed run, say) still fill it, so a day that
 * overflows the window is refused outright rather than counted wrongly — see
 * `tooManyBriefs` / `tooManyFacts`.
 */
export const DAY_WINDOW = 50;
export const DAILY_BUDGET_USD = 5;
export const MAX_BRIEF_CHARS = 2000;
export const MAX_FACT_CHARS = 1000;
/** An edited draft's `to`/`cc` list, before it becomes a fact body. */
export const MAX_RECIPIENTS = 20;
/** Each recipient in that list — an email address or a Slack channel name, never a paragraph. */
export const MAX_RECIPIENT_CHARS = 200;

/**
 * List price per 1M tokens, env-configurable so the cap stays meaningful
 * whichever `MODEL_*` provider is live (see lib/model.ts). Defaults are
 * Groq's paid `openai/gpt-oss-20b` price — $0.075 in / $0.30 out per 1M —
 * from console.groq.com/docs/models via .superpowers/sdd/llm-providers-research.md.
 *
 * ponytail: Groq's free tier bills nothing, so on the default provider this
 * cap doesn't ration real spend — it just bounds runs/day (5/$0.30-ish worth
 * of output ≈ hundreds of runs). It becomes a real dollar cap the moment
 * MODEL_BASE_URL points at a paid tier. Read once here; costUsd stays pure.
 */
const USD_PER_M_IN = Number(process.env.MODEL_USD_PER_M_IN) || 0.075;
const USD_PER_M_OUT = Number(process.env.MODEL_USD_PER_M_OUT) || 0.3;

const DAY_MS = 86_400_000;
const RESETS = "Resets at 00:00 UTC.";

export const dayStart = (now: number) => now - (now % DAY_MS);
export const dayKey = (now: number) => new Date(dayStart(now)).toISOString().slice(0, 10);

export const costUsd = (tokensIn: number, tokensOut: number, usdPerMIn = USD_PER_M_IN, usdPerMOut = USD_PER_M_OUT) =>
  (tokensIn * usdPerMIn + tokensOut * usdPerMOut) / 1_000_000;

/**
 * `CAP_EXEMPT_HANDLES`: a deployment env var, comma-separated GitHub handles,
 * for the deployment owner's own testing — so hitting BRIEFS_PER_DAY on your
 * own deployment doesn't stop you from trying it. Case-insensitive and
 * whitespace-trimmed on both sides, so `CAP_EXEMPT_HANDLES=" Mihir, Ann "`
 * matches a `users.handle` of `mihir` or `ANN`. Unset or empty exempts no
 * one. Exemption is per-member caps only — see each `*Blocked` function's own
 * note for what it never skips.
 */
export function isCapExempt(handle: string | null | undefined, env: string | undefined): boolean {
  if (!handle) return false;
  const h = handle.trim().toLowerCase();
  return (env ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(h);
}

/** Exempt still hits the shared $5/day budget — it isn't a per-member quota. */
export function spawnBlocked(s: {
  briefsToday: number;
  active: boolean;
  spentToday: number;
  exempt?: boolean;
}): string | null {
  if (s.spentToday >= DAILY_BUDGET_USD) {
    return `The community used today's $${DAILY_BUDGET_USD} model budget. ${RESETS}`;
  }
  if (s.exempt) return null;
  if (s.active) return "You already have an intern working. Wait for it to finish.";
  if (s.briefsToday >= BRIEFS_PER_DAY) {
    return `You've used your ${BRIEFS_PER_DAY} briefs for today. ${RESETS}`;
  }
  return null;
}

export const teachBlocked = (factsToday: number, exempt = false): string | null =>
  !exempt && factsToday >= FACTS_PER_DAY ? `You've added ${FACTS_PER_DAY} facts today. ${RESETS}` : null;

export const SENDS_PER_DAY = 20;

export const sendBlocked = (sendsToday: number, exempt = false): string | null =>
  !exempt && sendsToday >= SENDS_PER_DAY ? `You've used your ${SENDS_PER_DAY} sends for today. ${RESETS}` : null;

export const SOURCES_PER_DAY = 5;

export const sourceBlocked = (addedToday: number, exempt = false): string | null =>
  !exempt && addedToday >= SOURCES_PER_DAY ? `You've added ${SOURCES_PER_DAY} sources today. ${RESETS}` : null;

/**
 * Said when the day's window overflows and the counts above stop being
 * trustworthy — a safety guard against miscounting, not a quota, so it's
 * never skipped by `CAP_EXEMPT_HANDLES`.
 */
export const tooManyBriefs = `You've started too many interns today. ${RESETS}`;
export const tooManyFacts = `You've written too many facts today. ${RESETS}`;
export const tooManySends = `You've decided too many drafts today to count your sends. ${RESETS}`;
