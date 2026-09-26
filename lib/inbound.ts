import { MAX_FACT_CHARS } from "./caps.ts";

/**
 * Inbound: members add to the brain from their own tools. Every trigger slug,
 * tool slug, payload field and the signature scheme Composio owns lives here.
 * Pure (Web Crypto only), so node tests it with payloads in the documented shape.
 *
 * Confirmed against docs.composio.dev on 2026-09-21 (Task 7 Step 1):
 *   /toolkits/slack.md → Triggers: SLACK_MESSAGE_REACTION_ADDED (SLACK_REACTION_ADDED
 *     is marked DEPRECATED there), config `emoji_name`, payload `reaction`, `user`,
 *     `message_channel`, `message_ts`. Tools: SLACK_TEST_AUTH ("tells you who you
 *     are"), SLACK_FETCH_CONVERSATION_HISTORY (`channel`, `latest`, `inclusive`, `limit`),
 *     SLACK_RETRIEVE_CONVERSATION_INFORMATION (`channel`; "Retrieves metadata for a
 *     Slack conversation by ID … excluding message content").
 *   /toolkits/gmail.md → Triggers: GMAIL_NEW_GMAIL_MESSAGE (poll), config `query` in
 *     Gmail search syntax ("labels (label:inbox)", and it "takes precedence over
 *     labelIds"), payload `id`, `message_id`, `subject`, `message_text`.
 *   /docs/setting-up-triggers/subscribing-to-events.md → the V3 envelope (`id`,
 *     `metadata.user_id`, `metadata.connected_account_id`, `metadata.trigger_slug`,
 *     `data`) and the signature: headers `webhook-id` / `webhook-timestamp` /
 *     `webhook-signature`, HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` keyed
 *     with the secret's raw text, base64, `v1,` prefix, 300 s tolerance.
 *   @composio/core 0.19.0's `verifyWebhookSignature` / `validateWebhookTimestamp`
 *     (the SDK those docs defer to): the timestamp is Unix seconds, and the header
 *     may carry several space-separated `v1,<sig>` entries; only `v1` counts.
 * Composio documents the Slack tools' output only as `data`; the field names
 * read below are Slack's own auth.test / conversations.history /
 * conversations.info responses
 * (docs.slack.dev/reference/methods/{auth.test,conversations.history,conversations.info}).
 * Where that shape decides privacy (`isPublicChannel`), anything else reads as private.
 */

export const BRAIN_REACTION = "brain";

export const TRIGGERS = {
  // Composio filters on the emoji too, so other reactions never leave Composio.
  slack: { slug: "SLACK_MESSAGE_REACTION_ADDED", config: { emoji_name: BRAIN_REACTION } as Record<string, unknown> },
  gmail: { slug: "GMAIL_NEW_GMAIL_MESSAGE", config: { query: "label:Intern" } as Record<string, unknown> },
};

export const SLACK_TOOLS = {
  whoami: "SLACK_TEST_AUTH",
  history: "SLACK_FETCH_CONVERSATION_HISTORY",
  info: "SLACK_RETRIEVE_CONVERSATION_INFORMATION",
};

export const GMAIL_TOOLS = {
  /** Who connected: Gmail's users.getProfile, called with `{ user_id: "me" }`. */
  profile: "GMAIL_GET_PROFILE",
};

type Json = Record<string, unknown>;
export const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
export const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// --- signature -------------------------------------------------------------

const enc = new TextEncoder();
export const TOLERANCE_S = 300;

/** base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)). */
export async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time for equal lengths; the length itself isn't secret. */
export const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** False on anything short of a fresh `v1` signature by `secret`, including no secret at all. */
export async function verifyWebhook(
  secret: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_S) return false;
  const expected = await sign(secret, h.id, h.timestamp, body);
  return h.signature.split(" ").some((s) => s.startsWith("v1,") && same(s.slice(3), expected));
}

// --- payload ---------------------------------------------------------------

export type Envelope = { id: string | null; userId: string; accountId: string; trigger: string; data: Json };

