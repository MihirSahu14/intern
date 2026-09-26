# Ingestion: sources feed the brain — design

Date: 2026-09-25 · Status: approved in brainstorming ("yes to both")

## Changed since the plan was written

The plan (`docs/superpowers/plans/2026-09-25-ingestion.md`) was refreshed
against `main` @ `1238905`. What that changes about this design:

- **Already on `main`:** `COMMUNITY_SLACK_TEAM_ID` (enforced when a member
  connects Slack) and `COMMUNITY_SLACK_INVITE_URL` (the rail's "Join the
  community Slack first" link, via `connections.mine`). Ingestion reuses both;
  only `SLACK_BRAIN_BOT_TOKEN`, `SLACK_BRAIN_SIGNING_SECRET` and
  `GITHUB_TOKEN` are new. The join step reads the same `invite` and is
  skipped once the member's Slack is connected.
- **The brief** no longer has a question block and already tells interns to
  cite fact ids in `"sources"` only, never in prose. Passage ids follow that
  rule: `[p:<id>]` in `"sources"` only, the terminal's `stripCites` drops any
  that leak, and automatic promotion reads them from the approved action's
  `sources` and nowhere else. The fixed "what Intern is" section gains one
  line naming the archive.
- **The graph** now collapses resume chains, redacts every label and has a
  "starter facts" node for ownerless facts. Source nodes are redacted too; a
  promoted fact hangs off its source first, and an ownerless promoted fact
  never falls back to "starter facts".
- **Caps:** `CAP_EXEMPT_HANDLES` skips the 5 sources/day cap, like every
  other per-member cap.
- **UI:** the log is now a tab behind the graph, so "add a source" and a
  source's passages show their status inline. The consent notice names
  sources and the community Slack.
- **Seed:** the seeded "What Intern is" fact says Slack and document feeding
  is "the next step"; the plan rewrites that sentence and Mihir patches the
  prod row.

## Frame

The brain should be the one place interns read from. When a member says "post in
Slack about what we decided last week", the intern already has last week, because
every source feeds the brain as it happens. It doesn't fetch messages per person,
per request.

Every connector can be a **source** (it feeds the brain), a **sink** (interns send
through it), or both. This piece adds three sources:

| Source | What goes in | Visibility |
|---|---|---|
| Community Slack | Every message in the Intern workspace's **public** channels, live, plus a 90-day backfill | public |
| Documents | A URL, or an uploaded markdown, text or PDF file, split into passages | public by default; "keep private" makes them owner-only |
| GitHub | A public repo's README, issues and PRs, refreshed daily | public |

## Decisions (from brainstorming)

- **Searchable archive plus promoted facts.**
  - Sources produce **passages**, which interns recall from but which are never drawn
    on the graph.
  - Only **facts** are drawn, so the graph stays legible at thousands of messages.
- **People decide, interns suggest.** A passage becomes a fact when:
  - a member reacts 🧠 in the community Slack, or presses **promote** on a passage in
    the cockpit;
  - an approved draft cited it. It's promoted automatically, with no extra model call.
- **Full-text search now, embeddings later.** Recall uses Convex full-text search.
  Semantic search is a later change to one function, once billing makes embedding
  calls affordable.
- **No model calls anywhere in ingestion.** Every service is on a free plan.

## Data

- `sources`:
  - `{ kind: "slack_channel" | "document" | "github_repo", label, url?, externalId,
    ownerId?, visibility: "public" | "owner", status: "active" | "failed" | "removed",
    lastSyncedAt?, cursor?, error? }`
  - Indexes: `by_kind_and_externalId`, `by_ownerId`.
  - `ownerId` is the member who added a document or repo. Slack channels have none;
    they belong to the community.
- `passages`:
  - `{ sourceId, externalId, text, author?, authorHandle?, url?, at, visibility,
    ownerId?, promotedFactId? }`
  - Search index `search_text` on `text`, with `filterFields: ["visibility", "ownerId"]`.
  - Indexes: `by_sourceId_and_externalId` (idempotent upserts), `by_sourceId`.
  - `externalId` is the Slack `channel:ts`, the document chunk index, or the GitHub
    `issue:N` / `pr:N` / `readme`.
- `facts` gains an optional `fromPassageId`, so a promoted fact links back to its
  passage and source.

## Recall

`facts.recall` keeps returning facts as today, plus up to **6 passages**:
- the top public passages for the task (a search filtered `visibility == "public"`);
- the owner's own private passages (a second search filtered `ownerId == owner`,
  keeping only `visibility == "owner"`);
- merged and deduped.

The brief gains a section **"FROM THE ARCHIVE"** listing each passage as
`[p:<id>] <source label> · <author> · <date>: <text, max 400 chars>`. The prompt tells
the intern to cite `[p:…]` ids it relied on in the action's `sources`.
`PROMPT_VERSION` changes, which is intended.

Privacy is the same rule as facts: public passages, plus the intern owner's own
private ones, never another member's.

## Promotion

- **Automatic:** when `outbox.decide` approves a draft whose `sources` contain
  `[p:<id>]`, each cited passage the owner can see is promoted.
  - The new fact is `kind: "note"`, `title` = its first line (max 120 chars), `body` =
    the passage text, `fromPassageId`.
  - Its visibility is the passage's, or owner-only if the action is owner-only.
  - Promoting is idempotent: `promotedFactId` is set once.
- **🧠 in the community Slack:** promotes that message's passage to a public fact,
  attributed to the reactor if they're a linked member.
- **Promote button:** clicking a source node in the graph lists its recent passages in
  the rail, each with **promote**. The caller must be able to see the passage. The
  20 facts/day cap applies to manual promotes only.

