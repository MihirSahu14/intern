/**
 * Offline eval: 22 fixed briefs through the current prompt.
 * Checks the one thing that has silently broken before: does a brief that
 * should draft produce a *usable* action block, and does one that should ask
 * produce a question?
 *
 *   npm run eval
 *
 * Reads MODEL_* from .env.local (see .env.local.example). Cents per run on
 * Groq's free tier; paces at 6s/brief to stay under its 30 req/min.
 * Exits 1 if the action parse rate is under 90%, if more than a quarter of the
 * briefs errored, or if every attempt errored out before producing anything to
 * rate — a model outage, whole or partial, can't look like a pass.
 */
import { parseActionBlock } from "../lib/action-block.ts";
import { PROMPT_VERSION, brief } from "../lib/brief.ts";
import { stream } from "../lib/model.ts";
import { parseQuestionBlock } from "../lib/parse.ts";

type Expect = "action" | "question" | "any";

const CASES: [string, Expect][] = [
  ["Draft a Slack post introducing Intern to a new teammate", "action"],
  ["Write a follow-up email to someone who asked what Intern does", "action"],
  ["Email a prospect a two-line intro to Intern", "action"],
  ["Post in #general that the brain now has a community feed", "action"],
  ["Post in #general: hi from Intern", "action"],
  ["Draft a Slack message thanking the team for testing", "action"],
  ["Write an email inviting a friend to try the public brain", "action"],
  ["Draft a short Slack update: approvals are sandbox-only", "action"],
  ["Email a recruiter a one-paragraph summary of Intern", "action"],
  ["Draft a Slack reminder to review pending drafts", "action"],
  ["Write an email declining a meeting politely", "action"],
  ["Post a Slack welcome for a new designer", "action"],
  ["Draft an email asking for feedback on Intern", "action"],
  // Eval runs sandbox: a placeholder recipient is fine, so "myself" is no reason to ask.
  ["send a mail to myself explaining what Intern can do", "action"],
  // Once "question": under the one-question rule only an unknown recipient on a
  // real send may ask, and eval runs sandbox, so these draft with placeholders or ask.
  ["Email Sarah about the thing we discussed", "any"],
  ["Send the pricing to our biggest customer", "any"],
  ["Book the usual room for the weekly sync", "any"],
  ["Tell the new hire who they report to", "any"],
  ["Summarise what Intern is in three sentences", "any"],
  ["What makes a prospect viable for Intern?", "any"],
  ["List two risks the brain has not solved yet", "any"],
  ["Who is Intern for?", "any"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let attempted = 0;
let usable = 0;
let matched = 0;
let errored = 0;

console.log(`prompt ${PROMPT_VERSION} · ${CASES.length} briefs\n`);
for (const [task, expect] of CASES) {
  let report = "";
  try {
    for await (const c of stream(brief(task, []))) report += c.text ?? "";
  } catch (err) {
    console.log(`ERR  ${task}\n     ${err instanceof Error ? err.message : err}`);
    errored++;
    await sleep(6000);
    continue;
  }
  const action = parseActionBlock(report);
  const question = parseQuestionBlock(report);
  const got = action && !("error" in action) ? "action" : question && !("error" in question) ? "question" : action ? "action_malformed" : "none";
  if (action) attempted++;
  if (got === "action") usable++;
  const ok = expect === "any" || got === expect;
  if (ok) matched++;
  console.log(`${ok ? "ok " : "MISS"} ${got.padEnd(16)} ${task}${action && "error" in action ? `\n     ${action.error}` : ""}`);
  await sleep(6000);
}

// `attempted` (action blocks seen, malformed or not) is 0 whenever nothing
// could be rated — either every call errored, or none of the "action"
// briefs produced a block. Either way there is no parse rate to report, and
// that is a failure, not a vacuous pass.
if (!attempted) {
  console.log(`\n${errored}/${CASES.length} briefs errored · nothing evaluable · expectation match ${matched}/${CASES.length}`);
  process.exit(1);
}

const parseRate = usable / attempted;
// A parse rate over what survived says nothing about what never ran: 8 of 12
// action briefs erroring while 4 parse cleanly is a 100% pass otherwise.
const outage = errored > CASES.length / 4;
console.log(
  `\naction parse rate ${Math.round(parseRate * 100)}% (${usable}/${attempted}) · expectation match ${matched}/${CASES.length}` +
    (errored ? ` · ${errored} errored${outage ? " — more than a quarter, not a pass" : ""}` : ""),
);
process.exit(parseRate < 0.9 || outage ? 1 : 0);
