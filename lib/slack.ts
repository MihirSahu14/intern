import { same } from "./inbound.ts";

/**
 * The community Slack workspace, read through its own "Intern Brain" app.
 * Pure (Web Crypto only), so node tests it.
 *
 * Request signing confirmed against
 * docs.slack.dev/authentication/verifying-requests-from-slack on 2026-09-25
 * (Task 1 Step 1): `X-Slack-Signature` is `v0=` + hex HMAC-SHA256 of
 * `v0:<X-Slack-Request-Timestamp>:<raw body>`, keyed with the app's signing
 * secret; a timestamp more than five minutes off is refused.
 */

export const SLACK_TOLERANCE_S = 300;

const enc = new TextEncoder();

export async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** False on anything short of a fresh signature by `secret`, including no secret at all. */
export async function verifySlack(
  secret: string,
  h: { timestamp: string | null; signature: string | null },
  body: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_TOLERANCE_S) return false;
  return same(h.signature, await slackSignature(secret, h.timestamp, body));
}
