import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFS_PER_DAY } from "./caps.ts";
import { CONNECTORS } from "./connectors.ts";
import { NO_DRAFT, PROMPT_VERSION, REWRITE, type Self, brief, resumeTask, rewrite, wantsDraft } from "./brief.ts";

const ME: Self = {
  handle: "ann",
  accounts: [
    { kind: "email", label: "Gmail", account: "ann@acme.com" },
    { kind: "slack", label: "Slack", account: "@ann in Intern Community" },
  ],
};

test("the brief carries the task, the recalled facts, and the sandbox rule", () => {
  const text = brief("Draft a hello", [{ id: "f1", title: "Tone", body: "Be brief" }]);
  assert.ok(text.includes("TASK: Draft a hello"));
  assert.ok(text.includes("[f1] Tone"));
  assert.match(text, /public sandbox/);
});

test("no recalled facts means no memory section", () => {
  assert.ok(!brief("x", []).includes("WHAT THE BRAIN ALREADY KNOWS"));
});

test("prompt version is a stable short hash", () => {
  assert.match(PROMPT_VERSION, /^[0-9a-z]{4,8}$/);
});

test("a connected member's intern is told drafts go out for real", () => {
  const text = brief("Email Ann", [], ["Gmail", "Slack"]);
  assert.match(text, /Drafts go out for real from Gmail and Slack once the person approves/);
  assert.match(text, /The sender is settled; never ask about it\./);
  assert.match(text, /Use real recipients only if the task names them or YOU WORK FOR resolves them; never invent an address\./);
  assert.ok(!text.includes("public sandbox"));
});

test("with nothing connected the sandbox rule stays", () => {
  assert.match(brief("x", [], []), /public sandbox/);
  assert.ok(!brief("x", []).includes("go out for real"));
});

test("the task outranks the brain, and a missing detail is a placeholder, not a question", () => {
  const text = brief("x", []);
  assert.match(text, /The TASK outranks the brain/);
  assert.match(text, /Do not invent people, systems, dates or numbers\./);
  assert.match(text, /A missing detail is not a question\./);
  assert.match(text, /\[bracketed placeholder\]/);
});

test("no brief, sandbox or live, offers a question block: asking becomes a placeholder", () => {
  for (const text of [brief("x", []), brief("x", [], ["Gmail", "Slack"], ME, "#all-intern-community"), brief("x", [], ["Gmail"])]) {
    assert.ok(!text.includes("```question"));
    assert.match(text, /You can't ask questions\. Anything you'd need to ask becomes a \[placeholder\] in\nthe draft, which the person fills in before approving\./);
    assert.match(text, /When in doubt, draft\.$/);
  }
});

