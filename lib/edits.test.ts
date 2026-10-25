import assert from "node:assert/strict";
import { test } from "node:test";
import { RECALLED_BODY_CHARS } from "./brief.ts";
import { changedFields, correctionFromEdit, correctionFromReject, editRatio, hasPlaceholder } from "./edits.ts";

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

test("an edit at the end of a long draft survives the recall cut, named where it happened", () => {
  const body = `${"Intern is a shared brain for the community. ".repeat(14)}\n\nBest,\n[Your Name]`;
  const accepted = { ...draft, body: body.replace("Best,\n[Your Name]", "Cheers,\nMihir") };
  const c = correctionFromEdit("email", { ...draft, body }, accepted, ["body"]);
  const seen = c.body.slice(0, RECALLED_BODY_CHARS);
  assert.match(seen, /BODY, at the end:/);
  assert.match(seen, /Best,\s+\[Your Name\]/);
  assert.match(seen, /Cheers,\s+Mihir/);
});

test("an edit at the start names the changed line only", () => {
  const proposed = { ...draft, body: "Hi team,\n\nIntern drafts and you approve.\n\nThanks" };
  const c = correctionFromEdit("email", proposed, { ...proposed, body: proposed.body.replace("Hi team,", "Hey all —") }, ["body"]);
  assert.match(c.body, /BODY, at the start:\nwas: Hi team,\nnow: Hey all —/);
  assert.ok(!c.body.includes("Intern drafts and you approve."));
});

test("text only added reads as an addition: a subject prefix, a line after the last one", () => {
  const proposed = { ...draft, subject: "Review your drafts", body: "Please review.\n@ann" };
  const accepted = { ...proposed, subject: "Intern · Review your drafts", body: "Please review.\n@ann\n\nTry it: https://intern-brain.vercel.app" };
  const c = correctionFromEdit("email", proposed, accepted, ["subject", "body"]);
  assert.match(c.body, /SUBJECT, at the start:\nadded: Intern ·\n/);
  assert.match(c.body, /BODY, at the end:\nadded: Try it: https:\/\/intern-brain\.vercel\.app\n/);
});

test("text only removed reads as a removal, named where it was", () => {
  const proposed = { ...draft, body: "A\nB\nC" };
  assert.match(correctionFromEdit("email", proposed, { ...proposed, body: "A\nB" }, ["body"]).body, /BODY, at the end:\nremoved: C\n/);
  assert.match(correctionFromEdit("email", proposed, { ...proposed, body: "A\nC" }, ["body"]).body, /BODY, in the middle:\nremoved: B\n/);
  const subject = { ...draft, subject: "Intern · Review your drafts" };
  assert.match(correctionFromEdit("email", subject, { ...subject, subject: "Review your drafts" }, ["subject"]).body, /SUBJECT, at the start:\nremoved: Intern ·\n/);
});

test("a one-word edit in a long paragraph is quoted with only the words around it", () => {
  const para = `${"Intern drafts and you approve every message it writes. ".repeat(4)}Reply by Friday. ${"It learns from each edit you make before approving. ".repeat(4)}`.trim();
  const c = correctionFromEdit("email", { ...draft, body: para }, { ...draft, body: para.replace("Friday", "Thursday") }, ["body"]);
  assert.ok(c.body.length < RECALLED_BODY_CHARS, `${c.body.length} chars`);
  assert.match(c.body, /was: ….*Reply by Friday\..*…\nnow: ….*Reply by Thursday\..*…/);
});

test("an added recipient, a split address, a whitespace edit", () => {
  const proposed = { ...draft, to: ["ann@acme.test"], body: "Hi Ann,\nSee you there." };
  const add = correctionFromEdit("email", proposed, { ...proposed, to: ["ann@acme.test", "bo@acme.test"] }, ["to"]);
  assert.match(add.body, /TO, at the end:\nadded: bo@acme\.test\n/);
  const split = correctionFromEdit("email", { ...proposed, to: ["ann"] }, proposed, ["to"]);
  assert.match(split.body, /was: ann\nnow: ann@acme\.test\n/);
  const spaced = correctionFromEdit("email", proposed, { ...proposed, body: "Hi Ann,\n\nSee you there." }, ["body"]);
  assert.match(spaced.body, /BODY, in the middle:\nonly whitespace changed\n/);
});

test("a lesson is searched by its topic and its change, not its fixed wording or addresses", () => {
  const proposed = { to: ["ann@acme.test"], subject: "Standup notes", body: "Notes attached.\n\nBest" };
  const c = correctionFromEdit("email", proposed, { ...proposed, body: "Notes attached.\n\nCheers, bo@corp.test" }, ["body"]);
  const words = new Set(c.search.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  assert.deepEqual([...words].sort(), ["best", "cheers", "notes", "standup"]);
  const r = correctionFromReject("email", proposed, "wrong team");
  assert.ok(!/email|drafted|intern/i.test(r.search) && r.search.includes("wrong team"));
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

test("footnotes, indexes and checkboxes aren't placeholders; a word in brackets still is", () => {
  for (const body of ["as shown [1]", "- [x] done", "- [X] done", "- [ ] todo", "arr[0] and m[12]", "[ 3 ]"]) {
    assert.equal(hasPlaceholder({ ...draft, body }), false, body);
  }
  for (const body of ["Hi [name],", "on [Q3 date]", "[sic]", "[équipe]"]) {
    assert.equal(hasPlaceholder({ ...draft, body }), true, body);
  }
});
