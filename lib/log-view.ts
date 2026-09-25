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
 * A fence still being streamed — no closing "```" yet among the given lines —
 * is dropped along with the rest of the input rather than shown half-formed:
 * nothing crashes, and it collapses normally once a later call sees the row
 * that closes it.
 */
export function collapseBlocks(lines: LogLine[]): LogLine[] {
  const out: LogLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = line.text.trim().match(FENCE_OPEN);
    if (!open) {
      out.push(line);
      i++;
      continue;
    }
    const kind = open[1] as "action" | "fact" | "question";
    const buf = [line.text];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      buf.push(lines[j].text);
      if (FENCE_CLOSE.test(lines[j].text.trim())) {
        closed = true;
        break;
      }
    }
    if (!closed) return out;
    out.push({ ...line, text: summarize(kind, buf.join("\n")) });
    i = j + 1;
  }
  return out;
}
