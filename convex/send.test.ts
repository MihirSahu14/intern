import { expect, test } from "vitest";
import { providerReason } from "./send.ts";

test("a reason is read from the first line", () => {
  expect(providerReason("composio 400: bad recipient (req_1)")).toBe("bad recipient");
});

test("a real prod Composio rejection: log id stripped, second line joined in", () => {
  // Slack's SLACK_SEND_MESSAGE rejecting `as_user` (prod, 2026-09-25).
  const raw = "Invalid request data provided\n- Extra inputs are not permitted on parameter `as_user` (log__KDwERiNr2u3)";
  expect(providerReason(raw)).toBe(
    "Invalid request data provided: Extra inputs are not permitted on parameter `as_user`",
  );
});

test("a message with no log id is left alone", () => {
  expect(providerReason("channel not found")).toBe("channel not found");
});

test("the cap is applied at 120 characters", () => {
  const long = "x".repeat(200);
  const reason = providerReason(long);
  expect(reason).toHaveLength(120);
  expect(reason).toBe("x".repeat(120));
});

test("no usable text means no reason", () => {
  expect(providerReason("")).toBeUndefined();
  expect(providerReason("   \n  ")).toBeUndefined();
  expect(providerReason("composio 500: ")).toBeUndefined();
});

test("an email in the reason is redacted like anywhere else", () => {
  expect(providerReason("no such user ann@acme.com")).toBe("no such user [email]");
});
