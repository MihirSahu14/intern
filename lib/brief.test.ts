import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFS_PER_DAY } from "./caps.ts";
import { CONNECTORS } from "./connectors.ts";
import { PROMPT_VERSION, brief, resumeTask } from "./brief.ts";

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
  assert.match(text, /Never ask anything else: not intent, scope, tone, wording, length, examples or\nwho sends it\./);
});

test("a fresh brief offers the question block, only for the recipient of a real send", () => {
  const text = brief("x", []);
  assert.ok(text.includes("```question"));
  assert.match(text, /The ONLY thing you may ask is who a real send goes to/);
  assert.match(text, /At most one question per brief\./);
  assert.ok(!text.includes("already asked your one question"));
});

test("a resumed brief has no question block and says to draft now", () => {
  const text = brief("x", [], [], undefined, true);
  assert.ok(!text.includes("```question"));
  assert.ok(!text.includes("The ONLY thing you may ask"));
  assert.match(text, /You already asked your one question\. Do not ask another: draft now, using\n\[placeholders\] for anything still missing\./);
  // The placeholder rule and the settled answers still hold.
  assert.match(text, /A missing detail is not a question\./);
  assert.match(text, /ANSWERS YOU WERE GIVEN is settled/);
});

test("YOU WORK FOR resolves me, with only the parts that exist", () => {
  const gmail = { label: "Gmail", account: "ann@acme.com" };
  const slack = { label: "Slack", account: "@ann in Intern Community" };
  assert.ok(
    brief("x", [], [], { handle: "ann", accounts: [gmail, slack] }).includes(
      'YOU WORK FOR: @ann. "Me", "myself" and "my" in the task mean them — their email is ann@acme.com; on Slack they are @ann in Intern Community.',
    ),
  );
  assert.ok(brief("x", [], [], { handle: "ann", accounts: [] }).includes('YOU WORK FOR: @ann. "Me", "myself" and "my" in the task mean them. '));
  const slackOnly = brief("x", [], [], { handle: "ann", accounts: [slack] });
  assert.match(slackOnly, /mean them — on Slack they are @ann in Intern Community\./);
  assert.ok(!slackOnly.includes("their email"));
  assert.ok(!brief("x", []).includes("YOU WORK FOR:"));
  assert.ok(!brief("x", [], [], { accounts: [] }).includes("YOU WORK FOR:"));
});

test("every brief, fresh or resumed, knows what Intern is, from the code's own connectors and cap", () => {
  for (const text of [brief("x", []), brief("x", [], ["Gmail"], undefined, true)]) {
    const about = text.slice(text.indexOf("WHAT INTERN IS AND WHAT YOU CAN DO (true; use it whenever the task is about Intern itself):"));
    assert.ok(about.length < text.length);
    for (const c of CONNECTORS) assert.ok(about.includes(c.label), c.label);
    assert.ok(about.includes(`${BRIEFS_PER_DAY} briefs a day per member`));
    assert.match(about, /Nothing goes out until the member approves it in the outbox/);
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
