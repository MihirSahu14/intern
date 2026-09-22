import assert from "node:assert/strict";
import { test } from "node:test";
import { BROADCASTS_PER_HOUR, broadcastText, discordBody, hourKey, slackBody } from "./broadcast.ts";

const SITE = "https://intern-brain.vercel.app";

test("each event is one public line that links to the member", () => {
  assert.equal(broadcastText({ type: "joined", handle: "ann" }, SITE), "@ann joined the brain · https://intern-brain.vercel.app/u/ann");
  assert.equal(
    broadcastText({ type: "taught", handle: "ann", title: "We ship on Fridays" }, SITE),
    "@ann taught the brain: We ship on Fridays · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "learned", handle: "ann", title: "email: body rewritten before approval" }, SITE),
    "@ann corrected a draft and the brain learned: email: body rewritten before approval · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "drafted", handle: "ann", kind: "email" }, SITE),
    "@ann's intern finished with an email draft · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "drafted", handle: "ann", kind: "slack" }, SITE),
    "@ann's intern finished with a slack draft · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(broadcastText({ type: "sent", handle: "ann", connector: "gmail" }, SITE), "@ann sent an email · https://intern-brain.vercel.app/u/ann");
  assert.equal(broadcastText({ type: "sent", handle: "ann", connector: "slack" }, SITE), "@ann posted in Slack · https://intern-brain.vercel.app/u/ann");
});

test("long titles are cut to 120 characters", () => {
  const line = broadcastText({ type: "taught", handle: "ann", title: "x".repeat(300) }, SITE);
  assert.ok(line.includes(`: ${"x".repeat(120)} · `));
});

test("Discord pings nobody; Slack's control characters are escaped", () => {
  assert.deepEqual(discordBody("@everyone hi"), { content: "@everyone hi", username: "Intern", allowed_mentions: { parse: [] } });
  assert.deepEqual(slackBody("<!channel> & co"), { text: "&lt;!channel&gt; &amp; co" });
});

test("the throttle counts per UTC hour, thirty to an hour", () => {
  assert.equal(hourKey(Date.UTC(2026, 8, 21, 14, 59)), "2026-09-21T14");
  assert.equal(hourKey(Date.UTC(2026, 8, 21, 15, 0)), "2026-09-21T15");
  assert.equal(BROADCASTS_PER_HOUR, 30);
});

test("a title's links never reach the community's channels", () => {
  assert.equal(
    broadcastText({ type: "taught", handle: "ann", title: "Free stuff at https://evil.test/x?y=1 and www.evil.test now" }, SITE),
    "@ann taught the brain: Free stuff at [link] and [link] now · https://intern-brain.vercel.app/u/ann",
  );
});
