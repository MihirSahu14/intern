# Handover

**Read the Public MVP section first. Everything under it is the hackathon
record — 9 Aug 2026, kept for the traps it documents, not as a description of
the code.** Scout, the MCP server, VoiceOS and every outbound connector are
gone from this branch; the sections below still talk about them.

---

## Public MVP

What this is now: one public shared brain, GitHub sign-in, interns that run
inside Convex on Gemini, and approvals that send nothing.

**The run path.** `interns.spawn` (mutation) checks the caps, inserts the row
and schedules `internal.run.go` (action), which recalls facts, makes one
streamed Gemini call over plain `fetch`, parses the report, and calls
`internal.interns.finish` (mutation) — facts, a draft *or* a question, in one
transaction. A run that throws lands in `internal.interns.fail` instead, which
still records what Google billed. No agent service, no Python, no queue.

**Caps**, all in `lib/caps.ts`, all checked inside mutations: 5 briefs per
person per UTC day, 1 intern working at a time, 20 facts per person per day,
$5 of model spend across everyone per day. A run that produced nothing billable
(free-tier 429) doesn't cost a brief.

**Approvals are a sandbox.** There is no connector, webhook or outbound path in
the repo. Approving files the decision and the difference from the draft as a
preference fact; rejecting files the reason as a correction. That is the whole
learning loop, and `/stats` measures it from real runs.

**Admin** is the Convex dashboard's function runner — `users:ban
{"handle":"x"}` bans and purges everything that person added. There is no admin
UI and deliberately so. A `sending` row that never reached `send.finish` (the
action died mid-flight — a deploy, a crash) is stuck: clear it from the
dashboard's data table by hand-patching its status to `unsure`, never straight
to `failed`, and only after the action's own timeout has passed (Convex
actions stop at 10 minutes), so you never patch a send that is still running.
`unsure` is the only status that owns up to not knowing whether Composio's
second call already reached Gmail/Slack before whatever killed the process;
patching straight to `failed` would let `outbox.resend` fire again uncontested
and could send the same message twice. The owner still has to run
`outbox.confirmUnsent` (after checking their Sent folder) before a resend is
possible.

**Tests**: `npm test` (pure logic), `npx vitest run` (the Convex functions via
convex-test), `npm run eval` (20 fixed briefs through the live prompt — costs
tokens, and exits non-zero on a partial outage, not just a total one).

**The dev deployment still holds hackathon data and was never wiped.** Rows and
indexes from before this branch are still there, which is why a schema push can
fight you. See MANIFEST.md.

---

## What this is

**Intern** — a shared company brain plus agents that do real work against it.
Agents draft, a human approves, then it sends. See `IDEA.md` and `docs/HLD.md`.

The wire that confuses people:

```
VoiceOS ──MCP──► Intern (Next app, /api/mcp)  ◄── the cockpit UI
                     │
                     ├── brain: Convex (log, facts, outbox, auth)
                     └──HTTP──► Scout (agent engine, :8000, Python/agno)
                                    └── tools: query_crm, query_knowledge,
                                        query_workspace, web_search, read_file…
```

**VoiceOS never talks to Scout.** Scout is the engine, Intern is the product,
VoiceOS is a remote control for the product.

---

## Working and verified

Not "should work" — actually observed:

- **Interns run end to end** on `gpt-5.6-luna` via Scout. One run made 57 tool
  calls across 11 tools and returned a written summary.
- **They read the brain.** `recalled 5 facts from the brain · fact-00e …` appears
  in the stream. `recalled()` in `lib/store.ts` injects facts into the brief.
- **They write back.** A run updated `wiki/knowledge/learnings/ramp-pilot.md`,
  created the CRM project, and added three contacts with roles.
- **The brain survives restarts.** Observations live in Convex; `ready()` in
  `lib/brain.ts` replays them on boot and rebuilds facts. Killed the server
  mid-demo and the facts came back.
- **Capture is idempotent** on `(sourceId, externalId)`.
- **Slack posts** to `#demo` (`C0BP0HJC6DU`), confirmed with a live message.
- **Auth works.** Sign-up mints tokens, sign-in verified, `users` rows exist.
- **Two people share one brain** — same Convex deployment, live subscriptions.

