import assert from "node:assert/strict";
import { test } from "node:test";
import { recipientsInBrief } from "./recipients.ts";

const brief = "Email oksir1410@gmail.com a two-line intro to Intern.";

test("a recipient the member typed, exactly, is in the brief", () => {
  assert.equal(recipientsInBrief(["oksir1410@gmail.com"], brief), true);
});

test("a case difference still matches", () => {
  assert.equal(recipientsInBrief(["OKSir1410@Gmail.com"], brief), true);
});

test("one of two recipients missing from the brief fails the whole check", () => {
  assert.equal(recipientsInBrief(["oksir1410@gmail.com", "bob@acme.com"], brief), false);
});

test("a placeholder the member never typed is not in the brief", () => {
  assert.equal(recipientsInBrief(["#general"], "post a Slack update about the launch"), false);
});

test("an address only as a substring of a longer token doesn't match", () => {
  assert.equal(recipientsInBrief(["bob@x.com"], "cc jimbob@x.com on this"), false);
});