## Community Slack

- **A separate Slack app, "Intern Brain",** installed once in the community workspace,
  with a bot token.
  - It must be separate from the "Intern" app members connect through Composio,
    because a Slack app can deliver its events to only one Request URL. "Intern"'s
    events go to Composio; "Intern Brain"'s events go to us.
  - Bot scopes: `channels:history`, `channels:read`, `reactions:read`, `users:read`.
  - Never `groups:*`, `im:*` or `mpim:*`.
- **Events:** `POST /slack/events`, a Convex `httpAction`.
  - Verify Slack's `v0` signature over `v0:<timestamp>:<raw body>` with
    `SLACK_BRAIN_SIGNING_SECRET`: constant-time compare, 5-minute window, 401 before
    parsing.
  - Answer `url_verification`.
  - Ignore any event whose `team_id` isn't `COMMUNITY_SLACK_TEAM_ID`.
  - Subscribe to `message.channels` and `reaction_added`. Handle:
    - new messages: upsert a passage;
    - `message_changed`: update the passage;
    - `message_deleted`: delete the passage, and its promoted fact if the fact is
      unchanged;
    - `brain` reactions: promote.
  - Ignore bot messages, joins and leaves, and any `channel_type` other than
    `channel`.
- **Backfill:**
  - An admin-run internal action, from the Convex dashboard function runner:
    `ingest:backfillSlack`.
  - It lists public channels, then pages `conversations.history` back 90 days in
    scheduled batches that respect Slack's rate limits.
  - It's resumable through the source's `cursor`.
- **Authors:** a Slack user id is shown as the linked member's `@handle` when a member
  connected that Slack account (`connections.externalUserId`). Otherwise it's Slack's
  display name, cached per user.
- **Joining:** after the consent screen, one step shows "Join the community Slack →"
  (`COMMUNITY_SLACK_INVITE_URL`) with **Skip**. The link also sits in the rail. If the
  var is unset, the step is hidden.
- The workspace itself must say "Public channels are read into the Intern brain" (a
  setup step for Mihir).

## Documents

- The cockpit rail gains **"add a source"**. A member can paste a URL, upload a file,
  or add a GitHub repo, and can tick **keep private** for documents.
- **URL fetch safety:**
  - https only; hostnames that are IP literals in private or loopback ranges are
    refused, as are `localhost`, `*.local` and `*.internal`;
  - no redirects to such hosts;
  - a 10-second timeout, a 2 MB cap, and `text/html`, `text/plain` or `text/markdown`
    only.
  - HTML is reduced to text: scripts, styles and nav are removed.
- **Uploads:** markdown, text or PDF, up to 5 MB, through Convex file storage.
  - PDF text is extracted by a pure-JS library in a `"use node"` action if needed. The
    plan confirms which library works in Convex's runtime.
  - A scanned PDF with no text layer is refused with a clear message.
- **Chunking** (pure, tested): split on blank lines into passages of about 800–1,200
  characters, at most 200 per document.
- **Caps:** 5 sources added per member per day. A removed source deletes its passages
  but keeps any facts already promoted from it.

## GitHub

- A member adds `owner/repo`. It must be public: `GET /repos/{owner}/{repo}` must say
  `private: false`, or it's refused.
- Ingest the README, plus the latest 200 issues and PRs (title + body), one passage
  each.
- Refreshed daily by a cron (`crons.interval`, per the Convex guidelines).
- Calls use one read-only token of Mihir's (`GITHUB_TOKEN`, fine-grained, public repos
  read-only), because GitHub's anonymous limit is 60 calls an hour. Unset means GitHub
  sources show "not set up yet".

## Graph and pages

- Each source is one `source` node: `#channel`, a document title, or `owner/repo`.
  Promoted facts hang off it (`from`). Passages are never nodes.
- Member pages list the public sources a member added. The feed and broadcasts add
  "@x added a source: <label>", for public sources only, with links stripped as
  today.

## Privacy and abuse

- **Visibility:**
  - Slack passages are public, but only from public channels of the community
    workspace.
  - Documents are public unless marked private.
  - GitHub passages are public repos only.
- **Deleted in Slack means deleted in the brain.**
- `users.purge` deletes a member's sources and passages (and their files in storage).
- **Readers apply `visibleTo`:** every reader of passages (recall, the promote
  listing, member pages) uses the same rule as facts.
- **Webhook hygiene:** the Slack endpoint logs event ids and types only, never message
  text.

## Env (all Convex, prod and dev)

`SLACK_BRAIN_BOT_TOKEN`, `SLACK_BRAIN_SIGNING_SECRET`, `COMMUNITY_SLACK_TEAM_ID`,
`COMMUNITY_SLACK_INVITE_URL`, `GITHUB_TOKEN`. Each is optional; unset means that
source is off.

## Testing

**Pure (`node --test`):**
- the Slack signature verifier (good, bad and stale);
- the chunker;
- the URL safety check (private IPs, localhost, redirects);
- HTML to text;
- the `[p:…]` citation parser.

**`convex-test`, with `fetch` stubbed:**
- events: `url_verification`; a public-channel message is ingested; a wrong team or
  non-channel message is ignored; edits update; deletes remove passage and fact; 🧠
  promotes; a bad signature gets 401;
- backfill paging resumes from its cursor;
- a document is added, chunked and capped; a private document is invisible to
  another member's recall;
- a private GitHub repo is refused;
- recall merges passages under the visibility rules;
- approving a draft that cited `[p:…]` promotes it exactly once;
- purge removes a member's sources.

## Out of scope

Embeddings and semantic search, Discord as a source, private Slack channels and DMs,
Google Drive or Notion, and any paid service.