---

## Running it

```bash
npm run dev                    # cockpit on :3000
cd scout && docker compose up -d   # scout-db + scout-api on :8000
npx convex dev                 # only when convex/ changes
```

Cockpit flips SIM → LIVE by itself within 20s of Scout answering.

**Deployment:** Convex `graceful-albatross-202` (team `mihirs1410`, project `intern`).
Dashboard: https://dashboard.convex.dev/d/graceful-albatross-202

**Accounts:** GitHub sign-in only (since the public MVP). The old demo password
was published in this file and is burned.

**Secrets** live in two gitignored files, both already populated:
- `.env.local` — Convex URLs, `SCOUT_API_URL`, `SLACK_BOT_TOKEN`, Google OAuth trio
- `scout/.env` — `OPENAI_API_KEY`, DB pointing at the compose Postgres

⚠️ **The OpenAI key is Andrew's personal account.** Every key here was pasted in
a chat transcript. Rotate them after the hackathon.

---

## Known bugs, with locations

**1. ~~Interleaved stream output~~ — FIXED.** The cause was not "parallel
sub-agent results": Scout streams the top-level run *and* every context
provider's run down one HTTP response, interleaved chunk by chunk — measured at
794 alternations across 4 concurrent runs in a single brief. `lanes()` in
`lib/scout.ts` buffers per `run_id`, and sub-agent lines are prefixed with their
agent (`knowledge-read · …`). It also fixed a bug nobody had noticed: all four
runs emit `RunCompleted`, so `intern.summary` was whichever sub-agent finished
last, not the answer. Covered by `lib/scout.test.ts`.

**2. ~~The roster~~ — GONE.** Trust is per action kind now. One correction to
the old plan, for the record: step 3 did not apply. `actions` and `decisions`
were both **empty**, so `role` dropped in a single schema push with no
optional-then-drop dance. The original steps:

1. Trust moves from role to **action kind**. `decisions.role` → `decisions.kind`
   (`slack` / `email` / `calendar`); rework `tally()` and `get()` in `lib/trust.ts`.
   You get *"8 of 9 Slack posts approved unedited"* — a true statement about a
   real capability.
2. Then delete `lib/roster.ts`, `components/Roster.tsx`, `app/api/roster/route.ts`,
   `RoleId` from `lib/types.ts`, the charter from `BRIEF()` in `lib/store.ts`,
   and `spawn as <role>` from the command bar.
3. ~~`actions.role` is required with existing rows.~~ There were no rows.

**3. ~~Company positioning facts are placeholders.~~ REWRITTEN.** They now say
what Intern actually is, sourced from `IDEA.md` and `docs/HLD.md`. The two that
*cannot* be true yet — the ICP and any numeric qualification bar — say **NOT YET
DECIDED** in the body and tell the intern to ask instead of filling it in. That
is deliberate: a fact that admits a hole beats a confident invention, and it is
the same rule the interns are held to.

⚠️ **The instruction that used to be here was wrong and cost time.**
"Re-capture with the same `external_id` to update in place" does not work.
`appendObservation` is idempotent on `(sourceId, externalId)` and returns early,
so re-capturing is a **no-op**, not an update. Use the `log:retract` mutation
(added for exactly this), then capture the true one under the same key.

