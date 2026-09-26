/**
 * Offline eval: 28 fixed briefs through the current prompt, sandbox by
 * default; `EVAL_LIVE=1` runs every brief as a connected member (see LIVE).
 * Checks the one thing that has silently broken before: does a brief that
 * should draft produce a *usable* action block instead of a question?
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
import { PROMPT_VERSION, type Self, brief } from "../lib/brief.ts";
import { stream } from "../lib/model.ts";
import { parseQuestionBlock } from "../lib/parse.ts";

type Expect = "action" | "question" | "any";

/** How a brief is run: who it works for and what it could send from. Unset means sandbox, nobody. */
type Mode = { self?: Self; sendsFrom?: string[]; slackChannel?: string };

/**
 * Who a "me/myself" brief resolves to, the way prod's `interns.start` hands it
 * over from a connected Gmail. The run itself stays sandbox: nothing is sent.
 */
const ME: Self = { handle: "tester", accounts: [{ kind: "email", label: "Gmail", account: "tester@example.com" }] };

/**
 * `EVAL_LIVE=1`: every brief runs the way prod runs a fully connected member —
 * Gmail and Slack live, and YOU WORK FOR knows both accounts. Nothing is sent
 * either way; the eval only reads what the model writes.
 */
const LIVE: Mode | null = process.env.EVAL_LIVE === "1"
  ? {
      sendsFrom: ["Gmail", "Slack"],
      // What interns.start hands a prod run once COMMUNITY_SLACK_TEAM_ID is set.
      slackChannel: "#all-intern-community",
      self: {
        handle: "tester",
        accounts: [
          { kind: "email", label: "Gmail", account: "tester@example.com" },
          { kind: "slack", label: "Slack", account: "@tester in Intern Community" },
        ],
      },
    }
  : null;

const CASES: [string, Expect, Mode?][] = [
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
  ["send a mail to myself explaining what Intern can do", "action", { self: ME }],
  ["Email me a summary of what Intern can do", "action", { self: ME }],
  ["Post in #all-intern-community: welcome to the new members", "action"],
  ["Draft a Slack message to the team about today's progress", "action"],
  ["Write an email to the team with Intern's features and limits", "action"],
  // Vague briefs: drafting with [placeholders] (a "[recipient]" included) is
  // the default now, but asking isn't wrong when there's truly nothing to draft.
  // This one runs live (Gmail, nobody named) even without EVAL_LIVE.
  ["Email the new customer a welcome note", "any", { sendsFrom: ["Gmail"], self: { handle: "tester", accounts: [] } }],
  ["Email Sarah about the thing we discussed", "any"],
  ["Send the pricing to our biggest customer", "any"],
  ["Book the usual room for the weekly sync", "any"],
  ["Tell the new hire who they report to", "any"],
  ["Summarise what Intern is in three sentences", "any"],
  ["What makes a prospect viable for Intern?", "any"],
  ["List two risks the brain has not solved yet", "any"],
  ["Who is Intern for?", "any"],
  ["What can Intern do?", "any"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let attempted = 0;
let usable = 0;
let matched = 0;
let errored = 0;

console.log(`prompt ${PROMPT_VERSION} · ${CASES.length} briefs · ${LIVE ? "live (EVAL_LIVE=1)" : "sandbox"}\n`);
for (const [task, expect, mode] of CASES) {
  const { self, sendsFrom = [], slackChannel } = LIVE ?? mode ?? {};
  let report = "";
  try {
    for await (const c of stream(brief(task, [], sendsFrom, self, false, slackChannel))) report += c.text ?? "";
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
  // A miss says why: the question it asked instead, or what was malformed.
  const why = [
    action && "error" in action ? `action: ${action.error}` : null,
    !ok && question ? ("error" in question ? `question: ${question.error}` : `asked: ${question.question}`) : null,
  ].filter(Boolean);
  console.log(`${ok ? "ok " : "MISS"} ${got.padEnd(16)} ${task}${why.map((w) => `\n     ${w}`).join("")}`);
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
