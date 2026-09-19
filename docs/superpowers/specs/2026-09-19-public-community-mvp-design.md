# Public community MVP — design

Date: 2026-09-19 · Status: approved in brainstorming, awaiting spec review

## Goal

A public "try it and see" instance of Intern. Every trial user shares one brain,
so visitors see who else tried it and what they added. Scope: about 9 working
days. Zero fixed cost: pay-per-token Gemini only, Vercel Hobby, Convex free tier.

## Decisions

| Question | Decision |
|---|---|
| First 2 minutes | Brief an intern → watch it recall facts → approve/edit the draft → the edit becomes a fact |
| Sends | Sandbox only. Approving never sends anything. Own accounts (Slack/Gmail) are a later phase |
| Sign-in | GitHub OAuth only (Convex Auth). Password provider removed |
| Spend | $5/day global, enforced in code. No always-on paid servers |
| Direction | Undecided. Ship the community brain, learn from usage. No tenant/workspace code |
| VoiceOS / MCP | Not needed. `/api/mcp` and `lib/mcp.ts` are deleted |

## Why the engine moves

The intern engine lives in the memory of one Next.js process (`lib/store.ts`:
interns, queue, outbox, questions and the SSE bus on `globalThis`). On Vercel,
each request can hit a different short-lived instance and background work is
frozen after the response returns, so a run started by `POST /api/interns` is
likely never seen by `GET /api/events` and may never finish. Day 1 confirms this
on the live site before any porting starts.

## 1. Run engine (Convex)

Flow:

1. `interns.spawn` (mutation): checks auth, consent, ban and caps (section 2), inserts an
   `interns` row with status `queued`, schedules `internal.run.go`.
2. `run.go` (action, plain `fetch`, no `"use node"`):
   - Recalls facts with a Convex query: the latest correction facts plus a
     `search_label` search on the task. Replaces the in-memory `brain.recall` /
     `brain.preferences`.
   - Streams Gemini (logic from `lib/gemini.ts`), appending a `logs` row about
     every 160 chars so the terminal fills live.
   - Parses the full report with `lib/action-block.ts` plus the question and fact
     parsers, moved out of `store.ts` into `lib/parse.ts` so Convex and tests
     share them.
   - Writes results: `fact` blocks → `facts` (max 3); action block → `actions`
     (`proposed`); question block → `questions` (intern parked, run ends).
   - Records `tokensIn`, `tokensOut` (Gemini `usageMetadata`), latency and parse
     outcome on the intern row; adds cost to today's `usage` row.
   - On error: status `failed`, error text on the row and in `logs`.
3. `actions.decide` (mutation): approve / edit-then-approve / reject by the owner.
   An edit creates a correction fact (the existing learning loop). Status becomes
   `approved`; nothing is sent.
4. Answering a question (mutation) re-spawns the intern with the answer appended,
   as `resumes` does today. It counts toward the per-user cap.
5. `Cockpit.tsx` replaces the SSE `fetch` with `useQuery` on interns, logs,
   actions, questions and facts.

Deleted: `lib/store.ts` singleton, `/api/events`, `/api/interns`, `/api/outbox`,
`/api/questions`, `/api/ask`, `/api/capture`, `/api/brain`, `/api/trust`,
`/api/connectors`, `/api/slack`, `/api/mcp`, `lib/mcp.ts`, `lib/notify.ts`,
`lib/sim.ts`, Scout `runLive`, `probe()` and the LIVE/SIM badge. Anything still
needed from these routes moves to Convex functions. `scout/` stays in the repo,
unused. The exact deletion list is confirmed while writing the plan, by grepping
each file's importers.

**Schema changes** (applied after the brain wipe, so no rows violate them):
- `facts.ownerId`: optional; seed facts have none. Add index `by_ownerId_and_observedAt`.
- `interns`: add the eval fields from section 4 and an index on owner + creation time.
- `questions`: new table, because questions move out of process memory.
- `usage`: new table, `{ date: "YYYY-MM-DD", costUsd, runs }`, with index `by_date`.
- `users`: add `acceptedAt`, `bannedAt`, `githubId`, `handle`, `avatarUrl`.
- Reconcile the index drift noted in `HANDOVER.md` ("Watch for a schema fight")
  before the first push.

## 2. Public guardrails

**Sign-in and consent**
- GitHub provider in `convex/auth.ts` (`AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`).
  Store GitHub handle and avatar on `users`.
- First sign-in shows a consent screen: "This is a public test brain. Everything
  you type (briefs, facts, drafts) is visible to every other visitor. Don't
  enter anything private." Accepting sets `users.acceptedAt`. Every mutation
  refuses users without it.
- A thin banner in the cockpit repeats the warning.

**Caps.** All caps are checked inside the `spawn` / fact-capture mutations, so
they are transactional. Days are UTC.

| Cap | Value | Mechanism |
|---|---|---|
| Global spend | $5.00/day | `usage` table, one row per UTC date, `costUsd` incremented after each run from token counts × model price constants |
| Briefs per user | 5/day | count `interns` by owner since 00:00 UTC |
| Concurrent per user | 1 | any owner intern `queued` or `running` |
| Facts per user | 20/day | count `facts` by owner since 00:00 UTC |
| Input size | brief ≤ 2,000 chars, fact ≤ 1,000 chars, output ≤ 4,096 tokens | validators + existing `maxOutputTokens` |

