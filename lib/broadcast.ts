/**
 * The community speaking in its own channels. Public information only: who
 * did what, never a recipient, a draft or a private fact. Pure, so node tests it.
 */

export const BROADCASTS_PER_HOUR = 30;

export type BroadcastEvent =
  | { type: "joined"; handle: string }
  | { type: "taught"; handle: string; title: string }
  | { type: "learned"; handle: string; title: string }
  | { type: "drafted"; handle: string; kind: "email" | "slack" | "calendar" }
  | { type: "sent"; handle: string; connector: "gmail" | "slack" };

const cut = (s: string) => s.slice(0, 120);

export function broadcastText(e: BroadcastEvent, siteUrl: string): string {
  const what =
    e.type === "joined"
      ? " joined the brain"
      : e.type === "taught"
        ? ` taught the brain: ${cut(e.title)}`
        : e.type === "learned"
          ? ` corrected a draft and the brain learned: ${cut(e.title)}`
          : e.type === "drafted"
            ? `'s intern finished with ${e.kind === "email" ? "an email" : `a ${e.kind}`} draft`
            : e.connector === "gmail"
              ? " sent an email"
              : " posted in Slack";
  return `@${e.handle}${what} · ${siteUrl}/u/${encodeURIComponent(e.handle)}`;
}

/** Discord: posts as "Intern", and a title reading "@everyone" pings nobody. */
export const discordBody = (text: string) => ({
  content: text,
  username: "Intern" as const,
  allowed_mentions: { parse: [] as never[] },
});

/** Slack: `<` `>` `&` are its control characters, so `<!channel>` in a title stays text. */
export const slackBody = (text: string) => ({
  text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
});

export const hourKey = (now: number) => new Date(now).toISOString().slice(0, 13);
