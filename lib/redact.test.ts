import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEmails } from "./redact.ts";

test("addresses become [email] and everything else stays", () => {
  assert.equal(redactEmails("Email ann.lee+x@acme.co.uk about pricing"), "Email [email] about pricing");
  assert.equal(redactEmails("a@b.io, c@d.com"), "[email], [email]");
  assert.equal(redactEmails("ping @mihir in #general"), "ping @mihir in #general");
});
