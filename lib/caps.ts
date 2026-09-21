/**
 * Limits for the public instance. Pure, so the arithmetic is tested here and
 * the Convex mutations only count rows and ask.
 *
 * Checked inside mutations, which Convex runs serializably, so two tabs racing
 * the fifth brief cannot both win.
 */

export const BRIEFS_PER_DAY = 5;
export const FACTS_PER_DAY = 20;
export const DAILY_BUDGET_USD = 5;
export const MAX_BRIEF_CHARS = 2000;
export const MAX_FACT_CHARS = 1000;
/** An edited draft's `to`/`cc` list, before it becomes a fact body. */
export const MAX_RECIPIENTS = 20;
/** Each recipient in that list — an email address or a Slack channel name, never a paragraph. */
export const MAX_RECIPIENT_CHARS = 200;

// ponytail: list price per 1M tokens for gemini-flash-latest, checked by hand
// at ai.google.dev/pricing. On the free tier nothing is billed; the cap then
// acts as a ~500-runs/day ceiling. Update both if GEMINI_MODEL changes.
const USD_PER_M_IN = 0.3;
const USD_PER_M_OUT = 2.5;

const DAY_MS = 86_400_000;
const RESETS = "Resets at 00:00 UTC.";

export const dayStart = (now: number) => now - (now % DAY_MS);
export const dayKey = (now: number) => new Date(dayStart(now)).toISOString().slice(0, 10);

export const costUsd = (tokensIn: number, tokensOut: number) =>
  (tokensIn * USD_PER_M_IN + tokensOut * USD_PER_M_OUT) / 1_000_000;

export function spawnBlocked(s: {
  briefsToday: number;
  active: boolean;
  spentToday: number;
}): string | null {
  if (s.spentToday >= DAILY_BUDGET_USD) {
    return `The community used today's $${DAILY_BUDGET_USD} model budget. ${RESETS}`;
  }
  if (s.active) return "You already have an intern working. Wait for it to finish.";
  if (s.briefsToday >= BRIEFS_PER_DAY) {
    return `You've used your ${BRIEFS_PER_DAY} briefs for today. ${RESETS}`;
  }
  return null;
}

export const teachBlocked = (factsToday: number): string | null =>
  factsToday >= FACTS_PER_DAY ? `You've added ${FACTS_PER_DAY} facts today. ${RESETS}` : null;
