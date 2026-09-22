# Community surfaces — design

Date: 2026-09-21 · Status: approved in brainstorming ("ok, do everything")

## Frame

**Intern is the community.** The shared brain, its members and their interns live in
the app. Gmail, Slack and Discord are surfaces: places members act from, and places the
community shows itself. Four pieces, built in order, each depending on the one before:

| # | Piece | What it adds |
|---|---|---|
| 1 | Outbound | Interns send from a member's own Gmail or Slack, after approval, and the send updates the brain live |
| 2 | Broadcast | The community mirrors its public activity into Discord/Slack channels via webhooks |
| 3 | Inbound | Members add to the brain from their tools: 🧠 on a Slack message, or the `Intern` label on an email |
| 4 | Member pages | `/u/<handle>` shows what a member taught the brain and what their interns did |

Constraints carried from the public-MVP spec still hold: GitHub sign-in, consent gate,
per-user caps, $5/day model budget, every write through `requireMember`.

## Decisions (from brainstorming)

- **Composio** hosts OAuth and token storage for member accounts.
- **Private drafts, shared brain.** A draft to a real recipient is visible only to its
  owner. Others see that a draft or send happened, never the address or body.
- **Sent facts, private where they must be.** Every send files a fact. Gmail sends are
  owner-only facts; only the owner's interns recall them.
- **Discord is not an outbound connector.** Discord forbids apps posting as a user.
  Discord appears only as a broadcast surface, where the community (a bot) speaks.
- No paid services. Composio's free tier (100k tool calls/month) and Discord/Slack
  incoming webhooks are free.

## Composio facts this design relies on

Researched 2026-09-21, sources in `.superpowers/sdd/composio-research.md`:

- REST, not SDK. `@composio/core` needs Node ≥22.22.3. Composio's REST API works from
  Convex's default runtime with `fetch` (`x-api-key` header). The exact API host
  (`backend.composio.dev` vs `api.composio.dev`) and paths are verified against
  `docs.composio.dev/reference` before use and kept in one constant.
- Connect: `connected_accounts/link` (the successor to `initiate`, which was retired for
  managed OAuth on 2026-07-03) returns a `redirect_url`. After consent, Composio
  redirects to our callback with `status` and `connected_account_id`.
- Execute: `POST /api/v3.1/tools/execute/{tool_slug}` with a `user_id`.
- Gmail: managed auth exists; the consent screen reads "Composio wants to access your
  account". Whether Google lets that shared app use `gmail.send` is unresolved, so the
  auth-config id is an env var and switching to a custom OAuth app is config only.
