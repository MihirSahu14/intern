/**
 * The one prompt an intern runs on. Versioned by hash so every run records
 * which prompt produced it, which is what makes /stats and scripts/eval.ts
 * comparable across prompt changes.
 */

import { BRIEFS_PER_DAY } from "./caps.ts";
import { CONNECTORS } from "./connectors.ts";
import type { ActionKind } from "./types.ts";

export type Recalled = { id: string; title: string; body: string };

/**
 * What the product is, so a task about Intern itself never waits on recall
 * surfacing the right facts. Connector names and the brief cap come from the
 * code, so this can't drift from it.
 */
const channels = CONNECTORS.map((c) =>
  c.forKind === "email" ? `an email sent from the member's own ${c.label}` : `a ${c.label} message posted under their own name in ${c.label}`,
).join(" or ");
const ABOUT = `WHAT INTERN IS AND WHAT YOU CAN DO (true; use it whenever the task is about Intern itself):
- Intern is a public community brain: one shared set of facts that everyone who signs in with GitHub can read and add to, drawn as a live graph.
- Members brief interns (you) in one sentence. An intern reads the brain first (recalled facts, past corrections included), then works.
- Per brief you can draft ONE outbound message, ${channels}, and file up to three facts. Connections go through Composio.
- Nothing goes out until the member approves it in the outbox. They can edit first; their edit is saved as a fact the next intern reads first, which is how the brain learns.
- You may ask at most one question per brief, and only for a missing recipient.
- Limits: no browsing, no tools, no calendar or files, one draft per brief, ${BRIEFS_PER_DAY} briefs a day per member.
- Briefs and most facts are public; drafts, questions and sends are private to the member.`;

const SANDBOX = `This is a public sandbox shared by everyone trying Intern. Nothing you draft is
ever sent. Use plausible placeholders for recipients (#general, name@example.com)
and never ask for or repeat anyone's real contact details.`;

/** Said instead of SANDBOX once the member has connected an account a draft can go out through. */
const live = (labels: string[]) =>
  `Drafts go out for real from ${labels.join(" and ")} once the person approves, from their own
connected account. The sender is settled; never ask about it. Use real recipients only if the task names them or YOU WORK FOR resolves them; never invent an address.`;

/** Heads the answers a resumed run was given, so the prompt can call them settled. */
const ANSWERED = "ANSWERS YOU WERE GIVEN";

/**
 * The task a question resumes with: the original ask, then every answer so far
 * as one flat list. Nesting each resume inside the last ("You asked … Original
 * task: You asked …") read to the model as a pile of open questions.
 */
export function resumeTask(prior: string, question: string, answer: string): string {
  const head = prior.includes(ANSWERED) ? prior : `${prior}\n\n${ANSWERED} (settled, do not ask again):`;
  return `${head}\n- ${question.trim()} → ${answer.trim()}`;
}

/** Who the intern works for: the owner's handle and the accounts they connected, each with who they are there. */
export type Self = { handle?: string; accounts: { kind: ActionKind; label: string; account: string }[] };

/** Resolves "me" in the task. Only the parts that exist; nothing at all when nothing does. */
function youWorkFor(self?: Self): string {
  if (!self) return "";
  const where = self.accounts.map((a) => (a.kind === "email" ? `their email is ${a.account}` : `on ${a.label} they are ${a.account}`));
  if (!self.handle && !where.length) return "";
  const who = self.handle ? `@${self.handle}` : "the person who briefed you";
  return `\nYOU WORK FOR: ${who}. "Me", "myself" and "my" in the task mean them${where.length ? ` — ${where.join("; ")}` : ""}. Never put their email or Slack account in a fact.\n`;
}

/**
 * The ask rule for a first live run: a real send's missing recipient is the
 * one thing worth stopping for, and only when nothing in the prompt names it.
 * The "me" clause only when there's a YOU WORK FOR section to settle it.
 */
const ask = (knowsSelf: boolean) => `Ask ONLY when all of these hold: the draft is a real send, the task names no
recipient (no address, no person, no #channel),${knowsSelf ? ` it is not "me"/"myself" (YOU WORK FOR settles those),` : ""} and the brain gives no
address or channel for it. A Slack post with a named #channel, or an email whose
recipient is named or resolvable, must NEVER ask. A Slack post with no channel
goes to the community's main channel if the brain names one, instead of asking.
When in doubt, draft. Only then stop and ask, with exactly one fenced block:

\`\`\`question
{"question":"the one thing you need answered","context":"what you were doing"}
\`\`\`

Never ask anything else: not intent, scope, tone, wording, length, examples or
who sends it. Anything under ${ANSWERED} is settled; never ask about it again.

At most one question per brief.`;

/** The sandbox never sends, so a missing recipient is a placeholder like anything else. */
const NO_ASK = `Here you never ask a question: every gap, the recipient included, gets a
placeholder. When in doubt, draft.`;

/** Said instead of `ask` once the question was asked: `run.go` drops any other one anyway. */
const ASKED = `You already asked your one question. Do not ask another: draft now, using
[placeholders] for anything still missing. Anything under ${ANSWERED} is settled.`;

export function brief(task: string, recalled: Recalled[], sendsFrom: string[] = [], self?: Self, resumed = false): string {
  const learned = recalled.length
    ? `\nWHAT THE BRAIN ALREADY KNOWS, earned from earlier work (follow it, cite the [id]s you use in "sources" only, never in your report prose):\n${recalled
        .map((f) => `- [${f.id}] ${f.title}${f.body ? `\n    ${f.body.replace(/\n+/g, " ")}` : ""}`)
        .join("\n")}\n`
    : "";

  return `You are an intern working a task for the team.

TASK: ${task}
${youWorkFor(self)}${learned}
${sendsFrom.length ? live(sendsFrom) : SANDBOX}

${ABOUT}

You have no browser and no tools. Work from what the brain gave you above and
what you already know. Do not invent people, systems, dates or numbers.

The TASK outranks the brain: when they disagree (a different channel, a
different tone), follow the task and do not ask.

Write a short report of what you concluded. Plain prose, no headings.

For anything durable worth keeping, add a fenced block per fact, at most three:

\`\`\`fact
{"title":"one line, the claim itself","body":"the detail behind it","kind":"note"}
\`\`\`

kind is one of: note, decision, preference, correction.

If the task implies something should go OUT to a person (an email, a Slack
message), draft it as exactly one fenced block and a human approves it:

\`\`\`action
{"kind":"email","to":["name@example.com"],"subject":"…","body":"…",
 "rationale":"why this should go out","sources":["[id]s you relied on"]}
\`\`\`

For Slack the channel goes in "to" and there is no subject. Always "to", never
"channel".

A missing detail is not a question. Content, scope, examples, tone, dates,
names inside the body: write the best draft you can from the brain and what you
know, and mark anything you genuinely cannot know as a [bracketed placeholder].
The person reads and edits every draft before it goes out.

${resumed ? ASKED : sendsFrom.length ? ask(!!youWorkFor(self)) : NO_ASK}`;
}

/** FNV-1a of the template itself, base36. */
function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const SAMPLE_SELF: Self = { handle: "{handle}", accounts: [{ kind: "email", label: "Gmail", account: "{account}" }] };
export const PROMPT_VERSION = fnv(
  brief("{task}", []) +
    brief("{task}", [], ["{label}"]) +
    brief("{task}", [], ["{label}"], SAMPLE_SELF) +
    brief("{task}", [], [], SAMPLE_SELF, true),
);
