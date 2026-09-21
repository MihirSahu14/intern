# Public Community MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Intern into a public "try it" instance: GitHub sign-in, one shared brain, interns run inside Convex, drafts are sandbox-only, with spend/rate caps and eval logging.

**Architecture:**
- The in-memory engine in `lib/store.ts` (Next process) is replaced by Convex:
  - a `spawn` mutation checks the caps and schedules an internal action
  - the action recalls facts, streams Gemini, and writes log lines
  - one `finish` mutation files the facts, the draft or the question
- The cockpit reads everything with `useQuery`. The SSE bus and every `/api/*` route are deleted.
- Pure logic (caps, parsers, edit diffing, the brief) lives in `lib/*.ts` with node tests, and is imported by both Convex and `scripts/eval.ts`.

**Tech Stack:**
- Next.js 16.3 (App Router), React 19, Tailwind 4
- Convex 1.43 with `@convex-dev/auth` 0.0.94 (GitHub via `@auth/core`)
- Gemini over plain `fetch`
- `node --test` with `--experimental-strip-types`

**Spec:** `docs/superpowers/specs/2026-09-19-public-community-mvp-design.md`

## Global Constraints

- Caps (UTC days):
  - $5.00/day global
  - 5 briefs/day per user; a Gemini 429 does not count
  - 1 intern queued or running per user
  - 20 facts/day per user
  - brief ≤ 2,000 chars, fact ≤ 1,000 chars, output ≤ 4,096 tokens