**4. ~~An intern drafted to Slack and nothing was sent.~~ FIXED.** A run
researched for three minutes, wrote a good Slack draft, and posted nothing. The
brief carries one ```action example and it is an *email*, so the model wrote
`{"kind":"slack","channel":"#demo","body":…}` — no `to`, no `subject`, because a
Slack post has neither. The parser demanded both and returned `null` **silently**,
so the run finished looking successful with an empty outbox. `lib/action-block.ts`
now takes `channel`/`channels` as `to`, lets Slack have no subject, and — the
part that matters — says why a block was unusable instead of dropping it.
`lib/action-block.test.ts` pins it, using the real block from that run.

**5. Failed tool calls looked like successes.** `web_search → Error: Timed out`
was logged at `ok` level, behind a green tick. Now logged at `err`, counted on
`intern.toolErrors`, and the finish line reads
`finished in 182.1s · 6 tool calls failed` instead of just `finished`.

**6. Slack scopes are short of the manifest.** Installed app has
`channels:history, chat:write`. Missing `chat:write.public`, `channels:read`,
`users:read`, `groups:*`. Effect: the bot only posts to channels it's invited
to, can't resolve channel names to ids, can't resolve user ids to names. Fix by
re-pasting `slack-app-manifest.yml` under App Manifest and reinstalling.

---

## Traps that already cost hours

**The stream parser fix is load-bearing and easy to lose.** `runStream` in
`lib/scout.ts` used to split on blank lines and return without flushing the
tail — so the last frame was always dropped, and the last frame is
`RunCompleted`, the only event carrying the answer. Every intern finished with
tool calls logged and **no summary**, so nothing reached the brain. It looked
healthy the whole time.

After **every** merge touching `lib/scout.ts`:

```bash
grep "yield\* parse(buf" lib/scout.ts    # absent = the fix is gone
```

**`docker compose restart` does not re-read `.env`.** It reuses the container's
original environment. Use `docker compose up -d --force-recreate scout-api`.

**Convex refuses schema pushes when existing rows violate the new shape.** Clear
or migrate the rows first: `npx convex import --table X --replace --yes empty.jsonl`.

**Gemini free tier is a dead end here** — recorded so nobody retries it.
`gemini-2.5-flash` is "no longer available to new users", `gemini-2.0-flash` was
already past quota, the working alias 429'd within a few runs. Two side traps:
`uv pip sync` installs *exactly* requirements.txt and removes everything else
(so `google-genai` arrived without `tenacity`), and agno's import guard blames
`google-genai` for the missing transitive dep.

**Interns are long runs.** 57 tool calls for one brief. Cost scales with the
tool loop, not the question — hence luna.

---

## Git

Branch `brain-aware-interns`, identical to `main` after merging. Merged PRs: #2
(Convex backend), #3 (proposed/accepted diff), #4 (live interns + parser fix).

⚠️ Five commits went **directly to main** early on — my mistake. The user's rule
now: **always branch, then PR.**

---

## Next

Nothing outbound. Whatever comes next should not quietly reintroduce a send
path — the sandbox invariant is stated on every screen and in the consent gate,
and the docs lied about it for a whole branch before anyone noticed.

The open ones that survive the cut:

1. **Watch for a schema fight.** The deployment carries indexes and tables that
   are not in this repo's `convex/schema.ts`, left over from the hackathon.
   Reconcile before pushing from a second branch.
2. **Pagination.** `facts.graph`, `community.feed` and `community.evals` all
   take bounded windows (400 facts, 30 events, 1,000 runs) and say so in a
   `ponytail:` comment. They stop being honest once the community outgrows one
   screen.

---

## Inbound from members' own tools (Task 7)

- **🧠 in Slack** files a fact under the member's name. It is **public and
  broadcast only** when the member wrote the message *and* it's in a channel
  Slack confirms public (`SLACK_RETRIEVE_CONVERSATION_INFORMATION`:
  `is_private`, `is_im`, `is_mpim` all false). A 🧠 on a DM (`D…`), a legacy
  private channel or group DM (`G…`), a channel reported private, or someone
  else's message is saved **owner-only**, never broadcast. If the channel
  lookup fails, the fact is owner-only too.
- **Slack user scopes:** `reactions:read` and `channels:history` (public
  channels) are enough. **Don't grant `groups:history`, `im:history` or
  `mpim:history`** unless Mihir decides he wants private captures. They would
  let a member's 🧠 in private channels (`groups`), DMs (`im`) and group DMs
  (`mpim`) read that message's text through Composio into their own
  owner-only facts. Without them, a 🧠 there captures nothing, because the
  history lookup is refused.
- **The Gmail `Intern` label** is opt-in per member: a second, read-only
  (`gmail.readonly`) grant with its own consent screen, through
  `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE`. The send grant never reads mail.
  Captures are owner-only.
- **Webhook:** `https://<deployment>.convex.site/composio/webhook`, signed with
  `COMPOSIO_WEBHOOK_SECRET`. Without the secret, every event gets a 401 and no
  trigger is created.

