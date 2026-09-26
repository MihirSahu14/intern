import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFS_PER_DAY } from "./caps.ts";
import { CONNECTORS } from "./connectors.ts";
import { PROMPT_VERSION, type Self, brief, resumeTask } from "./brief.ts";

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

test("the sandbox never offers the question block: it can't send, so it drafts", () => {
  const text = brief("x", []);
  assert.ok(!text.includes("```question"));
  assert.ok(!text.includes("Ask only when you cannot"));
  assert.match(text, /Here you never ask a question: every gap, the recipient included, gets a\nplaceholder\. When in doubt, draft\./);
});

test("a fresh live brief drafts even without a recipient, and asks only when nothing could be drafted", () => {
  const text = brief("x", [], ["Gmail", "Slack"], ME, false, "#all-intern-community");
  assert.match(text, /An unnamed recipient is not a question either\. A Slack post with no channel goes to #all-intern-community\./);
  assert.match(text, /"to":\["\[recipient\]"\]; the member fills it in before it can send\./);
  assert.match(text, /Ask only when you cannot write any meaningful draft at all: the task says\nnothing about what to write\./);
  assert.match(text, /When in\ndoubt, draft\./);
  assert.ok(text.includes("```question"));
  assert.match(text, /At most one\nquestion per brief\./);
  assert.ok(!text.includes("already asked your one question"));
  // No community channel configured: no line naming one.
  const noChannel = brief("x", [], ["Slack"], ME);
  assert.ok(!noChannel.includes("A Slack post with no channel goes to"));
  assert.match(noChannel, /An unnamed recipient is not a question either\.\n/);
});

test("a resumed brief has no question block and says to draft now, live or not", () => {
  for (const text of [brief("x", [], [], undefined, true), brief("x", [], ["Gmail"], ME, true)]) {
    assert.ok(!text.includes("```question"));
    assert.ok(!text.includes("Ask only when you cannot"));
    assert.match(text, /You already asked your one question\. Do not ask another: draft now, using\n\[placeholders\] for anything still missing\./);
    // The placeholder rule and the settled answers still hold.
    assert.match(text, /A missing detail is not a question\./);
    assert.match(text, /ANSWERS YOU WERE GIVEN is settled/);
  }
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

test("every brief, fresh or resumed, knows what Intern is, from the code's own connectors and cap", () => {
  for (const text of [brief("x", []), brief("x", [], ["Gmail"], undefined, true)]) {
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