- Sandbox: nothing is ever sent. Approve copy says: `Approved. Sandbox: nothing was sent.`
- Consent copy, verbatim: `This is a public test brain. Everything you type (briefs, facts, drafts) is visible to every other visitor. Don't enter anything private.`
- 429 copy, verbatim: `The free model is busy, try again in a minute.`
- Every public Convex function has arg validators. Every write derives the user server-side (`requireMember`), never from args.
- Read `convex/_generated/ai/guidelines.md` before touching `convex/`. Read the relevant page under `node_modules/next/dist/docs/01-app/` before adding a Next page.
- Runtime imports between `lib/` files, and from `convex/` into `lib/`, spell out the `.ts` extension (node's type stripper needs it; esbuild accepts it).
- Branch: `public-mvp`, off `public-mvp-spec`. Commit after every task. Push to `origin` only when Mihir says so. Never push to `upstream`.

## Deviations from the spec (decided while planning; flag to Mihir at handoff)

1. **Launch on a new Convex *production* deployment.**
   - Today the live Vercel site points at the *dev* deployment (`dev:graceful-albatross-202`, `SITE_URL=http://localhost:3000`), and there is no prod deployment.
   - Dev gets backed up and wiped (the schema push needs empty tables anyway).
   - Prod starts clean with only the seed facts.
   - End-to-end testing happens on the production URL before anyone is told. A Vercel preview can't sign in: each deployment has one `SITE_URL`, so the GitHub redirect lands on prod.
2. **Admin tools are the Convex dashboard plus one internal `users:ban` mutation.** No admin UI and no `ADMIN_GITHUB_IDS`. The dashboard already deletes any document and runs internal functions, and it works from a phone.
3. **The Slack/Google connection code is deleted, not parked.** Tag `pre-public-mvp` keeps it for the own-accounts phase. Leaving public `connections.start` etc. deployed is attack surface.
4. **Outbox and Asks panes show only your own items.** Other people's drafts and questions appear in the feed and on the graph. Only the owner can act on them anyway, so this needs no Outbox rewrite.
5. **No "confirm the Vercel breakage" step.** Approach A is right either way (free, durable, eval data).
6. **The live cockpit at `/app` is broken from Task 2 until Task 10.** The landing page `/` keeps working (its graph is seeded).

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/caps.ts` (+test) | new | Limits, UTC day math, cost, "is this blocked and why" |
| `lib/parse.ts` (+test) | new | ```fact and ```question block parsers (moved out of `store.ts`) |
| `lib/edits.ts` (+test) | new | Changed fields, edit ratio, correction-fact text |
| `lib/brief.ts` (+test) | new | The intern prompt and `PROMPT_VERSION` |
| `lib/gemini.ts` | modify | Also yield token usage; put the HTTP status in errors |
| `convex/schema.ts` | rewrite | New tables: users (auth + profile), facts, interns, logs, actions, questions, usage |
| `convex/auth.ts` | rewrite | GitHub provider with handle/avatar profile |
| `convex/access.ts` | new | `requireMember`, `ownerView` helpers |
| `convex/users.ts` | rewrite | viewer, accept, deleteMine, purge, ban |
| `convex/facts.ts` | new | teach, insertFact, recall, graph |
| `convex/interns.ts` | rewrite | spawn/dispatch (caps), cancel, list, logs, start, noteRecall, appendLog, finish, fail |
| `convex/run.ts` | new | `go` internal action: recall → Gemini → finish |
| `convex/outbox.ts` | rewrite | list, decide (approve/edit/reject → learned fact) |
| `convex/questions.ts` | new | list, answer (→ fact + resume), dismiss |
| `convex/community.ts` | new | feed, landing counts, eval stats |
| `convex/seed.ts` | new | Internal `run` that inserts the 3 positioning facts |
| `convex/http.ts` | rewrite | Auth routes only |
| `convex/{brain,log,connections,gmail,providers,slack,tokens}.ts` | delete | |
| `app/api/**`, `lib/{store,brain,mcp,notify,sim,scout,scout.test,trust,auth,convex}.ts`, `lib/connectors/`, `components/Trust.tsx` | delete | |
| `components/Gate.tsx`, `SignIn.tsx` | rewrite | GitHub button, consent gate, ban notice |
| `components/Consent.tsx`, `Feed.tsx`, `LandingStats.tsx` | new | |
| `components/Cockpit.tsx` | rewrite | `useQuery`/`useMutation` instead of SSE and fetch |
| `components/BrainRail.tsx`, `Outbox.tsx`, `CommandBar.tsx` | modify | Drop the LIVE/SIM, senders and trust sections; sandbox copy; new help |
| `app/page.tsx` | modify | CTA copy plus `LandingStats` |
| `app/stats/page.tsx` | new | Three eval numbers |
| `scripts/eval.ts` | new | 20-brief offline eval |
| `HANDOVER.md` | modify | Drop the account line |

---

### Task 1: Branch, tag, back up, wipe dev, remove the leaked line

**⚠ Destructive: wipes the dev Convex deployment. Get Mihir's explicit "yes, wipe dev" in chat before Step 4.**

**Files:**
- Modify: `HANDOVER.md:61-62`, `.gitignore`

- [ ] **Step 1: Branch and tag the last version that has the connection code**

```bash
git checkout public-mvp-spec
git checkout -b public-mvp
git tag pre-public-mvp main
```

- [ ] **Step 2: Remove the account line from HANDOVER.md**

Replace lines 61–62:
```
**Accounts:** `mihirs1410@gmail.com` / `intern-demo-2026`. Andrew has his own.
There is a junk `demo@intern.test` row — delete from the Convex dashboard.
```
with:
```
**Accounts:** GitHub sign-in only (since the public MVP). The old demo password
was published in this file and is burned.
```

- [ ] **Step 3: Back up dev locally (contains PII, so keep it out of git)**

Add to `.gitignore`:
```
# convex snapshots — contain user data
/backups/
```
Run:
```bash
npx convex export --path backups/dev-pre-public-mvp.zip
```
Expected: `Downloaded snapshot ... backups/dev-pre-public-mvp.zip`.

- [ ] **Step 4: Wipe every dev table (only after Mihir's yes)**

```bash
printf "" > backups/empty.jsonl
for t in facts relations observations decisions interns logs actions connections slackThreads oauthStates users authAccounts authSessions authRefreshTokens authVerificationCodes authVerifiers authRateLimits; do
  npx convex import --table "$t" --replace -y backups/empty.jsonl
done
```
Expected: each prints `Imported 0 rows`. A table that doesn't exist yet may error; that's fine.

- [ ] **Step 5: Commit**

```bash
git add HANDOVER.md .gitignore
git commit -m "Drop the published demo password, and keep convex snapshots out of git"
```

---

### Task 2: Pure logic: caps, parsers, edits, brief, Gemini usage

**Files:**
- Create: `lib/caps.ts`, `lib/caps.test.ts`, `lib/parse.ts`, `lib/parse.test.ts`, `lib/edits.ts`, `lib/edits.test.ts`, `lib/brief.ts`, `lib/brief.test.ts`
- Modify: `lib/gemini.ts`

**Interfaces (produced, used by Tasks 4–9):**
```ts
// lib/caps.ts
BRIEFS_PER_DAY = 5; FACTS_PER_DAY = 20; DAILY_BUDGET_USD = 5; MAX_BRIEF_CHARS = 2000; MAX_FACT_CHARS = 1000
dayStart(now: number): number; dayKey(now: number): string   // "YYYY-MM-DD", UTC
costUsd(tokensIn: number, tokensOut: number): number
spawnBlocked(s: { briefsToday: number; active: boolean; spentToday: number }): string | null
teachBlocked(factsToday: number): string | null
// lib/parse.ts
type FactBlock = { title: string; body: string; kind: "note" | "decision" | "preference" | "correction" }
parseFactBlocks(report: string): FactBlock[]
parseQuestionBlock(report: string): { question: string; context: string } | { error: string } | null
// lib/edits.ts
type Field = "to" | "cc" | "subject" | "body"
changedFields(proposed: Draft, accepted: Draft): Field[]
editRatio(proposed: Draft, accepted: Draft): number          // 0..1
correctionFromEdit(kind: string, proposed: Draft, accepted: Draft, fields: Field[]): { title: string; body: string }
correctionFromReject(kind: string, draft: Draft, reason: string): { title: string; body: string }
// lib/brief.ts
type Recalled = { id: string; title: string; body: string }
brief(task: string, recalled: Recalled[]): string
PROMPT_VERSION: string
// lib/gemini.ts
stream(prompt, opts?) yields { text?: string; usage?: { in: number; out: number }; done?: boolean }
errors thrown as `gemini <status>: <message>`
```

- [ ] **Step 1: Write the failing tests**

`lib/caps.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIEFS_PER_DAY,
  FACTS_PER_DAY,
  costUsd,
  dayKey,
  dayStart,
  spawnBlocked,
  teachBlocked,
} from "./caps.ts";

test("a day is a UTC day", () => {
  const lastSecond = Date.UTC(2026, 8, 19, 23, 59, 59);
  assert.equal(dayStart(lastSecond), Date.UTC(2026, 8, 19));
  assert.equal(dayKey(lastSecond), "2026-09-19");
  assert.equal(dayKey(lastSecond + 1000), "2026-09-20");
});

test("cost is priced per million tokens", () => {
  assert.equal(costUsd(1_000_000, 0), 0.3);
  assert.equal(costUsd(0, 1_000_000), 2.5);
});

test("a brief under every limit goes through", () => {
  assert.equal(
    spawnBlocked({ briefsToday: BRIEFS_PER_DAY - 1, active: false, spentToday: 4.99 }),
    null,
  );
});

test("the sixth brief of the day is refused, with when it resets", () => {
  const why = spawnBlocked({ briefsToday: BRIEFS_PER_DAY, active: false, spentToday: 0 });
  assert.match(why ?? "", /5 briefs/);
  assert.match(why ?? "", /00:00 UTC/);
});

test("one intern at a time", () => {
  assert.match(spawnBlocked({ briefsToday: 0, active: true, spentToday: 0 }) ?? "", /already/);
});

test("the community budget outranks everything", () => {
  assert.match(spawnBlocked({ briefsToday: 0, active: true, spentToday: 5 }) ?? "", /budget/);
});

test("facts cap at twenty a day", () => {
  assert.equal(teachBlocked(FACTS_PER_DAY - 1), null);
  assert.match(teachBlocked(FACTS_PER_DAY) ?? "", /20 facts/);
});
```

`lib/parse.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFactBlocks, parseQuestionBlock } from "./parse.ts";

const fence = (tag: string, body: string) => "```" + tag + "\n" + body + "\n```";

test("fact blocks: at most three, bad JSON skipped, unknown kind becomes note", () => {
  const report = [
    fence("fact", '{"title":"A","body":"a","kind":"decision"}'),
    fence("fact", "{not json"),
    fence("fact", '{"title":"B","kind":"person"}'),
    fence("fact", '{"title":"C"}'),
    fence("fact", '{"title":"D"}'),
  ].join("\n");
  assert.deepEqual(parseFactBlocks(report), [
    { title: "A", body: "a", kind: "decision" },
    { title: "B", body: "", kind: "note" },
    { title: "C", body: "", kind: "note" },
  ]);
});

test("fact blocks without a title are dropped", () => {
  assert.deepEqual(parseFactBlocks(fence("fact", '{"body":"x"}')), []);
});

test("question block: parsed, missing, and broken", () => {
  assert.deepEqual(
    parseQuestionBlock(fence("question", '{"question":"Who?","context":"ctx"}')),
    { question: "Who?", context: "ctx" },
  );
  assert.equal(parseQuestionBlock("no block here"), null);
  assert.deepEqual(parseQuestionBlock(fence("question", "{oops")), {
    error: "question block was not valid JSON",
  });
  assert.deepEqual(parseQuestionBlock(fence("question", '{"context":"x"}')), {
    error: "question block had no question",
  });
});
```

`lib/edits.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { changedFields, correctionFromEdit, editRatio } from "./edits.ts";

const draft = { to: ["#general"], subject: "", body: "Hello team, meet Intern." };

test("an untouched draft has no changes and ratio 0", () => {
  assert.deepEqual(changedFields(draft, { ...draft }), []);
  assert.equal(editRatio(draft, { ...draft }), 0);
});

test("whitespace-only edits don't count", () => {
  assert.deepEqual(changedFields(draft, { ...draft, body: `  ${draft.body}\n` }), []);
});

test("a body rewrite is detected and sized", () => {
  const accepted = { ...draft, body: "Hi all, meet Intern." };
  assert.deepEqual(changedFields(draft, accepted), ["body"]);
  const r = editRatio(draft, accepted);
  assert.ok(r > 0 && r < 1, `ratio ${r}`);
});

test("a full rewrite is ratio 1", () => {
  assert.equal(editRatio({ to: ["a"], subject: "", body: "xxxx" }, { to: ["a"], subject: "", body: "yyyy" }), 1);
});

test("the correction quotes both versions", () => {
  const accepted = { ...draft, body: "Hi all, meet Intern." };
  const c = correctionFromEdit("slack", draft, accepted, ["body"]);
  assert.match(c.title, /slack: body rewritten/);
  assert.ok(c.body.includes(draft.body) && c.body.includes(accepted.body));
});
```

`lib/brief.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROMPT_VERSION, brief } from "./brief.ts";

test("the brief carries the task, the recalled facts, and the sandbox rule", () => {
  const text = brief("Draft a hello", [{ id: "f1", title: "Tone", body: "Be brief" }]);
  assert.ok(text.includes("TASK: Draft a hello"));
  assert.ok(text.includes("[f1] Tone"));
  assert.match(text, /public sandbox/);
});

test("no recalled facts means no memory section", () => {
  assert.ok(!brief("x", []).includes("WHAT THE BRAIN ALREADY KNOWS"));
});

test("prompt version is a stable short hash", () => {
  assert.match(PROMPT_VERSION, /^[0-9a-z]{4,8}$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module .../lib/caps.ts` (and the same for parse, edits, brief).

- [ ] **Step 3: Implement `lib/caps.ts`**

```ts
/**
 * Limits for the public instance. Pure, so the arithmetic is tested here and
 * the Convex mutations only count rows and ask.
 *
 * Checked inside mutations, which Convex runs serializably, so two tabs racing
 * the fifth brief cannot both win.
 */

export const BRIEFS_PER_DAY = 5;
export const FACTS_PER_DAY = 20;
export const DAILY_BUDGET_USD = 5;
export const MAX_BRIEF_CHARS = 2000;
export const MAX_FACT_CHARS = 1000;

// ponytail: list price per 1M tokens for gemini-flash-latest, checked by hand
// at ai.google.dev/pricing. On the free tier nothing is billed; the cap then
// acts as a ~500-runs/day ceiling. Update both if GEMINI_MODEL changes.
const USD_PER_M_IN = 0.3;
const USD_PER_M_OUT = 2.5;

const DAY_MS = 86_400_000;
const RESETS = "Resets at 00:00 UTC.";

export const dayStart = (now: number) => now - (now % DAY_MS);
export const dayKey = (now: number) => new Date(dayStart(now)).toISOString().slice(0, 10);

export const costUsd = (tokensIn: number, tokensOut: number) =>
  (tokensIn * USD_PER_M_IN + tokensOut * USD_PER_M_OUT) / 1_000_000;

export function spawnBlocked(s: {
  briefsToday: number;
  active: boolean;
  spentToday: number;
}): string | null {
  if (s.spentToday >= DAILY_BUDGET_USD) {
    return `The community used today's $${DAILY_BUDGET_USD} model budget. ${RESETS}`;
  }
  if (s.active) return "You already have an intern working. Wait for it to finish.";
  if (s.briefsToday >= BRIEFS_PER_DAY) {
    return `You've used your ${BRIEFS_PER_DAY} briefs for today. ${RESETS}`;
  }
  return null;
}

export const teachBlocked = (factsToday: number): string | null =>
  factsToday >= FACTS_PER_DAY ? `You've added ${FACTS_PER_DAY} facts today. ${RESETS}` : null;
```

- [ ] **Step 4: Implement `lib/parse.ts`**

```ts
/**
 * The fenced blocks an intern ends its report with, other than ```action
 * (that one lives in action-block.ts). Moved out of the old in-memory store
 * so Convex, the tests and scripts/eval.ts all read reports the same way.
 */

const FACT_KINDS = ["note", "decision", "preference", "correction"] as const;

export type FactBlock = {
  title: string;
  body: string;
  kind: (typeof FACT_KINDS)[number];
};

/** At most three; malformed ones are skipped rather than failing the run. */
export function parseFactBlocks(report: string): FactBlock[] {
  const out: FactBlock[] = [];
  for (const m of report.matchAll(/```fact\s*\n([\s\S]*?)```/g)) {
    try {
      const raw = JSON.parse(m[1].trim()) as { title?: unknown; body?: unknown; kind?: unknown };
      const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 200) : "";
      if (!title) continue;
      const kind = FACT_KINDS.find((k) => k === raw.kind) ?? "note";
      const body = typeof raw.body === "string" ? raw.body.trim().slice(0, 1000) : "";
      out.push({ title, body, kind });
    } catch {
      /* malformed block: dropped, the run still counts */
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** `null` when there is no block; `{ error }` when there is one that can't be used. */
export function parseQuestionBlock(
  report: string,
): { question: string; context: string } | { error: string } | null {
  const m = report.match(/```question\s*([\s\S]*?)```/);
  if (!m) return null;
  let raw: { question?: unknown; context?: unknown };
  try {
    raw = JSON.parse(m[1].trim());
  } catch {
    return { error: "question block was not valid JSON" };
  }
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return { error: "question block had no question" };
  const context = typeof raw.context === "string" ? raw.context.trim() : "";
  return { question: question.slice(0, 500), context: context.slice(0, 1000) };
}
```

- [ ] **Step 5: Implement `lib/edits.ts`**

```ts
import type { Draft } from "./types";

/**
 * What a person changed before approving. The pair (proposed, accepted) is the
 * training signal; these helpers size it and turn it into a fact.
 */

const FIELDS = ["to", "cc", "subject", "body"] as const;
export type Field = (typeof FIELDS)[number];

const render = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v.join(", ") : (v ?? "")).trim();

export const changedFields = (proposed: Draft, accepted: Draft): Field[] =>
  FIELDS.filter((f) => render(proposed[f]) !== render(accepted[f]));

/**
 * Share of characters changed across all fields, 0..1.
 *
 * ponytail: common prefix/suffix, not Levenshtein. It ranks small edits vs
 * rewrites, which is all /stats needs. Swap in a real diff if the number gets
 * reported as more than a trend.
 */
export function editRatio(proposed: Draft, accepted: Draft): number {
  let changed = 0;
  let total = 0;
  for (const f of FIELDS) {
    const a = render(proposed[f]);
    const b = render(accepted[f]);
    const longest = Math.max(a.length, b.length);
    total += longest;
    if (a === b) continue;
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (
      suf < a.length - pre &&
      suf < b.length - pre &&
      a[a.length - 1 - suf] === b[b.length - 1 - suf]
    ) suf++;
    changed += longest - pre - suf;
  }
  return total ? changed / total : 0;
}

export const correctionFromEdit = (
  kind: string,
  proposed: Draft,
  accepted: Draft,
  fields: Field[],
) => ({
  title: `${kind}: ${fields.join(" and ")} rewritten before approval`,
  body: [
    `An intern drafted a ${kind}; a person rewrote it before approving.`,
    "",
    ...fields.flatMap((f) => [
      `${f.toUpperCase()}, proposed:`,
      render(proposed[f]),
      `${f.toUpperCase()}, accepted:`,
      render(accepted[f]),
      "",
    ]),
    "Write it the accepted way next time.",
  ].join("\n"),
});

export const correctionFromReject = (kind: string, draft: Draft, reason: string) => ({
  title: `do not send: ${draft.subject || draft.body.slice(0, 60)}`,
  body: `An intern drafted a ${kind} to ${draft.to.join(", ")} and a person rejected it.\n\nReason: ${reason}\n\nWhat was drafted:\n${draft.body}`,
});
```

- [ ] **Step 6: Implement `lib/brief.ts`**

```ts
/**
 * The one prompt an intern runs on. Versioned by hash so every run records
 * which prompt produced it, which is what makes /stats and scripts/eval.ts
 * comparable across prompt changes.
 */

export type Recalled = { id: string; title: string; body: string };

export function brief(task: string, recalled: Recalled[]): string {
  const learned = recalled.length
    ? `\nWHAT THE BRAIN ALREADY KNOWS, earned from earlier work (follow it, cite the [id]s you use in "sources"):\n${recalled
        .map((f) => `- [${f.id}] ${f.title}${f.body ? `\n    ${f.body.replace(/\n+/g, " ")}` : ""}`)
        .join("\n")}\n`
    : "";

  return `You are an intern working a task for the team.

TASK: ${task}
${learned}
This is a public sandbox shared by everyone trying Intern. Nothing you draft is
ever sent. Use plausible placeholders for recipients (#general, name@example.com)
and never ask for or repeat anyone's real contact details.

You have no browser and no tools. Work from what the brain gave you above and
what you already know. Do not invent people, systems, dates or numbers. If a
detail matters and you do not have it, ask rather than filling it in.

Write a short report of what you concluded. Plain prose, no headings.

For anything durable worth keeping, add a fenced block per fact, at most three:

\`\`\`fact
{"title":"one line, the claim itself","body":"the detail behind it","kind":"note"}
\`\`\`

kind is one of: note, decision, preference, correction.

If the task implies something should go OUT to a person (an email, a Slack
message), draft it as exactly one fenced block and a human approves it:

\`\`\`action
{"kind":"email","to":["name@example.com"],"subject":"…","body":"…",
 "rationale":"why this should go out","sources":["[id]s you relied on"]}
\`\`\`

For Slack the channel goes in "to" and there is no subject. Always "to", never
"channel".

If something the task left out cannot be resolved from what you were given, do
NOT pick the likely one. Stop and ask, with exactly one fenced block:

\`\`\`question
{"question":"the one thing you need answered","context":"what you were doing"}
\`\`\`

At most one question per run, and only when genuinely blocked.`;
}

/** FNV-1a of the template itself, base36. */
function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export const PROMPT_VERSION = fnv(brief("{task}", []));
```

- [ ] **Step 7: Make `lib/gemini.ts` report usage and status codes**

In `lib/gemini.ts`:
- Change `type Chunk = { text?: string; done?: boolean };` to:
  ```ts
  type Chunk = { text?: string; usage?: { in: number; out: number }; done?: boolean };
  ```
- Change `let detail = \`${res.status}\`;` … `throw new Error(\`gemini: ${detail}\`);` so the thrown message is `` `gemini ${res.status}: ${detail}` ``, with `detail` defaulting to `"request failed"`.
- In the frame loop, widen the parsed type and yield usage:
  ```ts
  const json = JSON.parse(payload) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
  if (text) yield { text };
  // Every frame carries running totals; the caller keeps the last one.
  if (json.usageMetadata) {
    yield {
      usage: {
        in: json.usageMetadata.promptTokenCount ?? 0,
        out: json.usageMetadata.candidatesTokenCount ?? 0,
      },
    };
  }
  ```
- Update the header comment's "free-tier" paragraph to say the model runs from a Convex action now.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests in `caps`, `parse`, `edits`, `brief`, `action-block` and `scout` PASS. (`scout.test.ts` is deleted in Task 5.)

- [ ] **Step 9: Commit**

```bash
git add lib/caps.ts lib/caps.test.ts lib/parse.ts lib/parse.test.ts lib/edits.ts lib/edits.test.ts lib/brief.ts lib/brief.test.ts lib/gemini.ts
git commit -m "Pure pieces for the public instance: caps, block parsers, edit sizing, a versioned brief"
```

---

### Task 3: Schema, GitHub auth, access helper, users

**Files:**
- Rewrite: `convex/schema.ts`, `convex/auth.ts`, `convex/users.ts`, `convex/http.ts`
- Create: `convex/access.ts`
- Delete: `convex/brain.ts`, `convex/log.ts`, `convex/connections.ts`, `convex/gmail.ts`, `convex/providers.ts`, `convex/slack.ts`, `convex/tokens.ts`

**Mihir does first (about 10 min), because the steps below need these values:**
1. Go to https://github.com/settings/developers → **New OAuth App** named `Intern (dev)`. Homepage `http://localhost:3000`. Callback `https://graceful-albatross-202.convex.site/api/auth/callback/github`.
2. Convex dashboard (dev) → Settings → Environment Variables. Set `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `GEMINI_API_KEY` (the rotated key). Keep `SITE_URL=http://localhost:3000`.
3. Delete the now-unused `APP_URL`, `GOOGLE_CLIENT_ID`, `SLACK_CLIENT_ID` and `INTERN_SERVICE_SECRET` from Convex dev env.

**Interfaces (produced):**
```ts
// convex/schema.ts exports
factKind, draft, logLevel, internStatus, actionKind  // validators
// convex/access.ts
requireMember(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">>   // throws ConvexError(string)
ownerView(ctx: QueryCtx, id: Id<"users">): Promise<{ handle: string; image: string | null }>
// convex/users.ts
api.users.viewer: () => { userId, handle, image, accepted, banned } | null
api.users.accept: () => null
api.users.deleteMine: () => null
internal.users.purge: { userId } => null
internal.users.ban: { handle } => { banned: boolean }
```

- [ ] **Step 1: Delete the old modules**

```bash
git rm convex/brain.ts convex/log.ts convex/connections.ts convex/gmail.ts convex/providers.ts convex/slack.ts convex/tokens.ts
```

- [ ] **Step 2: Rewrite `convex/schema.ts`**

```ts
import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The public community brain. Everyone reads everything; each row has one
 * owner who alone can change it.
 */

export const factKind = v.union(
  v.literal("note"),
  v.literal("decision"),
  v.literal("preference"),
  v.literal("correction"),
  v.literal("answer"),
);

export const actionKind = v.union(v.literal("email"), v.literal("slack"), v.literal("calendar"));

export const draft = v.object({
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  subject: v.string(),
  body: v.string(),
});

export const logLevel = v.union(
  v.literal("sys"),
  v.literal("in"),
  v.literal("out"),
  v.literal("tool"),
  v.literal("ok"),
  v.literal("warn"),
  v.literal("err"),
);

export const internStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export default defineSchema({
  ...authTables,

  /** Convex Auth's users table plus the GitHub profile and the two gates. */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    handle: v.optional(v.string()),
    githubId: v.optional(v.string()),
    acceptedAt: v.optional(v.number()),
    bannedAt: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_handle", ["handle"]),

  /** One claim. Seed facts have no owner. `text` = title + body, for search. */
  facts: defineTable({
    title: v.string(),
    body: v.string(),
    kind: factKind,
    ownerId: v.optional(v.id("users")),
    internId: v.optional(v.id("interns")),
    text: v.string(),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_kind", ["kind"])
    .searchIndex("search_text", { searchField: "text" }),

  interns: defineTable({
    ownerId: v.id("users"),
    task: v.string(),
    status: internStatus,
    resumes: v.optional(v.id("interns")),
    summary: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    /** False when the run died on Gemini's free-tier 429, so it isn't charged. */
    countsTowardCap: v.boolean(),
    // Eval fields, one row per run.
    promptVersion: v.optional(v.string()),
    recalledFactIds: v.optional(v.array(v.id("facts"))),
    recalledCorrection: v.optional(v.boolean()),
    tokensIn: v.optional(v.number()),
    tokensOut: v.optional(v.number()),
    latencyMs: v.optional(v.number()),
    /** "action" | "action_malformed:<why>" | "question" | "none" */
    parseOutcome: v.optional(v.string()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"]),

  logs: defineTable({
    internId: v.id("interns"),
    level: logLevel,
    text: v.string(),
  }).index("by_internId", ["internId"]),

  actions: defineTable({
    ownerId: v.id("users"),
    internId: v.id("interns"),
    kind: actionKind,
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    title: v.string(),
    /** What the intern proposed. Never overwritten. */
    draft,
    /** What the person approved, when they changed something. */
    accepted: v.optional(draft),
    editedFields: v.optional(v.array(v.string())),
    rationale: v.string(),
    sources: v.array(v.string()),
    /** Copied from the run: did it recall a preference/correction? Drives /stats. */
    recalledCorrection: v.boolean(),
    decision: v.optional(
      v.union(v.literal("approved_unedited"), v.literal("edited"), v.literal("rejected")),
    ),
    editRatio: v.optional(v.number()),
    reason: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"])
    .index("by_internId", ["internId"]),

  questions: defineTable({
    ownerId: v.id("users"),
    internId: v.id("interns"),
    question: v.string(),
    context: v.string(),
    status: v.union(v.literal("open"), v.literal("answered"), v.literal("dismissed")),
    answer: v.optional(v.string()),
    resumedBy: v.optional(v.id("interns")),
  })
    .index("by_ownerId", ["ownerId"])
    .index("by_status", ["status"]),

  /** One row per UTC day. The global budget reads this. */
  usage: defineTable({
    date: v.string(),
    costUsd: v.number(),
    runs: v.number(),
  }).index("by_date", ["date"]),
});
```

- [ ] **Step 3: Rewrite `convex/auth.ts`**

```ts
import GitHub from "@auth/core/providers/github";
import { convexAuth } from "@convex-dev/auth/server";

/**
 * GitHub only. One click, a real identity per person (so caps can't be dodged
 * with throwaway emails), and no app review. Email is deliberately not stored:
 * the brain is public and nothing here needs it.
 *
 * Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET from the deployment env.
 */
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    GitHub({
      profile(p) {
        return {
          id: String(p.id),
          name: p.name ?? p.login,
          image: p.avatar_url,
          handle: p.login,
          githubId: String(p.id),
        };
      },
    }),
  ],
});
```
If `tsc` complains that `handle`/`githubId` aren't allowed profile keys, cast the returned object `as { id: string; name: string; image: string }` and add a `ponytail:` comment. Convex Auth writes every profile key to `users`.

- [ ] **Step 4: Create `convex/access.ts`**

```ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * The caller, if they may write to the public brain: signed in, consented,
 * not banned. Every mutation that writes starts here.
 */
export async function requireMember(ctx: QueryCtx): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get("users", userId) : null;
  if (!user) throw new ConvexError("Sign in first.");
  if (user.bannedAt) throw new ConvexError("This account is blocked from the public brain.");
  if (!user.acceptedAt) throw new ConvexError("Accept the public-brain notice first.");
  return user;
}

/** What other visitors may see about a person: GitHub handle and avatar. */
export async function ownerView(ctx: QueryCtx, id: Id<"users">) {
  const u = await ctx.db.get("users", id);
  return { handle: u?.handle ?? u?.name ?? "someone", image: u?.image ?? null };
}
```

- [ ] **Step 5: Rewrite `convex/users.ts`**

```ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireMember } from "./access";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const u = userId ? await ctx.db.get("users", userId) : null;
    if (!u) return null;
    return {
      userId: u._id,
      handle: u.handle ?? u.name ?? "you",
      image: u.image ?? null,
      accepted: !!u.acceptedAt,
      banned: !!u.bannedAt,
    };
  },
});

export const accept = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in first.");
    await ctx.db.patch("users", userId, { acceptedAt: Date.now() });
    return null;
  },
});

/** "Delete everything I added." The account stays so the caps still apply. */
export const deleteMine = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireMember(ctx);
    await ctx.scheduler.runAfter(0, internal.users.purge, { userId: user._id });
    return null;
  },
});

const BATCH = 100;

/**
 * Deletes one batch per table and reschedules itself until nothing is left.
 * ponytail: an intern's logs are deleted with take(500); a run writes well
 * under 200 lines (4,096 output tokens / 160-char lines).
 */
export const purge = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    let more = false;

    const facts = await ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of facts) await ctx.db.delete("facts", r._id);

    const actions = await ctx.db.query("actions").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of actions) await ctx.db.delete("actions", r._id);

    const questions = await ctx.db.query("questions").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of questions) await ctx.db.delete("questions", r._id);

    const interns = await ctx.db.query("interns").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(BATCH);
    for (const r of interns) {
      const lines = await ctx.db.query("logs").withIndex("by_internId", (q) => q.eq("internId", r._id)).take(500);
      for (const l of lines) await ctx.db.delete("logs", l._id);
      await ctx.db.delete("interns", r._id);
    }

    more = [facts, actions, questions, interns].some((rows) => rows.length === BATCH);
    if (more) await ctx.scheduler.runAfter(0, internal.users.purge, { userId });
    return null;
  },
});

/** Admin, from the Convex dashboard's function runner: users:ban {"handle":"x"}. */
export const ban = internalMutation({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const user = await ctx.db.query("users").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
    if (!user) return { banned: false };
    await ctx.db.patch("users", user._id, { bannedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.users.purge, { userId: user._id });
    return { banned: true };
  },
});
```

- [ ] **Step 6: Rewrite `convex/http.ts`**

```ts
import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);
export default http;
```

- [ ] **Step 6b: Let Convex import `../lib/*.ts`**

In `convex/tsconfig.json` `compilerOptions`, add `"allowImportingTsExtensions": true` (it's legal because `noEmit` is already true). Without it, Task 4's `import … from "../lib/caps.ts"` fails with TS5097.

- [ ] **Step 7: Typecheck and push to dev**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`. If it fails on a function file that Task 4 rewrites (`interns.ts`, `outbox.ts` reference the old schema), temporarily `git rm` them. Task 4 re-creates them.

- [ ] **Step 8: Commit**

```bash
git add -A convex/
git commit -m "Public schema, GitHub sign-in, and a single gate every write goes through"
```

---

### Task 4: The run engine in Convex

**Files:**
- Create: `convex/facts.ts`, `convex/run.ts`, `convex/questions.ts`, `convex/seed.ts`
- Rewrite: `convex/interns.ts`, `convex/outbox.ts`

**Interfaces:**
- Consumes: Task 2 libs, Task 3 `requireMember`, `ownerView` and the schema validators.
- Produces (the UI in Tasks 6–9 relies on these exact names):
  ```ts
  api.facts.teach({ title, body, kind }) => Id<"facts">
  api.facts.graph({}) => { nodes: {id,label,kind,weight,detail,meta}[]; edges: {source,target,rel}[]; generatedAt: number }
  api.interns.spawn({ task }) => Id<"interns">          // throws ConvexError(reason)
  api.interns.cancel({ internId }) => null
  api.interns.list({}) => (Doc<"interns"> & { handle: string; image: string|null })[]  // newest 40
  api.interns.logs({}) => Doc<"logs">[]                 // oldest→newest, last 400
  api.outbox.list({}) => (Doc<"actions"> & { handle: string })[]   // newest 30
  api.outbox.decide({ actionId, decision: "approve"|"reject", edits?, reason? }) => null
  api.questions.list({}) => Doc<"questions">[]         // newest 30
  api.questions.answer({ questionId, answer }) => { resumed: boolean; reason: string | null }
  api.questions.dismiss({ questionId }) => null
  ```

- [ ] **Step 1: Create `convex/facts.ts`**

```ts
import { ConvexError, v } from "convex/values";
import { MAX_FACT_CHARS, dayStart, teachBlocked } from "../lib/caps.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalQuery, mutation, query } from "./_generated/server";
import { requireMember } from "./access";
import { factKind } from "./schema";

type FactKind = Doc<"facts">["kind"];

export async function insertFact(
  ctx: MutationCtx,
  f: { title: string; body: string; kind: FactKind; ownerId?: Id<"users">; internId?: Id<"interns"> },
) {
  return await ctx.db.insert("facts", { ...f, text: `${f.title}\n${f.body}` });
}

export const teach = mutation({
  args: { title: v.string(), body: v.string(), kind: factKind },
  handler: async (ctx, args) => {
    const user = await requireMember(ctx);
    const title = args.title.trim().slice(0, 200);
    const body = args.body.trim();
    if (!title) throw new ConvexError("Say what you know first.");
    if (title.length + body.length > MAX_FACT_CHARS) {
      throw new ConvexError(`Keep a fact under ${MAX_FACT_CHARS} characters.`);
    }
    const today = await ctx.db
      .query("facts")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", user._id).gte("_creationTime", dayStart(Date.now())))
      .take(50);
    const blocked = teachBlocked(today.length);
    if (blocked) throw new ConvexError(blocked);
    return await insertFact(ctx, { title, body, kind: args.kind, ownerId: user._id });
  },
});

/**
 * What an intern reads before it starts: the newest house-style lessons
 * (preferences and corrections, the learning loop), then the best full-text
 * matches for the task.
 */
export const recall = internalQuery({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    const lessons = [
      ...(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "preference")).order("desc").take(3)),
      ...(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "correction")).order("desc").take(3)),
    ];
    // Convex search takes at most 16 terms.
    const terms = task.split(/\s+/).filter(Boolean).slice(0, 16).join(" ");
    const hits = terms
      ? await ctx.db.query("facts").withSearchIndex("search_text", (q) => q.search("text", terms)).take(5)
      : [];

    const seen = new Set<string>();
    const out: { id: Id<"facts">; title: string; body: string; kind: FactKind }[] = [];
    for (const f of [...lessons, ...hits]) {
      if (seen.has(f._id)) continue;
      seen.add(f._id);
      out.push({ id: f._id, title: f.title, body: f.body.slice(0, 400), kind: f.kind });
    }
    return out;
  },
});