---

## Community surfaces: setup

Everything below is manual, does Mihir's own accounts, and is never run by an
agent. Nothing here executes `npx convex dev/deploy/run/env` on your behalf —
those are yours to run, from your own terminal, never pasted into chat.

**Deployments:** dev `graceful-albatross-202` (⚠️ still carries incompatible
hackathon rows — don't push schema without wiping/migrating, see "Public MVP"
above), prod `neighborly-peacock-427`. Site: `https://intern-brain.vercel.app`.
Composio projects are per-environment: expect **two** Composio projects
(`intern-dev`, `intern-prod`), each with its own API key, webhook secret and
verifier URL.

Total time, done carefully with throwaway test accounts: roughly 2–3 hours,
most of it Google/Slack consent-screen back-and-forth.

### Env vars

All of these are Convex env vars (`npx convex env set [--prod] NAME value`),
never Vercel — every one is read server-side, in `convex/` or `lib/` that
`convex/` imports.

| Var | Required? | Dev value / where to get it | Prod value |
|---|---|---|---|
| `COMPOSIO_API_KEY` | Yes — unset means every connector shows "not set up yet" and outbox drafts stay sandboxed (approved, nothing sent) | `intern-dev` project's API key, Composio dashboard. **Scope it to Gmail + Slack toolkits only** (Composio's May 2026 breach — see Step 1 below) | `intern-prod` project's key, same scoping |
| `COMPOSIO_VERIFIER_URL` | Yes, alongside the API key — `isConfigured` requires both, and it must start with `https://` or the connector reads as unconfigured | A public HTTPS URL that resolves to `/app` — Composio rejects localhost/private addresses on save, so this needs a tunnel to `localhost:3000` (e.g. an ngrok URL) or a Vercel preview URL, ending in `/app` | `https://intern-brain.vercel.app/app` |
| `COMPOSIO_AUTH_CONFIG_GMAIL` | Optional, strongly recommended | A **send-only** Gmail auth config's `ac_…` id, Composio-managed auth, scope `gmail.send` only. Without it, Gmail connects through Composio's default managed scopes, which are **not publicly documented and may cover the whole mailbox** | same, `intern-prod`'s send-only config |
| `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE` | Optional — without it, the Gmail `Intern`-label toggle is hidden and `start({capture: true})` refuses | A **separate, read-only** Gmail auth config's `ac_…` id, scope `gmail.readonly` only. This is a second consent screen a member opts into; the send grant never reads mail | same, `intern-prod`'s capture config |
| `COMPOSIO_AUTH_CONFIG_SLACK` | Optional but likely needed — whether Composio-managed Slack auth posts as the member (vs. as an app) is **unconfirmed** (Task 3 concern 2); test a throwaway connect first | A **custom** Slack auth config's `ac_…` id, backed by your own Slack app with **user scopes** `chat:write`, `reactions:read`, `channels:history`, `users:read` | same, `intern-prod`'s custom config, a separate Slack app or a separately-installed one |
| `COMPOSIO_WEBHOOK_SECRET` | Optional — without it, every inbound webhook call gets a 401 and no 🧠/label trigger is ever created; sends and connects still work | `intern-dev` project's webhook signing secret, Composio dashboard | `intern-prod`'s webhook secret |
| `BROADCAST_DISCORD_WEBHOOK_URL` | Optional — unset means no Discord broadcasts | A **separate test channel's** webhook URL | Your real announcements channel's webhook URL |
| `BROADCAST_SLACK_WEBHOOK_URL` | Optional — unset means no Slack broadcasts | A separate test channel's incoming-webhook URL | Real channel's incoming-webhook URL |
| `SITE_URL` | Already set (Convex Auth) — reused to build the `/u/<handle>` link in every broadcast line | `http://localhost:3000` | `https://intern-brain.vercel.app` |

