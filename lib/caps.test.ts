import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIEFS_PER_DAY,
  FACTS_PER_DAY,
  costUsd,
  dayKey,
  dayStart,
  spawnBlocked,
  teachBlocked,
} from "./caps.ts";

test("a day is a UTC day", () => {
  const lastSecond = Date.UTC(2026, 8, 19, 23, 59, 59);
  assert.equal(dayStart(lastSecond), Date.UTC(2026, 8, 19));
  assert.equal(dayKey(lastSecond), "2026-09-19");
  assert.equal(dayKey(lastSecond + 1000), "2026-09-20");
});

test("cost is priced per million tokens", () => {
  assert.equal(costUsd(1_000_000, 0), 0.3);
  assert.equal(costUsd(0, 1_000_000), 2.5);
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