/**
 * The shared graph, shaped for BrainGraph. Public: the whole brain is public
 * by design. Only GitHub handle and avatar are shown for people.
 *
 * ponytail: newest 400 facts / 60 interns / 60 drafts. Paginate if the
 * community outgrows one screen.
 */
export const graph = query({
  args: {},
  handler: async (ctx) => {
    const facts = await ctx.db.query("facts").order("desc").take(400);
    const interns = await ctx.db.query("interns").order("desc").take(60);
    const actions = await ctx.db.query("actions").order("desc").take(60);

    type Node = { id: string; label: string; kind: "fact" | "intern" | "action" | "contact" | "source"; weight: number; detail?: string; meta?: Record<string, string | number | null> };
    const nodes = new Map<string, Node>();
    const edges: { source: string; target: string; rel: string }[] = [];

    const person = async (id: Id<"users">) => {
      const key = `user:${id}`;
      if (!nodes.has(key)) {
        const u = await ctx.db.get("users", id);
        const handle = u?.handle ?? u?.name ?? "someone";
        nodes.set(key, { id: key, label: `@${handle}`, kind: "contact", weight: 5, meta: { image: u?.image ?? null } });
      }
      return key;
    };

    for (const i of interns) {
      nodes.set(i._id, { id: i._id, label: i.task.slice(0, 56), kind: "intern", weight: 5, detail: i.status });
      edges.push({ source: await person(i.ownerId), target: i._id, rel: "briefed" });
    }
    for (const f of facts) {
      nodes.set(f._id, { id: f._id, label: f.title.slice(0, 56), kind: "fact", weight: 3, detail: f.kind, meta: { kind: f.kind } });
      if (f.internId && nodes.has(f.internId)) edges.push({ source: f.internId, target: f._id, rel: "filed" });
      else if (f.ownerId) edges.push({ source: await person(f.ownerId), target: f._id, rel: "taught" });
      else {
        nodes.set("src:seed", { id: "src:seed", label: "seed", kind: "source", weight: 6 });
        edges.push({ source: "src:seed", target: f._id, rel: "seeded" });
      }
    }
    for (const a of actions) {
      nodes.set(a._id, { id: a._id, label: `✉ ${a.draft.subject || a.title}`.slice(0, 56), kind: "action", weight: 4, detail: a.status });
      if (nodes.has(a.internId)) edges.push({ source: a.internId, target: a._id, rel: "drafted" });
    }

    return {
      nodes: [...nodes.values()],
      edges: edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)),
      generatedAt: facts[0]?._creationTime ?? 0,
    };
  },
});
```

- [ ] **Step 2: Rewrite `convex/interns.ts`**

```ts
import { ConvexError, v } from "convex/values";
import { MAX_BRIEF_CHARS, costUsd, dayKey, dayStart, spawnBlocked } from "../lib/caps.ts";
import { PROMPT_VERSION } from "../lib/brief.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { insertFact } from "./facts";
import { actionKind, draft, factKind, logLevel } from "./schema";

