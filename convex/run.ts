import { v } from "convex/values";
import { parseActionBlock } from "../lib/action-block.ts";
import { brief } from "../lib/brief.ts";
import { stream } from "../lib/gemini.ts";
import { parseFactBlocks, parseQuestionBlock } from "../lib/parse.ts";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const BUSY = "The free model is busy, try again in a minute.";

/**
 * One intern run: recall, one streamed Gemini call, parse, finish.
 * Plain fetch, so no "use node". Cancellation is checked by `finish`, which
 * ignores a run whose intern was cancelled meanwhile.
 */
export const go = internalAction({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const started = await ctx.runMutation(internal.interns.start, { internId });
    if (!started) return null;

    const say = (level: "sys" | "out", text: string) =>
      ctx.runMutation(internal.interns.appendLog, { internId, level, text });
    const t0 = Date.now();

    try {
      const recalled = await ctx.runQuery(internal.facts.recall, { task: started.task });
      await ctx.runMutation(internal.interns.noteRecall, {
        internId,
        recalled: recalled.map((f) => ({ id: f.id, kind: f.kind })),
      });
      if (recalled.length) await say("sys", `recalled ${recalled.length} facts from the brain`);
      await say("sys", "thinking · gemini");

      let report = "";
      let pending = "";
      let usage = { in: 0, out: 0 };
      for await (const chunk of stream(brief(started.task, recalled))) {
        if (chunk.usage) usage = chunk.usage;
        if (!chunk.text) continue;
        report += chunk.text;
        pending += chunk.text;
        if (pending.length > 160 || /[.\n]$/.test(pending)) {
          const line = pending.trim();
          if (line) await say("out", line);
          pending = "";
        }
      }
      if (pending.trim()) await say("out", pending.trim());

      report = report.trim();
      if (!report) throw new Error("gemini returned an empty report");

      const asked = parseQuestionBlock(report);
      const parsed = parseActionBlock(report);
      const ok = parsed && !("error" in parsed) ? parsed : null;
      await ctx.runMutation(internal.interns.finish, {
        internId,
        report,
        tokensIn: usage.in,
        tokensOut: usage.out,
        latencyMs: Date.now() - t0,
        facts: parseFactBlocks(report),
        action: ok
          ? {
              kind: ok.kind,
              title: ok.title,
              // Rebuilt field by field: the validator rejects startsAt/endsAt.
              draft: ok.draft.cc
                ? { to: ok.draft.to, cc: ok.draft.cc, subject: ok.draft.subject, body: ok.draft.body }
                : { to: ok.draft.to, subject: ok.draft.subject, body: ok.draft.body },
              rationale: ok.rationale,
              sources: ok.sources,
            }
          : undefined,
        actionError: parsed && "error" in parsed ? parsed.error : undefined,
        question: asked && !("error" in asked) ? asked : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const busy = message.startsWith("gemini 429");
      await ctx.runMutation(internal.interns.fail, {
        internId,
        error: busy ? BUSY : message.slice(0, 500),
        countsTowardCap: !busy,
      });
    }
    return null;
  },
});
