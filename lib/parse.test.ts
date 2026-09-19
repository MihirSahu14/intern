import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFactBlocks, parseQuestionBlock } from "./parse.ts";

const fence = (tag: string, body: string) => "```" + tag + "\n" + body + "\n```";

test("fact blocks: at most three, bad JSON skipped, unknown kind becomes note", () => {
  const report = [
    fence("fact", '{"title":"A","body":"a","kind":"decision"}'),
    fence("fact", "{not json"),
    fence("fact", '{"title":"B","kind":"person"}'),
    fence("fact", '{"title":"C"}'),
    fence("fact", '{"title":"D"}'),
  ].join("\n");
  assert.deepEqual(parseFactBlocks(report), [
    { title: "A", body: "a", kind: "decision" },
    { title: "B", body: "", kind: "note" },
    { title: "C", body: "", kind: "note" },
  ]);
});

test("fact blocks without a title are dropped", () => {
  assert.deepEqual(parseFactBlocks(fence("fact", '{"body":"x"}')), []);
});

test("question block: parsed, missing, and broken", () => {
  assert.deepEqual(
    parseQuestionBlock(fence("question", '{"question":"Who?","context":"ctx"}')),
    { question: "Who?", context: "ctx" },
  );
  assert.equal(parseQuestionBlock("no block here"), null);
  assert.deepEqual(parseQuestionBlock(fence("question", "{oops")), {
    error: "question block was not valid JSON",
  });
  assert.deepEqual(parseQuestionBlock(fence("question", '{"context":"x"}')), {
    error: "question block had no question",
  });
});