/** Caps, then insert, then schedule. Shared by spawn and by answering a question. */
export async function dispatch(
  ctx: MutationCtx,
  ownerId: Id<"users">,
  task: string,
  resumes?: Id<"interns">,
): Promise<Id<"interns">> {
  if (!task) throw new ConvexError("Give the intern a task.");
  if (task.length > MAX_BRIEF_CHARS) {
    throw new ConvexError(`Keep the brief under ${MAX_BRIEF_CHARS} characters.`);
  }
  const now = Date.now();
  const today = await ctx.db
    .query("interns")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId).gte("_creationTime", dayStart(now)))
    .take(50);
  const usage = await ctx.db.query("usage").withIndex("by_date", (q) => q.eq("date", dayKey(now))).unique();
  const blocked = spawnBlocked({
    briefsToday: today.filter((i) => i.countsTowardCap).length,
    active: today.some((i) => i.status === "queued" || i.status === "running"),
    spentToday: usage?.costUsd ?? 0,
  });
  if (blocked) throw new ConvexError(blocked);

  const internId = await ctx.db.insert("interns", {
    ownerId,
    task,
    status: "queued",
    resumes,
    countsTowardCap: true,
  });
  await ctx.scheduler.runAfter(0, internal.run.go, { internId });
  return internId;
}

export const spawn = mutation({
  args: { task: v.string() },
  handler: async (ctx, { task }) => {
    const user = await requireMember(ctx);
    return await dispatch(ctx, user._id, task.trim());
  },
});

export const cancel = mutation({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const user = await requireMember(ctx);
    const i = await ctx.db.get("interns", internId);
    if (!i || i.ownerId !== user._id) throw new ConvexError("Only whoever briefed an intern can stop it.");
    if (i.status === "queued" || i.status === "running" || i.status === "waiting") {
      await ctx.db.patch("interns", internId, { status: "cancelled", endedAt: Date.now() });
      await ctx.db.insert("logs", { internId, level: "warn", text: "cancelled" });
    }
    return null;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("interns").order("desc").take(40);
    return await Promise.all(rows.map(async (i) => ({ ...i, ...(await ownerView(ctx, i.ownerId)) })));
  },
});

export const logs = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("logs").order("desc").take(400)).reverse(),
});

// --- called by run.go ------------------------------------------------------

export const start = internalMutation({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const i = await ctx.db.get("interns", internId);
    if (!i || i.status !== "queued") return null;
    await ctx.db.patch("interns", internId, { status: "running", startedAt: Date.now(), promptVersion: PROMPT_VERSION });
    return { task: i.task };
  },
});

export const noteRecall = internalMutation({
  args: { internId: v.id("interns"), recalled: v.array(v.object({ id: v.id("facts"), kind: factKind })) },
  handler: async (ctx, { internId, recalled }) => {
    await ctx.db.patch("interns", internId, {
      recalledFactIds: recalled.map((r) => r.id),
      recalledCorrection: recalled.some((r) => r.kind === "preference" || r.kind === "correction"),
    });
    return null;
  },
});

export const appendLog = internalMutation({
  args: { internId: v.id("interns"), level: logLevel, text: v.string() },
  handler: async (ctx, a) => {
    await ctx.db.insert("logs", { ...a, text: a.text.slice(0, 2000) });
    return null;
  },
});

async function addUsage(ctx: MutationCtx, tokensIn: number, tokensOut: number) {
  const date = dayKey(Date.now());
  const row = await ctx.db.query("usage").withIndex("by_date", (q) => q.eq("date", date)).unique();
  const cost = costUsd(tokensIn, tokensOut);
  if (row) await ctx.db.patch("usage", row._id, { costUsd: row.costUsd + cost, runs: row.runs + 1 });
  else await ctx.db.insert("usage", { date, costUsd: cost, runs: 1 });
}

/** Every write a finished run makes, in one transaction. */
export const finish = internalMutation({
  args: {
    internId: v.id("interns"),
    report: v.string(),
    tokensIn: v.number(),
    tokensOut: v.number(),
    latencyMs: v.number(),
    facts: v.array(v.object({ title: v.string(), body: v.string(), kind: factKind })),
    action: v.optional(
      v.object({ kind: actionKind, title: v.string(), draft, rationale: v.string(), sources: v.array(v.string()) }),
    ),
    actionError: v.optional(v.string()),
    question: v.optional(v.object({ question: v.string(), context: v.string() })),
  },
  handler: async (ctx, a) => {
    const intern = await ctx.db.get("interns", a.internId);
    if (!intern) return null;
    // The tokens were spent whatever happens next.
    await addUsage(ctx, a.tokensIn, a.tokensOut);

    const base = {
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      latencyMs: a.latencyMs,
      summary: a.report.slice(0, 600),
      endedAt: Date.now(),
    };
    const log = (level: "ok" | "warn" | "err", text: string) =>
      ctx.db.insert("logs", { internId: a.internId, level, text });

    if (intern.status === "cancelled") {
      await ctx.db.patch("interns", a.internId, base);
      return null;
    }

    if (a.question) {
      await ctx.db.insert("questions", {
        ownerId: intern.ownerId,
        internId: a.internId,
        question: a.question.question,
        context: a.question.context,
        status: "open",
      });
      await ctx.db.patch("interns", a.internId, { ...base, status: "waiting", parseOutcome: "question" });
      await log("warn", `asks: ${a.question.question}`);
      return null;
    }

    for (const f of a.facts) {
      await insertFact(ctx, { ...f, ownerId: intern.ownerId, internId: a.internId });
      await log("ok", `filed · ${f.title}`);
    }

    let parseOutcome = "none";
    if (a.action) {
      await ctx.db.insert("actions", {
        ...a.action,
        ownerId: intern.ownerId,
        internId: a.internId,
        status: "pending",
        recalledCorrection: intern.recalledCorrection ?? false,
      });
      await log("warn", `drafted a ${a.action.kind} · waiting for approval`);
      parseOutcome = "action";
    } else if (a.actionError) {
      await log("err", `${a.actionError}. Nothing was queued.`);
      parseOutcome = `action_malformed:${a.actionError}`;
    }

    await ctx.db.patch("interns", a.internId, { ...base, status: "done", parseOutcome });
    await log("ok", `finished in ${(a.latencyMs / 1000).toFixed(1)}s`);
    return null;
  },
});

