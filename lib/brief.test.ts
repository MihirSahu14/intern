import assert from "node:assert/strict";
import { test } from "node:test";
import { PROMPT_VERSION, brief } from "./brief.ts";

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
