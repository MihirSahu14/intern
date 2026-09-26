/**
 * The one prompt an intern runs on. Versioned by hash so every run records
 * which prompt produced it, which is what makes /stats and scripts/eval.ts
 * comparable across prompt changes.
 */

import { BRIEFS_PER_DAY } from "./caps.ts";
import { CONNECTORS } from "./connectors.ts";
import { PASSAGE_EXCERPT } from "./ingest.ts";
import type { ActionKind } from "./types.ts";

export type Recalled = { id: string; title: string; body: string };

/** An archive passage, as `facts.archive` returns it. */
export type Archived = { id: string; label: string; author: string | null; at: number; text: string };

/** One passage line: its citation id, where and when it was said, and at most PASSAGE_EXCERPT of it on one line. */
const archived = (a: Archived) =>
  `- [p:${a.id}] ${[a.label, a.author, new Date(a.at).toISOString().slice(0, 10)].filter(Boolean).join(" · ")}: ${a.text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PASSAGE_EXCERPT)}`;

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
- The brain also holds a searchable archive of the community Slack's public channels, documents members share and public GitHub repos; the passages that match a task reach you as FROM THE ARCHIVE.
- Nothing goes out until the member approves it in the outbox. They can edit first; their edit is saved as a fact the next intern reads first, which is how the brain learns.
- You never ask questions: anything missing becomes a [placeholder] the member fills in before approving.
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
 * There is no question block to offer: a model given one uses it, and no
 * prompt rule made that deterministic (see the eval history in
 * .superpowers/sdd/deterministic-questions-report.md). `run.go` backs this up
 * with one rewrite call if a question comes back anyway.
 */
const NO_ASK = `You can't ask questions. Anything you'd need to ask becomes a [placeholder] in
the draft, which the person fills in before approving.`;

/** Live only: where an unnamed recipient goes, so it is never a reason to stall. */
const recipients = (slackChannel?: string) => `${slackChannel ? `A Slack post with no channel goes to ${slackChannel}. ` : ""}An email with no recipient you
can name or resolve is drafted with "to":["[recipient]"]; the member fills it
in before it can send.`;

/** What `run.go` (and scripts/eval.ts) sends when a reply asked instead of drafting. */
export const REWRITE = "Asking isn't available. Rewrite your answer now: draft it, using [placeholders] for anything you would have asked.";

/** What they send when an outbound task's reply has no usable draft. */
export const NO_DRAFT =
  'The task asks for something to go out, but your reply has no ```action block. Rewrite it as one draft now, using [placeholders] (including "to":["[recipient]"]) for anything unknown.';

/**
 * Whether a task asks for something to go out, so a reply with no draft
 * missed the point. Whole words only.
 * ponytail: a keyword list, not intent classification; a miss costs nothing
 * worse than the prose reply it already was.
 */
export const wantsDraft = (task: string) => /\b(e-?mail|mail|slack|post|send|message|dm|draft|write to|reply)\b/i.test(task);

/** The one follow-up call: the original prompt, the reply that missed, and what to do instead. */
export const rewrite = (prompt: string, reply: string, instruction = REWRITE) =>
  `${prompt}\n\nYOUR FIRST ANSWER:\n${reply}\n\n${instruction}`;

export function brief(
  task: string,
  recalled: Recalled[],
  sendsFrom: string[] = [],
  self?: Self,
  /** Where a live Slack post with no channel goes; see interns.start. */
  slackChannel?: string,
  /** Passages `facts.archive` found for this task. Evidence, cited like facts: in "sources" only. */
  archive: Archived[] = [],
): string {
  const learned = recalled.length
    ? `\nWHAT THE BRAIN ALREADY KNOWS, earned from earlier work (follow it, cite the [id]s you use in "sources" only, never in your report prose):\n${recalled
        .map((f) => `- [${f.id}] ${f.title}${f.body ? `\n    ${f.body.replace(/\n+/g, " ")}` : ""}`)
        .join("\n")}\n`
    : "";
  const fromArchive = archive.length
    ? `\nFROM THE ARCHIVE, what the community said in Slack, documents and GitHub (evidence, not settled facts; cite the [p:id]s you use in "sources" only, never in your report prose):\n${archive
        .map(archived)
        .join("\n")}\n`
    : "";

  return `You are an intern working a task for the team.

TASK: ${task}
${youWorkFor(self)}${learned}${fromArchive}
${sendsFrom.length ? live(sendsFrom) : SANDBOX}

${ABOUT}

You have no browser and no tools. Work from what the brain gave you above and
what you already know. Do not invent people, systems, dates or numbers.

The TASK outranks the brain: when they disagree (a different channel, a
different tone), follow the task.

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
 "rationale":"why this should go out","sources":["[id]s and [p:id]s you relied on"]}
\`\`\`

For Slack the channel goes in "to" and there is no subject. Always "to", never
"channel".

A missing detail is not a question. Content, scope, examples, tone, dates,
names inside the body: write the best draft you can from the brain and what you
know, and mark anything you genuinely cannot know as a [bracketed placeholder].
The person reads and edits every draft before it goes out.

${NO_ASK}${sendsFrom.length ? `\n\n${recipients(slackChannel)}` : ""}

When in doubt, draft.`;
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
const SAMPLE_ARCHIVE: Archived[] = [{ id: "{id}", label: "{label}", author: "{author}", at: 0, text: "{text}" }];
export const PROMPT_VERSION = fnv(
  brief("{task}", []) +
    brief("{task}", [], ["{label}"]) +
    brief("{task}", [], ["{label}"], SAMPLE_SELF, "{channel}") +
    brief("{task}", [], ["{label}"], SAMPLE_SELF, "{channel}", SAMPLE_ARCHIVE),
);
