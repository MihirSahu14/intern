/**
 * The rendered terminal collapses a model's fenced ```action/```fact/```question
 * block into one line. `convex/run.ts`'s `go` action appends the model's raw
 * output to the log in chunks — `pending` is flushed through `say` when it ends
 * in a period or a newline, or passes 160 characters — and trims each one. So
 * one `LogLine` can hold several rows ("```action\n{\n\"kind\":…"), and a
 * boundary between two `LogLine`s is either trimmed whitespace between JSON
 * tokens or a split mid-string ("ann@acme." | "com"). Fence markers are
 * matched per row; a block's body joins rows within a `LogLine` with "\n" and
 * across `LogLine`s with "" — valid JSON either way — and is parsed with the
 * same helpers `convex/run.ts` uses on the finished report, so "collapsed" and
 * "what the run actually filed" never disagree.
 *
 * ponytail: a 160-cap split that lands inside a marker row ("```act" | "ion")
 * isn't recognised and shows raw. Rejoin rows across a split if it ever shows up.
 */

import { parseActionBlock } from "./action-block.ts";
import { parseFactBlocks, parseQuestionBlock } from "./parse.ts";
import type { LogLine } from "./types.ts";

type Kind = "action" | "fact" | "question";

const FENCE_OPEN = /^```(action|fact|question)\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const FALLBACK = "(structured output)";

function summarize(kind: Kind, body: string): string {
  const text = "```" + kind + "\n" + body + "\n```";
  if (kind === "action") {
    const parsed = parseActionBlock(text);
    return parsed && !("error" in parsed) ? `drafted ${parsed.kind} → ${parsed.draft.to.join(", ")}` : FALLBACK;
  }
  if (kind === "fact") {
    const [fact] = parseFactBlocks(text);
    return fact ? `noted: ${fact.title}` : FALLBACK;
  }
  const question = parseQuestionBlock(text);
  return question && !("error" in question) ? `asked: ${question.question}` : FALLBACK;
}

/**
 * Collapse every complete ```action/```fact/```question fence in `lines` into
 * one summary line each; everything else passes through untouched.
 *
 * `lines` is the merged, time-ordered stream across every intern in the
 * panel (the "all" tab), not one intern's own log — so an open fence is
 * tracked per `internId`, not globally. Only that intern's model output
 * (`out` lines) can continue it: a still-streaming fence hides just its own
 * rows, and any other line from the same intern (finished, drafted, failed…)
 * ends it — shown as the fallback label, then the line itself.
 *
 * One `LogLine` can yield several lines (text, summary, text), all sharing
 * its `id` — render keys must not assume `id` is unique.
 */
export function collapseBlocks(lines: LogLine[]): LogLine[] {
  const out: LogLine[] = [];
  // Per intern: the block's kind and its body, one part per LogLine.
  const open = new Map<string | null, { kind: Kind; parts: string[] }>();

  for (const line of lines) {
    let fence = open.get(line.internId);
    if (line.level !== "out") {
      if (fence) out.push({ ...line, level: "out", text: FALLBACK });
      open.delete(line.internId);
      out.push(line);
      continue;
    }

    let text: string[] = [];
    let body: string[] = [];
    const flush = () => {
      const t = text.join("\n").trim();
      if (t) out.push({ ...line, text: t });
      text = [];
    };
    for (const row of line.text.split("\n")) {
      if (fence) {
        if (FENCE_CLOSE.test(row.trim())) {
          fence.parts.push(body.join("\n"));
          out.push({ ...line, text: summarize(fence.kind, fence.parts.join("")) });
          open.delete(line.internId);
          fence = undefined;
          body = [];
        } else body.push(row);
        continue;
      }
      const opened = row.trim().match(FENCE_OPEN);
      if (!opened) {
        text.push(row);
        continue;
      }
      flush();
      fence = { kind: opened[1] as Kind, parts: [] };
      open.set(line.internId, fence);
    }
    if (fence) fence.parts.push(body.join("\n"));
    flush();
  }
  return out;
}
