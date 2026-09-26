# Handover

**Read the Public MVP section first. Everything under it is the hackathon
record — 9 Aug 2026, kept for the traps it documents, not as a description of
the code.** Scout, the MCP server, VoiceOS and every outbound connector are
gone from this branch; the sections below still talk about them.

---

## Public MVP

What this is now: one public shared brain, GitHub sign-in, interns that run
inside Convex on any OpenAI-compatible model (Groq by default — see **Model
provider** below), and approvals that send through the member's own Gmail or
Slack once they connect it (sandbox until then).

**The run path.** `interns.spawn` (mutation) checks the caps, inserts the row
and schedules `internal.run.go` (action), which recalls facts, makes one
streamed model call over plain `fetch` (`lib/model.ts`), parses the report,
and calls `internal.interns.finish` (mutation) — facts, a draft *or* a
question, in one transaction. A run that throws lands in
`internal.interns.fail` instead, which still records what the provider
billed. No agent service, no Python, no queue.

**Caps**, all in `lib/caps.ts`, all checked inside mutations: 5 briefs per
person per UTC day, 1 intern working at a time, 20 facts per person per day,
$5 of model spend across everyone per day. A run that produced nothing billable
(the model was busy — 429/503/529) doesn't cost a brief.

**`CAP_EXEMPT_HANDLES`** (Convex env var, comma-separated GitHub handles,
case-insensitive) is for the deployment owner's own testing; exempt members
still spend the shared budget. It skips every per-member cap — briefs/day,
one-concurrent-intern, facts/day, sends/day, connect-starts/hour — for a
listed `users.handle`, checked server-side, never from client args. It never
skips the shared $5/day budget, the DAY_WINDOW overflow safety guard, or the
resend-attempts cap. One helper, `access.ts`'s `capExempt` (built on
`lib/caps.ts`'s pure `isCapExempt`), backs every one of those cap sites.

### Model provider

`lib/model.ts` speaks the OpenAI-compatible `/chat/completions` streaming API
over plain `fetch` — no SDK — so any provider that implements that shape works
by changing env, no code. These are **Convex** env vars (`npx convex env set
... `, on both the dev and prod deployments), plus the same three in
`.env.local` for `npm run eval`, which is a plain node script and can't read
the deployment's env (see `.env.local.example`).

| Var | Default | What it is |
|---|---|---|
| `MODEL_BASE_URL` | `https://api.groq.com/openai/v1` | provider's OpenAI-compatible base URL |
| `MODEL_NAME` | `openai/gpt-oss-20b` | model id, as that provider names it |
| `MODEL_API_KEY` | none — required | provider API key; unset fails the run with the same busy-style copy, no brief charged |

**Default: Groq, `openai/gpt-oss-20b`.** No card to sign up (console.groq.com),
30 req/min · 1,000 req/day · 8,000 tokens/min per model — official docs,
console.groq.com/docs/rate-limits, dated 2026-09-22 in
`.superpowers/sdd/llm-providers-research.md`. That's why it replaced Gemini:
Gemini's free tier rate-limits **per Google Cloud project**, not per key, so
every visitor to the public demo shared one ~5 req/min bucket and 503s failed
19 of 20 eval briefs. Get a key at console.groq.com.

**Paid fallback: OpenAI, `gpt-5-nano`.**
```
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_NAME=gpt-5-nano
MODEL_API_KEY=<your OpenAI key>
```
$0.05 / 1M input, $0.40 / 1M output — about $0.00175/run at this app's rough
token shape (official pricing, developers.openai.com/api/docs/pricing).
Requires a card on the OpenAI account.

**Gemini stays reachable, through its own OpenAI-compatibility shim** (not the
native `generateContent` API):
```
MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
MODEL_NAME=gemini-flash-latest
MODEL_API_KEY=<your Gemini key>
```
Base URL, `Authorization: Bearer` auth and `stream: true` SSE confirmed
against Google's own docs, ai.google.dev/gemini-api/docs/openai (fetched
2026-09-25). Get a key at aistudio.google.com. This is the same per-project
rate limit that motivated the move to Groq — keep it as a fallback, not the
default.

**Pricing for the $5/day cap** is env-configurable too: `MODEL_USD_PER_M_IN`
and `MODEL_USD_PER_M_OUT` (both `lib/caps.ts`), defaulting to Groq's *paid*
`gpt-oss-20b` list price ($0.075 in / $0.30 out per 1M) so the cap stays
meaningful if this moves off the free tier. On the free tier itself nothing is
billed, so the cap just bounds runs/day rather than dollars — see the
`ponytail:` comment in `lib/caps.ts`.

