import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFields, correctionFromEdit, editRatio } from "./edits.ts";

const draft = { to: ["#general"], subject: "", body: "Hello team, meet Intern." };

test("an untouched draft has no changes and ratio 0", () => {
  assert.deepEqual(changedFields(draft, { ...draft }), []);
  assert.equal(editRatio(draft, { ...draft }), 0);
});

test("whitespace-only edits don't count", () => {
  assert.deepEqual(changedFields(draft, { ...draft, body: `  ${draft.body}\n` }), []);
});

test("a body rewrite is detected and sized", () => {
  const accepted = { ...draft, body: "Hi all, meet Intern." };
  assert.deepEqual(changedFields(draft, accepted), ["body"]);
  const r = editRatio(draft, accepted);
  assert.ok(r > 0 && r < 1, `ratio ${r}`);
});

test("a full rewrite is ratio 1", () => {
  assert.equal(editRatio({ to: ["a"], subject: "", body: "xxxx" }, { to: ["a"], subject: "", body: "yyyy" }), 1);
});

test("the correction quotes both versions", () => {
  const accepted = { ...draft, body: "Hi all, meet Intern." };
  const c = correctionFromEdit("slack", draft, accepted, ["body"]);
  assert.match(c.title, /slack: body rewritten/);
  assert.ok(c.body.includes(draft.body) && c.body.includes(accepted.body));
});