export const fail = internalMutation({
  args: { internId: v.id("interns"), error: v.string(), countsTowardCap: v.boolean() },
  handler: async (ctx, a) => {
    const intern = await ctx.db.get("interns", a.internId);
    if (!intern || intern.status === "cancelled") return null;
    await ctx.db.patch("interns", a.internId, {
      status: "failed",
      error: a.error,
      endedAt: Date.now(),
      countsTowardCap: a.countsTowardCap,
    });
    await ctx.db.insert("logs", { internId: a.internId, level: "err", text: a.error });
    return null;
  },
});
```

- [ ] **Step 3: Create `convex/run.ts`**

```ts
import { v } from "convex/values";
import { parseActionBlock } from "../lib/action-block.ts";
import { brief } from "../lib/brief.ts";
import { stream } from "../lib/gemini.ts";
import { parseFactBlocks, parseQuestionBlock } from "../lib/parse.ts";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const BUSY = "The free model is busy, try again in a minute.";

/**
 * One intern run: recall, one streamed Gemini call, parse, finish.
 * Plain fetch, so no "use node". Cancellation is checked by `finish`, which
 * ignores a run whose intern was cancelled meanwhile.
 */
export const go = internalAction({
  args: { internId: v.id("interns") },
  handler: async (ctx, { internId }) => {
    const started = await ctx.runMutation(internal.interns.start, { internId });
    if (!started) return null;

    const say = (level: "sys" | "out", text: string) =>
      ctx.runMutation(internal.interns.appendLog, { internId, level, text });
    const t0 = Date.now();

    try {
      const recalled = await ctx.runQuery(internal.facts.recall, { task: started.task });
      await ctx.runMutation(internal.interns.noteRecall, {
        internId,
        recalled: recalled.map((f) => ({ id: f.id, kind: f.kind })),
      });
      if (recalled.length) await say("sys", `recalled ${recalled.length} facts from the brain`);
      await say("sys", "thinking · gemini");

      let report = "";
      let pending = "";
      let usage = { in: 0, out: 0 };
      for await (const chunk of stream(brief(started.task, recalled))) {
        if (chunk.usage) usage = chunk.usage;
        if (!chunk.text) continue;
        report += chunk.text;
        pending += chunk.text;
        if (pending.length > 160 || /[.\n]$/.test(pending)) {
          const line = pending.trim();
          if (line) await say("out", line);
          pending = "";
        }
      }
      if (pending.trim()) await say("out", pending.trim());

      report = report.trim();
      if (!report) throw new Error("gemini returned an empty report");

      const asked = parseQuestionBlock(report);
      const parsed = parseActionBlock(report);
      const ok = parsed && !("error" in parsed) ? parsed : null;
      await ctx.runMutation(internal.interns.finish, {
        internId,
        report,
        tokensIn: usage.in,
        tokensOut: usage.out,
        latencyMs: Date.now() - t0,
        facts: parseFactBlocks(report),
        action: ok
          ? {
              kind: ok.kind,
              title: ok.title,
              // Rebuilt field by field: the validator rejects startsAt/endsAt.
              draft: ok.draft.cc
                ? { to: ok.draft.to, cc: ok.draft.cc, subject: ok.draft.subject, body: ok.draft.body }
                : { to: ok.draft.to, subject: ok.draft.subject, body: ok.draft.body },
              rationale: ok.rationale,
              sources: ok.sources,
            }
          : undefined,
        actionError: parsed && "error" in parsed ? parsed.error : undefined,
        question: asked && !("error" in asked) ? asked : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const busy = message.startsWith("gemini 429");
      await ctx.runMutation(internal.interns.fail, {
        internId,
        error: busy ? BUSY : message.slice(0, 500),
        countsTowardCap: !busy,
      });
    }
    return null;
  },
});
```

- [ ] **Step 4: Rewrite `convex/outbox.ts`**

```ts
import { ConvexError, v } from "convex/values";
import { changedFields, correctionFromEdit, correctionFromReject, editRatio } from "../lib/edits.ts";
import { mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { insertFact } from "./facts";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("actions").order("desc").take(30);
    return await Promise.all(rows.map(async (a) => ({ ...a, handle: (await ownerView(ctx, a.ownerId)).handle })));
  },
});

/**
 * Approve (optionally edited) or reject. Sandbox: nothing is ever sent. An edit
 * becomes a preference fact and a rejection becomes a correction fact, which
 * the next intern recalls. That is the learning loop.
 */
export const decide = mutation({
  args: {
    actionId: v.id("actions"),
    decision: v.union(v.literal("approve"), v.literal("reject")),
    edits: v.optional(
      v.object({
        to: v.optional(v.array(v.string())),
        cc: v.optional(v.array(v.string())),
        subject: v.optional(v.string()),
        body: v.optional(v.string()),
      }),
    ),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can decide on its draft.");
    }
    if (action.status !== "pending") throw new ConvexError("Already decided.");
    const now = Date.now();
    const log = (level: "ok" | "warn", text: string) =>
      ctx.db.insert("logs", { internId: action.internId, level, text });

    if (a.decision === "reject") {
      const reason = (a.reason ?? "").trim().slice(0, 500) || "no reason given";
      await ctx.db.patch("actions", action._id, { status: "rejected", decision: "rejected", reason, decidedAt: now });
      const c = correctionFromReject(action.kind, action.draft, reason);
      await insertFact(ctx, { ...c, kind: "correction", ownerId: user._id, internId: action.internId });
      await log("warn", `rejected · learned: ${c.title}`);
      return null;
    }

    const accepted = { ...action.draft, ...a.edits };
    const fields = changedFields(action.draft, accepted);
    await ctx.db.patch("actions", action._id, {
      status: "approved",
      decision: fields.length ? "edited" : "approved_unedited",
      editRatio: editRatio(action.draft, accepted),
      decidedAt: now,
      ...(fields.length ? { accepted, editedFields: fields } : {}),
    });
    if (fields.length) {
      const c = correctionFromEdit(action.kind, action.draft, accepted, fields);
      await insertFact(ctx, { ...c, kind: "preference", ownerId: user._id, internId: action.internId });
      await log("ok", `learned: ${c.title}`);
    }
    await log("ok", "Approved. Sandbox: nothing was sent.");
    return null;
  },
});
```

- [ ] **Step 5: Create `convex/questions.ts`**

```ts
import { ConvexError, v } from "convex/values";
import { MAX_BRIEF_CHARS } from "../lib/caps.ts";
import { mutation, query } from "./_generated/server";
import { requireMember } from "./access";
import { insertFact } from "./facts";
import { dispatch } from "./interns";

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("questions").order("desc").take(30),
});

/** The answer becomes a fact first, then the work resumes as a fresh intern (subject to caps). */
export const answer = mutation({
  args: { questionId: v.id("questions"), answer: v.string() },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const q = await ctx.db.get("questions", a.questionId);
    if (!q || q.ownerId !== user._id || q.status !== "open") throw new ConvexError("That question isn't open for you.");
    const answer = a.answer.trim().slice(0, 1000);
    if (!answer) throw new ConvexError("Type an answer first.");

    await insertFact(ctx, { title: q.question, body: answer, kind: "answer", ownerId: user._id, internId: q.internId });
    const parked = await ctx.db.get("interns", q.internId);
    if (parked?.status === "waiting") await ctx.db.patch("interns", parked._id, { status: "done" });

    const task = `You asked: ${q.question}\nThe answer is: ${answer}\n\nOriginal task: ${parked?.task ?? ""}`.slice(0, MAX_BRIEF_CHARS);
    let resumedBy;
    let reason: string | null = null;
    try {
      // dispatch checks every cap before writing, so catching here leaves no partial intern.
      resumedBy = await dispatch(ctx, user._id, task, q.internId);
    } catch (err) {
      reason = err instanceof ConvexError ? String(err.data) : "could not resume";
    }
    await ctx.db.patch("questions", q._id, { status: "answered", answer, resumedBy });
    return { resumed: !!resumedBy, reason };
  },
});

export const dismiss = mutation({
  args: { questionId: v.id("questions") },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    const q = await ctx.db.get("questions", a.questionId);
    if (!q || q.ownerId !== user._id || q.status !== "open") throw new ConvexError("That question isn't open for you.");
    await ctx.db.patch("questions", q._id, { status: "dismissed" });
    const parked = await ctx.db.get("interns", q.internId);
    if (parked?.status === "waiting") await ctx.db.patch("interns", parked._id, { status: "cancelled", endedAt: Date.now() });
    return null;
  },
});
```

- [ ] **Step 6: Create `convex/seed.ts` (the three positioning facts, verbatim from the old dev brain)**

```ts
import { internalMutation } from "./_generated/server";
import { insertFact } from "./facts";

/**
 * Run once per deployment: `npx convex run seed:run` (add --prod for prod).
 * Idempotent: skips if any ownerless fact exists.
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const any = await ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", undefined)).first();
    if (any) return { seeded: 0 };
    for (const f of SEED) await insertFact(ctx, { ...f, kind: "note" });
    return { seeded: SEED.length };
  },
});

const SEED = [
  { title: "What Intern is", body: `<paste the body of co.what-we-do from the spec-time export, verbatim>` },
  { title: "Who Intern is for", body: `<paste co.icp verbatim>` },
  { title: "What makes a prospect viable", body: `<paste co.qualification verbatim>` },
];
```
The three bodies are the `co.what-we-do`, `co.icp` and `co.qualification` observations. Read them from the Task 1 backup:
```bash
unzip -p backups/dev-pre-public-mvp.zip observations/documents.jsonl | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const l of s.split("\n")){if(!l)continue;const r=JSON.parse(l);if(["co.what-we-do","co.icp","co.qualification"].includes(r.externalId))console.log(r.externalId+"\n"+r.body+"\n----")}})'
```
Paste each body into a template literal (escape any backticks). Do **not** seed `co.slack-channel`: it names Mihir's private workspace channel.

- [ ] **Step 7: Push, seed, and smoke-test the engine from the CLI**

```bash
npx convex dev --once
npx convex run seed:run
```
Expected: `{ "seeded": 3 }`.

The engine can't be driven from the CLI without a signed-in user, so the full smoke test is in Task 6, Step 5. Here, check that `internal.facts.recall` works:
```bash
npx convex run facts:recall '{"task":"what is intern"}'
```
Expected: a JSON array containing `"What Intern is"`.

- [ ] **Step 8: Commit**

```bash
git add convex/
git commit -m "Run interns inside Convex: capped spawn, one streamed call, one transactional finish"
```

---

### Task 5: Delete the in-memory engine and every `/api` route

**Files:**
- Delete: `app/api/` (whole tree), `lib/store.ts`, `lib/brain.ts`, `lib/mcp.ts`, `lib/notify.ts`, `lib/sim.ts`, `lib/scout.ts`, `lib/scout.test.ts`, `lib/trust.ts`, `lib/auth.ts`, `lib/convex.ts`, `lib/connectors/`, `components/Trust.tsx`

- [ ] **Step 1: Delete**

```bash
git rm -r app/api lib/store.ts lib/brain.ts lib/mcp.ts lib/notify.ts lib/sim.ts lib/scout.ts lib/scout.test.ts lib/trust.ts lib/auth.ts lib/convex.ts lib/connectors components/Trust.tsx
```

- [ ] **Step 2: Find what still imports them**

Run: `npx tsc --noEmit 2>&1 | grep -v "^ " | sort -u`
Expected: errors only in `components/Cockpit.tsx`, `components/BrainRail.tsx`, `components/Outbox.tsx` and `components/SignIn.tsx` (fixed in Tasks 6–7), plus `lib/types.ts` if it imports a deleted file. Remove any such import from `lib/types.ts`. If any other file errors, delete its import of the removed module. If that isn't possible, stop and report.

- [ ] **Step 3: Tests still pass**

Run: `npm test`
Expected: PASS (caps, parse, edits, brief, action-block).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Delete the in-memory engine, the SSE bus, MCP and every /api route"
```

---

### Task 6: Sign-in, consent, ban notice

**Files:**
- Rewrite: `components/SignIn.tsx`, `components/Gate.tsx`
- Create: `components/Consent.tsx`

**Interfaces:**
- Consumes: `api.users.viewer`, `api.users.accept`.
- Produces: `<Cockpit me={me} />`, where `me = { userId: Id<"users">; handle: string; image: string | null }`.

- [ ] **Step 1: Rewrite `components/SignIn.tsx`**

```tsx
"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

/** GitHub only: see convex/auth.ts for why. */
export default function SignIn() {
  const { signIn } = useAuthActions();
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[340px]">
        <div className="mb-6 flex items-baseline gap-3">
          <span className="tracking-[0.28em] text-fg">INTERN</span>
          <span className="text-line-2">|</span>
          <span className="text-faint">community brain</span>
        </div>
        <div className="border border-line bg-panel p-4">
          <p className="leading-relaxed text-dim">
            A public test brain. Everyone who signs in shares it: you&rsquo;ll see what others
            taught it, and they&rsquo;ll see what you do.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signIn("github", { redirectTo: "/app" });
            }}
            className="mt-4 w-full border border-accent/60 bg-accent/10 py-2 text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {busy ? "redirecting…" : "continue with GitHub"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `components/Consent.tsx`**