`GEMINI_API_KEY` / `GEMINI_MODEL` are gone — nothing reads them anymore.

### Gmail scope

⚠️ **The Gmail grant is not send-only.** Google blocks a Composio-managed auth
config scoped to `gmail.send` only on Composio's *shared* app (the
"send-only" config this file used to describe never actually connects).
Prod's `COMPOSIO_AUTH_CONFIG_GMAIL` is a managed config trimmed to
`userinfo.email`, `userinfo.profile` and `https://mail.google.com/` — the
last of those is full mailbox read/write/send access, not send-only. Intern
itself still only ever sends what a member approves; the point is that the
*grant* Composio holds can do more than that, and the disclosure under the
connect control (`lib/connectors.ts`'s Gmail `disclosure`) says so.

The least-privilege path, if it's worth the setup: Mihir's own Google OAuth
app, scoped to `gmail.send` only, used as a custom Composio auth config
instead of the managed one. In **Testing** publishing status it works for up
to 100 test users (added by email in the Google Cloud Console) with no
review; opening it to everyone needs Google's verification for the
`gmail.send` scope, which is free but not instant.

**Approvals send, once a member connects an account.** With Composio set up
(`COMPOSIO_API_KEY` + `COMPOSIO_VERIFIER_URL`), approving an email or Slack
draft sends it from the member's own connected Gmail/Slack (`outbox.decide` ->
`send.go`, capped at 20 sends/day and 3 attempts per draft); without a
connection it asks them to connect first and keeps their edits. Calendar
drafts, and every draft on a deployment without Composio, stay sandboxed:
approving sends nothing. A draft written before its account was connected was
briefed with placeholder recipients (#general, name@example.com); it can go
out unedited only when every recipient it names is one the member actually
typed in their own brief (`lib/recipients.ts`'s `recipientsInBrief`) —
otherwise it can't go out until the member changes `to`. Inbound: a member's own 🧠 in Slack and
an opt-in `Intern` Gmail label add facts through a signed webhook
(`/composio/webhook`). Broadcasts post public one-liners to Discord/Slack
webhooks. Either way, approving files the difference from the draft as a
preference fact and rejecting files the reason as a correction — owner-only
whenever the draft could reach a real person or its run read anything
private, and address-redacted otherwise. That is the learning loop, and
`/stats` measures it from real runs.

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

Outbound is real now (see the Public MVP section and "Community surfaces"
below), and it is opt-in per member: nothing sends from an account the member
didn't connect, and nothing sends without their approval. Keep every screen
and the consent gate saying exactly that — the docs lied about the sandbox for
a whole branch once before anyone noticed, and must not drift the other way.

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
- **Slack user scopes:** `reactions:read`, `channels:history` and
  `channels:read` (public channels) are enough. `channels:read` is what
  `SLACK_RETRIEVE_CONVERSATION_INFORMATION` needs to confirm a channel is
  public; without it that lookup fails and **every 🧠 silently stays
  owner-only**. **Don't grant `groups:history`, `im:history` or
  `mpim:history`** unless Mihir decides he wants private captures. They would
  let a member's 🧠 in private channels (`groups`), DMs (`im`) and group DMs
  (`mpim`) read that message's text through Composio into their own
  owner-only facts. Without them, a 🧠 there captures nothing, because the
  history lookup is refused.
- **The Gmail `Intern` label** is opt-in per member: a second, read-only
  (`gmail.readonly`) grant with its own consent screen, through
  `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE`. ⚠️ On prod's actual config the send
  grant *can* already read mail (see "Gmail scope" above — Google blocks a
  `gmail.send`-only auth config on Composio's shared app), which makes this
  second grant redundant for members connected through that config. It's kept
  anyway: it's opt-in and harmless, and it's the only route to
  least-privilege capture on a deployment that does move to Mihir's own
  send-only Google OAuth app. Captures are owner-only.
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
| `COMPOSIO_AUTH_CONFIG_GMAIL` | Optional — unset means Gmail connects through Composio's own default managed config instead (see "Gmail scope" above) | Not set on `intern-dev`/`intern-prod`: Google blocks a `gmail.send`-only Composio-managed auth config on Composio's shared app, so prod uses the default managed config (`userinfo.email`, `userinfo.profile`, `https://mail.google.com/` — **not send-only**). Set this only if you build a **custom** auth config backed by your own Google OAuth app, scoped to `gmail.send` only (see "Gmail scope") | same — unset unless you've built the custom least-privilege config |
| `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE` | Optional — without it, **or without `COMPOSIO_WEBHOOK_SECRET`**, the Gmail `Intern`-label toggle is hidden and `start({capture: true})` refuses | A **separate, read-only** Gmail auth config's `ac_…` id, scope `gmail.readonly` only. This is a second consent screen a member opts into; redundant on the current send config (which can already read) but kept because it's opt-in and harmless | same, `intern-prod`'s capture config |
| `COMPOSIO_AUTH_CONFIG_SLACK` | Optional — Composio-managed Slack is a user token, so sends post as the member who connected (`SLACK_SEND_MESSAGE` takes only `channel` + `markdown_text`; it rejects `as_user`) | A **custom** Slack auth config's `ac_…` id, backed by your own Slack app with **user scopes** `chat:write`, `reactions:read`, `channels:history`, `channels:read`, `users:read` | same, `intern-prod`'s custom config, a separate Slack app or a separately-installed one |
| `COMPOSIO_WEBHOOK_SECRET` | Optional (but the Gmail `Intern` label needs it: `COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE` does nothing without it) — without it, every inbound webhook call gets a 401 and no 🧠/label trigger is ever created; sends and connects still work | `intern-dev` project's webhook signing secret, Composio dashboard | `intern-prod`'s webhook secret |
| `BROADCAST_DISCORD_WEBHOOK_URL` | Optional — unset means no Discord broadcasts | A **separate test channel's** webhook URL | Your real announcements channel's webhook URL |
| `BROADCAST_SLACK_WEBHOOK_URL` | Optional — unset means no Slack broadcasts | A separate test channel's incoming-webhook URL | Real channel's incoming-webhook URL |
| `SITE_URL` | Already set (Convex Auth) — reused to build the `/u/<handle>` link in every broadcast line | `http://localhost:3000` | `https://intern-brain.vercel.app` |
| `CAP_EXEMPT_HANDLES` | Optional — unset means nobody is exempt | Your own GitHub handle(s), comma-separated, for your own testing; exempt members still spend the shared budget | Unset unless you're testing on prod yourself |
| `COMMUNITY_SLACK_TEAM_ID` | Optional — unset means a member may connect any Slack workspace. Set, a connect from any other workspace (or one whose `auth.test` fails) is refused and its grant revoked | Your test workspace's `T…` id (see "Community Slack" below) | The community workspace's `T…` id |
| `COMMUNITY_SLACK_INVITE_URL` | Optional — unset (or not `https://`) means no "Join the community Slack first" link in the rail | The test workspace's invite link | The community workspace's never-expiring invite link |

Unset `COMPOSIO_API_KEY`/`COMPOSIO_VERIFIER_URL` together means the whole app
runs in sandbox (drafts approve but nothing sends, nothing captures). Unset
`BROADCAST_*` means no broadcasts, silently — `convex/broadcast.ts` returns
early with no log.

### Composio (~30 min)

1. **Read Composio's own incident post first.** The May 2026 breach is
   confirmed by Composio itself:
   https://composio.dev/blog/composio-may-2026-security-incident (Gmail
   connections, GitHub tokens and API keys exposed; since remediated with
   envelope encryption, scoped keys and an IP allowlist). Decide whether
   Composio may hold members' tokens before going further; Mihir's ruling was
   keep Composio and harden (scoped key, trimmed Gmail scopes — not send-only,
   see "Gmail scope" above — opt-in capture, revoke on disconnect/purge).
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

4. **Decide managed vs. custom auth.** Composio-managed Slack is a user token, so
   sends should post as the member. Before the demo, connect a throwaway Slack account through Composio-managed auth and
   confirm one live send posts *as that person*, not as an app/bot. If it does, `COMPOSIO_AUTH_CONFIG_SLACK` can
   stay unset. If not (or you want the 🧠 capture trigger, which needs a
   custom app regardless — see Step 5), build a custom Slack app.
5. **Custom Slack app, if used:** `slack-app-manifest.yml` in the repo root is
   stale (hackathon-era: it points `redirect_urls` at a `/oauth/callback` path
   that no longer exists, and its `user_scopes` are only `chat:write` +
   `users:read`). Don't paste it as-is. Either edit it or set scopes by hand:
   **user scopes** `chat:write`, `reactions:read`, `channels:history`,
   `channels:read`, `users:read` (`channels:read` confirms a 🧠'd channel is
   public; without it every 🧠 stays owner-only). **Do not add `groups:history`, `im:history` or
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

### Community Slack (~15 min)

The demo's one public workspace: members join it, connect their own Slack
through Composio, and approved Slack drafts post as them there
(Composio's `slack` toolkit is a user token), nowhere else.

- **Create the workspace:** slack.com → Create a workspace, on the free plan.
- **Never-expiring invite link:** Invite people → Copy invite link → Edit link
  settings → Never expires. That link is `COMMUNITY_SLACK_INVITE_URL`; the
  rail shows it to anyone who hasn't connected Slack yet.
- **Team ID:** open the workspace in a browser; the URL is
  `app.slack.com/client/T…/…`, and the `T…` segment is the team ID.
- **Set both on prod** (your terminal, not an agent's):
  `npx convex env set --prod COMMUNITY_SLACK_TEAM_ID T…` and
  `npx convex env set --prod COMMUNITY_SLACK_INVITE_URL https://join.slack.com/…`.
- **App approval:** on a free workspace, members can install apps by default.
  If "App management" is restricted, the workspace owner has to
  approve Composio (or your custom Slack app) before anyone can connect.

### Gmail (~30 min)

7. **Sending.** Leave `COMPOSIO_AUTH_CONFIG_GMAIL` unset and connect through
   Composio's own default managed app — a `gmail.send`-only Composio-managed
   auth config does not connect at all; Google blocks it on Composio's shared
   app. The default managed app's actual grant is `userinfo.email`,
   `userinfo.profile` and `https://mail.google.com/` (full mailbox), which is
   what prod runs on (see "Gmail scope" earlier in this file). For
   least-privilege sending instead, build your own Google OAuth app scoped to
   `gmail.send` only and use it as a **custom** Composio auth config — Testing
   publishing status covers up to 100 test users with no review; opening it to
   everyone needs Google's (free) verification of the `gmail.send` scope.
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
13. **Dev env vars**, from your own terminal, on the deployment you'll test
    with (see the checklist below — not the old dev deployment as it stands):
    `npx convex env set COMPOSIO_API_KEY …` and so on for each var in the
    table.
14. **Deploy in this order.** The old cockpit on prod ignores `needsConnect`,
    so setting the prod Composio vars while it is still live would turn its
    "approve" into a silent no-op for anyone not connected.
    1. Push `connectors`, open a PR to `main`, then `npx convex deploy` (prod)
       **without** any `COMPOSIO_*` var set on prod yet. Safe: the schema is
       additive, and with no Composio vars every draft stays sandboxed.
    2. Merge the PR; wait for Vercel to deploy `main` and confirm the new
       cockpit is live at `https://intern-brain.vercel.app` (the outbox header
       shows `sandbox`/`live`, and the accounts rail is there).
    3. Only then set the prod vars with `--prod` and the `intern-prod`
       values: `COMPOSIO_*`, `BROADCAST_*`.

### First-live-connect checklist

Run through this on a dev deployment first, then again on prod, with two
GitHub accounts (the second one in a private window). `npm run dev` is only
`next dev`: it runs the frontend and never pushes Convex code. The existing dev
deployment (`graceful-albatross-202`) still holds incompatible hackathon rows
and needs a wipe before this schema will push, so test on a **fresh** dev
deployment or a local one (`npx convex dev --local` in its own terminal,
yours to run), pointed at by `.env.local`, with the frontend on a public
HTTPS tunnel for the verifier URL.

- [ ] Connect Gmail. On the connected account, check `requested_scopes` (via
      `GET /connected_accounts/{id}` in the Composio dashboard or API) — on
      the default managed config it's `userinfo.email`, `userinfo.profile`
      and `https://mail.google.com/` (full mailbox, not send-only — see
      "Gmail scope"); on a custom least-privilege config, confirm it's
      `gmail.send` only.
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
of the purge, and deletes any account a still-pending connect link had already
made there.

**The revoke-mid-purge edge.** `forget` is best-effort: if Composio is down or
refuses while a purge runs, our row is already gone and nothing retries, so
the grant lives on at Composio with no row pointing at it. The Convex logs say
`composio delete ca_… failed`; delete that account by hand in the Composio
dashboard. A connect the member finishes *while* their purge runs is refused
(no row of theirs is left) and its account deleted without revoke.

## Ingestion: setup

Sources feed the brain: the community Slack's public channels (live, plus 90
days back), documents members add, and public GitHub repos become
**passages** interns recall ("FROM THE ARCHIVE" in the brief; cited as
`[p:<id>]` in a draft's sources, never in prose). A 🧠, the promote button or
an approved draft that cited one turns a passage into a fact. No model calls,
no paid services. Everything below is manual and uses Mihir's own accounts;
nothing here runs `npx convex dev/deploy/run/env` for you.

**Deployments:** prod `neighborly-peacock-427` (site
`https://intern-brain.vercel.app`). The dev deployment
`graceful-albatross-202` still carries incompatible hackathon rows (see
"Public MVP"); test on a fresh or local deployment, with its own Slack app in
a test workspace pointed at that deployment's `/slack/events`.

### Env vars

All Convex env vars, set from your own terminal (`npx convex env set [--prod]
NAME value` in PowerShell — never paste a secret into chat, and never set
them in Vercel). Each is optional; unset means that part is off.

| Var | Unset means | Where it comes from |
|---|---|---|
| `SLACK_BRAIN_SIGNING_SECRET` | every `/slack/events` call is a 401: no live Slack | Intern Brain app → Basic Information → App Credentials → Signing Secret |
| `SLACK_BRAIN_BOT_TOKEN` | no backfill; authors and new channels show as bare Slack ids | Intern Brain app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`), after installing to the workspace |
| `GITHUB_TOKEN` | repos show "github repos: not set up yet" and can't be added | a fine-grained token, public repositories, read-only (below) |
| `COMMUNITY_SLACK_TEAM_ID` | **already set** (see "Community Slack" above). Ingestion reuses it: unset, every event is ignored (200, nothing stored) | the community workspace's `T…` id |
| `COMMUNITY_SLACK_INVITE_URL` | **already set**. Also drives the one-time "Join the community Slack →" step after consent (hidden once the member's Slack is connected) | the workspace's never-expiring invite link |

`CAP_EXEMPT_HANDLES` also skips the 5 sources/day cap.

### 1. The "Intern Brain" Slack app (Mihir, ~20 min)

A separate app from "Intern" (the one members connect through Composio): a
Slack app delivers its events to one Request URL, and Intern's go to
Composio. Keep it **internal** (installed in the community workspace only,
never distributed), which keeps `conversations.history` at Tier 3 for the
backfill.

1. `api.slack.com/apps` → Create New App → From a manifest → the community
   workspace → paste:
   ```yaml
   display_information:
     name: Intern Brain
     description: Reads this workspace's public channels into the Intern community brain.
   features:
     bot_user:
       display_name: Intern Brain
       always_online: false
   oauth_config:
     scopes:
       bot:
         - channels:history
         - channels:join
         - channels:read
         - reactions:read
         - users:read
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```
   No event subscriptions yet: Slack verifies the Request URL the moment it's
   saved, which needs the code deployed and the signing secret set first
   (step 3). **Never add `groups:*`, `im:*` or `mpim:*`**: private channels
   and DMs are never read. `channels:join` lets the backfill join public
   channels; a bot reads history and hears messages only where it's a member.
2. Install to Workspace. Copy the Bot User OAuth Token
   (`SLACK_BRAIN_BOT_TOKEN`) and the Signing Secret
   (`SLACK_BRAIN_SIGNING_SECRET`) — paste both into the env-var commands in
   your own terminal (below), not into chat.
3. After the deploy and env below: Features → Event Subscriptions → on →
   Request URL `https://neighborly-peacock-427.convex.site/slack/events` (it
   should say Verified) → Subscribe to bot events: `message.channels`,
   `reaction_added` → Save, and reinstall if Slack asks. Equivalent manifest
   addition under `settings`:
   ```yaml
     event_subscriptions:
       request_url: https://neighborly-peacock-427.convex.site/slack/events
       bot_events:
         - message.channels
         - reaction_added
   ```
4. **Tell the workspace.** Set `#all-intern-community`'s description (or
   `COMMUNITY_SLACK_CHANNEL`'s, if renamed), and pin a message there:
   "Public channels are read into the Intern brain
   (https://intern-brain.vercel.app). Private channels and DMs never are."

A member who 🧠s a message now reaches both paths (their Composio grant and
Intern Brain). That's expected: the second one finds the first one's fact by
its `slack:<channel>:<ts>` key and files nothing new.

### 2. The GitHub token (Mihir, ~5 min)

1. Go to `github.com/settings/personal-access-tokens/new`.
2. Name it `intern-brain-read`; expiration: the longest allowed (put the
   renewal in your calendar).
3. Resource owner: your account. Repository access: **Public repositories**
   (read-only, no extra permissions).
4. Generate, and keep the value for the env-var step below — that's
   `GITHUB_TOKEN`: one token for the whole community, because GitHub's
   anonymous limit is 60 calls an hour.

When it expires, every repo's next daily read fails with "Couldn't read this
repo from GitHub." until it's replaced.

### 3. Deploy and set env (needs Mihir's go-ahead)

1. `npx convex deploy` (prod). The schema is additive (`sources`,
   `passages`, `slackUsers`, `facts.fromPassageId`,
   `connections.by_externalUserId`), so it's safe before the frontend. It's
   also the first bundle of `convex/documents.ts` (`"use node"`, `unpdf`,
   which declares `engines.node >= 22`): `convex.json` now pins
   `node.nodeVersion` to `"22"` for this. If the bundler still rejects
   `unpdf`, add `"externalPackages": ["unpdf"]` under `node` in
   `convex.json` and deploy again. The brief's `PROMPT_VERSION` changes with
   this deploy (the archive section), so `/stats` starts a new series.
2. Set the three new vars with `--prod`, from your own terminal (the two
   `COMMUNITY_SLACK_*` ones are already there):
   ```
   npx convex env set --prod SLACK_BRAIN_SIGNING_SECRET <signing secret>
   npx convex env set --prod SLACK_BRAIN_BOT_TOKEN <xoxb-…>
   npx convex env set --prod GITHUB_TOKEN <github_pat_…>
   ```
3. Then Event Subscriptions (section 1, step 3).
4. Merge to `main`; Vercel deploys the cockpit.
5. **Refresh the seeded "What Intern is" fact.** `seed:run` never re-runs on
   a deployment that already has starter facts, so prod's row still needs
   the sentence now in `convex/seed.ts`. Claude runs `npx convex run --prod
   seed:refresh` after deploy (with your yes, prod): it finds each ownerless
   seed fact by title and patches `body`/`text` when they differ from
   `SEED`; a second run updates 0.

### 4. Backfill (Mihir, from the Convex dashboard, ~2 min)

1. Prod dashboard → Functions → `ingest:backfillSlack` → Run with `{}`.

It returns `{ channels: N }`, joins each public channel, and reads its last
90 days one page every 1.5 s, one channel after another; the logs show
`backfill:` only on failure. Safe to re-run at any time: passages upsert and
a channel part-way through resumes from its source's `cursor`. **Re-run it
after creating a public channel**, so the bot joins it; until then that
channel isn't read.

### 5. First-live checklist

- [ ] Post in a public channel: within seconds a `#channel` source node is in
      the graph; clicking it lists the message under the poster's name (or
      `@handle` if they connected that Slack account).
- [ ] Edit it: the passage changes. React 🧠: a public fact hangs off the
      channel node, once, even though your own Composio 🧠 also fired.
      Delete the message: passage and fact both go.
- [ ] Post in a private channel and DM the bot: nothing appears.
- [ ] Brief an intern about something said in Slack: its log says `read N
      passages from the archive`, and no `[p:…]` id shows in its prose;
      approve a draft whose sources cite `[p:…]`: the passage becomes a
      fact, once.
- [ ] Add a URL, a markdown upload, a PDF with text and a scanned PDF (the
      scan fails: "That PDF has no text in it…"), a private document (a second
      account can't see it in the graph, the rail or recall), and a public
      repo `owner/repo` (README, issues and PRs as passages; a private repo
      fails "Only public repos can be added."). The sixth source of the day
      is refused, under the form.
- [ ] Remove a source: its passages go, promoted facts stay. The feed and the
      broadcast channel show "@you added a source: …" for public ones only;
      `/u/<you>` lists them.
- [ ] Sign in fresh with an account whose Slack isn't connected: after the
      notice (which now names sources and the community Slack), one "Join the
      community Slack →" step with Skip.

### Admin

`sources`, `passages` and `slackUsers` are in the Convex dashboard's data
tables. `users:ban` purges a member's documents, repos, their passages and
uploaded files (Slack passages belong to the community and stay; deleting the
message in Slack removes one). The `/slack/events` log lines name event ids
and kinds only, never message text.