test("live, an unnamed recipient is the default channel or [recipient], never a stall", () => {
  const text = brief("x", [], ["Gmail", "Slack"], ME, "#all-intern-community");
  assert.match(text, /A Slack post with no channel goes to #all-intern-community\./);
  assert.match(text, /"to":\["\[recipient\]"\]; the member fills it\nin before it can send\./);
  // No community channel configured: no line naming one.
  assert.ok(!brief("x", [], ["Slack"], ME).includes("A Slack post with no channel goes to"));
  // The sandbox has its own placeholder recipients.
  assert.ok(!brief("x", []).includes("[recipient]"));
});

test("an outbound task wants a draft; a question about Intern doesn't", () => {
  for (const task of [
    "Email a prospect a two-line intro to Intern",
    "Write an email declining a meeting politely",
    "Write a follow-up email to someone who asked what Intern does",
    "Email me a summary of what Intern can do",
    "Post in #general: hi",
    "DM Ann the link",
  ]) {
    assert.equal(wantsDraft(task), true, task);
  }
  for (const task of [
    "What can Intern do?",
    "Summarise what Intern is in three sentences",
    "List two risks the brain has not solved yet",
    "What makes a prospect viable for Intern?",
    "Who is the poster child for Intern?",
  ]) {
    assert.equal(wantsDraft(task), false, task);
  }
});

test("the rewrite a run sends after a reply that missed carries the prompt, the reply and the instruction", () => {
  assert.equal(rewrite("P", "R"), `P\n\nYOUR FIRST ANSWER:\nR\n\n${REWRITE}`);
  assert.equal(rewrite("P", "R", NO_DRAFT), `P\n\nYOUR FIRST ANSWER:\nR\n\n${NO_DRAFT}`);
  assert.equal(
    NO_DRAFT,
    'The task asks for something to go out, but your reply has no ```action block. Rewrite it as one draft now, using [placeholders] (including "to":["[recipient]"]) for anything unknown.',
  );
  assert.match(REWRITE, /^Asking isn't available\. Rewrite your answer now: draft it, using \[placeholders\] for anything you would have asked\.$/);
});

test("YOU WORK FOR resolves me, with only the parts that exist, keyed on the connector's kind", () => {
  const slack = { kind: "slack" as const, label: "Slack", account: "@ann in Intern Community" };
  assert.ok(
    brief("x", [], [], ME).includes(
      'YOU WORK FOR: @ann. "Me", "myself" and "my" in the task mean them — their email is ann@acme.com; on Slack they are @ann in Intern Community. Never put their email or Slack account in a fact.',
    ),
  );
  assert.ok(brief("x", [], [], { handle: "ann", accounts: [] }).includes('YOU WORK FOR: @ann. "Me", "myself" and "my" in the task mean them. '));
  const slackOnly = brief("x", [], [], { handle: "ann", accounts: [slack] });
  assert.match(slackOnly, /mean them — on Slack they are @ann in Intern Community\./);
  assert.ok(!slackOnly.includes("their email is"));
  // The kind decides the phrasing, not the label.
  assert.match(brief("x", [], [], { handle: "ann", accounts: [{ kind: "email", label: "Mail", account: "a@b.co" }] }), /their email is a@b\.co/);
  assert.ok(!brief("x", []).includes("YOU WORK FOR:"));
  assert.ok(!brief("x", [], [], { accounts: [] }).includes("YOU WORK FOR:"));
});

test("every brief, sandbox or live, knows what Intern is, from the code's own connectors and cap", () => {
  for (const text of [brief("x", []), brief("x", [], ["Gmail"])]) {
    const at = text.indexOf("WHAT INTERN IS AND WHAT YOU CAN DO (true; use it whenever the task is about Intern itself):");
    assert.ok(at >= 0);
    const about = text.slice(at);
    for (const c of CONNECTORS) assert.ok(about.includes(c.label), c.label);
    assert.ok(about.includes(`${BRIEFS_PER_DAY} briefs a day per member`));
    assert.match(about, /Nothing goes out until the member approves it in the outbox/);
    assert.match(about, /Briefs and most facts are public/);
  }
});

test("resumed answers stay one flat list under the original ask", () => {
  const once = resumeTask("Post in #general: hi", "Which channel?", " #all-intern ");
  assert.equal(once, "Post in #general: hi\n\nANSWERS YOU WERE GIVEN (settled, do not ask again):\n- Which channel? → #all-intern");
  const twice = resumeTask(once, "Which account?", "mine");
  assert.equal(twice, `${once}\n- Which account? → mine`);
  assert.equal(twice.match(/ANSWERS YOU WERE GIVEN/g)?.length, 1);
  assert.ok(!twice.includes("Original task"));
});

test("archive passages are listed with their citation id, source, author and date, cut to 400 characters", () => {
  const text = brief("Post about Friday", [], [], undefined, undefined, [
    { id: "p1", label: "#general", author: "@ann", at: Date.UTC(2026, 8, 18), text: `We ship\non Fridays ${"x".repeat(500)}` },
    { id: "p2", label: "Handbook", author: null, at: Date.UTC(2026, 8, 1), text: "QA is Thursday" },
  ]);
  assert.ok(
    text.includes(
      `- [p:p1] #general · @ann · 2026-09-18: We ship on Fridays ${"x".repeat(381)}\n- [p:p2] Handbook · 2026-09-01: QA is Thursday\n`,
    ),
  );
});

test("passage ids, like fact ids, go in sources only, never in prose", () => {
  const text = brief("x", [], ["Slack"], ME, "#all-intern-community", [{ id: "p1", label: "#general", author: null, at: 0, text: "hi" }]);
  assert.match(
    text,
    /FROM THE ARCHIVE, what the community said in Slack, documents and GitHub \(evidence, not settled facts; cite the \[p:id\]s you use in "sources" only, never in your report prose\):/,
  );
  // The one action example names both kinds of id, archive or not.
  for (const t of [text, brief("x", [])]) assert.ok(t.includes(`"sources":["[id]s and [p:id]s you relied on"]`));
});

test("no archive passages means no archive section", () => {
  // ABOUT always mentions "FROM THE ARCHIVE" in prose (see the next test), so
  // this checks for the passages section's own header, not the bare phrase.
  assert.ok(!brief("x", []).includes("FROM THE ARCHIVE, what the community said"));
  assert.ok(!brief("x", [], ["Gmail"], ME, "#all-intern-community", []).includes("FROM THE ARCHIVE, what the community said"));
});

test("ABOUT says the brain also holds the archive", () => {
  for (const text of [brief("x", []), brief("x", [], ["Gmail"])]) {
    assert.ok(
      text.includes(
        "- The brain also holds a searchable archive of the community Slack's public channels, documents members share and public GitHub repos; the passages that match a task reach you as FROM THE ARCHIVE.",
      ),
    );
  }
});