```tsx
"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

export const NOTICE =
  "This is a public test brain. Everything you type (briefs, facts, drafts) is visible to every other visitor. Don't enter anything private.";

export default function Consent() {
  const accept = useMutation(api.users.accept);
  const { signOut } = useAuthActions();
  const [checked, setChecked] = useState(false);

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[420px] border border-line bg-panel p-4">
        <p className="label">before you go in</p>
        <p className="mt-3 leading-relaxed text-fg">{NOTICE}</p>
        <label className="mt-4 flex items-start gap-2 text-dim">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-1" />
          I understand, and I won&rsquo;t enter anything private.
        </label>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={!checked}
            onClick={() => void accept({})}
            className="flex-1 border border-accent/60 bg-accent/10 py-2 text-accent hover:bg-accent/20 disabled:opacity-40"
          >
            enter the brain
          </button>
          <button type="button" onClick={() => void signOut()} className="border border-line px-3 text-faint hover:text-fg">
            leave
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rewrite `components/Gate.tsx`**

```tsx
"use client";

import { AuthLoading, Authenticated, Unauthenticated, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import Cockpit from "./Cockpit";
import Consent from "./Consent";
import SignIn from "./SignIn";

const Wait = ({ text }: { text: string }) => (
  <div className="flex h-full items-center justify-center bg-bg">
    <span className="text-faint">
      {text}
      <span className="caret">_</span>
    </span>
  </div>
);

export default function Gate() {
  return (
    <>
      <AuthLoading>
        <Wait text="checking session" />
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Member />
      </Authenticated>
    </>
  );
}

function Member() {
  const me = useQuery(api.users.viewer, {});
  if (me === undefined) return <Wait text="loading" />;
  if (me === null) return <SignIn />;
  if (me.banned) return <Wait text="this account is blocked from the public brain" />;
  if (!me.accepted) return <Consent />;
  return <Cockpit me={{ userId: me.userId, handle: me.handle, image: me.image }} />;
}
```

- [ ] **Step 4: Commit** (the Next build is still red until Task 7; that's expected)

```bash
git add components/SignIn.tsx components/Gate.tsx components/Consent.tsx
git commit -m "GitHub sign-in, a consent gate with the public-brain notice, and a ban screen"
```

---

### Task 7: Cockpit on live queries; trimmed rails; sandbox copy

**Files:**
- Rewrite: `components/Cockpit.tsx`
- Modify: `components/BrainRail.tsx`, `components/Outbox.tsx`, `components/CommandBar.tsx`

- [ ] **Step 1: Rewrite `components/Cockpit.tsx`**

Keep the layout JSX from the current file (graph, filter box, resize handle, terminal, CommandBar, right aside) and the terminal-resize effect as they are. Replace everything else with:

```tsx
"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Graph, GraphNode, Intern, LogLevel, LogLine, NodeKind, ProposedAction, Question } from "@/lib/types";
import BrainGraph from "./BrainGraph";
import BrainRail from "./BrainRail";
import CommandBar, { HELP } from "./CommandBar";
import { NOTICE } from "./Consent";
import Feed from "./Feed";
import InternRail from "./InternRail";
import Outbox, { type Decision } from "./Outbox";
import Questions from "./Questions";
import Teach, { type TeachInput } from "./Teach";
import Terminal from "./Terminal";

export type Me = { userId: Id<"users">; handle: string; image: string | null };

const EXAMPLES = [
  "Draft a Slack post introducing Intern to a new teammate",
  "Write a follow-up email to someone who asked what Intern does",
  "What has the community taught the brain today? Summarise it.",
];

/** A ConvexError's message is the reason to show; anything else is a bug. */
const why = (err: unknown) =>
  err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err);

