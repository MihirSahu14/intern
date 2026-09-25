import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFields, correctionFromEdit, editRatio, hasPlaceholder } from "./edits.ts";

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

test("a bracketed placeholder is caught in any field; a markdown link is not one", () => {
  assert.equal(hasPlaceholder({ ...draft, body: "See you on [date]." }), true);
  assert.equal(hasPlaceholder({ ...draft, to: ["[recipient email]"] }), true);
  assert.equal(hasPlaceholder({ ...draft, cc: ["[manager]"] }), true);
  assert.equal(hasPlaceholder({ ...draft, subject: "Intro to [company]" }), true);
  assert.equal(hasPlaceholder({ ...draft, body: "Docs: [the guide](https://example.com/guide)" }), false);
  assert.equal(hasPlaceholder(draft), false);
  assert.equal(hasPlaceholder({ ...draft, body: "an empty [] pair, and a [line\nbreak]" }), false);
});
