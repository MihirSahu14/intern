import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.match(text, /Use real recipients only if the task names them; never invent an address\./);
  assert.ok(!text.includes("public sandbox"));
});

test("with nothing connected the sandbox rule stays", () => {
  assert.match(brief("x", [], []), /public sandbox/);
  assert.ok(!brief("x", []).includes("go out for real"));
});

test("the task outranks the brain, and confirming intent is never a question", () => {
  const text = brief("x", []);
  assert.match(text, /The TASK outranks the brain/);
  assert.match(text, /Never ask to confirm intent, tone, wording, length or who sends it/);
});

test("resumed answers stay one flat list under the original ask", () => {
  const once = resumeTask("Post in #general: hi", "Which channel?", " #all-intern ");
  assert.equal(once, "Post in #general: hi\n\nANSWERS YOU WERE GIVEN (settled, do not ask again):\n- Which channel? → #all-intern");
  const twice = resumeTask(once, "Which account?", "mine");
  assert.equal(twice, `${once}\n- Which account? → mine`);
  assert.equal(twice.match(/ANSWERS YOU WERE GIVEN/g)?.length, 1);
  assert.ok(!twice.includes("Original task"));
});
