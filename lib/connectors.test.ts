import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTORS, connectorByKey, connectorFor, isConfigured, sentFact } from "./connectors.ts";

const draft = { to: ["ann@acme.com", "bo@acme.com"], cc: ["cy@acme.com"], subject: "Pricing", body: "Hi Ann,\nhere it is." };

test("each draft kind has at most one connector, and calendar has none", () => {
  assert.equal(connectorFor("email")?.key, "gmail");
  assert.equal(connectorFor("slack")?.key, "slack");
  assert.equal(connectorFor("calendar"), null);
  assert.equal(new Set(CONNECTORS.map((c) => c.forKind)).size, CONNECTORS.length);
});

test("gmail sends to the first recipient and the rest ride along", () => {
  assert.deepEqual(connectorByKey("gmail").toArguments(draft), {
    recipient_email: "ann@acme.com",
    extra_recipients: ["bo@acme.com"],
    cc: ["cy@acme.com"],
    subject: "Pricing",
    body: "Hi Ann,\nhere it is.",
  });
});

test("slack posts to the channel as the member and bolds a subject only when there is one", () => {
  const slack = connectorByKey("slack");
  assert.deepEqual(slack.toArguments({ to: ["#general"], subject: "", body: "ship it" }), {
    channel: "#general",
    markdown_text: "ship it",
    as_user: true,
  });
  assert.deepEqual(slack.toArguments({ to: ["#general"], subject: "Heads up", body: "ship it" }), {
    channel: "#general",
    markdown_text: "*Heads up*\nship it",
    as_user: true,
  });
});

test("a connector needs the API key and a verifier URL; auth is Composio-managed unless overridden", () => {
  const gmail = connectorByKey("gmail");
  const ready = { COMPOSIO_API_KEY: "k", COMPOSIO_VERIFIER_URL: "https://intern.test/app" };
  assert.equal(isConfigured(gmail, {}), false);
  assert.equal(isConfigured(gmail, { COMPOSIO_API_KEY: "k" }), false);
  assert.equal(isConfigured(gmail, { COMPOSIO_API_KEY: "k", COMPOSIO_VERIFIER_URL: "http://localhost:3000/app" }), false);
  assert.equal(isConfigured(gmail, ready), true);
  assert.equal(isConfigured(connectorByKey("slack"), ready), true);
});

test("the write-back fact says who, what and when", () => {
  const now = Date.UTC(2026, 8, 21, 12);
  assert.deepEqual(sentFact("gmail", draft, now), {
    title: "emailed ann@acme.com, bo@acme.com about Pricing",
    body: "2026-09-21 · Hi Ann,\nhere it is.",
  });
  assert.equal(sentFact("gmail", { ...draft, body: "x".repeat(400) }, now).body, `2026-09-21 · ${"x".repeat(280)}`);
  assert.deepEqual(sentFact("slack", { to: ["#general"], subject: "", body: "\nship it\nmore" }, now), {
    title: "posted in #general: ship it",
    body: "2026-09-21",
  });
});