Unset `COMPOSIO_API_KEY`/`COMPOSIO_VERIFIER_URL` together means the whole app
runs in sandbox (drafts approve but nothing sends, nothing captures). Unset
`BROADCAST_*` means no broadcasts, silently — `convex/broadcast.ts` returns
early with no log.

### Composio (~30 min)

1. **Check Composio's trust page first.** Read `https://trust.composio.dev`
   for the reported May 2026 incident before connecting any real member's
   Gmail/Slack (unconfirmed, from a secondary source —
   `composio.dev/blog/composio-may-2026-security-incident`). Decide whether
   Composio may hold members' tokens before going further.
2. **Create two Composio projects**, `intern-dev` and `intern-prod`. For each,
   generate an API key **scoped to the Gmail and Slack toolkits only** — not a
   full-access key — given the breach in Step 1. That key is
   `COMPOSIO_API_KEY` for that deployment.
3. **Set the verifier URL on each project.** In the Composio dashboard:
   Settings → General → Configuration → callback identity verification →
   enter the URL. `intern-prod` → `https://intern-brain.vercel.app/app`.
   `intern-dev` → a public HTTPS tunnel or preview URL ending `/app`
   (`http://localhost:3000/app` will be rejected on save). Set the same URL as
   `COMPOSIO_VERIFIER_URL`.

### Slack (~30–45 min)

4. **Decide managed vs. custom auth.** Connect a throwaway Slack account
   through Composio-managed auth first and confirm a test send posts *as that
   person*, not as an app/bot. If it does, `COMPOSIO_AUTH_CONFIG_SLACK` can
   stay unset. If not (or you want the 🧠 capture trigger, which needs a
   custom app regardless — see Step 5), build a custom Slack app.
5. **Custom Slack app, if used:** `slack-app-manifest.yml` in the repo root is
   stale (hackathon-era: it points `redirect_urls` at a `/oauth/callback` path
   that no longer exists, and its `user_scopes` are only `chat:write` +
   `users:read`). Don't paste it as-is. Either edit it or set scopes by hand:
   **user scopes** `chat:write`, `reactions:read`, `channels:history`,
   `users:read`. **Do not add `groups:history`, `im:history` or
   `mpim:history`** unless you want 🧠 to capture private channels/DMs/group
   DMs — granting them lets a member's 🧠 there read that message's text into
   their own owner-only facts (never public); without them, that lookup is
   refused and nothing captures. In the Composio dashboard, create the custom
   Slack auth config against this app and set the Slack app's OAuth redirect
   URL to whatever Composio shows on that auth config's page. The config's
   `ac_…` id is `COMPOSIO_AUTH_CONFIG_SLACK`.
6. **Event Subscriptions, for the 🧠 trigger** (needed whenever a custom Slack
   app is used, per Task 7 Step 1): in the Composio dashboard, create a
   webhook endpoint for the Slack toolkit, then set its Signing Secret and an
   App-Level Token (`xapp-…`, scope `authorizations:read`) on it; Composio
   gives back a `webhook_url`. Paste that URL into the Slack app's Event
   Subscriptions → Request URL, and subscribe to `reaction_added`.

### Gmail (~30 min)