export default function Cockpit({ me }: { me: Me }) {
  const internRows = useQuery(api.interns.list, {});
  const logRows = useQuery(api.interns.logs, {});
  const actionRows = useQuery(api.outbox.list, {});
  const questionRows = useQuery(api.questions.list, {});
  const graphData = useQuery(api.facts.graph, {});

  const spawnM = useMutation(api.interns.spawn);
  const cancelM = useMutation(api.interns.cancel);
  const decideM = useMutation(api.outbox.decide);
  const answerM = useMutation(api.questions.answer);
  const dismissM = useMutation(api.questions.dismiss);
  const teachM = useMutation(api.facts.teach);
  const deleteMineM = useMutation(api.users.deleteMine);

  const [local, setLocal] = useState<LogLine[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const [termHeight, setTermHeight] = useState(280);

  const localSeq = useRef(0);
  const echo = useCallback((level: LogLevel, text: string) => {
    setLocal((prev) => [...prev, { id: -++localSeq.current, internId: null, ownerId: null, ts: Date.now(), level, text }]);
  }, []);

  // --- server rows → the shapes the existing components take ---------------
  const interns = useMemo<Intern[]>(
    () =>
      (internRows ?? []).map((i) => ({
        id: i._id,
        ownerId: i.ownerId,
        handle: `@${i.handle} ${i._id.slice(-4)}`,
        task: i.task,
        status: i.status,
        mode: "live",
        createdAt: i._creationTime,
        startedAt: i.startedAt,
        endedAt: i.endedAt,
        tools: [],
        toolCalls: 0,
        toolErrors: 0,
        artifacts: [],
        summary: i.summary,
        error: i.error,
        sessionId: "",
      })),
    [internRows],
  );

  const log = useMemo<LogLine[]>(
    () =>
      [
        ...(logRows ?? []).map((l, idx) => ({
          id: idx,
          internId: l.internId,
          ownerId: null,
          ts: l._creationTime,
          level: l.level,
          text: l.text,
        })),
        ...local,
      ].sort((a, b) => a.ts - b.ts),
    [logRows, local],
  );

  // Your own drafts and questions only: only you can act on them.
  const outbox = useMemo<ProposedAction[]>(
    () =>
      (actionRows ?? [])
        .filter((a) => a.ownerId === me.userId)
        .map((a) => ({
          id: a._id,
          internId: a.internId,
          ownerId: a.ownerId,
          kind: a.kind,
          status: a.status,
          title: a.title,
          draft: a.draft,
          accepted: a.accepted,
          editedFields: a.editedFields as ProposedAction["editedFields"],
          rationale: a.rationale,
          sources: a.sources,
          createdAt: a._creationTime,
          decidedAt: a.decidedAt,
          decidedVia: "cockpit",
          result: a.reason,
        })),
    [actionRows, me.userId],
  );

  const questions = useMemo<Question[]>(
    () =>
      (questionRows ?? [])
        .filter((q) => q.ownerId === me.userId)
        .map((q) => ({
          id: q._id,
          internId: q.internId,
          ownerId: q.ownerId,
          question: q.question,
          context: q.context,
          status: q.status,
          answer: q.answer,
          askedAt: q._creationTime,
          resumedBy: q.resumedBy,
        })),
    [questionRows, me.userId],
  );

  const graph = useMemo<Graph>(
    () => ({
      nodes: (graphData?.nodes ?? []) as GraphNode[],
      edges: graphData?.edges ?? [],
      mode: "live",
      generatedAt: graphData?.generatedAt ?? 0,
    }),
    [graphData],
  );

  const selected = useMemo(() => graph.nodes.find((n) => n.id === selectedId) ?? null, [graph.nodes, selectedId]);
  const select = useCallback((node: GraphNode | null) => setSelectedId(node?.id ?? null), []);

  // Running interns pulse, and so do the facts they recalled.
  const activeIds = useMemo(
    () =>
      (internRows ?? [])
        .filter((i) => i.status === "running" || i.status === "queued")
        .flatMap((i) => [i._id as string, ...(i.recalledFactIds ?? [])]),
    [internRows],
  );

  // --- actions -------------------------------------------------------------
  const spawn = useCallback(
    async (task: string) => {
      try {
        await spawnM({ task });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [spawnM, echo],
  );

  const kill = useCallback(
    async (id: string) => {
      try {
        await cancelM({ internId: id as Id<"interns"> });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [cancelM, echo],
  );

  const decide = useCallback(
    async (id: string, d: Decision) => {
      try {
        if (d.decision === "approve") {
          const { to, cc, subject, body } = d.edits ?? {};
          await decideM({ actionId: id as Id<"actions">, decision: "approve", edits: d.edits ? { to, cc, subject, body } : undefined });
        } else {
          await decideM({ actionId: id as Id<"actions">, decision: "reject", reason: d.reason });
        }
      } catch (err) {
        echo("err", why(err));
      }
    },
    [decideM, echo],
  );

  const answer = useCallback(
    async (id: string, text: string) => {
      try {
        const r = await answerM({ questionId: id as Id<"questions">, answer: text });
        if (!r.resumed && r.reason) echo("warn", `answer saved as a fact, but the intern didn't resume: ${r.reason}`);
      } catch (err) {
        echo("err", why(err));
      }
    },
    [answerM, echo],
  );

  const dismiss = useCallback(
    async (id: string) => {
      try {
        await dismissM({ questionId: id as Id<"questions"> });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [dismissM, echo],
  );

  const teach = useCallback(
    async (input: TeachInput) => {
      const [head, ...rest] = input.text.split(/\n|(?<=[.!?])\s+/);
      const kind = input.kind === "person" || input.kind === "project" ? "note" : input.kind;
      try {
        await teachM({ title: head.slice(0, 200), body: rest.join(" ").trim(), kind });
        return true;
      } catch (err) {
        echo("err", why(err));
        return false;
      }
    },
    [teachM, echo],
  );

  const deleteMine = useCallback(async () => {
    if (!window.confirm("Delete every brief, fact, draft and question you added? This can't be undone.")) return;
    try {
      await deleteMineM({});
      echo("ok", "deleting everything you added…");
    } catch (err) {
      echo("err", why(err));
    }
  }, [deleteMineM, echo]);

  const run = useCallback(
    (raw: string) => {
      const [verb, ...rest] = raw.split(/\s+/);
      const arg = rest.join(" ").trim();
      echo("in", raw);
      switch (verb.toLowerCase()) {
        case "help":
          for (const l of HELP) echo("out", l);
          return;
        case "clear":
          setLocal([]);
          return;
        case "focus":
          setFilter(!arg || arg === "all" ? null : arg);
          return;
        case "kill":
          if (!arg) return echo("err", "usage: kill <id>");
          void kill(arg);
          return;
        case "reject": {
          const [target, ...reason] = arg.split(/\s+/);
          if (!target) return echo("err", "usage: reject <draft-id> [reason]");
          void decide(target, { decision: "reject", reason: reason.join(" ") || "rejected from the command bar" });
          return;
        }
        case "approve":
          if (!arg) return echo("err", "usage: approve <draft-id>");
          void decide(arg, { decision: "approve" });
          return;
        case "answer": {
          const [target, ...text] = arg.split(/\s+/);
          if (!target || !text.length) return echo("err", "usage: answer <question-id> <answer>");
          void answer(target, text.join(" "));
          return;
        }
        case "capture":
          if (!arg) return echo("err", "usage: capture <what you know>");
          void teach({ text: arg, kind: "note", tags: [], links: [] });
          return;
        case "spawn":
          if (!arg) return echo("err", "usage: spawn <task>");
          void spawn(arg);
          return;
        default:
          void spawn(raw);
      }
    },
    [answer, decide, echo, kill, spawn, teach],
  );

  const toggleKind = (k: NodeKind) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const mine = interns.filter((i) => i.ownerId === me.userId);

  // --- terminal resize: keep the existing `dragging` ref + useEffect block unchanged ---
  const dragging = useRef(false);
  useEffect(() => {
    /* paste the existing onMove/onUp effect body from the old file here, unchanged */
  }, []);

  return (/* the layout below */);
}
```

Layout changes to the existing JSX:
- `<Header … />` becomes `<Header me={me} interns={interns} onDeleteMine={deleteMine} />`. Directly under it, add the notice:
  ```tsx
  <div className="shrink-0 border-b border-warn/30 bg-warn/5 px-3 py-1 text-warn">{NOTICE}</div>
  ```
- `<BrainRail … />` becomes `<BrainRail graph={graph} hidden={hidden} onToggleKind={toggleKind} selected={selected} onSelect={select} />`.
- Just above `<CommandBar …>`, when `mine.length === 0`:
  ```tsx
  {mine.length === 0 ? (
    <div className="flex shrink-0 flex-wrap gap-2 border-t border-line bg-panel px-3 py-2">
      <span className="text-faint">try:</span>
      {EXAMPLES.map((e) => (
        <button key={e} type="button" onClick={() => void spawn(e)} className="border border-line px-2 text-dim hover:border-line-2 hover:text-fg">
          {e}
        </button>
      ))}
    </div>
  ) : null}
  ```
- `<CommandBar onSubmit={run} mode="live" busy={activeIds.length} />`. Leave the prop as is.
- Right `<aside>`, in this order: `<Teach …/>`, `<Questions …/>`, `<Outbox actions={outbox} onDecide={decide} />`, `<Feed />`, `<InternRail …/>`.
- Replace the `Header` function with:
  ```tsx
  function Header({ me, interns, onDeleteMine }: { me: Me; interns: Intern[]; onDeleteMine: () => void }) {
    const { signOut } = useAuthActions();
    const working = interns.filter((i) => i.status === "running" || i.status === "queued").length;
    return (
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <span className="tracking-[0.28em] text-fg">INTERN</span>
        <span className="text-line-2">|</span>
        <span className="text-faint">community brain</span>
        <div className="ml-auto flex items-center gap-4 text-faint">
          <span>{working} working</span>
          <a href="/stats" className="hover:text-fg">stats</a>
          <button type="button" onClick={onDeleteMine} className="hover:text-err">delete my stuff</button>
          <span className="flex items-center gap-1.5">
            {me.image ? <img src={me.image} alt="" className="size-4 rounded-full" /> : null}@{me.handle}
          </span>
          <button type="button" onClick={() => void signOut()} className="hover:text-fg" title="sign out">⏻</button>
        </div>
      </header>
    );
  }
  ```
  (If lint flags `<img>`, add `// eslint-disable-next-line @next/next/no-img-element`: avatars are 16px, and `next/image` would need remote config for one icon.)

- [ ] **Step 2: Trim `components/BrainRail.tsx`**

- Props become: `graph, hidden, onToggleKind, selected, onSelect`, with their existing types. Remove the `system, connectors, onConnect, trust, brain, onGraduate, onRefresh, refreshing` props, and remove from the imports any types no longer used.
- Replace the `brain` Section (from the `mode` row through the refresh button) with:
  ```tsx
  <Section title="brain">
    <Row k="nodes"><span className="text-dim tabular-nums">{graph.nodes.length}</span></Row>
    <Row k="edges"><span className="text-dim tabular-nums">{graph.edges.length}</span></Row>
  </Section>
  ```
- Delete the `contexts`, `senders` and `trust` Sections entirely, and the `Trust` import.

- [ ] **Step 3: Sandbox copy in `components/Outbox.tsx`**

- Remove the `connectors` prop and the `ConnectorsState` import. Replace `wiredFor` with `const wiredFor = (_kind: string) => true;`.
- In the header, replace the `{connectors?.dryRun ? (...) : null}` badge with `<span className="border border-warn/40 px-1 text-warn">sandbox</span>`.
- Pass `dryRun={true}` to `<Pending>`.
- Change the button string `"approve (dry run)"` to `"approve (sandbox)"`.
- In `Settled`, replace `approved via {action.decidedVia} ·{" "}{wired ? "sending…" : "waiting for an external sender"}` with `Approved. Sandbox: nothing was sent.`
- Change the empty-state text to: `nothing waiting. your interns' drafts land here. approving never sends anything, this is a sandbox.`

- [ ] **Step 4: New help in `components/CommandBar.tsx`**

Replace the `HELP` array with:
```ts
export const HELP = [
  "spawn <task>            brief an intern (bare text does the same)",
  "capture <what you know> teach the brain a fact (the + panel does it with a kind)",
  "kill <id>               stop your intern",
  "",
  "approve <id>            approve your draft as written (sandbox: nothing is sent)",
  "reject <id> <why>       reject it; the reason becomes a correction fact",
  "answer <id> <answer>    unblock your intern; the answer becomes a fact",
  "",
  "focus <id|all>          filter the stream",
  "clear                   clear your local lines",
  "help                    this",
];
```
Change the input placeholder to `"brief an intern, e.g. draft a Slack post introducing Intern   ( / to focus )"`.

- [ ] **Step 5: Build (Feed arrives in Task 8, so stub it first)**

Create a placeholder `components/Feed.tsx` exporting `export default function Feed() { return null; }` so the build passes. Task 8 replaces it.
Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all three succeed.

- [ ] **Step 6: Smoke test locally (2 terminals)**

```bash
npx convex dev
```
```bash
npm run dev
```
Open http://localhost:3000/app and check:
1. The GitHub button works, then the consent screen appears, then the cockpit.
2. Click the first example brief. The terminal shows `recalled N facts`, then streamed lines, then `drafted a slack`. The outbox shows the draft.
3. Edit the body and approve. The log shows `learned: slack: body rewritten…` and `Approved. Sandbox: nothing was sent.` A new fact node appears.
4. Brief 5 more times. The 6th shows `You've used your 5 briefs for today. Resets at 00:00 UTC.`

- [ ] **Step 7: Commit**

```bash
git add -A components/
git commit -m "Cockpit on live Convex queries, sandbox approve, and the public notice on every screen"
```

---

### Task 8: Community feed and landing stats

**Files:**
- Create: `convex/community.ts` (feed + landing only; evals in Task 9), `components/LandingStats.tsx`
- Replace: `components/Feed.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Create `convex/community.ts`**

```ts
import { query } from "./_generated/server";
import { ownerView } from "./access";

/** Newest 30 things anyone did, for the right rail. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const [interns, facts, actions] = await Promise.all([
      ctx.db.query("interns").order("desc").take(30),
      ctx.db.query("facts").order("desc").take(30),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(15),
    ]);
    const events: { at: number; ownerId: (typeof interns)[number]["ownerId"]; text: string }[] = [
      ...interns.map((i) => ({ at: i._creationTime, ownerId: i.ownerId, text: `briefed an intern: ${i.task.slice(0, 80)}` })),
      ...facts.flatMap((f) =>
        f.ownerId
          ? [{
              at: f._creationTime,
              ownerId: f.ownerId,
              text:
                f.kind === "preference" || f.kind === "correction"
                  ? `corrected a draft → ${f.title.slice(0, 60)}`
                  : f.internId
                    ? `'s intern filed: ${f.title.slice(0, 60)}`
                    : `taught: ${f.title.slice(0, 60)}`,
            }]
          : [],
      ),
      ...actions.map((a) => ({ at: a.decidedAt ?? a._creationTime, ownerId: a.ownerId, text: `approved a ${a.kind} draft` })),
    ];
    events.sort((a, b) => b.at - a.at);
    return await Promise.all(
      events.slice(0, 30).map(async (e) => ({ at: e.at, text: e.text, ...(await ownerView(ctx, e.ownerId)) })),
    );
  },
});

/**
 * Landing-page counts. ponytail: bounded scans capped at 1,000 (the UI shows
 * "1000+"); swap for @convex-dev/aggregate if it ever says that.
 */
export const landing = query({
  args: {},
  handler: async (ctx) => {
    const cap = 1000;
    const [users, facts, approved] = await Promise.all([
      ctx.db.query("users").take(cap),
      ctx.db.query("facts").take(cap),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).take(cap),
    ]);
    return { people: users.filter((u) => u.acceptedAt).length, facts: facts.length, approved: approved.length, cap };
  },
});
```

- [ ] **Step 2: Replace `components/Feed.tsx`**

```tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const ago = (at: number) => {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

export default function Feed() {
  const events = useQuery(api.community.feed, {});
  return (
    <section className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-b border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center border-b border-line px-3">
        <h2 className="label">community</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!events?.length ? (
          <p className="p-3 text-faint">nobody yet. you&rsquo;re first.</p>
        ) : (
          events.map((e, i) => (
            <div key={i} className="flex items-start gap-2 border-b border-line/50 px-3 py-1.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {e.image ? <img src={e.image} alt="" className="mt-0.5 size-4 shrink-0 rounded-full" /> : null}
              <p className="min-w-0 text-dim leading-snug">
                <span className="text-fg">@{e.handle}</span> {e.text}
                <span className="ml-1 text-faint">· {ago(e.at)}</span>
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Create `components/LandingStats.tsx`**

```tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export default function LandingStats() {
  const s = useQuery(api.community.landing, {});
  if (!s) return null;
  const n = (x: number) => (x >= s.cap ? `${s.cap}+` : String(x));
  return (
    <p className="mt-4 text-faint">
      {n(s.people)} people have tried it · {n(s.facts)} facts · {n(s.approved)} drafts approved
    </p>
  );
}
```

- [ ] **Step 4: Edit `app/page.tsx`**

- Add `import LandingStats from "@/components/LandingStats";`.
- Change the CTA link text `open the cockpit →` to `Try it with GitHub →`.
- Change the span `no setup — it runs seeded until you connect anything` to `a public test brain · everyone who signs in shares it`.
- Insert `<LandingStats />` after the CTA `div` (inside `<header>`).
- Grep the page for `seeded`, `slack, drive`, `connect`: any sentence that promises real sends or connectors becomes sandbox-true (e.g. "Anything that would leave the building stops and waits for you" → "Drafts stop and wait for you; in this public sandbox nothing is ever sent.").

- [ ] **Step 5: Build, smoke test, commit**

Run: `npx convex dev --once && npm run build`. In `npm run dev`, confirm that `/` shows the counts and that `/app` shows the community rail with your earlier events.
```bash
git add convex/community.ts components/Feed.tsx components/LandingStats.tsx app/page.tsx
git commit -m "Show who else is in the brain: a community feed and live counts on the landing page"
```

---

### Task 9: Eval stats page and offline eval script

**Files:**
- Modify: `convex/community.ts` (add `evals`)
- Create: `app/stats/page.tsx`, `scripts/eval.ts`
- Modify: `package.json` (add `eval` script)

- [ ] **Step 1: Add `evals` to `convex/community.ts`**

```ts
/**
 * The three numbers on /stats. ponytail: last 1,000 runs and drafts.
 * "Edit rate" = share of decided drafts that were edited or rejected.
 */
export const evals = query({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db.query("interns").order("desc").take(1000);
    const drafts = (await ctx.db.query("actions").order("desc").take(1000)).filter((a) => a.decision);

    const withBlock = runs.filter((r) => r.parseOutcome?.startsWith("action"));
    const parsed = withBlock.filter((r) => r.parseOutcome === "action").length;

    const rate = (xs: typeof drafts) =>
      xs.length ? xs.filter((d) => d.decision !== "approved_unedited").length / xs.length : null;
    const recalled = drafts.filter((d) => d.recalledCorrection);
    const cold = drafts.filter((d) => !d.recalledCorrection);

    return {
      runs: runs.length,
      parseRate: withBlock.length ? parsed / withBlock.length : null,
      actionBlocks: withBlock.length,
      uneditedRate: drafts.length ? drafts.filter((d) => d.decision === "approved_unedited").length / drafts.length : null,
      decided: drafts.length,
      editRateWithCorrection: rate(recalled),
      withCorrection: recalled.length,
      editRateWithout: rate(cold),
      without: cold.length,
    };
  },
});
```

- [ ] **Step 2: Create `app/stats/page.tsx`**

First read `node_modules/next/dist/docs/01-app/` for the page-file conventions in this Next version, and check that a `"use client"` page is still allowed.
```tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export default function Stats() {
  const s = useQuery(api.community.evals, {});
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <p className="label">evals · live from every public run</p>
        {!s ? (
          <p className="mt-6 text-faint">loading…</p>
        ) : (
          <dl className="mt-6 space-y-6">
            <Stat k="action-block parse rate" v={pct(s.parseRate)} n={`${s.actionBlocks} drafts attempted · ${s.runs} runs`} />
            <Stat k="approved unedited" v={pct(s.uneditedRate)} n={`${s.decided} drafts decided`} />
            <Stat
              k="edit rate: recalled a correction vs not"
              v={`${pct(s.editRateWithCorrection)} vs ${pct(s.editRateWithout)}`}
              n={`${s.withCorrection} vs ${s.without} drafts · lower on the left means the brain is learning`}
            />
          </dl>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, n }: { k: string; v: string; n: string }) {
  return (
    <div className="border border-line bg-panel p-4">
      <dt className="text-faint">{k}</dt>
      <dd className="mt-1 text-2xl text-fg tabular-nums">{v}</dd>
      <dd className="mt-1 text-faint">{n}</dd>
    </div>
  );
}
```

- [ ] **Step 3: Create `scripts/eval.ts`**

```ts
/**
 * Offline eval: 20 fixed briefs through the current prompt.
 * Checks the one thing that has silently broken before: does a brief that
 * should draft produce a *usable* action block, and does one that should ask
 * produce a question?
 *
 *   npm run eval
 *
 * About $0.10 per run on paid Gemini; free tier works but paces at 6s/brief.
 * Exits 1 if the action parse rate is under 90%.
 */
import { parseActionBlock } from "../lib/action-block.ts";
import { PROMPT_VERSION, brief } from "../lib/brief.ts";
import { stream } from "../lib/gemini.ts";
import { parseQuestionBlock } from "../lib/parse.ts";

type Expect = "action" | "question" | "any";

const CASES: [string, Expect][] = [
  ["Draft a Slack post introducing Intern to a new teammate", "action"],
  ["Write a follow-up email to someone who asked what Intern does", "action"],
  ["Email a prospect a two-line intro to Intern", "action"],
  ["Post in #general that the brain now has a community feed", "action"],
  ["Draft a Slack message thanking the team for testing", "action"],
  ["Write an email inviting a friend to try the public brain", "action"],
  ["Draft a short Slack update: approvals are sandbox-only", "action"],
  ["Email a recruiter a one-paragraph summary of Intern", "action"],
  ["Draft a Slack reminder to review pending drafts", "action"],
  ["Write an email declining a meeting politely", "action"],
  ["Post a Slack welcome for a new designer", "action"],
  ["Draft an email asking for feedback on Intern", "action"],
  ["Email Sarah about the thing we discussed", "question"],
  ["Send the pricing to our biggest customer", "question"],
  ["Book the usual room for the weekly sync", "question"],
  ["Tell the new hire who they report to", "question"],
  ["Summarise what Intern is in three sentences", "any"],
  ["What makes a prospect viable for Intern?", "any"],
  ["List two risks the brain has not solved yet", "any"],
  ["Who is Intern for?", "any"],
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let attempted = 0;
let usable = 0;
let matched = 0;

console.log(`prompt ${PROMPT_VERSION} · ${CASES.length} briefs\n`);
for (const [task, expect] of CASES) {
  let report = "";
  try {
    for await (const c of stream(brief(task, []))) report += c.text ?? "";
  } catch (err) {
    console.log(`ERR  ${task}\n     ${err instanceof Error ? err.message : err}`);
    await sleep(6000);
    continue;
  }
  const action = parseActionBlock(report);
  const question = parseQuestionBlock(report);
  const got = action && !("error" in action) ? "action" : question && !("error" in question) ? "question" : action ? "action_malformed" : "none";
  if (action) attempted++;
  if (got === "action") usable++;
  const ok = expect === "any" || got === expect;
  if (ok) matched++;
  console.log(`${ok ? "ok " : "MISS"} ${got.padEnd(16)} ${task}${action && "error" in action ? `\n     ${action.error}` : ""}`);
  await sleep(6000);
}

const parseRate = attempted ? usable / attempted : 1;
console.log(`\naction parse rate ${Math.round(parseRate * 100)}% (${usable}/${attempted}) · expectation match ${matched}/${CASES.length}`);
process.exit(parseRate < 0.9 ? 1 : 0);
```

In `package.json` scripts, add:
```json
"eval": "node --env-file=.env.local --experimental-strip-types scripts/eval.ts"
```

- [ ] **Step 4: Run it once**

Run: `npm run eval`
Expected: 20 lines plus a summary, exit 0. If the parse rate is under 90%, paste the MISS lines to Mihir. Don't tune the prompt in this task.

- [ ] **Step 5: Build and commit**

Run: `npx convex dev --once && npm run build`
```bash
git add convex/community.ts app/stats/page.tsx scripts/eval.ts package.json
git commit -m "Eval the intern: live /stats from real runs, and a 20-brief offline check"
```

---

### Task 10: Production deployment, end-to-end check, launch

**Needs Mihir for the account steps.**

- [ ] **Step 1 (Mihir): Create the Convex production deployment and its secrets**

1. Run `npx convex deploy` and confirm. It pushes the functions and creates prod. Note the prod URL (`https://<name>.convex.cloud`) and site URL (`https://<name>.convex.site`).
2. On GitHub, create a new OAuth App named `Intern`. Homepage `https://intern-brain.vercel.app`. Callback `https://<name>.convex.site/api/auth/callback/github`.
3. Convex dashboard (prod) env:
   - `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `GEMINI_API_KEY`
   - `SITE_URL=https://intern-brain.vercel.app`
   - `JWT_PRIVATE_KEY` and `JWKS`: generate them with the Convex Auth manual-setup script (https://labs.convex.dev/auth/setup/manual). Don't reuse dev's.
4. Seed: `npx convex run --prod seed:run`. Expected: `{ "seeded": 3 }`.

- [ ] **Step 2 (Mihir): Point Vercel Production at prod Convex**

```bash
npx vercel env rm NEXT_PUBLIC_CONVEX_URL production -y
```
```bash
npx vercel env add NEXT_PUBLIC_CONVEX_URL production
```
Paste the prod `.convex.cloud` URL. Then remove the variables nothing reads anymore, from both `production` and `preview`:
```bash
npx vercel env rm GEMINI_API_KEY production -y
```
Repeat that command for `INTERN_SERVICE_SECRET` and `NEXT_PUBLIC_CONVEX_SITE_URL`, in both environments.

- [ ] **Step 3: Merge and deploy**

With Mihir's go-ahead: push the branch to `origin`, open a PR `public-mvp` → `main` on `MihirSahu14/intern`, and merge after review. Vercel deploys `main` to production.

- [ ] **Step 4: E2E on https://intern-brain.vercel.app (two GitHub accounts, e.g. one in a private window)**

1. A: sign in → consent → click the example brief. The terminal streams, the draft lands, and it's visible on the graph.
2. A: edit the draft body and approve. Check for `learned: …` and `Approved. Sandbox: nothing was sent.`
3. B: sign in → consent. The feed shows A's brief and correction. B briefs "Draft a Slack post introducing Intern". The terminal shows `recalled N facts`, and the pulsing nodes include A's correction.
4. B: brief 5 times. The 6th is refused with the reset time.
5. A: "delete my stuff". A's facts, interns and drafts disappear from the graph and feed. B's stay.
6. `/stats` shows non-empty numbers. `/` shows the counts.
7. Nothing reached Slack or email. This holds by construction: no send code exists. Grep to confirm:
   ```bash
   git grep -nE "chat\.postMessage|gmail|sendAs" -- convex lib app components
   ```
   Expected: no matches.

- [ ] **Step 5: Record the result**

Append to `HANDOVER.md` a short "Public MVP (launched YYYY-MM-DD)" section:
- the prod deployment name
- the GitHub OAuth apps (dev + prod)
- the admin tools: Convex dashboard, and `users:ban` via the function runner
- the caps
- `npm run eval`

Commit it. Update the WS3 row in `C:\Users\mihir\Desktop\Projects\job-search\HUB.md`.

---

## Self-review (done while writing)

- **Spec coverage:**
  - Run engine: Tasks 2, 4
  - Deletions: Tasks 3, 5
  - GitHub, consent, banner: Tasks 3, 6, 7
  - Caps: Tasks 2, 4
  - Free-tier 429: Tasks 2 (status in error), 4 (`BUSY`, `countsTowardCap:false`)
  - Sandbox and Slack fallback removal: Tasks 3 (delete `slack.ts`), 7
  - Delete-mine: Tasks 3, 7
  - Ban: Task 3 (dashboard; deviation 2)
  - Hygiene: Tasks 1, 4 (seed without Slack channel)
  - Community feed, landing stats, examples: Tasks 7, 8
  - Visibility (everyone reads, owner acts): Tasks 4, 7 (deviation 4)
  - Eval fields, /stats, eval.ts: Tasks 3, 4, 9
  - Tests: Task 2
  - Two-account E2E: Task 10
  - Git: Task 10
- **Types:**
  - `dispatch` (interns.ts) is used by questions.ts
  - `insertFact` (facts.ts) is used by interns, outbox, questions and seed
  - `requireMember` / `ownerView` (access.ts) are used everywhere
  - `recalledCorrection` is set by `noteRecall` and read by `finish` → `actions` → `evals`
  - `NOTICE` is exported by Consent and used by Cockpit
- **Known soft spots:**
  - The Task 3 Step 3 profile-key typing may need a cast (instructions given).
  - Task 4 Step 6 needs the three seed bodies pasted from the backup (command given).
  - The Gemini list price in `lib/caps.ts` is hand-checked.
