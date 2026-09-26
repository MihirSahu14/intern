import { CHUNK_MAX } from "./ingest.ts";
import { obj, same, str } from "./inbound.ts";

/**
 * The community Slack workspace, read through its own "Intern Brain" app.
 * Pure (Web Crypto only), so node tests it.
 *
 * Request signing confirmed against
 * docs.slack.dev/authentication/verifying-requests-from-slack on 2026-09-25
 * (Task 1 Step 1): `X-Slack-Signature` is `v0=` + hex HMAC-SHA256 of
 * `v0:<X-Slack-Request-Timestamp>:<raw body>`, keyed with the app's signing
 * secret; a timestamp more than five minutes off is refused.
 *
 * Events and Web API confirmed against docs.slack.dev on 2026-09-25 (Task 4
 * Step 1): /apis/events-api, /reference/events/{message.channels,
 * message/message_changed, message/message_deleted, message/bot_message,
 * reaction_added}, /reference/methods/{users.info, conversations.info},
 * /apis/web-api.
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

export const SLACK_API = "https://slack.com/api";

type Json = Record<string, unknown>;

/** Message subtypes that are a person's own words; joins, leaves, bots and channel housekeeping aren't. */
const PERSON_SUBTYPES = new Set<string | undefined>([undefined, "thread_broadcast", "file_share", "me_message"]);

export type SlackMessage = { channel: string; ts: string; user: string; text: string };

export type SlackEvent =
  | { kind: "challenge"; challenge: string }
  | ({ kind: "message"; teamId: string; eventId: string } & SlackMessage)
  | { kind: "edit"; teamId: string; eventId: string; channel: string; ts: string; text: string }
  | { kind: "delete"; teamId: string; eventId: string; channel: string; ts: string }
  | { kind: "reaction"; teamId: string; eventId: string; channel: string; ts: string; user: string; reaction: string }
  | { kind: "ignore"; teamId: string | null; eventId: string | null; type: string };

/**
 * One Events API delivery, reduced to what the brain does with it. A new
 * message counts only from a public channel (`channel_type: "channel"`) and
 * only as a person's own words. Edits and deletes pass through: they only
 * ever touch a passage already in the brain, which only a public-channel
 * message could have put there.
 */
export function readSlackEvent(json: unknown): SlackEvent {
  const j = obj(json);
  const challenge = str(j.challenge);
  if (j.type === "url_verification" && challenge) return { kind: "challenge", challenge };
  const teamId = str(j.team_id) ?? null;
  const eventId = str(j.event_id) ?? null;
  const e = obj(j.event);
  const type = str(e.type) ?? str(j.type) ?? "unknown";
  const ignore = { kind: "ignore" as const, teamId, eventId, type };
  if (j.type !== "event_callback" || !teamId || !eventId) return ignore;

  if (type === "reaction_added") {
    const item = obj(e.item);
    const channel = str(item.channel);
    const ts = str(item.ts);
    const user = str(e.user);
    const reaction = str(e.reaction);
    if (item.type !== "message" || !channel || !ts || !user || !reaction) return ignore;
    return { kind: "reaction", teamId, eventId, channel, ts, user, reaction };
  }
  if (type !== "message") return ignore;
  const channel = str(e.channel);
  if (!channel) return ignore;
  const subtype = str(e.subtype);
  if (subtype === "message_deleted") {
    const ts = str(e.deleted_ts) ?? str(obj(e.previous_message).ts);
    return ts ? { kind: "delete", teamId, eventId, channel, ts } : ignore;
  }
  if (subtype === "message_changed") {
    const m = obj(e.message);
    const ts = str(m.ts);
    const text = str(m.text);
    return ts && text && !m.bot_id ? { kind: "edit", teamId, eventId, channel, ts, text: text.slice(0, CHUNK_MAX) } : ignore;
  }
  if (e.channel_type !== "channel" || e.bot_id || !PERSON_SUBTYPES.has(subtype)) return ignore;
  const ts = str(e.ts);
  const user = str(e.user);
  const text = str(e.text);
  return ts && user && text ? { kind: "message", teamId, eventId, channel, ts, user, text: text.slice(0, CHUNK_MAX) } : ignore;
}

/** A message as `sources.write` takes it: keyed `<channel>:<ts>`, where `ts` is Slack's seconds-with-a-fraction. */
export const slackPassage = (m: SlackMessage, author: string | undefined) => ({
  externalId: `${m.channel}:${m.ts}`,
  text: m.text.slice(0, CHUNK_MAX),
  author,
  slackUser: m.user,
  at: Math.round(Number(m.ts) * 1000),
});

/** A Web API refusal: the method and Slack's error code, never a message's text. */
export class SlackError extends Error {
  retryAfterS: number | null;
  constructor(message: string, retryAfterS: number | null = null) {
    super(message);
    this.retryAfterS = retryAfterS;
  }
}

/** A stuck Web API call (the network, not a 429) can't hold the event handler open indefinitely. */
export const SLACK_API_TIMEOUT_MS = 5_000;

/** One Web API call with the bot token, as a form-encoded POST. */
export async function slackApi(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<Json> {
  const body = new URLSearchParams();
  for (const [k, val] of Object.entries(params)) if (val !== undefined) body.set(k, String(val));
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  if (res.status === 429) throw new SlackError(`${method}: rate limited`, Number(res.headers.get("retry-after")) || 30);
  const json = obj(await res.json().catch(() => null));
  if (json.ok !== true) throw new SlackError(`${method}: ${str(json.error) ?? `http ${res.status}`}`);
  return json;
}

export const readUserName = (json: Json): string | null => {
  const u = obj(json.user);
  const p = obj(u.profile);
  return str(p.display_name) ?? str(p.real_name) ?? str(u.real_name) ?? str(u.name) ?? null;
};

export const readChannelName = (json: Json): string | null => str(obj(json.channel).name) ?? null;
