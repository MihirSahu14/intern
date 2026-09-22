/**
 * Every account a draft can go out through. One row per connector, so adding
 * one later is a row, not a module. Pure: Convex reads it, node tests it.
 *
 * Discord is deliberately absent: it forbids apps posting as a user, so it
 * only ever appears as a broadcast surface (lib/broadcast.ts).
 */

import type { ActionKind, Draft } from "./types.ts";

export type ConnectorKey = "gmail" | "slack";

export type Connector = {
  key: ConnectorKey;
  label: string;
  /** Composio toolkit slug. */
  toolkit: string;
  /** Optional env var naming a custom Composio auth config; unset means Composio-managed auth. */
  authConfigEnv: string;
  /** Composio tool slug that sends. */
  sendTool: string;
  /** Which draft kind it sends. */
  forKind: ActionKind;
  toArguments(draft: Draft): Record<string, unknown>;
};

// Tool slugs and argument names confirmed against docs.composio.dev/toolkits/{gmail,slack} on 2026-09-21 (Task 1 Step 1).
// Gmail's GMAIL_SEND_EMAIL: recipient_email, extra_recipients (array), cc (array), subject, body.
// Slack's own SLACK_SEND_MESSAGE (not the deprecated SLACK_CHAT_POST_MESSAGE, and not Slackbot's
// SLACKBOT_SEND_MESSAGE, which is a separate toolkit): channel, markdown_text.
export const CONNECTORS: Connector[] = [
  {
    key: "gmail",
    label: "Gmail",
    toolkit: "gmail",
    authConfigEnv: "COMPOSIO_AUTH_CONFIG_GMAIL",
    sendTool: "GMAIL_SEND_EMAIL",
    forKind: "email",
    toArguments: (d) => ({
      recipient_email: d.to[0],
      extra_recipients: d.to.slice(1),
      cc: d.cc ?? [],
      subject: d.subject,
      body: d.body,
    }),
  },
  {
    key: "slack",
    label: "Slack",
    toolkit: "slack",
    authConfigEnv: "COMPOSIO_AUTH_CONFIG_SLACK",
    sendTool: "SLACK_SEND_MESSAGE",
    forKind: "slack",
    toArguments: (d) => ({
      channel: d.to[0],
      markdown_text: d.subject ? `*${d.subject}*\n${d.body}` : d.body,
    }),
  },
];

export const connectorFor = (kind: ActionKind): Connector | null =>
  CONNECTORS.find((c) => c.forKind === kind) ?? null;

export function connectorByKey(key: ConnectorKey): Connector {
  const c = CONNECTORS.find((x) => x.key === key);
  if (!c) throw new Error(`unknown connector ${key}`);
  return c;
}

/**
 * The deployment has what this connector needs. Says nothing about whether *you* connected.
 * Both toolkits have Composio-managed OAuth, so no auth config is needed. The
 * verifier URL is the deployer's word that Composio's callback identity
 * verification is switched on for this project (Composio requires public
 * HTTPS). Without it Composio would activate every consent on its side while
 * ours never finishes, leaving live grants nobody deletes.
 */
export const isConfigured = (_c: Connector, env: Record<string, string | undefined>) =>
  !!env.COMPOSIO_API_KEY && !!env.COMPOSIO_VERIFIER_URL?.startsWith("https://");

/** Shown by the connect buttons: who actually holds the member's grant. */
export const COMPOSIO_DISCLOSURE = "Composio holds this connection for Intern.";

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/** The owner-only fact a successful send files: the brain updates the moment it goes out. */
export function sentFact(key: ConnectorKey, d: Draft, now: number): { title: string; body: string } {
  const date = new Date(now).toISOString().slice(0, 10);
  if (key === "gmail") {
    return { title: `emailed ${d.to.join(", ")} about ${d.subject}`.slice(0, 200), body: `${date} · ${d.body.slice(0, 280)}` };
  }
  return { title: `posted in ${d.to[0]}: ${firstLine(d.body)}`.slice(0, 200), body: date };
}
