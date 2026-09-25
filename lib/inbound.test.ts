import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  TRIGGERS,
  gmailFact,
  isPublicChannel,
  mayBePublic,
  readEnvelope,
  readHistoryText,
  readWhoami,
  slackFact,
  toCapture,
  verifyWebhook,
} from "./inbound.ts";

const SECRET = "test-secret";
/** Independent of lib/inbound.ts's own signer, so the scheme is checked, not echoed. */
const nodeSign = (id: string, ts: string, body: string) => createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64");
const now = Date.UTC(2026, 8, 21, 12);
const ts = String(Math.floor(now / 1000));

// The V3 envelope from docs.composio.dev/docs/setting-up-triggers/subscribing-to-events.md
// (#webhook-payload-shape), `data` shaped by each trigger's payload table on
// docs.composio.dev/toolkits/{slack,gmail}.md.
const SLACK_EVENT = {
  id: "msg_abc123",
  type: "composio.trigger.message",
  metadata: {
    log_id: "log_abc123",
    trigger_slug: TRIGGERS.slack.slug,
    trigger_id: "ti_xyz789",
    connected_account_id: "ca_1",
    auth_config_id: "ac_xyz789",
    user_id: "u1",
  },
  data: {
    event_ts: "1726900001.000200",
    message_channel: "C1",
    message_ts: "1726900000.000100",
    message_user: "U777",
    reaction: "brain",
    team_id: "T1",
    user: "U123",
  },
  timestamp: "2026-09-21T12:00:00Z",
};
const GMAIL_EVENT = {
  id: "msg_def456",
  type: "composio.trigger.message",
  metadata: { ...SLACK_EVENT.metadata, trigger_slug: TRIGGERS.gmail.slug, connected_account_id: "ca_2" },
  data: {
    id: "18f0a1b2c3d4e5f6",
    message_id: "18f0a1b2c3d4e5f6",
    label_ids: ["Label_7", "INBOX"],
    sender: "ann@acme.com",
    subject: "Pricing decision",
    message_text: "We charge per seat.",
    thread_id: "18f0a1b2c3d4e5f6",
  },
  timestamp: "2026-09-21T12:00:00Z",
};

test("a correctly signed, fresh webhook verifies", async () => {
  const body = JSON.stringify(SLACK_EVENT);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,${nodeSign("msg_1", ts, body)}` }, body, now), true);
  // Several space-separated signatures, as Composio's SDK accepts during a secret rotation.
  assert.equal(
    await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,old v1,${nodeSign("msg_1", ts, body)}` }, body, now),
    true,
  );
});

test("a wrong secret, an edited body, a stale timestamp, a missing header or no v1 prefix fails", async () => {
  const body = JSON.stringify(SLACK_EVENT);
  const raw = nodeSign("msg_1", ts, body);
  const sig = `v1,${raw}`;
  assert.equal(await verifyWebhook("other", { id: "msg_1", timestamp: ts, signature: sig }, body, now), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, `${body} `, now), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, body, now + 10 * 60_000), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, body, now - 10 * 60_000), false);
  assert.equal(await verifyWebhook(SECRET, { id: null, timestamp: ts, signature: sig }, body, now), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: "soon", signature: sig }, body, now), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: raw }, body, now), false);
  assert.equal(await verifyWebhook("", { id: "msg_1", timestamp: ts, signature: sig }, body, now), false);
});

test("slack: a reaction maps to who reacted with what, on which message", () => {
  const e = readEnvelope(SLACK_EVENT);
  assert.deepEqual(e && { userId: e.userId, accountId: e.accountId, id: e.id }, { userId: "u1", accountId: "ca_1", id: "msg_abc123" });
  assert.deepEqual(e && toCapture(e), {
    connector: "slack",
    reaction: "brain",
    reactor: "U123",
    author: "U777",
    channel: "C1",
    ts: "1726900000.000100",
  });
});

test("gmail: a labelled message maps to its id, subject and body", () => {
  const e = readEnvelope(GMAIL_EVENT);
  assert.deepEqual(e && toCapture(e), {
    connector: "gmail",
    messageId: "18f0a1b2c3d4e5f6",
    subject: "Pricing decision",
    body: "We charge per seat.",
  });
});

test("an unknown trigger, or a payload with no user or no account, is ignored", () => {
  assert.equal(readEnvelope({ data: {} }), null);
  assert.equal(readEnvelope({ ...SLACK_EVENT, metadata: { ...SLACK_EVENT.metadata, connected_account_id: undefined } }), null);
  const e = readEnvelope({ ...SLACK_EVENT, metadata: { ...SLACK_EVENT.metadata, trigger_slug: "SOMETHING_ELSE" } });
  assert.equal(e && toCapture(e), null);
});

test("facts from captures: the first line or the subject is the title", () => {
  assert.deepEqual(slackFact("\nWe ship on Fridays\nbecause QA is Thursday"), { title: "We ship on Fridays", body: "because QA is Thursday" });
  assert.equal(slackFact("   "), null);
  assert.deepEqual(gmailFact({ subject: "Pricing decision", body: "We charge per seat." }), {
    title: "Pricing decision",
    body: "We charge per seat.",
  });
  assert.deepEqual(gmailFact({ subject: "", body: "Seat pricing\nmore" }), { title: "Seat pricing", body: "Seat pricing\nmore" });
  assert.equal(gmailFact({ subject: " ", body: "" }), null);
  const long = gmailFact({ subject: "s", body: "x".repeat(5000) });
  assert.ok(long && long.title.length + long.body.length <= 1000);
});

test("slack tool replies: the reacted message's own text, and the member's own id", () => {
  assert.equal(readHistoryText({ messages: [{ text: "hello", ts: "1.2" }] }, "1.2"), "hello");
  // `latest` + `inclusive` returns the newest message at or before ts: if the
  // reacted one is gone (deleted, or a thread reply), that's someone else's.
  assert.equal(readHistoryText({ messages: [{ text: "older", ts: "1.1" }] }, "1.2"), null);
  assert.equal(readHistoryText({}, "1.2"), null);
  assert.deepEqual(readWhoami({ ok: true, user_id: "U123", user: "ann", team: "acme", team_id: "T9" }), {
    userId: "U123",
    teamId: "T9",
    label: "@ann in acme",
  });
  assert.deepEqual(readWhoami({}), { userId: null, teamId: null, label: null });
});

test("slack: public only for the member's own message in a channel confirmed public", () => {
  const info = (c: Record<string, unknown>) => ({ ok: true, channel: { id: "C1", ...c } });
  const open = info({ is_private: false, is_im: false, is_mpim: false });
  assert.equal(isPublicChannel(open), true);
  assert.equal(isPublicChannel(info({ is_private: true, is_im: false, is_mpim: false })), false);
  assert.equal(isPublicChannel(info({ is_private: false, is_im: false, is_mpim: true })), false);
  // A flag missing, or the reply shaped some other way, is not a confirmation.
  assert.equal(isPublicChannel(info({ is_private: false, is_im: false })), false);
  assert.equal(isPublicChannel({ is_private: false, is_im: false, is_mpim: false }), false);
  assert.equal(mayBePublic({ channel: "C1", author: "U123" }, "U123"), true);
  assert.equal(mayBePublic({ channel: "D1", author: "U123" }, "U123"), false);
  assert.equal(mayBePublic({ channel: "G1", author: "U123" }, "U123"), false);
  assert.equal(mayBePublic({ channel: "C1", author: "U777" }, "U123"), false);
  assert.equal(mayBePublic({ channel: "C1", author: null }, "U123"), false);
});
