/**
 * The rendered terminal collapses a model's fenced ```action/```fact/```question
 * block into one line. `convex/run.ts` appends the model's raw output to the log
 * in chunks — flushed on a period, a newline, or a 160-character cap (see
 * `say`/`pending` in `run.go`) — so a fence's rows can land as several separate
 * `LogLine`s, each already trimmed of its own leading/trailing whitespace. This
 * reassembles a fence (rows joined back with "\n", which is fine for JSON) and
 * parses it with the same helpers `convex/run.ts` uses on the finished report,
 * so "collapsed" and "what the run actually filed" never disagree.
 */

import { parseActionBlock } from "./action-block.ts";
import { parseFactBlocks, parseQuestionBlock } from "./parse.ts";
import type { LogLine } from "./types.ts";

const FENCE_OPEN = /^```(action|fact|question)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

function summarize(kind: "action" | "fact" | "question", text: string): string {
  if (kind === "action") {
    const parsed = parseActionBlock(text);
    return parsed && !("error" in parsed) ? `drafted ${parsed.kind} → ${parsed.draft.to.join(", ")}` : "(structured output)";
  }
  if (kind === "fact") {
    const [fact] = parseFactBlocks(text);
    return fact ? `noted: ${fact.title}` : "(structured output)";
  }
  const question = parseQuestionBlock(text);
  return question && !("error" in question) ? `asked: ${question.question}` : "(structured output)";
}

/**
 * Collapse every complete ```action/```fact/```question fence in `lines` into
 * one summary line each; everything else passes through untouched.
 *
 * `lines` is the merged, time-ordered stream across every intern in the
 * panel (the "all" tab), not one intern's own log — so an open fence is
 * tracked per `internId`, not globally: one intern's unterminated fence only
 * swallows *that intern's* later rows (nothing crashes, and it collapses
 * normally once a later call sees the row that closes it) while every other
 * intern's rows keep showing, interleaved exactly as they came in.
 */
export function collapseBlocks(lines: LogLine[]): LogLine[] {
  const out: LogLine[] = [];
  const open = new Map<string | null, { kind: "action" | "fact" | "question"; buf: string[] }>();

  for (const line of lines) {
    const pending = open.get(line.internId);
    if (pending) {
      pending.buf.push(line.text);
      if (FENCE_CLOSE.test(line.text.trim())) {
        out.push({ ...line, text: summarize(pending.kind, pending.buf.join("\n")) });
        open.delete(line.internId);
      }
      continue;
    }
    const opened = line.text.trim().match(FENCE_OPEN);
    if (opened) {
      open.set(line.internId, { kind: opened[1] as "action" | "fact" | "question", buf: [line.text] });
      continue;
    }
    out.push(line);
  }
  return out;
}
