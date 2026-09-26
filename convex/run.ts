import { v } from "convex/values";
import { parseActionBlock } from "../lib/action-block.ts";
import { NO_DRAFT, REWRITE, brief, rewrite, wantsDraft } from "../lib/brief.ts";
import { NOT_CONFIGURED, describe, stream } from "../lib/model.ts";
import { parseFactBlocks, parseQuestionBlock } from "../lib/parse.ts";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const BUSY = "The model is busy, try again in a minute.";
const NOT_SET_UP = "The model isn't set up yet.";

/**
 * One intern run: recall, one streamed model call (two if it asked instead
 * of drafting), parse, finish.
 * Plain fetch, so no "use node". Cancellation is checked by `finish` and
 * `fail`, which both still record usage and mark the run's real end when the
 * intern was cancelled meanwhile — see `dispatch`'s active check.
 */
export const go = internalAction({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const say = (level: "sys" | "out", text: string) =>
      ctx.runMutation(internal.interns.appendLog, { internId, level, text });
    const t0 = Date.now();

    // Hoisted above the try so a mid-stream failure can still report what
    // Google had already billed by the time it threw — see interns.fail.
    let usage = { in: 0, out: 0 };
    try {
      // Inside the try: if this throws, `fail` still runs. Outside it, the
      // intern stayed `queued` forever and held the concurrency slot until the
      // UTC day rolled over.
      const started = await ctx.runMutation(internal.interns.start, { internId });
      if (!started) return null;

      const recalled = await ctx.runQuery(internal.facts.recall, { task: started.task, ownerId: started.ownerId });
      await ctx.runMutation(internal.interns.noteRecall, {
        internId,
        recalled: recalled.map((f) => ({ id: f.id, kind: f.kind, visibility: f.visibility })),
      });
      if (recalled.length) await say("sys", `recalled ${recalled.length} facts from the brain`);
      await say("sys", `thinking · ${describe()}`);

      const prompt = brief(started.task, recalled, started.sendsFrom, started.self, started.slackChannel);

      /**
       * One streamed model call, written to the log as it arrives. `usage`
       * is the run's running total across calls, so the catch below bills
       * whatever was spent even if a later call dies mid-stream.
       */
      const pass = async (input: string): Promise<string> => {
        const before = usage;
        let text = "";
        let pending = "";
        let framed = false;
        for await (const chunk of stream(input)) {
          if (chunk.usage) {
            usage = { in: before.in + chunk.usage.in, out: before.out + chunk.usage.out };
            framed = chunk.usage.out > 0;
          }
          if (!chunk.text) continue;
          text += chunk.text;
          pending += chunk.text;
          if (pending.length > 160 || /[.\n]$/.test(pending)) {
            const line = pending.trim();
            if (line) await say("out", line);
            pending = "";
          }
        }
        if (pending.trim()) await say("out", pending.trim());
        text = text.trim();
        if (!text) throw new Error("model returned an empty report");
        // ponytail: if the provider ever stops sending a usage frame, every run
        // books 0 tokens, addUsage adds $0 and the $5/day global budget quietly
        // stops existing. chars/4 is the usual rough estimate — wrong by a
        // third at worst, which is a budget that still holds. Only for a call
        // that produced something: an empty report must stay free (see the catch).
        if (!framed) usage = { in: before.in + Math.ceil(input.length / 4), out: before.out + Math.ceil(text.length / 4) };
        return text;
      };

      let report = await pass(prompt);
      const usable = (r: string) => {
        const p = parseActionBlock(r);
        return !!p && !("error" in p);
      };
      // Interns don't ask, and an outbound task gets a draft: a reply that
      // asks anyway, or answers an outbound task in prose, gets exactly one
      // rewrite call — at most one extra per run, whichever missed first.
      // Whatever question survives that is ignored, so nothing ever parks
      // `waiting` from here — no prompt rule made either deterministic.
      // Outbound or not is judged on the member's own ask, not on answers a
      // resumed task carries.
      if (!usable(report)) {
        const asked = !!parseQuestionBlock(report);
        // A cancelled run spends nothing more; `finish` records its end.
        if ((asked || wantsDraft(started.ask)) && !(await ctx.runQuery(internal.interns.cancelled, { internId }))) {
          await say("sys", asked ? "drafting instead of asking" : "no draft in the reply, drafting one");
          try {
            report = await pass(rewrite(prompt, report, asked ? REWRITE : NO_DRAFT));
          } catch (err) {
            // The first reply is still a finished run: keep it rather than
            // failing the brief over the optional second call. Its tokens are
            // already in `usage`, and so is whatever the second call billed.
            console.log(`run.go: rewrite failed for ${internId}: ${String(err)}`);
            await say("sys", "rewrite failed — kept the first reply");
          }
        }
      }
      if (parseQuestionBlock(report)) await say("sys", "ignored a question — interns draft instead");

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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 429 (quota), 503 (overloaded) and 529 (also "overloaded", used by
      // some providers) are all the model being busy, not this run's fault —
      // same user-facing copy either way. Whether it counts toward the daily
      // brief cap is decided by usage, not the status text: a missing key or
      // an overloaded model that returned zero output tokens produced
      // nothing billable, so it shouldn't cost a brief.
      const busy = ["429", "503", "529"].some((code) => message.startsWith(`model ${code}`));
      // Matched on model.ts's own exported marker, not by comparing this
      // whole message — an unset key is a setup problem, not the model
      // being busy, and telling the member that is more honest.
      const notConfigured = message === NOT_CONFIGURED;
      await ctx.runMutation(internal.interns.fail, {
        internId,
        error: notConfigured ? NOT_SET_UP : busy ? BUSY : message.slice(0, 500),
        countsTowardCap: usage.out > 0,
        tokensIn: usage.in,
        tokensOut: usage.out,
      });
    }
    return null;
  },
});
