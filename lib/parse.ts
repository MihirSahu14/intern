/**
 * The fenced blocks an intern ends its report with, other than ```action
 * (that one lives in action-block.ts). Moved out of the old in-memory store
 * so Convex, the tests and scripts/eval.ts all read reports the same way.
 */

const FACT_KINDS = ["note", "decision", "preference", "correction"] as const;

export type FactBlock = {
  title: string;
  body: string;
  kind: (typeof FACT_KINDS)[number];
};

/** At most three; malformed ones are skipped rather than failing the run. */
export function parseFactBlocks(report: string): FactBlock[] {
  const out: FactBlock[] = [];
  for (const m of report.matchAll(/```fact\s*\n([\s\S]*?)```/g)) {
    try {
      const raw = JSON.parse(m[1].trim()) as { title?: unknown; body?: unknown; kind?: unknown };
      const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
      if (!title) continue;
      const kind = FACT_KINDS.find((k) => k === raw.kind) ?? "note";
      const body = typeof raw.body === "string" ? raw.body.trim().slice(0, 1000) : "";
      out.push({ title, body, kind });
    } catch {
      /* malformed block: dropped, the run still counts */
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** `null` when there is no block; `{ error }` when there is one that can't be used. */
export function parseQuestionBlock(
  report: string,
): { question: string; context: string } | { error: string } | null {
  const m = report.match(/```question\s*([\s\S]*?)```/);
  if (!m) return null;
  let raw: { question?: unknown; context?: unknown };
  try {
    raw = JSON.parse(m[1].trim());
  } catch {
    return { error: "question block was not valid JSON" };
  }
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return { error: "question block had no question" };
  const context = typeof raw.context === "string" ? raw.context.trim() : "";
  return { question: question.slice(0, 500), context: context.slice(0, 1000) };
}