- Slack: posting as the user needs `user_scopes` on the auth config, so Slack uses a
  custom auth config (Mihir's Slack app), not the managed default.
- A secondary source reports a Composio breach in May 2026; unconfirmed. Mihir checks
  trust.composio.dev before real users connect.

## Piece 1 — Outbound

### Registry (`lib/connectors.ts`, pure, unit-tested)

One entry per connector, so adding one later is a row, not a module:

```ts
type ConnectorKey = "gmail" | "slack";
type Connector = {
  key: ConnectorKey;
  label: string;              // "Gmail", "Slack"
  toolkit: string;            // Composio toolkit slug
  authConfigEnv: string;      // env var holding the Composio auth config id
  sendTool: string;           // Composio tool slug that sends
  forKind: ActionKind;        // which draft kind it sends: "email" → gmail, "slack" → slack
  toArguments(draft: Draft): Record<string, unknown>;  // draft → tool arguments
};
```

`connectorFor(kind)` returns the connector for a draft kind, or null. `calendar` drafts
have none and stay draft-only.

### Data

- New table `connections`: `{ userId, connector, composioAccountId?, accountLabel?,
  status: "pending" | "active" | "failed", state, createdAt }`, indexes `by_userId_and_connector`
  and `by_state`. `state` is a random nonce for the callback.
- `actions` gains: `status` adds `"sending" | "sent" | "failed"`; optional `sentAt`,
  `sendError`, `connector`.
- `facts` gains optional `visibility: "public" | "owner"` (absent = public).
- `lib/caps.ts` gains `SENDS_PER_DAY = 20`.

### Connect flow (one hop, inline)

1. Approving a draft whose connector isn't active: `outbox.decide` records the approval
   intent and returns `{ needsConnect: "gmail" }` without sending.
2. The cockpit calls `connections.start({ connector })`. It inserts a `pending` row with
   a fresh `state`, then calls Composio link with `user_id = <our userId>` and
   `callback_url = <CONVEX_SITE_URL>/composio/callback?state=<state>`, and returns the
   redirect URL. The browser goes there.
3. `GET /composio/callback` (Convex `httpAction`): look up the row by `state`. If
   `status=success`, fetch the connected account from Composio and verify its user id
   equals the row's `userId`. Only then mark `active` and store `composioAccountId`.
   Then redirect to `SITE_URL/app?connected=<connector>`. Never trust a user id from the
   query string.
4. Back in the cockpit, the draft is still pending. Approve now sends.

The rail shows each connector as `connected as <label> · disconnect`, or `connect`.
`connections.disconnect` marks the row failed and asks Composio to delete the account.
There is no settings page.

### Send flow

`outbox.decide(approve)` with an active connection:
1. Checks `SENDS_PER_DAY` for the caller.
2. Patches the action to `sending` (keeping `accepted` and the edit-learning behaviour).
3. Schedules `internal.send.go({ actionId })`.

`send.go` (action, plain `fetch`) calls Composio execute with the connector's tool and
`toArguments(accepted ?? draft)` for `user_id = ownerId`, then runs `send.finish`:
- **Success:** status `sent`, `sentAt`, a log line `Sent from your Gmail.`, and a
  write-back fact (below).
- **Failure:** status `failed`, `sendError` = Composio's message, a log line with it. The
  draft can be retried from the outbox.

When Composio isn't configured (`COMPOSIO_API_KEY` or the auth-config env missing),
connectors show `not set up yet` and approval stays sandbox. Nothing crashes.

### Write-back (the brain updates in real time)

On a successful send, `send.finish` inserts a fact in the same transaction:
- Gmail: `{ kind: "note", visibility: "owner", title: "emailed <to> about <subject>",
  body: "<date> · <first 280 chars of body>" }`
- Slack: `{ kind: "note", visibility: "owner", title: "posted in <channel>: <first line>" }`

Both are owner-only: they're your accounts. The public trace of a send is the action's
`sent` status, shown redacted in the feed and graph.

### Privacy enforcement

- `outbox.list`: owner rows in full. Other people's rows are reduced to `{ _id, kind,
  status, ownerId, handle, _creationTime }`, with no draft, subject or recipient.
- `facts.graph` / `community.feed`: other people's `owner` facts are omitted. Other
  people's actions render as `✉ a draft` / `✉ sent`, with no subject.
- `facts.recall` returns public facts plus the intern owner's own `owner` facts. It takes
  `ownerId`; the run action passes the intern's owner.
- `interns.list`: for non-owners, email addresses in `task` are replaced with
  `[email]`.
- The notice copy changes to: *"This is a public test brain. Briefs and facts are
  visible to every visitor; drafts and anything you send stay private to you. Don't
  enter anything private in a brief."*

### Brief

`lib/brief.ts` takes the member's active connectors. When one is connected, the sandbox
paragraph becomes: *"Drafts go out for real from <label> once the person approves. Use
real recipients only if the task names them; never invent an address."* When none are
connected, the sandbox paragraph stays. `PROMPT_VERSION` changes, which is intended.

## Piece 2 — Broadcast

- Env: `BROADCAST_DISCORD_WEBHOOK_URL`, `BROADCAST_SLACK_WEBHOOK_URL`. Both are
  optional; unset means off.
- Events that broadcast (public information only):
  - a member joined (accepted the notice)
  - a public fact was taught or learned from an edit
  - an intern finished with a draft
  - a send succeeded (`@x sent an email` / `@x posted in Slack`, never the recipient)
- Mutations that create these events schedule `internal.broadcast.post({ text })`. It
  POSTs to each configured webhook: Discord `{ content, username: "Intern" }`, Slack
  `{ text }`.
- Throttle: at most 30 broadcasts per hour, via a `broadcasts` counter row per UTC hour.
  Over the cap, events are dropped with a log, not queued.
- Formatting lives in `lib/broadcast.ts` (pure, tested). It includes a link to
  `SITE_URL/u/<handle>`.

## Piece 3 — Inbound

- **Slack 🧠:** when a member connects Slack, create a Composio trigger for reaction-added
  events on their account. When the reaction is `brain` and the reactor is that member,
  capture the message text as a **public** fact owned by the member, titled with its
  first line. The member chose to put it in the community brain by reacting.
- **Gmail label:** when a member connects Gmail, create a Composio trigger for new
  messages carrying the `Intern` label. Capture subject and body as an **owner-only**
  fact. It's the member's mail, so it stays private by default.
- **Webhook:** `POST /composio/webhook` (Convex `httpAction`) verifies the signature with
  `COMPOSIO_WEBHOOK_SECRET` per Composio's documented scheme, rejects with 401 otherwise,
  maps the payload's user id to our user through `connections`, and checks
  `requireMember`-equivalent rules (exists, consented, not banned) plus the 20 facts/day
  cap.
- Trigger slugs and payload shape are verified against Composio's docs at build time;
  mapping lives in `lib/inbound.ts` (pure, tested with recorded payloads).

## Piece 4 — Member pages

- Route `app/u/[handle]/page.tsx`. `@` is reserved for parallel routes in Next, so the
  URL is `/u/<handle>`.
- Public query `community.member({ handle })`: the member's avatar and handle, join date,
  public facts taught (newest 50), interns run (tasks with emails redacted, statuses),
  and counts of drafts approved and sends made. No private facts, drafts or recipients.
- Feed, community rail and broadcast lines link handles to `/u/<handle>`.
- Unknown handle: a plain "nobody here by that name" page, not a crash.

## Testing

- Pure (`node --test`): registry mapping per connector, email redaction, broadcast
  formatting, inbound payload mapping, and the webhook signature verifier.
- `convex-test`:
  - decide returns `needsConnect` without an active connection
  - decide schedules a send with one, and respects `SENDS_PER_DAY`
  - the callback refuses an unknown state and a user-id mismatch
  - `send.finish` writes the owner-only fact
  - `outbox.list` redacts other people's drafts
  - recall includes the owner's private facts and excludes others'
  - the webhook rejects a bad signature and captures a good 🧠 event
  - `community.member` exposes no private data
- Composio calls are stubbed with `vi.stubGlobal("fetch", …)`. No test hits the network.
- Manual, needs Mihir: connecting real Gmail/Slack, a real send, a real 🧠 capture, and
  a broadcast landing in a real channel.

## Setup Mihir does (none of it is code)

1. Create a Composio account (free). Set `COMPOSIO_API_KEY` on dev and prod Convex.
2. In Composio: a managed Gmail auth config, and a custom Slack auth config with user
   scopes (`chat:write`, `reactions:read`, `channels:history`, `users:read`). Set
   `COMPOSIO_AUTH_CONFIG_GMAIL` and `COMPOSIO_AUTH_CONFIG_SLACK`.
3. Composio webhook secret → `COMPOSIO_WEBHOOK_SECRET`; point the webhook at
   `https://<deployment>.convex.site/composio/webhook`.