7. **Send-only auth config.** In the Composio dashboard, create a
   Composio-managed Gmail auth config scoped to `gmail.send` only, and set its
   id as `COMPOSIO_AUTH_CONFIG_GMAIL`. Connect a throwaway Gmail through it
   first: `gmail.send` is a Google *sensitive* scope and can trigger an
   unverified-app block on sending — if it does, you'll need your own Google
   OAuth app for this config instead (config only, no code change).
8. **Capture (opt-in inbound) auth config.** Create a second, separate Gmail
   auth config scoped to `gmail.readonly` only, id →
   `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE`. `gmail.readonly` is a Google
   *restricted* scope — Google may block it until the app passes verification.
9. **Create the label.** In the Gmail account(s) you'll connect, create a
   label named exactly `Intern`. The trigger is "new message received", so a
   Gmail filter that applies the label automatically on arrival works;
   hand-labelling an already-received email may not (unconfirmed — Task 7
   §4).

### Broadcast (optional, free, ~10 min)

10. **Discord:** the target channel → Edit Channel → Integrations → Webhooks →
    New Webhook → Copy URL → `BROADCAST_DISCORD_WEBHOOK_URL`.
11. **Slack:** `api.slack.com/apps` → your app → Incoming Webhooks → Add New
    Webhook to Workspace → pick the channel → `BROADCAST_SLACK_WEBHOOK_URL`.

Use a separate test channel for dev on both.

### Deploy (~30 min, needs your go-ahead)

12. **Set the webhook URL and secret**, per Composio project, in the Composio
    dashboard (Platform → webhook, per Task 7's report — the equivalent API
    call is `setWebhookSubscription`): dev
    `https://graceful-albatross-202.convex.site/composio/webhook`, prod
    `https://neighborly-peacock-427.convex.site/composio/webhook`. Copy each
    project's signing secret into `COMPOSIO_WEBHOOK_SECRET`.
13. **Set every env var above**, from your own terminal, dev first:
    `npx convex env set COMPOSIO_API_KEY …` (and so on for each var in the
    table), then the same six/seven with `--prod` and the `intern-prod`
    values.
14. **Deploy backend first.** Push `connectors`, open a PR to `main`, then
    `npx convex deploy` (prod). This is safe backend-first: the schema is
    additive, and the cockpit already filters the outbox to your own rows.
    Merge the PR once the backend is live; Vercel deploys `main`.

### First-live-connect checklist

Run through this on dev first (`npm run dev`), then again on prod, with two
GitHub accounts (the second one in a private window):

- [ ] Connect Gmail. On the connected account, check `requested_scopes` (via
      `GET /connected_accounts/{id}` in the Composio dashboard or API) —
      confirm it's `gmail.send` only, not the whole mailbox.
- [ ] Connect Slack. Confirm the stored `externalUserId` on that member's
      `connections` row (Convex dashboard) is the **member's own** Slack user
      id, not a bot's — `SLACK_TEST_AUTH`'s output shape isn't documented by
      Composio, so a nested response would silently leave this null.
- [ ] Approve and send a real email/Slack message. Confirm the send returns
      `error: null` (no `unsure`/`failed` status on the `actions` row) and
      actually lands in the recipient's inbox/channel.
- [ ] React 🧠 to your own message in a **public** channel: within about a
      minute it's a public fact, titled with the message's first line, and a
      broadcast fires. React 🧠 in a **DM**: it stays owner-only, no
      broadcast, no public fact.
- [ ] Confirm a broadcast actually lands in the configured Discord/Slack
      webhook channel, with a `/u/<handle>` link and no recipient in the text.

### Admin

`connections` rows (per-member Gmail/Slack grants, `composioAccountId`,
`triggerId`) live in the Convex dashboard's data tables, same as everything
else — there's no admin UI for them. `users:ban` still purges everything a
banned member added, connections included: it revokes and deletes each active
grant at Composio (`internal.connections.forget`, scheduled per row) as part
of the purge.
