import assert from "node:assert/strict";
import { test } from "node:test";

import { collapseBlocks, stripCites } from "./log-view.ts";
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

// A report shaped like lib/brief.ts asks for, fed through convex/run.ts's own
// flush rule: `pending` goes out (trimmed) once it ends in "." or "\n" or
// passes 160 characters. Chunk size decides where the LogLine boundaries fall.
const REPORT = `Ann asked for the launch date to go out to the partner list. The date is settled in the brain, so I drafted the email.

\`\`\`fact
{"title":"Launch moved to March 3","body":"Ann confirmed it in the planning thread.","kind":"decision"}
\`\`\`

\`\`\`action
{"kind":"email","to":["ann@acme.com"],"subject":"Launch date: March 3",
 "body":"Hi Ann,\\n\\nThe launch is on March 3. I'll share the plan by Friday.\\n\\nThanks.",
 "rationale":"the partner list needs the new date","sources":["[f1]"]}
\`\`\`
`;

function streamed(report: string, size: number): LogLine[] {
  const out: LogLine[] = [];
  let pending = "";
  for (let i = 0; i < report.length; i += size) {
    pending += report.slice(i, i + size);
    if (pending.length > 160 || /[.\n]$/.test(pending)) {
      if (pending.trim()) out.push(line(pending.trim()));
      pending = "";
    }
  }
  if (pending.trim()) out.push(line(pending.trim()));
  return out;
}

test("a streamed report collapses at any chunk size run.ts might flush at", () => {
  for (const size of [1, 4, 17, 40, 90, 400]) {
    const texts = collapseBlocks(streamed(REPORT, size)).map((l) => l.text);
    assert.ok(texts.includes("noted: Launch moved to March 3"), `size ${size}: ${JSON.stringify(texts)}`);
    assert.ok(texts.includes("drafted email → ann@acme.com"), `size ${size}: ${JSON.stringify(texts)}`);
    assert.ok(!texts.some((t) => t.includes("```")), `size ${size}: ${JSON.stringify(texts)}`);
    assert.ok(texts[0].startsWith("Ann asked for the launch date"), `size ${size}`);
  }
});

test("a fence that never closes ends at the intern's next non-output line", () => {
  const cut = REPORT.slice(0, REPORT.lastIndexOf("```"));
  for (const size of [1, 4, 17, 40, 90, 400]) {
    const done = line("finished in 12s", "ok");
    const texts = collapseBlocks([...streamed(cut, size), done]).map((l) => l.text);
    assert.ok(texts.includes("noted: Launch moved to March 3"), `size ${size}: ${JSON.stringify(texts)}`);
    assert.deepEqual(texts.slice(-2), ["(structured output)", "finished in 12s"], `size ${size}`);
    assert.ok(!texts.some((t) => t.includes("```")), `size ${size}`);
  }
});

test("inline fact-id citations are dropped, ordinary brackets kept", () => {
  assert.equal(
    stripCites("send hi to #all-intern-community [k97cqmxm3y4dykfba1x47t8n018f2h4e]. I have access [k971x6rpvpmeht5k8fvzfj83d18f2sfw], so"),
    "send hi to #all-intern-community. I have access, so",
  );
  assert.equal(stripCites("as agreed [k97cqmxm3y4dykfba1x47t8n018f2h4e, k97ag0gs7r1jp2sc2fxdavndrn8f2ma1]."), "as agreed.");
  assert.equal(stripCites("see [note] and [a1]"), "see [note] and [a1]");
});
