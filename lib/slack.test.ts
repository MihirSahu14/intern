import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  SLACK_TOLERANCE_S,
  SlackError,
  readChannelName,
  readSlackEvent,
  readUserName,
  slackApi,
  slackPassage,
  slackSignature,
  verifySlack,
} from "./slack.ts";

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

// --- events ------------------------------------------------------------------

// Shapes from docs.slack.dev/apis/events-api and /reference/events/* (Task 4 Step 1).
const envelope = (event: Record<string, unknown>, team = "T1") => ({
  token: "x",
  team_id: team,
  api_app_id: "A1",
  type: "event_callback",
  event_id: "Ev1",
  event_time: 1758800000,
  event,
});
const said = { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "We ship on Fridays", ts: "1758800000.000100" };

test("url_verification is answered with its challenge", () => {
  assert.deepEqual(readSlackEvent({ token: "x", challenge: "abc", type: "url_verification" }), { kind: "challenge", challenge: "abc" });
});

test("a person's message in a public channel is a message", () => {
  assert.deepEqual(readSlackEvent(envelope(said)), {
    kind: "message",
    teamId: "T1",
    eventId: "Ev1",
    channel: "C1",
    ts: "1758800000.000100",
    user: "U1",
    text: "We ship on Fridays",
  });
  assert.equal(readSlackEvent(envelope({ ...said, subtype: "thread_broadcast" })).kind, "message");
});

test("bots, joins, leaves, private channels and DMs are ignored", () => {
  for (const e of [
    { ...said, bot_id: "B1", subtype: "bot_message" },
    { ...said, subtype: "channel_join" },
    { ...said, subtype: "channel_leave" },
    { ...said, channel_type: "group" },
    { ...said, channel_type: "im" },
    { ...said, channel_type: "mpim" },
  ]) {
    assert.equal(readSlackEvent(envelope(e)).kind, "ignore");
  }
  assert.equal(readSlackEvent({ type: "event_callback", event: said }).kind, "ignore");
});

test("edits, deletes and reactions", () => {
  assert.deepEqual(
    readSlackEvent(
      envelope({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { type: "message", user: "U1", text: "We ship on Thursdays", ts: said.ts },
        previous_message: said,
        ts: "1758800100.000200",
      }),
    ),
    { kind: "edit", teamId: "T1", eventId: "Ev1", channel: "C1", ts: said.ts, text: "We ship on Thursdays" },
  );
  assert.deepEqual(
    readSlackEvent(
      envelope({ type: "message", subtype: "message_deleted", channel: "C1", hidden: true, deleted_ts: said.ts, previous_message: said, ts: "1758800200.000300" }),
    ),
    { kind: "delete", teamId: "T1", eventId: "Ev1", channel: "C1", ts: said.ts },
  );
  assert.deepEqual(
    readSlackEvent(
      envelope({ type: "reaction_added", user: "U2", reaction: "brain", item: { type: "message", channel: "C1", ts: said.ts }, item_user: "U1", event_ts: "1758800300.000400" }),
    ),
    { kind: "reaction", teamId: "T1", eventId: "Ev1", channel: "C1", ts: said.ts, user: "U2", reaction: "brain" },
  );
  assert.equal(readSlackEvent(envelope({ type: "reaction_added", user: "U2", reaction: "brain", item: { type: "file", file: "F1" } })).kind, "ignore");
});

test("a message becomes a passage keyed by channel and ts", () => {
  assert.deepEqual(slackPassage({ channel: "C1", ts: "1758800000.000100", user: "U1", text: "hi" }, "Ann"), {
    externalId: "C1:1758800000.000100",
    text: "hi",
    author: "Ann",
    slackUser: "U1",
    at: 1758800000000,
  });
});

test("names: display name first, then real name, then the handle", () => {
  assert.equal(readUserName({ user: { name: "ann", real_name: "Ann Lee", profile: { display_name: "", real_name: "Ann L." } } }), "Ann L.");
  assert.equal(readUserName({ user: { name: "ann" } }), "ann");
  assert.equal(readUserName({}), null);
  assert.equal(readChannelName({ channel: { id: "C1", name: "general" } }), "general");
});

test("the Web API helper posts a form with the bot token and names Slack's error", async (t) => {
  const calls: [string, RequestInit | undefined][] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return Response.json({ ok: false, error: "not_in_channel" });
  });
  await assert.rejects(slackApi("xoxb-1", "conversations.history", { channel: "C1", cursor: undefined, limit: 200 }), /conversations\.history: not_in_channel/);
  assert.equal(calls[0][0], "https://slack.com/api/conversations.history");
  assert.equal(calls[0][1]?.method, "POST");
  assert.equal(new Headers(calls[0][1]?.headers).get("authorization"), "Bearer xoxb-1");
  assert.equal(String(calls[0][1]?.body), "channel=C1&limit=200");
});

test("a rate-limited call carries Slack's Retry-After", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 429, headers: { "retry-after": "7" } }));
  await assert.rejects(slackApi("xoxb-1", "users.info", { user: "U1" }), (err) => err instanceof SlackError && err.retryAfterS === 7);
});