- A refused spawn returns the reason and "resets at 00:00 UTC", shown in the
  command bar.
- The cap uses actual spend, so runs already in flight can overshoot it (under
  $0.05). This is accepted.
- Pure cap math lives in `lib/caps.ts` so it can be unit-tested.
- Mihir also sets a Google Cloud budget alert as a backstop, since Google alerts
  on budgets but does not stop spending.

**Sandbox**
- Remove the Connect Slack/Google UI (`components/Cockpit.tsx` connect flow).
- Delete the `SLACK_BOT_TOKEN` fallback in `convex/slack.ts` (`deliveryFor`).
- Approving writes `approved` and a line "Sandbox: nothing was sent."
- The `connections`/`providers`/`gmail` code stays for the own-accounts phase,
  but it is unreachable from the UI.

**Abuse and PII**
- "Delete everything I added": a mutation removes the caller's facts, interns,
  logs, actions and questions.
- Admin: GitHub ids in the `ADMIN_GITHUB_IDS` env. An admin can delete any item
  and set `users.bannedAt`. Banned users are refused in every mutation.
- No automated moderation. Gemini's safety filters apply. Add moderation only if
  abuse appears.

**Launch hygiene (blocks launch)**
1. Wipe the brain: the hackathon runs stored contacts with names and roles.
   Reseed only the Intern positioning facts.
2. Delete `HANDOVER.md:61` (account line). The password stays in git history and
   is treated as burned.
3. Mihir: change that password and rotate the Gemini, Slack, Google OAuth and
   OpenAI keys.

## 3. Visitor experience

- **Landing (`/`)**: the existing live graph plus one stats line ("N people have
  tried it · M facts · K drafts approved") and a single **Try it with GitHub**
  button.
- **Consent screen**, then the cockpit (`/app`).
- **Cockpit**:
  - The command bar shows 3 clickable example briefs that hit the brain:
    1. "Draft a Slack post introducing Intern to a new teammate"
    2. "Write a follow-up email to someone who asked what Intern does"
    3. "What has the community taught the brain today? Summarise it."
  - The right rail carries a community feed: the last 30 events across all users,
    each with GitHub avatar and handle.
- **Run**: the terminal streams, and "recalled N facts" lists the ids, which
  pulse on the graph.
- **Draft**: the outbox shows the draft, its rationale and the cited facts.
  - Approve: "Approved. Sandbox: nothing was sent."
  - Edit: shows the diff and "Learned: …", and a new fact node appears labelled
    with the editor's handle.
  - Reject.
- **Questions** are answered inline in the cockpit.
- **Visibility**: everyone reads everything. Only the owner (or an admin) can
  approve, edit, answer or delete an item.
- Out of scope: notifications, profiles, search UI, mobile beyond "doesn't break".

## 4. Eval data, testing, rollout

**Logged per run**
- `interns`: `promptVersion` (hash of the brief template), `recalledFactIds`,
  `tokensIn`, `tokensOut`, `latencyMs`, `parseOutcome`. The outcome is one of
  `action`, `action_malformed:<reason>`, `question`, or `none`.
- `actions`: `decision` (`approved_unedited` | `edited` | `rejected`),
  `changedFields`, `editRatio` (changed chars / total chars).

**`/stats`** (public, one query):
1. Action-block parse rate
2. Unedited-approval rate
3. Edit rate for drafts whose run recalled a correction fact vs. drafts whose run
   did not

**`scripts/eval.ts`**: 20 fixed briefs run against the current prompt. It reports
the parse rate and missing required fields per brief. Cost is about $0.10 per run.
Run it by hand before every prompt change.

**Tests**
- Existing `lib/*.test.ts` stay green. The parser tests move with the parsers to
  `lib/parse.test.ts`.
- New `lib/caps.test.ts`: UTC day rollover, per-user limit, concurrent limit,
  global $ limit.
- Manual E2E on a Vercel preview with two GitHub accounts:
  - A briefs, drafts and edits; the learned fact appears.
  - B's run recalls A's fact.
  - The cap message shows when the limit is hit.
  - "Delete everything I added" removes only the caller's items.

**Timeline**

| Day | Work |
|---|---|
| 1 | Launch hygiene, confirm the Vercel breakage, GitHub auth + consent |
| 2–5 | Run engine into Convex, cockpit onto `useQuery`, delete store/SSE/MCP/Scout path |
| 6 | Caps, sandbox, delete-mine, admin ban |
| 7 | Community feed, landing stats, example briefs |
| 8 | Eval logging, `/stats`, `scripts/eval.ts` |
| 9 | Two-account E2E on preview, then launch |

**Git**: feature branch, then a PR on `origin` (`MihirSahu14/intern`). Nothing
goes to upstream.

## Later (not in this MVP)

- Own accounts: Slack public distribution + per-user OAuth; Gmail after Google
  verification.
- Per-company private brains, if usage says the community brain is an on-ramp.
- Automated moderation, if abuse appears.
