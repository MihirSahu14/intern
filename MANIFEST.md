# Intern — setup manifest

Every credential this project needs and where it lives. There are only two
places, and the split is simple: **the browser needs the Convex URLs, the
Convex functions need everything else.**

| Store | Read by | Committed? |
|---|---|---|
| `.env.local` | `next dev` / `next build` and the Convex CLI | no (gitignored) |
| Convex deployment env (`npx convex env set`) | the Convex functions themselves | n/a, lives in the cloud |

Putting a value in the wrong one fails silently, so: if a function in `convex/`
reads it, it goes on the deployment.

---

## `.env.local`

Three values, all written by `npx convex dev`. See `.env.local.example`.

```
CONVEX_DEPLOYMENT
NEXT_PUBLIC_CONVEX_URL
NEXT_PUBLIC_CONVEX_SITE_URL
```

## Convex deployment env

```sh
npx convex env list          # prints VALUES — careful
npx convex env set KEY value
```

| Key | Unlocks | Set by |
|---|---|---|
| `MODEL_API_KEY` | interns thinking at all — without it every run fails | you, from the provider (Groq's console by default) |
| `MODEL_BASE_URL` | optional override; defaults to Groq, `https://api.groq.com/openai/v1` | you |
| `MODEL_NAME` | optional override; defaults to `openai/gpt-oss-20b` | you |
| `MODEL_USD_PER_M_IN` / `MODEL_USD_PER_M_OUT` | optional override of the $5/day cap's per-token price; defaults to Groq's paid gpt-oss-20b rate | you |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | GitHub sign-in, the only way in | a GitHub OAuth App |
| `SITE_URL` | where the OAuth callback returns to | you |
| `JWKS` / `JWT_PRIVATE_KEY` | session tokens | `npx @convex-dev/auth`, once |

The GitHub OAuth App's **Authorization callback URL** is
`<NEXT_PUBLIC_CONVEX_SITE_URL>/api/auth/callback/github`. Nothing else is
registered with any third party: there are no Google, Slack or webhook
credentials any more, because there is no outbound path — approvals are a
sandbox and nothing is ever sent.

---

## Admin

There is no admin UI. Use the Convex dashboard's function runner:

```
users:ban            {"handle": "someone"}      bans and purges everything they added
users:purge          {"userId": "..."}          purge alone
```

Dashboard: https://dashboard.convex.dev/d/graceful-albatross-202

---

## Known hazards

**Shared dev deployment.** `graceful-albatross-202` is a personal dev
deployment, and Convex dev deployments are single-developer by design —
**whoever pushes last wins, for everyone.** Agree on one `npx convex dev`
watcher; everyone else uses `npx convex dev --once`. It still holds the
hackathon data and was never wiped, so a schema push can fight rows that
predate this branch.

**`JWT_PRIVATE_KEY` was printed to a chat transcript.** If that log is shared,
rotate: delete the var and re-run `npx @convex-dev/auth`.

**The brain is public.** Every brief, fact and draft is readable by anyone
signed in, and the consent gate says so before anyone can write. Don't paste
anything into it you wouldn't publish.

---

## Quick reference

```sh
npm run dev                # cockpit → localhost:3000
npx convex dev             # function watcher (one person at a time)
npx convex dev --once      # push once and exit
npm test                   # pure logic
npx vitest run             # the Convex functions
npm run eval               # 20 briefs through the live prompt (costs tokens)
```

Command bar: bare text is a brief · `spawn <task>` · `capture <what you know>` ·
`approve <id>` · `reject <id> <reason>` · `answer <id> <text>` · `kill <id>` ·
`focus <id>` · `clear` · `help`
