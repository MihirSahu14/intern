import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { SLACK_TOLERANCE_S, slackSignature, verifySlack } from "./slack.ts";

// The worked example on docs.slack.dev/authentication/verifying-requests-from-slack.
const DOC_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const DOC_TS = "1531420618";
const DOC_BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const DOC_SIG = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

const SECRET = "test-slack-secret";
/** Independent of lib/slack.ts's own signer, so the scheme is checked, not echoed. */
const nodeSign = (ts: string, body: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
const now = Date.UTC(2026, 8, 25, 12);
const ts = String(Math.floor(now / 1000));
const body = JSON.stringify({ type: "event_callback", event_id: "Ev1" });

test("Slack's own worked example verifies", async () => {
  assert.equal(await slackSignature(DOC_SECRET, DOC_TS, DOC_BODY), DOC_SIG);
  assert.equal(await verifySlack(DOC_SECRET, { timestamp: DOC_TS, signature: DOC_SIG }, DOC_BODY, Number(DOC_TS) * 1000), true);
});

test("a good signature passes", async () => {
  assert.equal(await verifySlack(SECRET, { timestamp: ts, signature: nodeSign(ts, body) }, body, now), true);
});

test("a bad signature fails: wrong secret, changed body, missing header, no secret", async () => {
  const sig = nodeSign(ts, body);
  assert.equal(await verifySlack("other", { timestamp: ts, signature: sig }, body, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: ts, signature: sig }, `${body} `, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: null, signature: sig }, body, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: ts, signature: null }, body, now), false);
  assert.equal(await verifySlack("", { timestamp: ts, signature: sig }, body, now), false);
});

test("a stale signature fails past five minutes", async () => {
  const at = (s: number) => String(Math.floor(now / 1000) - s);
  const stale = at(SLACK_TOLERANCE_S + 1);
  const fresh = at(SLACK_TOLERANCE_S - 1);
  assert.equal(await verifySlack(SECRET, { timestamp: stale, signature: nodeSign(stale, body) }, body, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: fresh, signature: nodeSign(fresh, body) }, body, now), true);
  assert.equal(await verifySlack(SECRET, { timestamp: "soon", signature: nodeSign("soon", body) }, body, now), false);
});
