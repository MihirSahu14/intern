import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIEFS_PER_DAY,
  FACTS_PER_DAY,
  SENDS_PER_DAY,
  SOURCES_PER_DAY,
  costUsd,
  dayKey,
  dayStart,
  isCapExempt,
  sendBlocked,
  sourceBlocked,
  spawnBlocked,
  teachBlocked,
} from "./caps.ts";

test("a day is a UTC day", () => {
  const lastSecond = Date.UTC(2026, 8, 19, 23, 59, 59);
  assert.equal(dayStart(lastSecond), Date.UTC(2026, 8, 19));
  assert.equal(dayKey(lastSecond), "2026-09-19");
  assert.equal(dayKey(lastSecond + 1000), "2026-09-20");
});

test("cost is priced per million tokens, at the default (Groq gpt-oss-20b) rate", () => {
  assert.equal(costUsd(1_000_000, 0), 0.075);
  assert.equal(costUsd(0, 1_000_000), 0.3);
});

test("costUsd takes prices as arguments for a provider other than the env default", () => {
  assert.equal(costUsd(1_000_000, 1_000_000, 1, 2), 3);
});

test("a brief under every limit goes through", () => {
  assert.equal(
    spawnBlocked({ briefsToday: BRIEFS_PER_DAY - 1, active: false, spentToday: 4.99 }),
    null,
  );
});

test("the sixth brief of the day is refused, with when it resets", () => {
  const why = spawnBlocked({ briefsToday: BRIEFS_PER_DAY, active: false, spentToday: 0 });
  assert.match(why ?? "", /5 briefs/);
  assert.match(why ?? "", /00:00 UTC/);
});

test("one intern at a time", () => {
  assert.match(spawnBlocked({ briefsToday: 0, active: true, spentToday: 0 }) ?? "", /already/);
});

test("the community budget outranks everything", () => {
  assert.match(spawnBlocked({ briefsToday: 0, active: true, spentToday: 5 }) ?? "", /budget/);
});

test("facts cap at twenty a day", () => {
  assert.equal(teachBlocked(FACTS_PER_DAY - 1), null);
  assert.match(teachBlocked(FACTS_PER_DAY) ?? "", /20 facts/);
});

test("sends cap at twenty a day", () => {
  assert.equal(SENDS_PER_DAY, 20);
  assert.equal(sendBlocked(SENDS_PER_DAY - 1), null);
  assert.match(sendBlocked(SENDS_PER_DAY) ?? "", /20 sends/);
  assert.match(sendBlocked(SENDS_PER_DAY) ?? "", /00:00 UTC/);
});

test("exempt clears the per-member checks, not the community budget", () => {
  assert.equal(spawnBlocked({ briefsToday: BRIEFS_PER_DAY, active: true, spentToday: 0, exempt: true }), null);
  assert.match(
    spawnBlocked({ briefsToday: 0, active: false, spentToday: 5, exempt: true }) ?? "",
    /budget/,
  );
  assert.equal(teachBlocked(FACTS_PER_DAY, true), null);
  assert.equal(sendBlocked(SENDS_PER_DAY, true), null);
});

test("CAP_EXEMPT_HANDLES matches case-insensitively, ignoring stray whitespace", () => {
  assert.equal(isCapExempt("Ann", " mihir , Ann ,bob"), true);
  assert.equal(isCapExempt("ANN", " mihir , Ann ,bob"), true);
  assert.equal(isCapExempt("carl", " mihir , Ann ,bob"), false);
  assert.equal(isCapExempt("mihir", undefined), false);
  assert.equal(isCapExempt(null, "mihir"), false);
});

test("sources cap at five a day, except for an exempt member", () => {
  assert.equal(SOURCES_PER_DAY, 5);
  assert.equal(sourceBlocked(SOURCES_PER_DAY - 1), null);
  assert.match(sourceBlocked(SOURCES_PER_DAY) ?? "", /5 sources/);
  assert.match(sourceBlocked(SOURCES_PER_DAY) ?? "", /00:00 UTC/);
  assert.equal(sourceBlocked(SOURCES_PER_DAY, true), null);
});
