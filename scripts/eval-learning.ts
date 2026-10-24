/**
 * Learning eval: does an edit change the next draft?
 *
 * Each case drafts a first brief, applies the edit a person might make before
 * approving, files the lesson exactly as `outbox.decide` would (redacted, the
 * same `correctionFromEdit` body) and hands it to a second, related brief the
 * way `facts.recall` would (body cut to RECALLED_BODY_CHARS). The second brief
 * is also run without the lesson, as a control. A case passes when the draft
 * with the lesson shows the edit and the control doesn't.
 *
 * Which lessons reach a brief is `facts.recall`'s job, covered by
 * convex/engine.test.ts; this checks what the model does with one once it has it.
 * Runs as a fully connected member, like `EVAL_LIVE=1` in scripts/eval.ts.
 *
 *   npm run eval:learning
 *
 * Exits 1 if fewer than 80% of cases pass, or more than a quarter errored.
 */
import { parseActionBlock } from "../lib/action-block.ts";
import { NO_DRAFT, PROMPT_VERSION, REWRITE, RECALLED_BODY_CHARS, type Recalled, type Self, brief, rewrite, wantsDraft } from "../lib/brief.ts";
import { changedFields, correctionFromEdit } from "../lib/edits.ts";
import { describe, stream } from "../lib/model.ts";
import { parseQuestionBlock } from "../lib/parse.ts";
import { redactEmails } from "../lib/redact.ts";
import type { Draft } from "../lib/types.ts";

const SELF: Self = {
  handle: "tester",
  accounts: [
    { kind: "email", label: "Gmail", account: "tester@example.com" },
    { kind: "slack", label: "Slack", account: "@tester in Intern Community" },
  ],
};
const SENDS_FROM = ["Gmail", "Slack"];
const CHANNEL = "#all-intern-community";

type Case = { name: string; first: string; edit: (d: Draft) => Draft; next: string; shows: (d: Draft) => boolean };

/** Replaces a closing like "Best,\n[Your Name]" with this person's sign-off, or adds it; nothing else moves. */
const signOff = (body: string) => {
  const text = body.trimEnd();
  const cut = text.lastIndexOf("\n\n");
  const closing = cut !== -1 && /^(best|thanks|thank you|cheers|regards|kind regards|sincerely|warmly|—)/i.test(text.slice(cut).trim());
  return `${closing ? text.slice(0, cut) : text}\n\nCheers,\nMihir`;
};

const CASES: Case[] = [
  {
    name: "sign-off (end of body)",
    first: "Email a prospect a two-line intro to Intern",
    edit: (d) => ({ ...d, body: signOff(d.body) }),
    next: "Write a follow-up email to a prospect who asked about pricing",
    shows: (d) => /\bCheers\b/.test(d.body),
  },
  {
    name: "greeting (start of body)",
    first: "Email the team with Intern's features and limits",
    edit: (d) => ({ ...d, body: `Hey all —\n\n${d.body.replace(/^(hi|hello|hey|dear)\b[^\n]*\n+/i, "")}` }),
    next: "Email the team that the brain now has a community feed",
    shows: (d) => /^Hey all\b/.test(d.body.trim()),
  },
  {
    name: "subject prefix",
    first: "Email the team a reminder to review pending drafts",
    edit: (d) => ({ ...d, subject: `Intern · ${d.subject}` }),
    next: "Email the team that approvals now send from your own account",
    shows: (d) => /^Intern ·/.test(d.subject.trim()),
  },
  {
    name: "link (end of body)",
    first: "Write an email inviting a friend to try the public brain",
    edit: (d) => ({ ...d, body: `${d.body.trim()}\n\nTry it: https://intern-brain.vercel.app` }),
    next: "Email a recruiter a one-paragraph summary of Intern",
    shows: (d) => /intern-brain\.vercel\.app/.test(d.body),
  },
  {
    name: "Slack channel",
    first: "Post a Slack message thanking the team for testing",
    edit: (d) => ({ ...d, to: ["#intern-testers"] }),
    next: "Draft a Slack reminder for the testers to try the new outbox",
    shows: (d) => d.to.includes("#intern-testers"),
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const complete = async (prompt: string) => {
  let text = "";
  for await (const c of stream(prompt)) text += c.text ?? "";
  return text;
};

/** One brief as `run.go` runs it, rewrite call included. Null when no usable draft came back. */
async function draft(task: string, recalled: Recalled[]): Promise<{ kind: string; draft: Draft } | null> {
  const prompt = brief(task, recalled, SENDS_FROM, SELF, CHANNEL);
  let report = await complete(prompt);
  await sleep(6000);
  const usable = (r: string) => {
    const a = parseActionBlock(r);
    return a && !("error" in a) ? a : null;
  };
  if (!usable(report) && (parseQuestionBlock(report) || wantsDraft(task))) {
    report = await complete(rewrite(prompt, report, parseQuestionBlock(report) ? REWRITE : NO_DRAFT));
    await sleep(6000);
  }
  return usable(report);
}

/** The fact `outbox.decide` files for this edit, as `facts.recall` hands it to the next intern. */
function lesson(kind: string, proposed: Draft, accepted: Draft): Recalled {
  const c = correctionFromEdit(kind, proposed, accepted, changedFields(proposed, accepted));
  return { id: "lesson", title: redactEmails(c.title), body: redactEmails(c.body).slice(0, RECALLED_BODY_CHARS) };
}

let passed = 0;
let errored = 0;
console.log(`prompt ${PROMPT_VERSION} · ${describe()} · ${CASES.length} cases\n`);
for (const c of CASES) {
  try {
    const first = await draft(c.first, []);
    if (!first) throw new Error("first brief produced no draft");
    const learned = lesson(first.kind, first.draft, c.edit(first.draft));
    const control = await draft(c.next, []);
    const taught = await draft(c.next, [learned]);
    if (!control || !taught) throw new Error("second brief produced no draft");
    const ok = c.shows(taught.draft) && !c.shows(control.draft);
    if (ok) passed++;
    const why = !c.shows(taught.draft) ? "edit not followed" : "control already did it";
    console.log(`${ok ? "ok  " : "MISS"} ${c.name}${ok ? "" : ` · ${why}`}`);
    if (!ok) {
      const d = taught.draft;
      console.log(`     lesson: ${learned.body.replace(/\s+/g, " ").slice(-160)}`);
      console.log(`     drafted: to ${d.to.join(", ")} · ${d.subject} · ${d.body.replace(/\s+/g, " ").slice(0, 60)} … ${d.body.replace(/\s+/g, " ").slice(-60)}`);
    }
  } catch (err) {
    errored++;
    console.log(`ERR  ${c.name}\n     ${err instanceof Error ? err.message : err}`);
  }
}

const outage = errored > CASES.length / 4;
console.log(`\nedit changed the next draft in ${passed}/${CASES.length}${errored ? ` · ${errored} errored${outage ? " — more than a quarter, not a pass" : ""}` : ""}`);
process.exit(passed < CASES.length * 0.8 || outage ? 1 : 0);
