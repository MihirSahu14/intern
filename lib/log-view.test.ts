import assert from "node:assert/strict";
import { test } from "node:test";

import { collapseBlocks } from "./log-view.ts";
import type { LogLine } from "./types.ts";

let nextId = 1;
const line = (text: string, level: LogLine["level"] = "out", internId = "i1"): LogLine => ({
  id: nextId++,
  internId,
  ownerId: "u1",
  ts: Date.now(),
  level,
  text,
});

test("an action block collapses to one line naming the kind and recipient", () => {
  const lines = [
    line("Here's what I found."),
    line("```action"),
    line('{"kind":"email","to":["a@b.co"],"subject":"Hi","body":"there"}'),
    line("```"),
  ];
  const out = collapseBlocks(lines);
  assert.equal(out.length, 2);
  assert.equal(out[0].text, "Here's what I found.");
  assert.equal(out[1].text, "drafted email → a@b.co");
});

test("a fact block collapses to its title", () => {
  const lines = [
    line("```fact"),
    line('{"title":"Ann prefers async updates","body":"said in standup","kind":"preference"}'),
    line("```"),
  ];
  const out = collapseBlocks(lines);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "noted: Ann prefers async updates");
});

test("a question block collapses to the question", () => {
  const lines = [
    line("```question"),
    line('{"question":"Which channel?","context":"drafting the update"}'),
    line("```"),
  ];
  const out = collapseBlocks(lines);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "asked: Which channel?");
});

test("a block split across several log lines still collapses", () => {
  const lines = [
    line("```action"),
    line("{"),
    line('"kind":"slack",'),
    line('"channel":"#general",'),
    line('"body":"standup notes"'),
    line("}"),
    line("```"),
  ];
  const out = collapseBlocks(lines);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "drafted slack → #general");
});

test("a block that never closes is hidden, not crashed on", () => {
  const lines = [line("Thinking it through."), line("```action"), line('{"kind":"email"')];
  const out = collapseBlocks(lines);
  assert.deepEqual(out, [lines[0]]);
});

test("an unterminated fence in one intern's stream doesn't hide another intern's later lines", () => {
  // "all" tab: lines merged across interns by time. A's fence never closes —
  // only A's own rows should be swallowed, not B's.
  const lines = [
    line("```action", "out", "A"),
    line('{"kind":"email"', "out", "A"),
    line("still working on it", "out", "B"),
    line("almost done", "out", "B"),
  ];
  const out = collapseBlocks(lines);
  assert.deepEqual(
    out.map((l) => l.text),
    ["still working on it", "almost done"],
  );
});

test("plain lines with no fence pass through untouched", () => {
  const lines = [line("recalled 2 facts from the brain", "sys"), line("Looking into it now."), line("done", "ok")];
  assert.deepEqual(collapseBlocks(lines), lines);
});

test("an unparsable block falls back to a generic label instead of vanishing", () => {
  const lines = [line("```action"), line("{not json}"), line("```")];
  const out = collapseBlocks(lines);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "(structured output)");
});
