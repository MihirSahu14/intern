# Handover

State of the build as of 9 Aug 2026, ~16:20. Written for whoever picks this up next.

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

## Next, in priority order

1. ~~Rewrite the four positioning facts~~ · ~~fix the interleaved stream~~ ·
   ~~kill the roster~~ — all done, see above.
2. **Rebuild Scout** and re-run one brief. `scout/scout/contexts.py` now gives
   the web sub-agent serial tool calls and a three-search budget, because
   firing six searches at once pinned the OpenAI 200k TPM ceiling and the last
   ninety seconds of a run were 429s and empty results. **This one is not
   verified** — it needs `docker compose up -d --build scout-api` and a real run.
3. **Watch for a schema fight.** Every `npx convex dev --once` from this branch
   deletes `actions.by_ownerId`, `actions.by_ownerId_and_status` and
   `interns.by_userId_and_status`. Those indexes are on the *deployed* schema
   but not in `convex/schema.ts` here, so someone else's branch has an `ownerId`
   this one does not. Reconcile before either of you pushes again.
4. **VoiceOS** — nothing to build. Point it at `http://localhost:3000/api/mcp`,
   or `ngrok http 3000` if it's on another machine.

For the two-person demo, Andrew needs the three `NEXT_PUBLIC_CONVEX_*` /
`CONVEX_DEPLOYMENT` values plus `SCOUT_API_URL=http://<your-lan-ip>:8000`, so
both cockpits say LIVE against one brain.

**Run the whole flow once before presenting** — sign in, brief that drafts to
Slack, approve it. The first end-to-end run should not be on stage.