/** The V3 envelope. No user or no account means we can't map it to a member, so it's nothing. */
export function readEnvelope(json: unknown): Envelope | null {
  const j = obj(json);
  const m = obj(j.metadata);
  const userId = str(m.user_id);
  const accountId = str(m.connected_account_id);
  const trigger = str(m.trigger_slug);
  if (!userId || !accountId || !trigger) return null;
  return { id: str(j.id) ?? null, userId, accountId, trigger, data: obj(j.data) };
}

export type Capture =
  /** `author` is who wrote the message (`message_user`); Slack omits it for app and system posts. */
  | { connector: "slack"; reaction: string; reactor: string; author: string | null; channel: string; ts: string }
  | { connector: "gmail"; messageId: string | null; subject: string; body: string };

export function toCapture(e: Envelope): Capture | null {
  const d = e.data;
  if (e.trigger === TRIGGERS.slack.slug) {
    const reaction = str(d.reaction);
    const reactor = str(d.user);
    const channel = str(d.message_channel);
    const ts = str(d.message_ts);
    if (!reaction || !reactor || !channel || !ts) return null;
    return { connector: "slack", reaction, reactor, author: str(d.message_user) ?? null, channel, ts };
  }
  if (e.trigger === TRIGGERS.gmail.slug) {
    const subject = str(d.subject) ?? "";
    const body = str(d.message_text) ?? "";
    if (!subject && !body) return null;
    return { connector: "gmail", messageId: str(d.message_id) ?? str(d.id) ?? null, subject, body };
  }
  return null;
}

// --- facts -----------------------------------------------------------------

export function slackFact(text: string): { title: string; body: string } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const title = lines[0].slice(0, 200);
  return { title, body: lines.slice(1).join("\n").slice(0, MAX_FACT_CHARS - title.length) };
}

export function gmailFact(c: { subject: string; body: string }): { title: string; body: string } | null {
  const body = c.body.trim();
  const title = (c.subject.trim() || body.split("\n")[0] || "").slice(0, 200);
  if (!title) return null;
  return { title, body: body.slice(0, MAX_FACT_CHARS - title.length) };
}

// --- slack tool calls ------------------------------------------------------

/** The newest main-timeline message at or before `ts`: the reacted one, if it's still there. */
export const slackHistoryArgs = (channel: string, ts: string): Json => ({ channel, latest: ts, inclusive: true, limit: 1 });

/** The reacted message's text, only if the reply is that very message (not an older one, nor a thread's parent). */
export function readHistoryText(data: Json, ts: string): string | null {
  const first = Array.isArray(data.messages) ? obj(data.messages[0]) : {};
  return first.ts === ts ? (str(first.text) ?? null) : null;
}

/**
 * Whether a captured message may go public before asking Slack about the
 * channel: the member wrote it, and it isn't in a DM (`D…`) or a legacy
 * private channel / group DM (`G…`). Otherwise it's saved owner-only.
 */
export const mayBePublic = (c: { channel: string; author: string | null }, member: string) =>
  c.author === member && !/^[DG]/.test(c.channel);

export const slackInfoArgs = (channel: string): Json => ({ channel });

/** conversations.info confirms a public channel: all three flags present and false. Anything else is private. */
export function isPublicChannel(data: Json): boolean {
  const c = obj(data.channel);
  return c.is_private === false && c.is_im === false && c.is_mpim === false;
}

/** Slack's auth.test: who connected, and in which workspace (`team_id`, `T…`). */
export function readWhoami(data: Json): { userId: string | null; teamId: string | null; label: string | null } {
  const user = str(data.user);
  const team = str(data.team);
  return { userId: str(data.user_id) ?? null, teamId: str(data.team_id) ?? null, label: user && team ? `@${user} in ${team}` : null };
}

/**
 * Gmail's users.getProfile: the connected address. `execute` hands over
 * Composio's `data`, which some toolkits wrap once more in `response_data`
 * (or `data`), so one level down is read too. Anything else is null.
 */
export function readGmailProfile(data: Json): string | null {
  for (const d of [data, obj(data.response_data), obj(data.data)]) {
    const email = str(d.emailAddress) ?? str(d.email);
    if (email) return email;
  }
  return null;
}