4. Discord channel webhook and/or Slack incoming webhook →
   `BROADCAST_DISCORD_WEBHOOK_URL` / `BROADCAST_SLACK_WEBHOOK_URL`.
5. Check trust.composio.dev about the reported May 2026 incident.

## Out of scope

Discord as an outbound connector, calendar invites, reading whole inboxes into the brain,
per-company private brains, notifications, and any paid service.

## Changed during build

Ledger rulings that replaced parts of this spec. The code follows these, not the
sections above.

- **Connect flow.** No `/composio/callback` route and no `state`-based finish. Connect
  runs on Composio sessions with managed auth plus callback identity verification:
  Composio sends the browser to the project's verifier URL (the cockpit), which calls
  `connections.finish` as the signed-in member with the single-use `session_uri`, and
  Composio refuses a member id that didn't consent. This closes OAuth session
  fixation. `state` only keys the pending row until Composio's account id is known.
- **The verifier gate.** A connector counts as configured only when
  `COMPOSIO_VERIFIER_URL` (public HTTPS) is set alongside `COMPOSIO_API_KEY`. Without
  it, Composio would activate consents that we never finish.
- **Revoke only on disconnect and purge.** Retiring an older grant on reconnect, or
  cleaning up a refused link, deletes the Composio account without revoking it,
  because the same Google account would otherwise lose the grant it just gave.
- **`unsure` status.** A send whose execute call gave no clear answer (network
  throw, 5xx, 408/499, an unconfirmed 200) is `unsure`, not `failed`. It can't be
  resent until the owner runs `outbox.confirmUnsent` after checking their Sent
  folder. `resend` also stops after 3 attempts per draft.
- **Gmail capture is opt-in, through a separate read-only grant.** The send grant is
  `gmail.send` only and never reads mail. The `Intern` label is a second consent
  through `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE` (`gmail.readonly`), and it needs
  `COMPOSIO_WEBHOOK_SECRET`. Its captures are owner-only.
- **Private Slack captures are owner-only.** A 🧠 is public and broadcast only for
  the member's own message in a channel Slack confirms is public (`channels:read`).
  A DM, a private channel, someone else's message, or a failed lookup files it
  owner-only.
- **Sandbox drafts can't go out unchanged.** A draft written under the sandbox prompt
  has placeholder recipients. `outbox.decide` refuses to send it for real unless the
  member changes `to` in that approval, and the Outbox asks for that change.
- **Learning facts from a draft** stay owner-only when the draft could reach a real
  person or its run read anything private. Otherwise addresses are redacted.
