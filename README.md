# Intern

A terminal for one public, shared brain.

Sign in with GitHub and you are in the same brain as everyone else: a graph of
what the community has taught it, and **interns** — short runs you dispatch at a
brief and watch. An intern recalls what is already in the brain, thinks, and
either files what it learned, asks a question it can't answer from the brain, or
drafts something and stops for you.

Everything anyone does is public by design. Nothing is ever sent.

```bash
npm run dev        # cockpit → localhost:3000
npx convex dev     # the backend (one watcher at a time)
```

## How a run works

```
spawn (mutation)          caps checked, row inserted, action scheduled
  → internal.run.go       recall → one streamed model call → parse
      → finish (mutation) facts, a draft, or a question — one transaction
```

There is no separate agent service. The whole run is a Convex action calling
any OpenAI-compatible model over plain `fetch` (`lib/model.ts`; Groq by
default), so the API key lives on the Convex deployment and never reaches a
browser.

An intern ends its report with a fenced ` ```action ` or ` ```question ` block.
`lib/action-block.ts` and `lib/parse.ts` parse them, and say *why* a block was
unusable rather than dropping it — the cockpit shows that as a failed parse, and
`/stats` counts it.

## Approvals are a sandbox

A draft lands in the outbox and waits for the person who briefed it. Approving
files the decision and **sends nothing** — there is no connector, no webhook, no
outbound path in this repo at all. The button says `approve (sandbox)` and the
result says so too.

That still teaches it something, which is the point. Rewrite the draft in place
before approving and the difference is filed as a *preference*; reject it with a
reason and the reason is filed as a *correction*. The next intern recalls both
before it starts. No training job — a correction is a fact, facts are retrieved
by the next brief, behaviour changes.

## Asking instead of guessing

When the brief leaves out something the brain can't settle — who someone reports
to, which of two people was meant — the intern parks and asks. Answering files
the answer as a fact **first**, so every future task has it, then dispatches a
fresh intern that picks the work back up with the answer attached (subject to
the caps).

## Caps

It's a public instance on a free-tier key, so limits are in one file,
`lib/caps.ts`, and enforced inside mutations (which Convex runs serializably, so
two tabs can't race the fifth brief):

| Limit | Per |
|---|---|
| 5 briefs | person, per UTC day |
| 1 intern working | person |
| 20 facts | person, per UTC day |
| $5 of model spend | everyone, per UTC day |

A run that dies on Gemini's free-tier 429 with nothing to show for it doesn't
cost a brief. `/stats` is live, from real runs: action-block parse rate,
approved-unedited rate, and the edit rate split by whether the run recalled a
correction — the last one is the learning loop, measured.

## Tests

```bash
npm test          # pure logic: caps, prompt, parsers, edits
npx vitest run    # the Convex functions, against convex-test
npm run eval      # 20 fixed briefs through the live prompt (costs tokens)
```

`npm run eval` exits non-zero if the action parse rate drops under 90% or if
more than a quarter of the briefs errored, so an outage can't read as a pass.

## Layout

```
convex/interns.ts   spawn, cancel, and every write a finished run makes
convex/run.ts       the action: recall → the model → parse → finish
convex/facts.ts     teach, recall, and the graph the cockpit draws
convex/outbox.ts    approve/reject, and the fact each decision leaves behind
convex/questions.ts what interns are parked on, and resuming them
convex/community.ts the feed, the landing counts, /stats
convex/users.ts     consent, delete-my-stuff, ban

lib/caps.ts         every limit, as pure arithmetic
lib/model.ts        streamed OpenAI-compatible chat completions over fetch, no SDK
lib/brief.ts        the prompt, versioned
lib/action-block.ts the action block an intern ends its report with

components/Cockpit.tsx     the signed-in app
components/BrainGraph.tsx  canvas force-directed graph, no graph library
```

[`docs/HLD.md`](./docs/HLD.md) is the older, larger design this was cut down
from. Read it as intent, not as a description of this code.
