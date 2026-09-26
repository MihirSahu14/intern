# Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sources feed the brain as things happen: every message in the community Slack's public channels (live, plus 90 days back), documents members add (a URL or an uploaded markdown, text or PDF file) and public GitHub repos become searchable **passages** that interns recall, and people (or an approved draft that cited one) promote a passage into a **fact** on the graph.

**Architecture:**
- Pure logic lives in `lib/*.ts` with `node --test` tests: the chunker, HTML to text, the URL safety check and the guarded fetch (`lib/ingest.ts`), Slack's `v0` signature, event reader and Web API helper (`lib/slack.ts`), GitHub's endpoints and readers (`lib/github.ts`), and PDF text (`lib/pdf.ts`).
- Convex owns the flow. `convex/sources.ts` is the database side (add, remove, promote, the one upsert every reader writes through). `convex/slack.ts` is the `/slack/events` HTTP action. `convex/ingest.ts` holds the Slack backfill and GitHub sync actions (default runtime, plain `fetch`). `convex/documents.ts` is the one `"use node"` file: URL and upload reading, where Node's `fetch` gives `redirect: "manual"` a real 3xx and pdf.js has what it needs. A cron refreshes repos daily.
- Recall stays full-text: `facts.archive` runs two Convex searches (public; the owner's own private) next to `facts.recall`, and the brief gains a "FROM THE ARCHIVE" section. Passage ids follow the brief's existing rule for fact ids: cited as `[p:<id>]` in the action's `"sources"` only, never in report prose (the terminal's `stripCites` drops any that leak). Semantic search later is a change to that one function.

**Tech Stack:**
- Next.js 16.3 (App Router), React 19, Tailwind 4
- Convex 1.43 (file storage, full-text search, crons, one `"use node"` module), `@convex-dev/auth` 0.0.94, `convex-test` 0.0.59
- Slack Web API + Events API (free), GitHub REST API (free, one fine-grained token), `unpdf` (pure-JS pdf.js build, MIT, free) — confirmed in Task 6 Step 1
- `node --test --experimental-strip-types` for `lib/`, `vitest` + `convex-test` for `convex/`

**Spec:** `docs/superpowers/specs/2026-09-25-ingestion-design.md`

## Refreshed against `main` @ `1238905` (2026-09-25)

The first draft of this plan was written against an older `main`. Roughly ten PRs have merged since (through #24). What changed here because of them:
- **`lib/brief.ts`** now takes `brief(task, recalled, sendsFrom, self?, slackChannel?)`, has no question block, a YOU WORK FOR section and a fixed ABOUT section built from `CONNECTORS` and the caps. `archive` becomes the **sixth** positional argument, `PROMPT_VERSION` hashes a fourth sample, and ABOUT gains one line naming the archive (Task 2).
- **Citations:** the brief already says fact `[id]`s go in `"sources"` only, never in prose, and `lib/log-view.ts`'s `stripCites` drops leaked ones in the terminal. Passage ids follow the same rule: the archive header says so, the action example lists `[id]s and [p:id]s`, and `stripCites` learns the `p:` prefix (Task 2). Auto-promotion reads `[p:…]` from the approved action's `sources` only (Task 3).
- **`convex/run.ts`** gained the one-rewrite-call backstop and summed usage. `run.go`'s recall block is unchanged, so it gains the archive query next to it and the `brief(...)` call gains `archive` (Task 2). The rewrite call reuses the same prompt, archive included.
- **`convex/facts.ts` `graph`** now collapses resume chains (`rootOf`), redacts every label, drops cancelled chains and draws ownerless facts off a `src:seed` "starter facts" node. Source nodes slot into that: labels redacted, a promoted fact hangs `from` its source before any other edge, and an ownerless promoted fact never falls back to "starter facts" (Task 8).
- **Already on `main`, not re-added:** `COMMUNITY_SLACK_TEAM_ID` (enforced on connect in `connections.finish`; the events endpoint reuses it) and `COMMUNITY_SLACK_INVITE_URL` (`connections.mine` returns it as the Slack row's `invite`, https-only and tested in `surfaces.test.ts`; the rail already links it). The old plan's `sources.setup.slackInvite` and its test are gone: the join step reads `connections.mine`, and `sources.setup` only says whether GitHub is on (Task 7).
- **Caps:** every per-member cap now takes `exempt` (`CAP_EXEMPT_HANDLES`), so `sourceBlocked` does too (Tasks 1, 6).
- **Cockpit:** the brief box is on top and the log is a tab behind the graph, so a rail action that only echoed to the log would go unseen. "Add a source" and a source's passages show their own status inline (`components/Sources.tsx`), and `Cockpit.tsx` is no longer touched (Task 8).
- **Broadcasts:** tests use `BROADCAST_SLACK_WEBHOOK_URL`. Discord is out of scope throughout.
- **`convex/seed.ts`** now says feeding the brain from Slack and documents "is the next step, not something it does today". Once this lands that's false, so Task 9 rewrites the sentence and HANDOVER tells Mihir to patch the already-seeded prod row.

## Global Constraints

- **Recall:** up to **6 passages** per run (`PASSAGES_RECALLED`), each shown as at most **400 characters** (`PASSAGE_EXCERPT`). Public passages, plus the intern owner's own private ones, never another member's.
- **Citations:** a passage is cited as `[p:<id>]` in the action's `"sources"` only, never in report prose, exactly like a fact's `[id]`. Promotion on approval reads `[p:…]` from `actions.sources` and nothing else.
- **Chunking:** split on blank lines into passages of about **800–1,200 characters** (`CHUNK_MIN`, `CHUNK_MAX`), **at most 200 per document** (`MAX_PASSAGES_PER_DOCUMENT`).
- **Caps:** **5 sources added per member per day** (`SOURCES_PER_DAY`, `lib/caps.ts`), skipped for `CAP_EXEMPT_HANDLES` like every other per-member cap. The **20 facts/day** cap applies to manual promotes only.
- **URL fetch safety:** https only; hostnames that are IP literals in private or loopback ranges are refused, as are `localhost`, `*.local` and `*.internal`; no redirects to such hosts; a **10-second timeout** (`FETCH_TIMEOUT_MS`), a **2 MB cap** (`URL_MAX_BYTES`), and `text/html`, `text/plain` or `text/markdown` only. HTML is reduced to text: scripts, styles and nav are removed.
- **Uploads:** markdown, text or PDF, **up to 5 MB** (`UPLOAD_MAX_BYTES`), through Convex file storage. A scanned PDF with no text layer is refused with a clear message.
- **Slack:** **public channels only**. Bot scopes `channels:history`, `channels:read`, `reactions:read`, `users:read` (plus `channels:join`, see Decision 1). **Never `groups:*`, `im:*` or `mpim:*`.** Backfill reaches **90 days** back (`BACKFILL_DAYS`).
- **Slack webhook:** verify the `v0` signature over `v0:<timestamp>:<raw body>` with `SLACK_BRAIN_SIGNING_SECRET`: constant-time compare, 5-minute window, **401 before parsing**. Ignore any event whose `team_id` isn't `COMMUNITY_SLACK_TEAM_ID`. The endpoint logs event ids and types only, never message text.
- **No model calls anywhere in ingestion. No paid services.** Every source is on a free plan.
- **Visibility:** Slack passages are public; documents are public unless "keep private"; GitHub is public repos only. Every reader of passages (recall, the promote listing, member pages, the graph) applies `visibleTo`, the same rule as facts. Deleted in Slack means deleted in the brain. What a public surface shows (graph labels, the rail's passage list, the feed, member pages) goes through `redactEmails`, as every graph label on `main` already does.
- **Every write goes through `requireMember`.** Every public mutation that writes starts with it; webhook and scheduled paths, which have no session, apply `memberProblem` to any member they attribute to.
- **Never trust an id from a request body.** A `sourceId`/`passageId` is checked against ownership and `visibleTo`; a `[p:…]` citation is looked up with `ctx.db.normalizeId` and checked; an upload's `storageId` is accepted only if the file is fresh, unclaimed and under the cap.
- Env (all Convex, prod and dev), each optional, unset means that part is off. **New:** `SLACK_BRAIN_BOT_TOKEN`, `SLACK_BRAIN_SIGNING_SECRET`, `GITHUB_TOKEN`. **Already on `main`, reused:** `COMMUNITY_SLACK_TEAM_ID` (unset: every Slack event is ignored), `COMMUNITY_SLACK_INVITE_URL` (read only through `connections.mine`'s `invite`). Read with `process.env`, as the rest of `convex/` does.
- Never invent a Slack, GitHub or `unpdf` field, endpoint or limit. The first step of Tasks 1, 4, 5, 6, 7 and 9 fetches the official page and confirms each value into one named constant or function; everything else in the task is written against that name. If a page can't be reached, stop and report; don't guess.
- No test hits the network: `fetch` is stubbed (`vi.stubGlobal` in vitest, an injected `fetch` in node tests), env with `vi.stubEnv`; both undone in `afterEach`.
- Every task ends green on its own: `npm test`, `npx vitest run`, `npx tsc --noEmit -p convex`, `npx tsc --noEmit`, `npm run build`, `npm run lint` (0 errors; the existing warnings stay).
- Read `convex/_generated/ai/guidelines.md` before touching `convex/`.
- **Implementers never run `npx convex dev`, `deploy`, `run` or `env`.** A task that adds a `convex/` module adds it to `convex/_generated/api.d.ts` by hand, exactly as codegen would: `import type * as <name> from "../<name>.js";` among the imports and `<name>: typeof <name>;` in `fullApi`, both in alphabetical order. The controller's deploy regenerates the file.
- Runtime imports from `convex/` into `lib/`, and between `lib/` files, spell out the `.ts` extension. `lib/ingest.ts` has no imports at all, so client components may import its constants.
- Branch `ingestion`, cut from `main` @ `1238905`. Match anchors on text, not line numbers. Commit after every task. Don't push; the controller deploys.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions made while planning (flag to Mihir at handoff)

1. **The bot needs `channels:join`.** A bot token reads `conversations.history` and receives `message.channels` only for channels it's a member of. The spec's four scopes can't join one, so the backfill adds `channels:join` (public channels only, like the rest). A channel created later is picked up by re-running `ingest:backfillSlack`.
2. **A run that recalled a private passage is private,** like one that recalled a private fact: `interns.noteRecall` takes `privateArchive`, so the facts that run files and the lesson its draft teaches stay owner-only.
3. **Passages come from a sibling query, `facts.archive`,** called next to `facts.recall` in `run.go`. `recall`'s return shape (and its five call sites in `convex/surfaces.test.ts`) stay as they are, and `archive` is the one function to swap for embeddings later.
4. **No twin facts from a double 🧠.** With `COMMUNITY_SLACK_TEAM_ID` enforced on connect, every member's Composio Slack *is* the community workspace, so one 🧠 from a linked member reaches both the Composio path (`convex/inbound.ts`, source `slack:<channel>:<ts>`) and "Intern Brain". Promotion files under that same `source` key and adopts an existing fact with it; `inbound.capture` then sees a duplicate. Whichever lands first decides the fact's visibility: Composio's path keeps someone else's message owner-only, Intern Brain's makes any public-channel message public.
5. **The upload's `storageId` is verified, not trusted:** fresh (under an hour old), unclaimed (no source with `externalId` `upload:<storageId>`), and 5 MB or less.
6. **Two small tables/indexes the spec doesn't list:** `slackUsers` (the per-user display-name cache the spec asks for) and `connections.by_externalUserId` (author and 🧠 mapping). `sources` gains `storageId` so removal and purge can delete the file.
7. **`passages.by_sourceId` is `by_sourceId_and_at`.** Its prefix serves every by-source query, and it orders the rail by message time.
8. **Every passage is at most 1,200 characters.** Documents already are (chunks); Slack messages and GitHub issue bodies are cut there. A README is chunked into at most 20 passages (`readme`, `readme:1`, …), not one.
9. **"Unchanged" promoted fact** means its title and body still equal what promotion makes from the passage. An edit in Slack (or on GitHub) carries over to an unchanged fact, so a later delete still removes it; a fact that isn't unchanged (a member's own Composio capture) is left alone.
10. **The 20/day cap is the promote button's only;** 🧠 and approval are uncapped, per the spec.
11. **Documents dedupe per member, repos globally,** so adding a URL never reveals that someone else added it privately. A removed source keeps its row (`status: "removed"`) so the 5/day cap can't be dodged by remove-and-re-add.
12. **"@x added a source" fires on the first successful read** (when a document's label has become its page title), from the one write path, for public sources only.
13. **Backfill reads channel-level history only;** thread replies arrive live but aren't backfilled (`conversations.replies` isn't called).
14. **URL reading runs in the `"use node"` module** (`convex/documents.ts`), next to PDF reading: Node's `fetch` documents `redirect: "manual"` as returning the real 3xx, which the redirect check depends on.
15. **The URL check is on the hostname as written** (after WHATWG normalization, so `https://2130706433/` is caught as `127.0.0.1`). Every IPv6 literal and every dotless host is refused. DNS rebinding isn't covered; that needs resolving the name first, which Convex's runtime doesn't expose.
16. **The join step is remembered per browser** (`localStorage`), so it shows once after consent, and once for members who consented before it existed. It reads the invite from `connections.mine` (no second copy of the env check) and is skipped when the member's Slack is already connected.
17. **Passage ids are handled exactly like fact ids:** `[p:<id>]` in `"sources"` only, and `stripCites` also drops `[p:…]` (alone or in a mixed list) from the terminal's prose.
18. **The consent notice names sources.** It said briefs and facts are public; members can now add public sources and the community Slack is read in, so `NOTICE` says that too (Task 5). The same string is the cockpit's banner.
19. **Rail status is inline, not echoed.** The log is a tab behind the graph now, so `components/Sources.tsx` shows "reading …", errors and cap refusals under its own form or passage list.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/ingest.ts` (+test) | new | Constants, chunker, HTML to text, `urlProblem`, `fetchDocument`, `parseCitations`, `passageFact`, `isPdf`/`decodeText`/`hasTextLayer`, `IngestError`/`sourceError` |
| `lib/slack.ts` (+test) | new | `v0` signature, event reader, Web API helper, readers, backfill pacing |
| `lib/github.ts` (+test) | new | Endpoints, headers, `repoPath`, `readRepo`, `readIssues`, `readmePassages` |
| `lib/pdf.ts` (+test) | new | `pdfText` over `unpdf` |
| `lib/caps.ts` (+test) | modify | `SOURCES_PER_DAY`, `sourceBlocked` (takes `exempt`) |
| `lib/brief.ts` (+test) | modify | `Archived`, the "FROM THE ARCHIVE" section (sixth `brief` argument), `[p:id]s` in the action example's `sources`, one ABOUT line, `PROMPT_VERSION` |
| `lib/log-view.ts` (+test) | modify | `stripCites` also drops `[p:…]` |
| `lib/broadcast.ts` (+test) | modify | `added_source` event; `stripLinks` exported |
| `lib/inbound.ts` | modify | export `same`, `obj`, `str` |
| `convex/schema.ts` | modify | `sources`, `passages`, `slackUsers`; `facts.fromPassageId`; `connections.by_externalUserId` |
| `convex/access.ts` | modify | `visibleTo` for any owned row; `slackMember`; `capExempt`'s comment names sources/day |
| `convex/facts.ts` | modify | `searchTerms`, `archive`; `insertFact` takes `fromPassageId`; graph source nodes, `added` and `from` edges |
| `convex/interns.ts` | modify | `noteRecall` takes `privateArchive` |
| `convex/run.ts` | modify | Recall the archive next to facts; pass it as `brief`'s sixth argument |
| `convex/outbox.ts` | modify | `decide` promotes cited passages |
| `convex/users.ts` | modify | `purge` removes sources, passages and files |
| `convex/community.ts` | modify | Feed "added a source"; member page sources |
| `convex/sources.ts` | new | `promote`, `remove`, `addLink`, `uploadUrl`, `addUpload`, `passages`, `setup` (`{ github }`); internal `write`, `get`, `fail`, `repos`; helpers `promotePassage`, `promoteCited`, `rewritePassage`, `clearPassages` |
| `convex/slack.ts` | new | `events` HTTP action; internal `knownChannel`, `ensureChannel`, `cachedName`, `rememberName`, `edit`, `forget`, `react`; `authorName` |
| `convex/ingest.ts` | new | `backfillSlack`, `backfillChannel`, `syncRepo`, `refreshRepos` |
| `convex/documents.ts` | new, `"use node"` | `readUrl`, `readUpload` |
| `convex/crons.ts` | new | Daily repo refresh |
| `convex/http.ts` | modify | `POST /slack/events` |
| `convex/_generated/api.d.ts` | modify | New modules, by hand |
| `convex/ingest.test.ts` | new | convex-test coverage for everything above |
| `components/Sources.tsx` | new | `AddSource` (the rail's "add a source") and `SourcePanel` (a source node's passages, promote, remove), each with its own inline status |
| `components/BrainRail.tsx` | modify | Mounts both; no new props |
| `components/Consent.tsx` | modify | `NOTICE` names sources; `JoinSlack` step |
| `components/Gate.tsx` | modify | Shows it once after consent, from `connections.mine`'s Slack `invite` |
| `components/MemberPage.tsx` | modify | "added sources" |
| `convex/seed.ts` | modify | "What Intern is" stops calling Slack/document feeding "the next step" |
| `HANDOVER.md` | modify | Setup: the Intern Brain app, the new env, token, backfill, patching the seeded fact |

---

### Task 1: Pure ingestion libs — chunker, HTML to text, URL safety, Slack signature, citations

**Files:**
- Create: `lib/ingest.ts`, `lib/ingest.test.ts`, `lib/slack.ts`, `lib/slack.test.ts`
- Modify: `lib/inbound.ts` (export `same`), `lib/caps.ts` (append after `sendBlocked`), `lib/caps.test.ts`

**Interfaces:**
- Consumes: `same` from `lib/inbound.ts` (made exported here).
- Produces (later tasks import these exact names):
  ```ts
  // lib/ingest.ts — no imports, safe for client components
  export const PASSAGES_RECALLED = 6, PASSAGE_EXCERPT = 400, CHUNK_MIN = 800, CHUNK_MAX = 1200,
    MAX_PASSAGES_PER_DOCUMENT = 200, URL_MAX_BYTES = 2 MB, UPLOAD_MAX_BYTES = 5 MB,
    FETCH_TIMEOUT_MS = 10_000, BACKFILL_DAYS = 90;
  export const DOCUMENT_TYPES: string[];
  export class IngestError extends Error {}
  export function sourceError(err: unknown): string;
  export function chunk(text: string): string[];
  export function htmlToText(html: string): { title: string | null; text: string };
  export function urlProblem(raw: string): string | null;
  export type Fetched = { url: string; contentType: string; text: string };
  export function fetchDocument(raw: string, f?: typeof fetch): Promise<Fetched>; // throws IngestError
  export function parseCitations(sources: string[]): string[];
  export function passageFact(text: string): { title: string; body: string };
  // lib/slack.ts
  export const SLACK_TOLERANCE_S = 300;
  export function slackSignature(secret: string, timestamp: string, body: string): Promise<string>; // "v0=<hex>"
  export function verifySlack(secret: string, h: { timestamp: string | null; signature: string | null }, body: string, nowMs?: number): Promise<boolean>;
  // lib/caps.ts
  export const SOURCES_PER_DAY = 5;
  export const sourceBlocked: (addedToday: number, exempt?: boolean) => string | null; // exempt: CAP_EXEMPT_HANDLES, like every per-member cap
  ```

- [ ] **Step 1: Confirm Slack's request signing against its docs**

Fetch `https://docs.slack.dev/authentication/verifying-requests-from-slack` and confirm:
1. The headers are `X-Slack-Signature` and `X-Slack-Request-Timestamp`.
2. The base string is `v0:<timestamp>:<raw body>`, HMAC-SHA256 keyed with the signing secret, hex digest, prefixed `v0=`.
3. Requests with a timestamp more than five minutes from now are to be ignored.
4. The worked example: signing secret `8f742231b10e8888abcd99yyyzzz85a5`, timestamp `1531420618`, the body in the Step 2 test, and signature `v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503`.

Record any difference in `lib/slack.ts` (Step 4) and in the Step 2 test before running anything. Put today's date in `lib/slack.ts`'s header comment.

- [ ] **Step 2: Write the failing tests**

`lib/ingest.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK_MAX,
  FETCH_TIMEOUT_MS,
  MAX_PASSAGES_PER_DOCUMENT,
  URL_MAX_BYTES,
  chunk,
  fetchDocument,
  htmlToText,
  parseCitations,
  passageFact,
  urlProblem,
} from "./ingest.ts";

const x = (n: number, c = "x") => c.repeat(n);

// --- chunking --------------------------------------------------------------

test("short text is one passage", () => {
  assert.deepEqual(chunk("Hello.\n\nWorld."), ["Hello.\n\nWorld."]);
  assert.deepEqual(chunk("  \n\n "), []);
});

test("paragraphs gather into passages of about 800 to 1,200 characters", () => {
  assert.deepEqual(chunk([x(500, "a"), x(500, "b"), x(500, "c")].join("\n\n")), [
    `${x(500, "a")}\n\n${x(500, "b")}`,
    x(500, "c"),
  ]);
  assert.deepEqual(chunk([x(500, "a"), x(900, "b")].join("\r\n\r\n")), [x(500, "a"), x(900, "b")]);
});

test("a paragraph over 1,200 characters is cut at a sentence end where it can be", () => {
  const first = `${"Word ".repeat(180).trim()}.`; // 900 characters
  const second = `${"More ".repeat(200).trim()}.`; // 1,000 characters
  assert.deepEqual(chunk(`${first} ${second}`), [first, second]);
});

test("with no sentence end to cut at, a paragraph is cut at 1,200", () => {
  assert.deepEqual(chunk(x(3000)).map((c) => c.length), [CHUNK_MAX, CHUNK_MAX, 600]);
});

test("a document stops at 200 passages", () => {
  const out = chunk(Array(300).fill(x(900)).join("\n\n"));
  assert.equal(out.length, MAX_PASSAGES_PER_DOCUMENT);
  assert.ok(out.every((c) => c.length <= CHUNK_MAX));
});

// --- html ------------------------------------------------------------------

test("html becomes text: scripts, styles and nav go, blocks become paragraphs, entities decode", () => {
  const html = `<html><head><title>Ship &amp; tell</title><style>p{}</style></head><body><nav><a href="/">Home</a></nav><script>alert(1)</script><h1>Release notes</h1><p>We ship on&nbsp;Fridays.</p><p>QA is &lt;Thursday&gt;.<br>Always &#8212; &#x2713;</p></body></html>`;
  assert.deepEqual(htmlToText(html), {
    title: "Ship & tell",
    text: "Release notes\n\nWe ship on Fridays.\n\nQA is <Thursday>.\nAlways — ✓",
  });
  assert.deepEqual(htmlToText("<p>no title</p>"), { title: null, text: "no title" });
});

// --- url safety ------------------------------------------------------------

test("only public https URLs pass", () => {
  assert.equal(urlProblem("https://example.com/handbook"), null);
  assert.match(urlProblem("http://example.com/") ?? "", /https/);
  assert.match(urlProblem("not a url") ?? "", /isn't a link/);
  for (const u of [
    "https://localhost/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://[::1]/",
    "https://intranet/",
  ]) {
    assert.match(urlProblem(u) ?? "", /private/, u);
  }
  assert.ok(urlProblem("https://user:pw@example.com/"));
});

// --- fetching --------------------------------------------------------------

const page = (body: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }, status = 200) =>
  new Response(body, { status, headers });

test("a page is fetched with redirects handled here, not by fetch", async () => {
  const seen: (RequestInit | undefined)[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init);
    return page("<p>hi</p>");
  }) as typeof fetch;
  assert.deepEqual(await fetchDocument("https://example.com/a", f), {
    url: "https://example.com/a",
    contentType: "text/html",
    text: "<p>hi</p>",
  });
  assert.equal(seen[0]?.redirect, "manual");
});

test("a redirect is followed only to another public https address", async () => {
  const moved = (async (url: string | URL | Request) =>
    String(url) === "https://example.com/a" ? page("", { location: "/b" }, 301) : page("moved here", { "content-type": "text/plain" })) as typeof fetch;
  assert.equal((await fetchDocument("https://example.com/a", moved)).url, "https://example.com/b");

  const metadata = (async () => page("", { location: "https://169.254.169.254/latest" }, 302)) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/a", metadata), /private/);

  const loop = (async () => page("", { location: "/again" }, 302)) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/a", loop), /redirects too many times/);
});

test("only web pages, plain text and markdown", async () => {
  const pdf = (async () => page("%PDF-1.4", { "content-type": "application/pdf" })) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/a.pdf", pdf), /Only web pages, plain text and markdown/);
  const md = (async () => page("# Hi", { "content-type": "text/markdown; charset=utf-8" })) as typeof fetch;
  assert.equal((await fetchDocument("https://example.com/a.md", md)).contentType, "text/markdown");
});

test("a page over 2 MB is refused, whether it says so or not", async () => {
  const says = (async () => page("x", { "content-type": "text/plain", "content-length": String(URL_MAX_BYTES + 1) })) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/big", says), /over 2 MB/);
  const streams = (async () => page(x(URL_MAX_BYTES + 1), { "content-type": "text/plain" })) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/big", streams), /over 2 MB/);
});

test("an error page says so", async () => {
  const gone = (async () => page("nope", { "content-type": "text/html" }, 404)) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/gone", gone), /answered 404/);
});

test("a page that hangs is given up on at ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hang = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const pending = fetchDocument("https://example.com/slow", hang);
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await assert.rejects(pending, /longer than 10 seconds/);
});

// --- citations and promotion -----------------------------------------------

test("[p:…] citations are pulled out of a draft's sources, deduped", () => {
  assert.deepEqual(parseCitations(["[p:abc123]", "[f1]", "p:abc123 and [p:def456]", "mp:nope"]), ["abc123", "def456"]);
  assert.deepEqual(parseCitations([]), []);
});

test("a promoted passage's title is its first line, cut to 120", () => {
  assert.deepEqual(passageFact("\n  We ship on Fridays  \nbecause QA is Thursday\n"), {
    title: "We ship on Fridays",
    body: "We ship on Fridays  \nbecause QA is Thursday",
  });
  assert.equal(passageFact(x(200)).title.length, 120);
});
```

`lib/slack.test.ts`:
```ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { SLACK_TOLERANCE_S, slackSignature, verifySlack } from "./slack.ts";

// The worked example on docs.slack.dev/authentication/verifying-requests-from-slack.
const DOC_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const DOC_TS = "1531420618";
const DOC_BODY =
  "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
const DOC_SIG = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

const SECRET = "test-slack-secret";
/** Independent of lib/slack.ts's own signer, so the scheme is checked, not echoed. */
const nodeSign = (ts: string, body: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
const now = Date.UTC(2026, 8, 25, 12);
const ts = String(Math.floor(now / 1000));
const body = JSON.stringify({ type: "event_callback", event_id: "Ev1" });

test("Slack's own worked example verifies", async () => {
  assert.equal(await slackSignature(DOC_SECRET, DOC_TS, DOC_BODY), DOC_SIG);
  assert.equal(await verifySlack(DOC_SECRET, { timestamp: DOC_TS, signature: DOC_SIG }, DOC_BODY, Number(DOC_TS) * 1000), true);
});

test("a good signature passes", async () => {
  assert.equal(await verifySlack(SECRET, { timestamp: ts, signature: nodeSign(ts, body) }, body, now), true);
});

test("a bad signature fails: wrong secret, changed body, missing header, no secret", async () => {
  const sig = nodeSign(ts, body);
  assert.equal(await verifySlack("other", { timestamp: ts, signature: sig }, body, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: ts, signature: sig }, `${body} `, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: null, signature: sig }, body, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: ts, signature: null }, body, now), false);
  assert.equal(await verifySlack("", { timestamp: ts, signature: sig }, body, now), false);
});

test("a stale signature fails past five minutes", async () => {
  const at = (s: number) => String(Math.floor(now / 1000) - s);
  const stale = at(SLACK_TOLERANCE_S + 1);
  const fresh = at(SLACK_TOLERANCE_S - 1);
  assert.equal(await verifySlack(SECRET, { timestamp: stale, signature: nodeSign(stale, body) }, body, now), false);
  assert.equal(await verifySlack(SECRET, { timestamp: fresh, signature: nodeSign(fresh, body) }, body, now), true);
  assert.equal(await verifySlack(SECRET, { timestamp: "soon", signature: nodeSign("soon", body) }, body, now), false);
});
```

Append to `lib/caps.test.ts` (and add `SOURCES_PER_DAY, sourceBlocked` to its import list):
```ts
test("sources cap at five a day, except for an exempt member", () => {
  assert.equal(SOURCES_PER_DAY, 5);
  assert.equal(sourceBlocked(SOURCES_PER_DAY - 1), null);
  assert.match(sourceBlocked(SOURCES_PER_DAY) ?? "", /5 sources/);
  assert.match(sourceBlocked(SOURCES_PER_DAY) ?? "", /00:00 UTC/);
  assert.equal(sourceBlocked(SOURCES_PER_DAY, true), null);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../lib/ingest.ts'` (and `slack.ts`), and `sourceBlocked is not a function`.

- [ ] **Step 4: Implement**

In `lib/inbound.ts`, export the constant-time compare (one word; nothing else changes):
```ts
/** Constant-time for equal lengths; the length itself isn't secret. */
export const same = (a: string, b: string) => {
```

Append to `lib/caps.ts` directly after `sendBlocked` (before the `tooMany*` block), the same shape as `teachBlocked`/`sendBlocked`:
```ts
export const SOURCES_PER_DAY = 5;

export const sourceBlocked = (addedToday: number, exempt = false): string | null =>
  !exempt && addedToday >= SOURCES_PER_DAY ? `You've added ${SOURCES_PER_DAY} sources today. ${RESETS}` : null;
```

`lib/ingest.ts`:
```ts
/**
 * Ingestion: sources feed the brain. Pure, apart from `fetchDocument`, which
 * takes `fetch` as an argument so node tests it with no network. No imports,
 * so client components can read the constants.
 *
 * There are no model calls anywhere in ingestion, by design: every source is
 * on a free plan.
 */

/** Archive passages an intern recalls per run. */
export const PASSAGES_RECALLED = 6;
/** How much of a passage the brief and the rail show. */
export const PASSAGE_EXCERPT = 400;
export const CHUNK_MIN = 800;
export const CHUNK_MAX = 1200;
export const MAX_PASSAGES_PER_DOCUMENT = 200;
export const URL_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const BACKFILL_DAYS = 90;
export const DOCUMENT_TYPES = ["text/html", "text/plain", "text/markdown"];
const MAX_REDIRECTS = 3;

/** Why a source couldn't be read, in words the member can act on. */
export class IngestError extends Error {}

/** What a failed source shows. Anything that isn't an IngestError is a bug: the caller logs it, the member sees a fixed copy. */
export const sourceError = (err: unknown) => (err instanceof IngestError ? err.message : "Couldn't read that source.");

// --- chunking ------------------------------------------------------------

/** One paragraph over CHUNK_MAX, cut at the last sentence end past CHUNK_MIN, else hard at CHUNK_MAX. */
function splitLong(p: string): string[] {
  const out: string[] = [];
  let rest = p;
  while (rest.length > CHUNK_MAX) {
    const window = rest.slice(0, CHUNK_MAX);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const at = cut >= CHUNK_MIN ? cut + 1 : CHUNK_MAX;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Splits on blank lines and gathers paragraphs into passages of about
 * CHUNK_MIN–CHUNK_MAX characters, at most MAX_PASSAGES_PER_DOCUMENT. A passage
 * comes in under CHUNK_MIN only when the next paragraph wouldn't fit, or at
 * the end.
 */
export function chunk(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitLong);
  const out: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (out.length >= MAX_PASSAGES_PER_DOCUMENT) break;
    if (cur && cur.length + 2 + p.length > CHUNK_MAX) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur.length >= CHUNK_MIN) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, MAX_PASSAGES_PER_DOCUMENT);
}

// --- html ------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? whole;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
  });

/**
 * A page reduced to readable text. Scripts, styles, nav and the head go;
 * block elements become blank lines, so the chunker splits between them.
 * ponytail: regex, not a parser. Good enough for text; swap for a real
 * parser only if pages start coming back mangled.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|aside|li|ul|ol|h[1-6]|tr|table|blockquote|pre|header|footer)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  const text = decode(stripped)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = decode(rawTitle).replace(/\s+/g, " ").trim();
  return { title: title || null, text };
}

// --- url safety --------------------------------------------------------------

/** 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, and multicast and up. */
function privateIPv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Why this URL may not be fetched, or null. Reads the host the way the URL
 * parser normalizes it, so `https://2130706433/` is caught as 127.0.0.1.
 * ponytail: every IPv6 literal and every dotless host is refused outright;
 * nobody shares a document that way. DNS rebinding isn't covered — that
 * needs resolving the name first, which Convex doesn't expose.
 */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "That isn't a link.";
  }
  if (u.protocol !== "https:") return "Only https:// links can be added.";
  if (u.username || u.password) return "Links with a username or password can't be added.";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[") ||
    !host.includes(".") ||
    privateIPv4(host)
  ) {
    return "That address is private.";
  }
  return null;
}

// --- fetching ----------------------------------------------------------------

export type Fetched = { url: string; contentType: string; text: string };

const tooBig = () => new IngestError(`That page is over ${URL_MAX_BYTES / 1024 / 1024} MB.`);

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > URL_MAX_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * GETs a member's link. Every hop is checked with `urlProblem`: redirects are
 * followed here (at most three), never by `fetch`. Ten seconds for the whole
 * thing, 2 MB, and html, plain text or markdown only. Throws IngestError.
 */
export async function fetchDocument(raw: string, f: typeof fetch = fetch): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = raw.trim();
    for (let hop = 0; ; hop++) {
      const problem = urlProblem(url);
      if (problem) throw new IngestError(problem);
      const res = await f(url, { redirect: "manual", signal: ctl.signal, headers: { accept: DOCUMENT_TYPES.join(", ") } });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next || hop >= MAX_REDIRECTS) throw new IngestError("That link redirects too many times.");
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok) throw new IngestError(`That page answered ${res.status}.`);
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!DOCUMENT_TYPES.includes(contentType)) throw new IngestError("Only web pages, plain text and markdown can be added.");
      if (Number(res.headers.get("content-length") ?? 0) > URL_MAX_BYTES) throw tooBig();
      return { url, contentType, text: await readCapped(res) };
    }
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(
      ctl.signal.aborted ? `That page took longer than ${FETCH_TIMEOUT_MS / 1000} seconds.` : "Couldn't reach that page.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- citations and promotion -------------------------------------------------

/** `[p:<id>]` citations in a draft's `sources`, deduped. The caller looks each id up; none is trusted. */
export function parseCitations(sources: string[]): string[] {
  const ids = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(/(?<![a-z0-9])p:([a-z0-9]+)/g)) ids.add(m[1]);
  return [...ids].slice(0, 20);
}

/** The fact a promoted passage becomes: its first line (max 120) as the title, the passage as the body. */
export function passageFact(text: string): { title: string; body: string } {
  const body = text.trim();
  return { title: (body.split("\n")[0] ?? "").trim().slice(0, 120), body };
}
```

`lib/slack.ts`:
```ts
import { same } from "./inbound.ts";

/**
 * The community Slack workspace, read through its own "Intern Brain" app.
 * Pure (Web Crypto only), so node tests it.
 *
 * Request signing confirmed against
 * docs.slack.dev/authentication/verifying-requests-from-slack on YYYY-MM-DD
 * (Task 1 Step 1): `X-Slack-Signature` is `v0=` + hex HMAC-SHA256 of
 * `v0:<X-Slack-Request-Timestamp>:<raw body>`, keyed with the app's signing
 * secret; a timestamp more than five minutes off is refused.
 */

export const SLACK_TOLERANCE_S = 300;

const enc = new TextEncoder();

export async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** False on anything short of a fresh signature by `secret`, including no secret at all. */
export async function verifySlack(
  secret: string,
  h: { timestamp: string | null; signature: string | null },
  body: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SLACK_TOLERANCE_S) return false;
  return same(h.signature, await slackSignature(secret, h.timestamp, body));
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm test`
Expected: PASS, including the three new files' tests.

- [ ] **Step 6: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts lib/slack.ts lib/slack.test.ts lib/inbound.ts lib/caps.ts lib/caps.test.ts
git commit -m "$(cat <<'EOF'
Ingestion libs: chunker, HTML to text, URL safety, Slack signature, citations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 2: Schema, archive recall and the brief's "FROM THE ARCHIVE"

**Files:**
- Modify: `convex/schema.ts` (new `sourceKind`; `facts` gains `fromPassageId`; new `sources`, `passages` tables), `convex/access.ts` (`visibleTo`), `convex/facts.ts` (`searchTerms`, `archive`), `convex/interns.ts` (`noteRecall`), `convex/run.ts` (the recall block and the `brief(...)` call), `lib/brief.ts`, `lib/brief.test.ts`, `lib/log-view.ts`, `lib/log-view.test.ts`
- Create: `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `PASSAGES_RECALLED`, `PASSAGE_EXCERPT` (Task 1); `brief(task, recalled, sendsFrom, self?, slackChannel?)`, `ABOUT`, `PROMPT_VERSION`'s `SAMPLE_SELF` (`lib/brief.ts`, existing); `stripCites` (`lib/log-view.ts`, existing).
- Produces:
  ```ts
  // convex/schema.ts
  export const sourceKind; // "slack_channel" | "document" | "github_repo"
  // sources { kind, label, url?, externalId, ownerId?, visibility, status: "active"|"failed"|"removed", lastSyncedAt?, cursor?, error?, storageId? }
  //   indexes by_kind_and_externalId, by_ownerId
  // passages { sourceId, externalId, text, author?, authorHandle?, url?, at, visibility, ownerId?, promotedFactId? }
  //   indexes by_sourceId_and_externalId, by_sourceId_and_at; searchIndex search_text (filterFields visibility, ownerId)
  // facts gains fromPassageId?: Id<"passages">
  // convex/access.ts
  export const visibleTo: (row: { visibility?: "public" | "owner"; ownerId?: Id<"users"> }, viewer: Id<"users"> | null) => boolean;
  // convex/facts.ts
  internal.facts.archive({ task: string, ownerId: Id<"users"> }) => (Archived & { visibility: "public" | "owner" })[]
  // convex/interns.ts
  internal.interns.noteRecall({ internId, recalled, privateArchive?: boolean })
  // lib/brief.ts
  export type Archived = { id: string; label: string; author: string | null; at: number; text: string };
  export function brief(task: string, recalled: Recalled[], sendsFrom?: string[], self?: Self, slackChannel?: string, archive?: Archived[]): string;
  // lib/log-view.ts: stripCites also drops `[p:<id>]`, alone or mixed into a list of fact ids
  // convex/ingest.test.ts
  function setup(): { t, seedUser, asUser, seedSource, seedPassage, seedDraft };
  const allPassages, allFacts;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `lib/brief.test.ts`:
```ts
test("archive passages are listed with their citation id, source, author and date, cut to 400 characters", () => {
  const text = brief("Post about Friday", [], [], undefined, undefined, [
    { id: "p1", label: "#general", author: "@ann", at: Date.UTC(2026, 8, 18), text: `We ship\non Fridays ${"x".repeat(500)}` },
    { id: "p2", label: "Handbook", author: null, at: Date.UTC(2026, 8, 1), text: "QA is Thursday" },
  ]);
  assert.ok(
    text.includes(
      `- [p:p1] #general · @ann · 2026-09-18: We ship on Fridays ${"x".repeat(381)}\n- [p:p2] Handbook · 2026-09-01: QA is Thursday\n`,
    ),
  );
});

test("passage ids, like fact ids, go in sources only, never in prose", () => {
  const text = brief("x", [], ["Slack"], ME, "#all-intern-community", [{ id: "p1", label: "#general", author: null, at: 0, text: "hi" }]);
  assert.match(
    text,
    /FROM THE ARCHIVE, what the community said in Slack, documents and GitHub \(evidence, not settled facts; cite the \[p:id\]s you use in "sources" only, never in your report prose\):/,
  );
  // The one action example names both kinds of id, archive or not.
  for (const t of [text, brief("x", [])]) assert.ok(t.includes(`"sources":["[id]s and [p:id]s you relied on"]`));
});

test("no archive passages means no archive section", () => {
  assert.ok(!brief("x", []).includes("FROM THE ARCHIVE"));
  assert.ok(!brief("x", [], ["Gmail"], ME, "#all-intern-community", []).includes("FROM THE ARCHIVE"));
});

test("ABOUT says the brain also holds the archive", () => {
  for (const text of [brief("x", []), brief("x", [], ["Gmail"])]) {
    assert.ok(
      text.includes(
        "- The brain also holds a searchable archive of the community Slack's public channels, documents members share and public GitHub repos; the passages that match a task reach you as FROM THE ARCHIVE.",
      ),
    );
  }
});
```

Append to `lib/log-view.test.ts`:
```ts
test("inline passage citations are dropped too, alone or mixed with fact ids", () => {
  assert.equal(stripCites("as posted [p:k97cqmxm3y4dykfba1x47t8n018f2h4e]."), "as posted.");
  assert.equal(
    stripCites("as agreed [k97cqmxm3y4dykfba1x47t8n018f2h4e, p:k97ag0gs7r1jp2sc2fxdavndrn8f2ma1], so"),
    "as agreed, so",
  );
  assert.equal(stripCites("see [p:short] and [p: note]"), "see [p:short] and [p: note]");
});
```

Create `convex/ingest.test.ts`:
```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The rows these tests keep needing. `seedUser`/`asUser` match surfaces.test.ts's. */
function setup() {
  const t = convexTest(schema, modules);
  let n = 0;
  const seedUser = (handle: string) => t.run((ctx) => ctx.db.insert("users", { handle, acceptedAt: Date.now() }));
  const asUser = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session`, issuer: "https://local" });
  const seedSource = (o: Partial<Doc<"sources">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("sources", {
        kind: "document",
        label: "Handbook",
        externalId: `https://example.com/${n++}`,
        visibility: "public",
        status: "active",
        ...o,
      }),
    );
  const seedPassage = (sourceId: Id<"sources">, text: string, o: Partial<Doc<"passages">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("passages", { sourceId, externalId: String(n++), text, at: Date.UTC(2026, 8, 18), visibility: "public", ...o }),
    );
  /** A sandbox Slack draft citing `sources`. No Composio env, so approving it sends nothing. */
  const seedDraft = (ownerId: Id<"users">, sources: string[], extra: Partial<Doc<"actions">> = {}) =>
    t.run(async (ctx) => {
      const internId = await ctx.db.insert("interns", { ownerId, task: "post about Fridays", status: "done", countsTowardCap: true });
      return await ctx.db.insert("actions", {
        ownerId,
        internId,
        kind: "slack",
        status: "pending",
        title: "Post in #general",
        draft: { to: ["#general"], subject: "", body: "We ship on Fridays." },
        rationale: "because",
        sources,
        recalledCorrection: false,
        ...extra,
      });
    });
  return { t, seedUser, asUser, seedSource, seedPassage, seedDraft };
}

type T = ReturnType<typeof setup>["t"];
const allPassages = (t: T) => t.run((ctx) => ctx.db.query("passages").collect());
const allFacts = (t: T) => t.run((ctx) => ctx.db.query("facts").collect());

// --- recall ------------------------------------------------------------------

test("archive: public passages and the owner's own private ones, never another member's", async () => {
  const { t, seedUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const channel = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1" });
  const aNotes = await seedSource({ label: "A's notes", ownerId: a, visibility: "owner" });
  const bNotes = await seedSource({ label: "B's notes", ownerId: b, visibility: "owner" });
  await seedPassage(channel, "pricing is per seat", { author: "Ann" });
  await seedPassage(aNotes, "pricing for Acme is 40k", { ownerId: a, visibility: "owner" });
  await seedPassage(bNotes, "pricing secret of B", { ownerId: b, visibility: "owner" });

  const forA = await t.query(internal.facts.archive, { task: "pricing", ownerId: a });
  expect(forA.map((p) => p.label).sort()).toEqual(["#general", "A's notes"]);
  expect(forA.find((p) => p.label === "#general")).toMatchObject({ author: "Ann", at: Date.UTC(2026, 8, 18), visibility: "public" });
  const forB = await t.query(internal.facts.archive, { task: "pricing", ownerId: b });
  expect(forB.map((p) => p.label).sort()).toEqual(["#general", "B's notes"]);
  expect(JSON.stringify(forB)).not.toMatch(/Acme/);
});

test("archive: six passages at most, none from a removed source, a linked author as their @handle", async () => {
  const { t, seedUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const channel = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1" });
  const gone = await seedSource({ label: "old doc", status: "removed" });
  for (let i = 0; i < 9; i++) await seedPassage(channel, `pricing note ${i}`, { author: "Ann", authorHandle: "ann" });
  await seedPassage(gone, "pricing from a removed doc");

  const got = await t.query(internal.facts.archive, { task: "pricing", ownerId: a });
  expect(got).toHaveLength(6);
  expect(got.every((p) => p.label === "#general" && p.author === "@ann")).toBe(true);
  expect(await t.query(internal.facts.archive, { task: "   ", ownerId: a })).toEqual([]);
});

test("a run that recalled a private passage is marked private", async () => {
  const { t, seedUser } = setup();
  const a = await seedUser("a");
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: a, task: "t", status: "running", countsTowardCap: true }));
  await t.mutation(internal.interns.noteRecall, { internId, recalled: [], privateArchive: true });
  expect((await t.run((ctx) => ctx.db.get("interns", internId)))?.recalledPrivate).toBe(true);
  await t.mutation(internal.interns.noteRecall, { internId, recalled: [] });
  expect((await t.run((ctx) => ctx.db.get("interns", internId)))?.recalledPrivate).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test && npx vitest run convex/ingest.test.ts`
Expected: FAIL — the brief has no archive section, no ABOUT line and the old action example; `stripCites` leaves `[p:…]`; `ctx.db.insert("sources", …)` fails schema validation (no such table); `internal.facts.archive` is undefined.

- [ ] **Step 3: Schema**

In `convex/schema.ts`, after `export const visibility = …`:
```ts
export const sourceKind = v.union(v.literal("slack_channel"), v.literal("document"), v.literal("github_repo"));
```

In `facts`, after `source: v.optional(v.string()),`:
```ts
    /** Set on a fact promoted from an archive passage: the graph hangs it off that passage's source. */
    fromPassageId: v.optional(v.id("passages")),
```

After the `facts` table:
```ts
  /**
   * Where passages come from: a public channel of the community Slack, a
   * member's document, or a public GitHub repo. A removed source keeps its
   * row, so it still counts toward its owner's day.
   */
  sources: defineTable({
    kind: sourceKind,
    label: v.string(),
    url: v.optional(v.string()),
    /** Slack channel id, a document's URL or `upload:<storageId>`, or `owner/repo` in lower case. */
    externalId: v.string(),
    /** Who added a document or repo. Slack channels belong to the community and have none. */
    ownerId: v.optional(v.id("users")),
    visibility,
    status: v.union(v.literal("active"), v.literal("failed"), v.literal("removed")),
    lastSyncedAt: v.optional(v.number()),
    /** Slack's `next_cursor` while a backfill is part-way. */
    cursor: v.optional(v.string()),
    /** Why the last read failed, in words the member can act on. */
    error: v.optional(v.string()),
    /** An upload's file, deleted with the source. */
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_kind_and_externalId", ["kind", "externalId"])
    .index("by_ownerId", ["ownerId"]),

  /** One searchable piece of a source. Interns recall passages; only facts are drawn. */
  passages: defineTable({
    sourceId: v.id("sources"),
    /** `<channel>:<ts>`, a document chunk's index, or `readme` / `issue:N` / `pr:N`. */
    externalId: v.string(),
    text: v.string(),
    author: v.optional(v.string()),
    /** The member's GitHub handle, when the Slack author is a member who connected that account. */
    authorHandle: v.optional(v.string()),
    url: v.optional(v.string()),
    at: v.number(),
    visibility,
    ownerId: v.optional(v.id("users")),
    /** Set once: the fact this passage became. */
    promotedFactId: v.optional(v.id("facts")),
  })
    .index("by_sourceId_and_externalId", ["sourceId", "externalId"])
    .index("by_sourceId_and_at", ["sourceId", "at"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["visibility", "ownerId"] }),
```

- [ ] **Step 4: `visibleTo` for any owned row**

In `convex/access.ts`, replace `visibleTo`:
```ts
/** Owner-only rows (facts, passages, sources) reach their owner alone. Absent means public. */
export const visibleTo = (row: { visibility?: "public" | "owner"; ownerId?: Id<"users"> }, viewer: Id<"users"> | null) =>
  row.visibility !== "owner" || (viewer !== null && row.ownerId === viewer);
```
`Doc` is still used by `memberProblem`; leave the imports.

- [ ] **Step 5: `facts.archive`**

In `convex/facts.ts`, add imports:
```ts
import type { Archived } from "../lib/brief.ts";
import { PASSAGES_RECALLED } from "../lib/ingest.ts";
```

Above `recall`:
```ts
/** Convex search takes at most 16 terms. */
const searchTerms = (task: string) => task.split(/\s+/).filter(Boolean).slice(0, 16).join(" ");
```
and in `recall`, replace the two lines
```ts
    // Convex search takes at most 16 terms.
    const terms = task.split(/\s+/).filter(Boolean).slice(0, 16).join(" ");
```
with
```ts
    const terms = searchTerms(task);
```

After `recall`:
```ts
/**
 * Up to PASSAGES_RECALLED archive passages for a task: the best public
 * matches and the owner's own private ones, interleaved so neither crowds the
 * other out. Never another member's private passage. Full-text now; this is
 * the one function to swap for embeddings later.
 *
 * ponytail: over-reads twelve per search, so a stray passage of a removed
 * source can't thin the six.
 */
export const archive = internalQuery({
  args: { task: v.string(), ownerId: v.id("users") },
  handler: async (ctx, { task, ownerId }) => {
    const terms = searchTerms(task);
    if (!terms) return [];
    const window = PASSAGES_RECALLED * 2;
    const [pub, own] = await Promise.all([
      ctx.db
        .query("passages")
        .withSearchIndex("search_text", (q) => q.search("text", terms).eq("visibility", "public"))
        .take(window),
      ctx.db
        .query("passages")
        .withSearchIndex("search_text", (q) => q.search("text", terms).eq("visibility", "owner").eq("ownerId", ownerId))
        .take(window),
    ]);
    const merged: Doc<"passages">[] = [];
    for (let i = 0; i < window; i++) for (const p of [own[i], pub[i]]) if (p) merged.push(p);

    const out: (Archived & { visibility: Doc<"passages">["visibility"] })[] = [];
    const seen = new Set<string>();
    for (const p of merged) {
      if (out.length >= PASSAGES_RECALLED) break;
      if (seen.has(p._id) || !visibleTo(p, ownerId)) continue;
      seen.add(p._id);
      const s = await ctx.db.get("sources", p.sourceId);
      if (!s || s.status === "removed") continue;
      out.push({
        id: p._id,
        label: s.label,
        author: p.authorHandle ? `@${p.authorHandle}` : (p.author ?? null),
        at: p.at,
        text: p.text,
        visibility: p.visibility,
      });
    }
    return out;
  },
});
```

- [ ] **Step 6: `noteRecall` takes `privateArchive`**

In `convex/interns.ts`, `noteRecall`'s args gain one field:
```ts
    recalled: v.array(v.object({ id: v.id("facts"), kind: factKind, visibility: v.optional(visibility) })),
    /** The run also read an owner-only archive passage. */
    privateArchive: v.optional(v.boolean()),
```
and the handler destructures it and folds it in:
```ts
  handler: async (ctx, { internId, recalled, privateArchive }) => {
```
```ts
      recalledPrivate: !!intern?.displayTask || !!privateArchive || recalled.some((r) => r.visibility === "owner"),
```
Add one line to the comment above `recalledPrivate`: `// So is one that read an owner-only archive passage (\`privateArchive\`).`

- [ ] **Step 7: The brief**

In `lib/brief.ts`, add the import after the `./connectors.ts` one:
```ts
import { PASSAGE_EXCERPT } from "./ingest.ts";
```
and, directly after `export type Recalled = …;`:
```ts
/** An archive passage, as `facts.archive` returns it. */
export type Archived = { id: string; label: string; author: string | null; at: number; text: string };

/** One passage line: its citation id, where and when it was said, and at most PASSAGE_EXCERPT of it on one line. */
const archived = (a: Archived) =>
  `- [p:${a.id}] ${[a.label, a.author, new Date(a.at).toISOString().slice(0, 10)].filter(Boolean).join(" · ")}: ${a.text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PASSAGE_EXCERPT)}`;
```

In `ABOUT`, add one line directly after the `- Per brief you can draft ONE outbound message, …` line:
```
- The brain also holds a searchable archive of the community Slack's public channels, documents members share and public GitHub repos; the passages that match a task reach you as FROM THE ARCHIVE.
```

`brief` gains a sixth parameter, after `slackChannel`:
```ts
export function brief(
  task: string,
  recalled: Recalled[],
  sendsFrom: string[] = [],
  self?: Self,
  /** Where a live Slack post with no channel goes; see interns.start. */
  slackChannel?: string,
  /** Passages `facts.archive` found for this task. Evidence, cited like facts: in "sources" only. */
  archive: Archived[] = [],
): string {
```
and, directly after the `learned` constant:
```ts
  const fromArchive = archive.length
    ? `\nFROM THE ARCHIVE, what the community said in Slack, documents and GitHub (evidence, not settled facts; cite the [p:id]s you use in "sources" only, never in your report prose):\n${archive
        .map(archived)
        .join("\n")}\n`
    : "";
```
In the template, `${youWorkFor(self)}${learned}` becomes `${youWorkFor(self)}${learned}${fromArchive}`, and the action example's second line becomes:
```
 "rationale":"why this should go out","sources":["[id]s and [p:id]s you relied on"]}
```

`PROMPT_VERSION` hashes a fourth sample, so the archive's wording is part of the version (it changes; that's intended):
```ts
const SAMPLE_SELF: Self = { handle: "{handle}", accounts: [{ kind: "email", label: "Gmail", account: "{account}" }] };
const SAMPLE_ARCHIVE: Archived[] = [{ id: "{id}", label: "{label}", author: "{author}", at: 0, text: "{text}" }];
export const PROMPT_VERSION = fnv(
  brief("{task}", []) +
    brief("{task}", [], ["{label}"]) +
    brief("{task}", [], ["{label}"], SAMPLE_SELF, "{channel}") +
    brief("{task}", [], ["{label}"], SAMPLE_SELF, "{channel}", SAMPLE_ARCHIVE),
);
```

In `lib/log-view.ts`, the citation pattern takes an optional `p:` on each id, and its comment says so:
```ts
/**
 * Brain ids the model cited inline: a fact's `[k97cqmxm3y4dykfba1x47t8n018f2h4e]`, an
 * archive passage's `[p:k97…]`, or a comma list of either. ponytail: an id that a
 * 160-char flush split across two log lines slips through; the prompt asking for ids
 * in "sources" only is the real fix.
 */
const CITE = /\s?\[(?:p:)?[a-z0-9]{20,}(?:,\s*(?:p:)?[a-z0-9]{20,})*\]/g;
```
(`stripCites` itself is unchanged.)

- [ ] **Step 8: `run.go` recalls the archive**

In `convex/run.ts`, replace
```ts
      const recalled = await ctx.runQuery(internal.facts.recall, { task: started.task, ownerId: started.ownerId });
      await ctx.runMutation(internal.interns.noteRecall, {
        internId,
        recalled: recalled.map((f) => ({ id: f.id, kind: f.kind, visibility: f.visibility })),
      });
      if (recalled.length) await say("sys", `recalled ${recalled.length} facts from the brain`);
```
with
```ts
      const recalled = await ctx.runQuery(internal.facts.recall, { task: started.task, ownerId: started.ownerId });
      const archive = await ctx.runQuery(internal.facts.archive, { task: started.task, ownerId: started.ownerId });
      await ctx.runMutation(internal.interns.noteRecall, {
        internId,
        recalled: recalled.map((f) => ({ id: f.id, kind: f.kind, visibility: f.visibility })),
        privateArchive: archive.some((p) => p.visibility === "owner"),
      });
      if (recalled.length) await say("sys", `recalled ${recalled.length} facts from the brain`);
      if (archive.length) await say("sys", `read ${archive.length} passages from the archive`);
```
and
```ts
      const prompt = brief(started.task, recalled, started.sendsFrom, started.self, started.slackChannel);
```
with
```ts
      const prompt = brief(started.task, recalled, started.sendsFrom, started.self, started.slackChannel, archive);
```
The one rewrite call below it (`rewrite(prompt, report, …)`) already carries the whole prompt, archive included; nothing else in `go` changes. `scripts/eval.ts`'s `brief(task, [], sendsFrom, self, slackChannel)` call stays as it is (no archive).

- [ ] **Step 9: Run the tests to see them pass**

Run: `npm test && npx vitest run`
Expected: PASS, including every existing `lib/brief.test.ts` and `lib/log-view.test.ts` case, and `convex/surfaces.test.ts` and `convex/engine.test.ts` unchanged.

- [ ] **Step 10: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 11: Commit**

```bash
git add convex/schema.ts convex/access.ts convex/facts.ts convex/interns.ts convex/run.ts convex/ingest.test.ts lib/brief.ts lib/brief.test.ts lib/log-view.ts lib/log-view.test.ts
git commit -m "$(cat <<'EOF'
Sources and passages; interns recall the archive under the facts' visibility rule, citing [p:id]s in sources only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Promotion — on approval, by hand, and what purge and remove take away

**Files:**
- Create: `convex/sources.ts`
- Modify: `convex/facts.ts` (`insertFact`), `convex/outbox.ts` (`decide`), `convex/users.ts` (`purge`), `convex/_generated/api.d.ts` (add `sources`), `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `parseCitations`, `passageFact` (Task 1); `visibleTo`, `setup()` (Task 2); `insertFact`, `factCapBlocked` (existing).
- Produces:
  ```ts
  // convex/facts.ts
  insertFact(ctx, { ..., fromPassageId?: Id<"passages"> })
  // convex/sources.ts
  export async function promotePassage(ctx: MutationCtx, p: Doc<"passages">, by: { ownerId?: Id<"users">; visibility: "public" | "owner"; source?: string }): Promise<Id<"facts">>;
  export async function promoteCited(ctx: MutationCtx, sources: string[], ownerId: Id<"users">, actionVisibility: "owner" | undefined): Promise<number>;
  export async function rewritePassage(ctx: MutationCtx, p: Doc<"passages">, text: string, patch?: Partial<Pick<Doc<"passages">, "author" | "authorHandle" | "url" | "at">>): Promise<void>;
  export const factMatches: (f: Doc<"facts">, passageText: string) => boolean;
  export async function clearPassages(ctx: MutationCtx, sourceId: Id<"sources">): Promise<boolean>;
  export const PASSAGE_BATCH = 250;
  api.sources.promote({ passageId }) => Id<"facts">
  api.sources.remove({ sourceId }) => null
  ```

- [ ] **Step 1: Write the failing tests**

In `convex/ingest.test.ts`, change the api import to `import { api, internal } from "./_generated/api";`, then append:
```ts
// --- promotion -----------------------------------------------------------------

test("approving a draft that cited [p:…] promotes the passage exactly once", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage, seedDraft } = setup();
  const a = await seedUser("a");
  const channel = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1" });
  const p = await seedPassage(channel, "We ship on Fridays\nbecause QA is Thursday");
  const actionId = await seedDraft(a, [`[p:${p}]`, `p:${p}`, "[p:notanid]", "[f1]"]);

  expect(await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" })).toBe(null);
  const facts = await allFacts(t);
  expect(facts).toEqual([
    expect.objectContaining({
      title: "We ship on Fridays",
      body: "We ship on Fridays\nbecause QA is Thursday",
      kind: "note",
      ownerId: a,
      fromPassageId: p,
    }),
  ]);
  expect(facts[0].visibility).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get("passages", p)))?.promotedFactId).toBe(facts[0]._id);

  // Promoting it again by hand changes nothing.
  expect(await asUser(a).mutation(api.sources.promote, { passageId: p })).toBe(facts[0]._id);
  expect(await allFacts(t)).toHaveLength(1);
});

test("only the draft's sources promote: a [p:…] in its body or rationale doesn't", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage, seedDraft } = setup();
  const a = await seedUser("a");
  const p = await seedPassage(await seedSource(), "Pricing is per seat");
  const actionId = await seedDraft(a, ["[f1]"], {
    draft: { to: ["#general"], subject: "", body: `Pricing is per seat [p:${p}]` },
    rationale: `from [p:${p}]`,
  });
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  expect(await allFacts(t)).toHaveLength(0);
});

test("a draft that could quote something private promotes what it cited owner-only", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage, seedDraft } = setup();
  const a = await seedUser("a");
  const p = await seedPassage(await seedSource(), "Pricing is per seat");
  const actionId = await seedDraft(a, [`[p:${p}]`], { recalledPrivate: true });
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  expect(await allFacts(t)).toEqual([expect.objectContaining({ title: "Pricing is per seat", visibility: "owner", ownerId: a })]);
});

test("nobody promotes a passage they can't see", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage, seedDraft } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const bNotes = await seedSource({ ownerId: b, visibility: "owner" });
  const p = await seedPassage(bNotes, "B's secret", { ownerId: b, visibility: "owner" });
  const actionId = await seedDraft(a, [`[p:${p}]`]);
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  expect(await allFacts(t)).toHaveLength(0);
  await expect(asUser(a).mutation(api.sources.promote, { passageId: p })).rejects.toThrow(/isn't there/);
  // Its owner can, and it stays theirs.
  await asUser(b).mutation(api.sources.promote, { passageId: p });
  expect(await allFacts(t)).toEqual([expect.objectContaining({ title: "B's secret", visibility: "owner", ownerId: b })]);
});

test("the promote button counts toward the 20 facts a day", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const p = await seedPassage(await seedSource(), "One more");
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) await ctx.db.insert("facts", { title: `f${i}`, body: "", kind: "note", ownerId: a, text: `f${i}\n` });
  });
  await expect(asUser(a).mutation(api.sources.promote, { passageId: p })).rejects.toThrow(/20 facts/);
});

test("removing a source deletes its passages and keeps what was promoted from it", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const doc = await seedSource({ ownerId: a });
  const p = await seedPassage(doc, "We ship on Fridays", { ownerId: a });
  await seedPassage(doc, "Second chunk", { ownerId: a });
  await asUser(a).mutation(api.sources.promote, { passageId: p });

  await expect(asUser(b).mutation(api.sources.remove, { sourceId: doc })).rejects.toThrow(/Only whoever added/);
  await asUser(a).mutation(api.sources.remove, { sourceId: doc });
  expect(await allPassages(t)).toHaveLength(0);
  expect(await allFacts(t)).toHaveLength(1);
  expect((await t.run((ctx) => ctx.db.get("sources", doc)))?.status).toBe("removed");
});

test("purge removes a member's sources, passages and files, and nobody else's", async () => {
  const { t, seedUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["notes"])));
  const aDoc = await seedSource({ ownerId: a, storageId, externalId: `upload:${storageId}` });
  await seedPassage(aDoc, "A's notes", { ownerId: a });
  const bDoc = await seedSource({ ownerId: b });
  await seedPassage(bDoc, "B's notes", { ownerId: b });
  const channel = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1" });
  await seedPassage(channel, "said in Slack");

  await t.mutation(internal.users.purge, { userId: a });
  expect((await allPassages(t)).map((p) => p.text).sort()).toEqual(["B's notes", "said in Slack"]);
  expect(await t.run((ctx) => ctx.db.get("sources", aDoc))).toBeNull();
  expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run convex/ingest.test.ts`
Expected: FAIL — `api.sources` is undefined, and no fact is filed on approval.

- [ ] **Step 3: `insertFact` takes `fromPassageId`**

In `convex/facts.ts`, `insertFact`'s argument type gains (after `source?: string;`):
```ts
    /** The archive passage it was promoted from. */
    fromPassageId?: Id<"passages">;
```

- [ ] **Step 4: `convex/sources.ts`**

```ts
import { ConvexError, v } from "convex/values";
import { passageFact, parseCitations } from "../lib/ingest.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation } from "./_generated/server";
import { requireMember, visibleTo } from "./access";
import { factCapBlocked, insertFact } from "./facts";

/**
 * Sources and their passages: the archive interns recall from. Passages are
 * never drawn. People decide what becomes a fact — a 🧠 in the community
 * Slack, the promote button — and so does an approved draft that cited one.
 */

/** A member's source holds at most 220 passages (200 chunks, or a README's 20 plus 200 issues). */
export const PASSAGE_BATCH = 250;

const hasFact = async (ctx: MutationCtx, p: Doc<"passages">) => !!p.promotedFactId && !!(await ctx.db.get("facts", p.promotedFactId));

/**
 * The fact a passage becomes, once. `source` is the capture key a member's
 * own 🧠 through Composio files under (`slack:<channel>:<ts>`, see
 * inbound.ts): if that member already has that fact, the passage adopts it
 * instead of filing a twin, and Composio's later delivery reads as a duplicate.
 */
export async function promotePassage(
  ctx: MutationCtx,
  p: Doc<"passages">,
  by: { ownerId?: Id<"users">; visibility: "public" | "owner"; source?: string },
): Promise<Id<"facts">> {
  if (p.promotedFactId && (await ctx.db.get("facts", p.promotedFactId))) return p.promotedFactId;
  const { ownerId, source } = by;
  const twin =
    ownerId && source
      ? await ctx.db
          .query("facts")
          .withIndex("by_ownerId_and_source", (q) => q.eq("ownerId", ownerId).eq("source", source))
          .first()
      : null;
  const factId =
    twin?._id ??
    (await insertFact(ctx, {
      ...passageFact(p.text),
      kind: "note",
      ownerId,
      visibility: by.visibility === "owner" ? "owner" : undefined,
      source,
      fromPassageId: p._id,
    }));
  await ctx.db.patch("passages", p._id, { promotedFactId: factId });
  return factId;
}

/**
 * An approved draft vouches for the passages it cited: each `[p:…]` the
 * approver can see becomes a fact, visible like the passage, or owner-only
 * when the draft's own lesson is. Ids come from the model, so each is looked
 * up, never trusted. Returns how many were promoted just now.
 */
export async function promoteCited(
  ctx: MutationCtx,
  sources: string[],
  ownerId: Id<"users">,
  actionVisibility: "owner" | undefined,
): Promise<number> {
  let promoted = 0;
  for (const raw of parseCitations(sources)) {
    const id = ctx.db.normalizeId("passages", raw);
    const p = id ? await ctx.db.get("passages", id) : null;
    if (!p || !visibleTo(p, ownerId) || (await hasFact(ctx, p))) continue;
    await promotePassage(ctx, p, { ownerId, visibility: actionVisibility ?? p.visibility });
    promoted++;
  }
  return promoted;
}

/** A promoted fact still says exactly what promotion made from this passage text. */
export const factMatches = (f: Doc<"facts">, passageText: string) => {
  const made = passageFact(passageText);
  return f.title === made.title && f.body === made.body;
};

/**
 * A passage's new text. An unchanged promoted fact follows it, so deleting
 * the message later still finds it unchanged; a fact that isn't (a member's
 * own capture) is left alone.
 */
export async function rewritePassage(
  ctx: MutationCtx,
  p: Doc<"passages">,
  text: string,
  patch: Partial<Pick<Doc<"passages">, "author" | "authorHandle" | "url" | "at">> = {},
): Promise<void> {
  if (p.text !== text && p.promotedFactId) {
    const f = await ctx.db.get("facts", p.promotedFactId);
    if (f && factMatches(f, p.text)) {
      const made = passageFact(text);
      await ctx.db.patch("facts", f._id, { ...made, text: `${made.title}\n${made.body}` });
    }
  }
  await ctx.db.patch("passages", p._id, { ...patch, text });
}

/** Deletes up to PASSAGE_BATCH of a source's passages; true once none are left. Promoted facts stay. */
export async function clearPassages(ctx: MutationCtx, sourceId: Id<"sources">): Promise<boolean> {
  const rows = await ctx.db
    .query("passages")
    .withIndex("by_sourceId_and_at", (q) => q.eq("sourceId", sourceId))
    .take(PASSAGE_BATCH);
  for (const r of rows) await ctx.db.delete("passages", r._id);
  return rows.length < PASSAGE_BATCH;
}

/** The promote button. The caller must be able to see the passage; the 20 facts/day cap applies here and only here. */
export const promote = mutation({
  args: { passageId: v.id("passages") },
  handler: async (ctx, { passageId }): Promise<Id<"facts">> => {
    const user = await requireMember(ctx);
    const p = await ctx.db.get("passages", passageId);
    if (!p || !visibleTo(p, user._id)) throw new ConvexError("That passage isn't there any more.");
    if (p.promotedFactId && (await ctx.db.get("facts", p.promotedFactId))) return p.promotedFactId;
    const blocked = await factCapBlocked(ctx, user._id);
    if (blocked) throw new ConvexError(blocked);
    return await promotePassage(ctx, p, { ownerId: user._id, visibility: p.visibility });
  },
});

/**
 * Deletes a source's passages and file; facts already promoted from it stay.
 * The row stays too (`removed`), so it still counts toward today's five.
 * ponytail: one batch clears it; see PASSAGE_BATCH.
 */
export const remove = mutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const user = await requireMember(ctx);
    const s = await ctx.db.get("sources", sourceId);
    if (!s || s.ownerId !== user._id || s.status === "removed") {
      throw new ConvexError("Only whoever added a source can remove it.");
    }
    await clearPassages(ctx, sourceId);
    if (s.storageId) await ctx.storage.delete(s.storageId);
    await ctx.db.patch("sources", sourceId, { status: "removed", storageId: undefined, cursor: undefined });
    return null;
  },
});
```

Add `sources` to `convex/_generated/api.d.ts` by hand: `import type * as sources from "../sources.js";` after `send`, and `sources: typeof sources;` after `send: typeof send;`.

- [ ] **Step 5: `decide` promotes what an approved draft cited**

In `convex/outbox.ts`, add the import:
```ts
import { promoteCited } from "./sources";
```
In `decide`, directly after the `await ctx.db.patch("actions", action._id, { status: live ? "sending" : "approved", … });` call (after the placeholder-recipient, `UNFILLED` and `assertCanSend` guards, so a refused approval promotes nothing), and before `if (fields.length) {`, insert:
```ts
    // The approval vouches for the archive passages the draft cited in its
    // `sources` (the only place the brief lets an id go): each becomes a
    // fact, once, owner-only whenever this draft's lesson is.
    const promoted = await promoteCited(ctx, action.sources, user._id, visibility);
    if (promoted) await log("ok", `promoted ${promoted} archive passage${promoted === 1 ? "" : "s"} it cited`);
```

- [ ] **Step 6: `purge` removes sources**

In `convex/users.ts`, import the helper:
```ts
import { clearPassages } from "./sources";
```
Add above `purge`:
```ts
/** Sources per purge batch: each can clear up to PASSAGE_BATCH passages. */
const SOURCE_BATCH = 4;
```
Before `more = …`:
```ts
    // A member's documents and repos, their passages and any uploaded file.
    // Facts promoted from them that the member owns went with `facts` above;
    // Slack channels have no owner and stay.
    const sources = await ctx.db.query("sources").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).take(SOURCE_BATCH);
    let sourcesLeft = sources.length === SOURCE_BATCH;
    for (const s of sources) {
      if (!(await clearPassages(ctx, s._id))) {
        sourcesLeft = true;
        continue;
      }
      if (s.storageId) await ctx.storage.delete(s.storageId);
      await ctx.db.delete("sources", s._id);
    }
```
and change the `more` line to:
```ts
    more = sourcesLeft || [facts, actions, questions, interns, connections].some((rows) => rows.length === BATCH);
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npx vitest run`
Expected: PASS, including every existing `convex/surfaces.test.ts` decide and purge test.

- [ ] **Step 8: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 9: Commit**

```bash
git add convex/sources.ts convex/facts.ts convex/outbox.ts convex/users.ts convex/_generated/api.d.ts convex/ingest.test.ts
git commit -m "$(cat <<'EOF'
Promotion: approved drafts promote the passages they cited; promote, remove, purge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 4: The community Slack — `/slack/events`, 🧠, author mapping

**Files:**
- Modify: `lib/slack.ts`, `lib/slack.test.ts`, `lib/inbound.ts` (export `obj`, `str`), `convex/schema.ts` (`slackUsers`; `connections.by_externalUserId`), `convex/access.ts` (`slackMember`), `convex/sources.ts` (`passageInput`, `write`), `convex/http.ts`, `convex/_generated/api.d.ts` (add `slack`), `convex/ingest.test.ts`
- Create: `convex/slack.ts`

**Interfaces:**
- Consumes: `verifySlack`, `CHUNK_MAX` (Task 1); `promotePassage`, `rewritePassage`, `factMatches` (Task 3); `BRAIN_REACTION` (`lib/inbound.ts`, existing).
- Produces:
  ```ts
  // lib/slack.ts
  export const SLACK_API = "https://slack.com/api";
  export type SlackMessage = { channel: string; ts: string; user: string; text: string };
  export type SlackEvent = { kind: "challenge"; challenge } | { kind: "message"; teamId; eventId } & SlackMessage
    | { kind: "edit"; teamId; eventId; channel; ts; text } | { kind: "delete"; teamId; eventId; channel; ts }
    | { kind: "reaction"; teamId; eventId; channel; ts; user; reaction } | { kind: "ignore"; teamId: string | null; eventId: string | null; type: string };
  export function readSlackEvent(json: unknown): SlackEvent;
  export const slackPassage: (m: SlackMessage, author: string | undefined) => { externalId; text; author; slackUser; at };
  export class SlackError extends Error { retryAfterS: number | null }
  export function slackApi(token: string, method: string, params: Record<string, string | number | boolean | undefined>): Promise<Record<string, unknown>>;
  export const readUserName: (json) => string | null;
  export const readChannelName: (json) => string | null;
  // lib/inbound.ts: export const obj, str (were private)
  // convex/access.ts
  export async function slackMember(ctx: QueryCtx, slackUserId: string): Promise<Doc<"users"> | null>;
  // convex/sources.ts
  export const passageInput; // v.object({ externalId, text, author?, slackUser?, url?, at })
  internal.sources.write({ sourceId, passages, label?, cursor?: string | null, synced?: boolean }) => null
  // convex/slack.ts
  internal.slack.knownChannel({ channel }) => Id<"sources"> | null
  internal.slack.ensureChannel({ channel, name? }) => Id<"sources">
  internal.slack.cachedName({ slackUserId }) => string | null;  internal.slack.rememberName({ slackUserId, name })
  export async function authorName(ctx: ActionCtx, token: string | undefined, slackUserId: string): Promise<string | undefined>;
  // convex/ingest.test.ts helpers
  slackEnv(), slackRequest(payload, o?), envelope, message, reaction, edited, deleted, stubSlackApi(replies), slackCalls(f, method), linkSlack(t, userId, slackUserId)
  ```

- [ ] **Step 1: Confirm the Events API and Web API shapes against Slack's docs**

Fetch each page and confirm the values below. Record any difference in `readSlackEvent`, `PERSON_SUBTYPES`, `slackApi`, `readUserName`, `readChannelName` and the Step 2 fixtures before running anything; put the date in `lib/slack.ts`'s header.
1. `https://docs.slack.dev/apis/events-api/`: the outer envelope is `{ type: "event_callback", team_id, event_id, event, … }`; `url_verification` carries `challenge`, answered with the challenge (plain text is accepted); a delivery must be acknowledged within 3 seconds, and unacknowledged ones are retried.
2. `https://docs.slack.dev/reference/events/message.channels`: `channel`, `channel_type` (`"channel"` for a public channel), `user`, `text`, `ts`; scope `channels:history`.
3. `https://docs.slack.dev/reference/events/message/message_changed`: `subtype: "message_changed"`, the new message under `message` (`text`, `ts`, `user`). `https://docs.slack.dev/reference/events/message/message_deleted`: `deleted_ts`, `previous_message`.
4. `https://docs.slack.dev/reference/events/message/bot_message`, `…/channel_join`, `…/channel_leave`: the subtypes and `bot_id`. Confirm `thread_broadcast`, `file_share` and `me_message` are a person's own messages.
5. `https://docs.slack.dev/reference/events/reaction_added`: `user`, `reaction` (the name without colons, `brain` for 🧠), `item: { type: "message", channel, ts }`; scope `reactions:read`.
6. `https://docs.slack.dev/reference/methods/users.info`: `user.profile.display_name`, `user.profile.real_name`, `user.real_name`, `user.name`. `https://docs.slack.dev/reference/methods/conversations.info`: `channel.name`.
7. `https://docs.slack.dev/apis/web-api/`: methods accept a form-encoded POST with `Authorization: Bearer <token>`; replies carry `ok` and `error`; a rate-limited call is HTTP 429 with `Retry-After` seconds.

- [ ] **Step 2: Write the failing tests**

Append to `lib/slack.test.ts` (and extend its import to `SLACK_TOLERANCE_S, SlackError, readChannelName, readSlackEvent, readUserName, slackApi, slackPassage, slackSignature, verifySlack`):
```ts
// --- events ------------------------------------------------------------------

// Shapes from docs.slack.dev/apis/events-api and /reference/events/* (Task 4 Step 1).
const envelope = (event: Record<string, unknown>, team = "T1") => ({
  token: "x",
  team_id: team,
  api_app_id: "A1",
  type: "event_callback",
  event_id: "Ev1",
  event_time: 1758800000,
  event,
});
const said = { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "We ship on Fridays", ts: "1758800000.000100" };

test("url_verification is answered with its challenge", () => {
  assert.deepEqual(readSlackEvent({ token: "x", challenge: "abc", type: "url_verification" }), { kind: "challenge", challenge: "abc" });
});

test("a person's message in a public channel is a message", () => {
  assert.deepEqual(readSlackEvent(envelope(said)), {
    kind: "message",
    teamId: "T1",
    eventId: "Ev1",
    channel: "C1",
    ts: "1758800000.000100",
    user: "U1",
    text: "We ship on Fridays",
  });
  assert.equal(readSlackEvent(envelope({ ...said, subtype: "thread_broadcast" })).kind, "message");
});

test("bots, joins, leaves, private channels and DMs are ignored", () => {
  for (const e of [
    { ...said, bot_id: "B1", subtype: "bot_message" },
    { ...said, subtype: "channel_join" },
    { ...said, subtype: "channel_leave" },
    { ...said, channel_type: "group" },
    { ...said, channel_type: "im" },
    { ...said, channel_type: "mpim" },
  ]) {
    assert.equal(readSlackEvent(envelope(e)).kind, "ignore");
  }
  assert.equal(readSlackEvent({ type: "event_callback", event: said }).kind, "ignore");
});

test("edits, deletes and reactions", () => {
  assert.deepEqual(
    readSlackEvent(
      envelope({
        type: "message",
        subtype: "message_changed",
        channel: "C1",
        message: { type: "message", user: "U1", text: "We ship on Thursdays", ts: said.ts },
        previous_message: said,
        ts: "1758800100.000200",
      }),
    ),
    { kind: "edit", teamId: "T1", eventId: "Ev1", channel: "C1", ts: said.ts, text: "We ship on Thursdays" },
  );
  assert.deepEqual(
    readSlackEvent(
      envelope({ type: "message", subtype: "message_deleted", channel: "C1", hidden: true, deleted_ts: said.ts, previous_message: said, ts: "1758800200.000300" }),
    ),
    { kind: "delete", teamId: "T1", eventId: "Ev1", channel: "C1", ts: said.ts },
  );
  assert.deepEqual(
    readSlackEvent(
      envelope({ type: "reaction_added", user: "U2", reaction: "brain", item: { type: "message", channel: "C1", ts: said.ts }, item_user: "U1", event_ts: "1758800300.000400" }),
    ),
    { kind: "reaction", teamId: "T1", eventId: "Ev1", channel: "C1", ts: said.ts, user: "U2", reaction: "brain" },
  );
  assert.equal(readSlackEvent(envelope({ type: "reaction_added", user: "U2", reaction: "brain", item: { type: "file", file: "F1" } })).kind, "ignore");
});

test("a message becomes a passage keyed by channel and ts", () => {
  assert.deepEqual(slackPassage({ channel: "C1", ts: "1758800000.000100", user: "U1", text: "hi" }, "Ann"), {
    externalId: "C1:1758800000.000100",
    text: "hi",
    author: "Ann",
    slackUser: "U1",
    at: 1758800000000,
  });
});

test("names: display name first, then real name, then the handle", () => {
  assert.equal(readUserName({ user: { name: "ann", real_name: "Ann Lee", profile: { display_name: "", real_name: "Ann L." } } }), "Ann L.");
  assert.equal(readUserName({ user: { name: "ann" } }), "ann");
  assert.equal(readUserName({}), null);
  assert.equal(readChannelName({ channel: { id: "C1", name: "general" } }), "general");
});

test("the Web API helper posts a form with the bot token and names Slack's error", async (t) => {
  const calls: [string, RequestInit | undefined][] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return Response.json({ ok: false, error: "not_in_channel" });
  });
  await assert.rejects(slackApi("xoxb-1", "conversations.history", { channel: "C1", cursor: undefined, limit: 200 }), /conversations\.history: not_in_channel/);
  assert.equal(calls[0][0], "https://slack.com/api/conversations.history");
  assert.equal(calls[0][1]?.method, "POST");
  assert.equal(new Headers(calls[0][1]?.headers).get("authorization"), "Bearer xoxb-1");
  assert.equal(String(calls[0][1]?.body), "channel=C1&limit=200");
});

test("a rate-limited call carries Slack's Retry-After", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("", { status: 429, headers: { "retry-after": "7" } }));
  await assert.rejects(slackApi("xoxb-1", "users.info", { user: "U1" }), (err) => err instanceof SlackError && err.retryAfterS === 7);
});
```

In `convex/ingest.test.ts`, add `import { slackSignature } from "../lib/slack.ts";` to the imports, then append:
```ts
// --- the community Slack -------------------------------------------------------

const SLACK_SECRET = "test-slack-secret";
const TS = "1758800000.000100";

function slackEnv() {
  vi.stubEnv("SLACK_BRAIN_SIGNING_SECRET", SLACK_SECRET);
  vi.stubEnv("COMMUNITY_SLACK_TEAM_ID", "T1");
}

/** A request signed the way Slack signs one (lib/slack.ts). `ageS` backdates it. */
async function slackRequest(payload: unknown, o: { secret?: string; ageS?: number } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000) - (o.ageS ?? 0));
  return {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await slackSignature(o.secret ?? SLACK_SECRET, ts, body),
    },
  };
}

// The Events API envelope and event shapes from docs.slack.dev (Task 4 Step 1).
const envelope = (event: Record<string, unknown>, team = "T1") => ({
  token: "x",
  team_id: team,
  api_app_id: "A1",
  type: "event_callback",
  event_id: "Ev1",
  event_time: 1758800000,
  event,
});
const message = (o: Record<string, unknown> = {}, team = "T1") =>
  envelope({ type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "We ship on Fridays\nbecause QA is Thursday", ts: TS, ...o }, team);
const reaction = (name: string, user: string) =>
  envelope({ type: "reaction_added", user, reaction: name, item: { type: "message", channel: "C1", ts: TS }, item_user: "U1", event_ts: "1758800300.000400" });
const edited = (text: string) =>
  envelope({
    type: "message",
    subtype: "message_changed",
    channel: "C1",
    channel_type: "channel",
    message: { type: "message", user: "U1", text, ts: TS },
    previous_message: { type: "message", user: "U1", text: "old", ts: TS },
    ts: "1758800100.000200",
  });
const deleted = () =>
  envelope({
    type: "message",
    subtype: "message_deleted",
    channel: "C1",
    channel_type: "channel",
    hidden: true,
    deleted_ts: TS,
    previous_message: { type: "message", user: "U1", text: "old", ts: TS },
    ts: "1758800200.000300",
  });

/** Slack's Web API, answered by method. A method's replies are used in order; the last one repeats. */
function stubSlackApi(replies: Record<string, unknown[]>) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const queue = replies[url.split("/api/")[1] ?? ""];
    const body = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    return new Response(JSON.stringify(body ?? { ok: false, error: "unknown_method" }));
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const slackCalls = (f: ReturnType<typeof stubSlackApi>, method: string) =>
  f.mock.calls.filter(([url]) => url.endsWith(`/api/${method}`)).map(([, init]) => Object.fromEntries(new URLSearchParams(String(init?.body))));

/** A member who connected this Slack account through Composio (connections.externalUserId). */
const linkSlack = (t: T, userId: Id<"users">, slackUserId: string) =>
  t.run((ctx) =>
    ctx.db.insert("connections", {
      userId,
      connector: "slack",
      status: "active",
      state: "s0",
      createdAt: Date.now(),
      composioAccountId: "ca_1",
      externalUserId: slackUserId,
    }),
  );
const post = async (t: T, payload: unknown) => (await t.fetch("/slack/events", await slackRequest(payload))).status;

test("slack: a bad, stale or missing signature is a 401 before anything is read", async () => {
  slackEnv();
  const { t } = setup();
  const f = stubSlackApi({});
  expect((await t.fetch("/slack/events", await slackRequest(message(), { secret: "wrong" }))).status).toBe(401);
  expect((await t.fetch("/slack/events", await slackRequest(message(), { ageS: 600 }))).status).toBe(401);
  expect((await t.fetch("/slack/events", { method: "POST", body: JSON.stringify(message()) })).status).toBe(401);
  vi.stubEnv("SLACK_BRAIN_SIGNING_SECRET", "");
  expect(await post(t, message())).toBe(401);
  expect(f).not.toHaveBeenCalled();
  expect(await allPassages(t)).toHaveLength(0);
});

test("slack: url_verification is answered with its challenge", async () => {
  slackEnv();
  const { t } = setup();
  const res = await t.fetch("/slack/events", await slackRequest({ token: "x", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", type: "url_verification" }));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P");
});

test("slack: a public-channel message becomes one public passage, its author and channel named once", async () => {
  slackEnv();
  vi.stubEnv("SLACK_BRAIN_BOT_TOKEN", "xoxb-test");
  const { t } = setup();
  const f = stubSlackApi({
    "conversations.info": [{ ok: true, channel: { id: "C1", name: "general", is_private: false } }],
    "users.info": [{ ok: true, user: { id: "U1", name: "ann", profile: { display_name: "Ann" } } }],
  });
  expect(await post(t, message())).toBe(200);
  expect(await post(t, message())).toBe(200); // Slack redelivers.

  const rows = await allPassages(t);
  expect(rows).toEqual([
    expect.objectContaining({
      externalId: `C1:${TS}`,
      text: "We ship on Fridays\nbecause QA is Thursday",
      author: "Ann",
      visibility: "public",
      at: 1758800000000,
    }),
  ]);
  expect(rows[0].ownerId).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get("sources", rows[0].sourceId)))?.label).toBe("#general");
  expect(slackCalls(f, "users.info")).toHaveLength(1);
  expect(slackCalls(f, "conversations.info")).toHaveLength(1);
});

test("slack: another team, a private channel, a DM, a bot or a join is ignored", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  for (const e of [
    message({}, "T9"),
    message({ channel_type: "group" }),
    message({ channel_type: "im" }),
    message({ channel_type: "mpim" }),
    message({ bot_id: "B1", subtype: "bot_message" }),
    message({ subtype: "channel_join", text: "<@U1> has joined the channel" }),
  ]) {
    expect(await post(t, e)).toBe(200);
  }
  expect(await allPassages(t)).toHaveLength(0);
  vi.stubEnv("COMMUNITY_SLACK_TEAM_ID", "");
  expect(await post(t, message())).toBe(200);
  expect(await allPassages(t)).toHaveLength(0);
});

test("slack: a linked author shows as their @handle", async () => {
  slackEnv();
  const { t, seedUser } = setup();
  stubSlackApi({});
  const a = await seedUser("a");
  await linkSlack(t, a, "U2");
  await post(t, message({ user: "U2" }));
  expect((await allPassages(t))[0]?.authorHandle).toBe("a");
});

test("slack: 🧠 promotes the message to a public fact, attributed to a linked member; other reactions don't", async () => {
  slackEnv();
  const { t, seedUser } = setup();
  stubSlackApi({});
  const a = await seedUser("a");
  await linkSlack(t, a, "U2");
  await post(t, message());
  await post(t, reaction("thumbsup", "U2"));
  expect(await allFacts(t)).toHaveLength(0);

  await post(t, reaction("brain", "U2"));
  await post(t, reaction("brain", "U3"));
  const facts = await allFacts(t);
  expect(facts).toEqual([expect.objectContaining({ title: "We ship on Fridays", kind: "note", ownerId: a, source: `slack:C1:${TS}` })]);
  expect(facts[0].visibility).toBeUndefined();
  expect((await allPassages(t))[0].promotedFactId).toBe(facts[0]._id);
});

test("slack: someone who isn't a member can 🧠 too; the fact is nobody's", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  await post(t, message());
  await post(t, reaction("brain", "U3"));
  const facts = await allFacts(t);
  expect(facts).toHaveLength(1);
  expect(facts[0].ownerId).toBeUndefined();
});

test("slack: an edit rewrites the passage, and the unchanged fact promoted from it", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  await post(t, message());
  await post(t, reaction("brain", "U3"));
  await post(t, edited("We ship on Thursdays"));
  expect((await allPassages(t))[0].text).toBe("We ship on Thursdays");
  expect((await allFacts(t))[0]).toMatchObject({ title: "We ship on Thursdays", body: "We ship on Thursdays" });
});

test("slack: a delete removes the passage and its unchanged fact", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  await post(t, message());
  await post(t, reaction("brain", "U3"));
  expect(await allFacts(t)).toHaveLength(1);
  await post(t, deleted());
  expect(await allPassages(t)).toHaveLength(0);
  expect(await allFacts(t)).toHaveLength(0);
});

test("slack: a member's own Composio capture of the message is adopted, not duplicated, and outlives the delete", async () => {
  slackEnv();
  const { t, seedUser } = setup();
  stubSlackApi({});
  const a = await seedUser("a");
  await linkSlack(t, a, "U2");
  await post(t, message());
  const captured = await t.run((ctx) =>
    ctx.db.insert("facts", {
      title: "We ship on Fridays",
      body: "because QA is Thursday",
      kind: "note",
      ownerId: a,
      source: `slack:C1:${TS}`,
      text: "We ship on Fridays\nbecause QA is Thursday",
    }),
  );
  await post(t, reaction("brain", "U2"));
  expect(await allFacts(t)).toHaveLength(1);
  expect((await allPassages(t))[0].promotedFactId).toBe(captured);
  await post(t, deleted());
  expect(await allFacts(t)).toHaveLength(1);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test && npx vitest run convex/ingest.test.ts`
Expected: FAIL — `readSlackEvent is not a function`, and `/slack/events` answers 404.

- [ ] **Step 4: `lib/inbound.ts` exports its two readers**

```ts
export const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
export const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
```
(Only `export` is added.)

- [ ] **Step 5: `lib/slack.ts` — events, the Web API, readers**

Change the import line to:
```ts
import { CHUNK_MAX } from "./ingest.ts";
import { obj, same, str } from "./inbound.ts";
```
Extend the header comment with the Step 1 pages and date:
```ts
 * Events and Web API confirmed against docs.slack.dev on YYYY-MM-DD (Task 4
 * Step 1): /apis/events-api, /reference/events/{message.channels,
 * message/message_changed, message/message_deleted, message/bot_message,
 * reaction_added}, /reference/methods/{users.info, conversations.info},
 * /apis/web-api.
```
Append:
```ts
export const SLACK_API = "https://slack.com/api";

type Json = Record<string, unknown>;

/** Message subtypes that are a person's own words; joins, leaves, bots and channel housekeeping aren't. */
const PERSON_SUBTYPES = new Set<string | undefined>([undefined, "thread_broadcast", "file_share", "me_message"]);

export type SlackMessage = { channel: string; ts: string; user: string; text: string };

export type SlackEvent =
  | { kind: "challenge"; challenge: string }
  | ({ kind: "message"; teamId: string; eventId: string } & SlackMessage)
  | { kind: "edit"; teamId: string; eventId: string; channel: string; ts: string; text: string }
  | { kind: "delete"; teamId: string; eventId: string; channel: string; ts: string }
  | { kind: "reaction"; teamId: string; eventId: string; channel: string; ts: string; user: string; reaction: string }
  | { kind: "ignore"; teamId: string | null; eventId: string | null; type: string };

/**
 * One Events API delivery, reduced to what the brain does with it. A new
 * message counts only from a public channel (`channel_type: "channel"`) and
 * only as a person's own words. Edits and deletes pass through: they only
 * ever touch a passage already in the brain, which only a public-channel
 * message could have put there.
 */
export function readSlackEvent(json: unknown): SlackEvent {
  const j = obj(json);
  const challenge = str(j.challenge);
  if (j.type === "url_verification" && challenge) return { kind: "challenge", challenge };
  const teamId = str(j.team_id) ?? null;
  const eventId = str(j.event_id) ?? null;
  const e = obj(j.event);
  const type = str(e.type) ?? str(j.type) ?? "unknown";
  const ignore = { kind: "ignore" as const, teamId, eventId, type };
  if (j.type !== "event_callback" || !teamId || !eventId) return ignore;

  if (type === "reaction_added") {
    const item = obj(e.item);
    const channel = str(item.channel);
    const ts = str(item.ts);
    const user = str(e.user);
    const reaction = str(e.reaction);
    if (item.type !== "message" || !channel || !ts || !user || !reaction) return ignore;
    return { kind: "reaction", teamId, eventId, channel, ts, user, reaction };
  }
  if (type !== "message") return ignore;
  const channel = str(e.channel);
  if (!channel) return ignore;
  const subtype = str(e.subtype);
  if (subtype === "message_deleted") {
    const ts = str(e.deleted_ts) ?? str(obj(e.previous_message).ts);
    return ts ? { kind: "delete", teamId, eventId, channel, ts } : ignore;
  }
  if (subtype === "message_changed") {
    const m = obj(e.message);
    const ts = str(m.ts);
    const text = str(m.text);
    return ts && text && !m.bot_id ? { kind: "edit", teamId, eventId, channel, ts, text: text.slice(0, CHUNK_MAX) } : ignore;
  }
  if (e.channel_type !== "channel" || e.bot_id || !PERSON_SUBTYPES.has(subtype)) return ignore;
  const ts = str(e.ts);
  const user = str(e.user);
  const text = str(e.text);
  return ts && user && text ? { kind: "message", teamId, eventId, channel, ts, user, text: text.slice(0, CHUNK_MAX) } : ignore;
}

/** A message as `sources.write` takes it: keyed `<channel>:<ts>`, where `ts` is Slack's seconds-with-a-fraction. */
export const slackPassage = (m: SlackMessage, author: string | undefined) => ({
  externalId: `${m.channel}:${m.ts}`,
  text: m.text.slice(0, CHUNK_MAX),
  author,
  slackUser: m.user,
  at: Math.round(Number(m.ts) * 1000),
});

/** A Web API refusal: the method and Slack's error code, never a message's text. */
export class SlackError extends Error {
  retryAfterS: number | null;
  constructor(message: string, retryAfterS: number | null = null) {
    super(message);
    this.retryAfterS = retryAfterS;
  }
}

/** One Web API call with the bot token, as a form-encoded POST. */
export async function slackApi(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<Json> {
  const body = new URLSearchParams();
  for (const [k, val] of Object.entries(params)) if (val !== undefined) body.set(k, String(val));
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status === 429) throw new SlackError(`${method}: rate limited`, Number(res.headers.get("retry-after")) || 30);
  const json = obj(await res.json().catch(() => null));
  if (json.ok !== true) throw new SlackError(`${method}: ${str(json.error) ?? `http ${res.status}`}`);
  return json;
}

export const readUserName = (json: Json): string | null => {
  const u = obj(json.user);
  const p = obj(u.profile);
  return str(p.display_name) ?? str(p.real_name) ?? str(u.real_name) ?? str(u.name) ?? null;
};

export const readChannelName = (json: Json): string | null => str(obj(json.channel).name) ?? null;
```

- [ ] **Step 6: Schema, `slackMember`, `sources.write`**

In `convex/schema.ts`, add `.index("by_externalUserId", ["externalUserId"])` to `connections` (after `by_composioAccountId`), and a table after `passages`:
```ts
  /** Slack display names, one row per Slack user, so each is asked for once. */
  slackUsers: defineTable({ slackUserId: v.string(), name: v.string() }).index("by_slackUserId", ["slackUserId"]),
```

In `convex/access.ts`, append:
```ts
/**
 * The member who connected this Slack user id through Composio and may still
 * write to the brain, or null. Maps a community-Slack author to an @handle
 * and a 🧠 to its member.
 */
export async function slackMember(ctx: QueryCtx, slackUserId: string): Promise<Doc<"users"> | null> {
  const rows = await ctx.db
    .query("connections")
    .withIndex("by_externalUserId", (q) => q.eq("externalUserId", slackUserId))
    .take(10);
  for (const c of rows) {
    if (c.connector !== "slack" || c.status !== "active") continue;
    const u = await ctx.db.get("users", c.userId);
    if (u && !memberProblem(u)) return u;
  }
  return null;
}
```

In `convex/sources.ts`, change the server import to `import { type MutationCtx, internalMutation, mutation } from "./_generated/server";` and the access import to `import { requireMember, slackMember, visibleTo } from "./access";`, then append:
```ts
export const passageInput = v.object({
  externalId: v.string(),
  text: v.string(),
  author: v.optional(v.string()),
  /** A Slack author's user id, resolved here to a linked member's @handle. Not stored. */
  slackUser: v.optional(v.string()),
  url: v.optional(v.string()),
  at: v.number(),
});

/**
 * The one way passages get in. Upserts by `(sourceId, externalId)`, so a
 * redelivered event or a re-run sync never duplicates one, and writes nothing
 * to a source that was removed (or purged) meanwhile. A passage takes its
 * source's visibility and owner. `label`/`cursor` update the source;
 * `synced` marks a read finished.
 */
export const write = internalMutation({
  args: {
    sourceId: v.id("sources"),
    passages: v.array(passageInput),
    label: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    synced: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const s = await ctx.db.get("sources", a.sourceId);
    if (!s || s.status === "removed") return null;
    const handles = new Map<string, string | undefined>();
    for (const { slackUser, ...row } of a.passages) {
      if (slackUser && !handles.has(slackUser)) handles.set(slackUser, (await slackMember(ctx, slackUser))?.handle);
      const authorHandle = slackUser ? handles.get(slackUser) : undefined;
      const existing = await ctx.db
        .query("passages")
        .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", s._id).eq("externalId", row.externalId))
        .unique();
      if (existing) await rewritePassage(ctx, existing, row.text, { author: row.author, authorHandle, url: row.url, at: row.at });
      else await ctx.db.insert("passages", { ...row, authorHandle, sourceId: s._id, visibility: s.visibility, ownerId: s.ownerId });
    }
    await ctx.db.patch("sources", s._id, {
      ...(a.label ? { label: a.label.slice(0, 120) } : {}),
      ...(a.cursor !== undefined ? { cursor: a.cursor ?? undefined } : {}),
      ...(a.synced ? { lastSyncedAt: Date.now(), status: "active" as const, error: undefined } : {}),
    });
    return null;
  },
});
```

- [ ] **Step 7: `convex/slack.ts` and the route**

```ts
import { v } from "convex/values";
import { BRAIN_REACTION } from "../lib/inbound.ts";
import { readChannelName, readSlackEvent, readUserName, slackApi, slackPassage, verifySlack } from "../lib/slack.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type ActionCtx, type QueryCtx, httpAction, internalMutation, internalQuery } from "./_generated/server";
import { slackMember } from "./access";
import { factMatches, promotePassage, rewritePassage } from "./sources";

/**
 * POST /slack/events: the community workspace, read into the brain through
 * its own "Intern Brain" app. It's a separate app from the "Intern" one
 * members connect through Composio because a Slack app delivers its events
 * to one Request URL: Intern's go to Composio, Intern Brain's come here.
 *
 * Public channels only. Nothing is parsed before the signature checks out.
 * Anything signed that it ignores still gets a 200, so Slack doesn't retry
 * it. Logs name the event id and kind, never a message's text.
 */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function channelSource(ctx: QueryCtx, channelId: string) {
  return await ctx.db
    .query("sources")
    .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "slack_channel").eq("externalId", channelId))
    .unique();
}

async function passageAt(ctx: QueryCtx, channelId: string, ts: string) {
  const src = await channelSource(ctx, channelId);
  if (!src) return null;
  return await ctx.db
    .query("passages")
    .withIndex("by_sourceId_and_externalId", (q) => q.eq("sourceId", src._id).eq("externalId", `${channelId}:${ts}`))
    .unique();
}

export const knownChannel = internalQuery({
  args: { channel: v.string() },
  handler: async (ctx, a): Promise<Id<"sources"> | null> => (await channelSource(ctx, a.channel))?._id ?? null,
});

/** The channel's source, made on first sight. A known name replaces a bare id. */
export const ensureChannel = internalMutation({
  args: { channel: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Id<"sources">> => {
    const label = `#${a.name ?? a.channel}`;
    const row = await channelSource(ctx, a.channel);
    if (!row) {
      return await ctx.db.insert("sources", { kind: "slack_channel", label, externalId: a.channel, visibility: "public", status: "active" });
    }
    if (a.name && row.label !== label) await ctx.db.patch("sources", row._id, { label });
    return row._id;
  },
});

export const cachedName = internalQuery({
  args: { slackUserId: v.string() },
  handler: async (ctx, a): Promise<string | null> =>
    (await ctx.db.query("slackUsers").withIndex("by_slackUserId", (q) => q.eq("slackUserId", a.slackUserId)).unique())?.name ?? null,
});

export const rememberName = internalMutation({
  args: { slackUserId: v.string(), name: v.string() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("slackUsers").withIndex("by_slackUserId", (q) => q.eq("slackUserId", a.slackUserId)).unique();
    if (row) await ctx.db.patch("slackUsers", row._id, { name: a.name });
    else await ctx.db.insert("slackUsers", a);
    return null;
  },
});

/** A Slack user's display name: cached, else asked for once. Never throws; a name is decoration. */
export async function authorName(ctx: ActionCtx, token: string | undefined, slackUserId: string): Promise<string | undefined> {
  const cached: string | null = await ctx.runQuery(internal.slack.cachedName, { slackUserId });
  if (cached !== null || !token) return cached ?? undefined;
  try {
    const name = readUserName(await slackApi(token, "users.info", { user: slackUserId }));
    if (name) await ctx.runMutation(internal.slack.rememberName, { slackUserId, name });
    return name ?? undefined;
  } catch (err) {
    console.log(`slack: users.info for ${slackUserId} failed: ${errText(err)}`);
    return undefined;
  }
}

async function channelName(token: string, channelId: string): Promise<string | undefined> {
  try {
    return readChannelName(await slackApi(token, "conversations.info", { channel: channelId })) ?? undefined;
  } catch (err) {
    console.log(`slack: conversations.info for ${channelId} failed: ${errText(err)}`);
    return undefined;
  }
}

/** An edit in Slack. Only a passage already in the brain changes. */
export const edit = internalMutation({
  args: { channel: v.string(), ts: v.string(), text: v.string() },
  handler: async (ctx, a) => {
    const p = await passageAt(ctx, a.channel, a.ts);
    if (p) await rewritePassage(ctx, p, a.text);
    return null;
  },
});

/** Deleted in Slack means deleted in the brain: the passage, and its promoted fact if nobody has changed it. */
export const forget = internalMutation({
  args: { channel: v.string(), ts: v.string() },
  handler: async (ctx, a) => {
    const p = await passageAt(ctx, a.channel, a.ts);
    if (!p) return null;
    const f = p.promotedFactId ? await ctx.db.get("facts", p.promotedFactId) : null;
    if (f && factMatches(f, p.text)) await ctx.db.delete("facts", f._id);
    await ctx.db.delete("passages", p._id);
    return null;
  },
});

/**
 * 🧠 on a message: a public fact, attributed to the reactor if they're a
 * member who linked this Slack account, owned by nobody otherwise. Filed
 * under the same key a member's own Composio 🧠 uses, so the two never twin.
 */
export const react = internalMutation({
  args: { channel: v.string(), ts: v.string(), user: v.string() },
  handler: async (ctx, a) => {
    const p = await passageAt(ctx, a.channel, a.ts);
    if (!p) return null;
    const member = await slackMember(ctx, a.user);
    await promotePassage(
      ctx,
      p,
      member ? { ownerId: member._id, visibility: "public", source: `slack:${a.channel}:${a.ts}` } : { visibility: "public" },
    );
    return null;
  },
});

export const events = httpAction(async (ctx, req) => {
  const body = await req.text();
  const signedOk = await verifySlack(
    process.env.SLACK_BRAIN_SIGNING_SECRET ?? "",
    { timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature") },
    body,
  );
  if (!signedOk) return new Response("bad signature", { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const e = readSlackEvent(json);
  if (e.kind === "challenge") return new Response(e.challenge, { status: 200, headers: { "content-type": "text/plain" } });
  const done = (why: string) => new Response(why, { status: 200 });
  console.log(`slack: ${e.eventId ?? "(no id)"} ${e.kind === "ignore" ? `ignored ${e.type}` : e.kind}`);
  // The same var connections.finish enforces on connect: one community workspace.
  const team = process.env.COMMUNITY_SLACK_TEAM_ID;
  if (e.kind === "ignore" || !team || e.teamId !== team) return done("ignored");

  if (e.kind === "delete") {
    await ctx.runMutation(internal.slack.forget, { channel: e.channel, ts: e.ts });
    return done("deleted");
  }
  if (e.kind === "edit") {
    await ctx.runMutation(internal.slack.edit, { channel: e.channel, ts: e.ts, text: e.text });
    return done("edited");
  }
  if (e.kind === "reaction") {
    if (e.reaction !== BRAIN_REACTION) return done("ignored");
    await ctx.runMutation(internal.slack.react, { channel: e.channel, ts: e.ts, user: e.user });
    return done("promoted");
  }
  const token = process.env.SLACK_BRAIN_BOT_TOKEN;
  const known: Id<"sources"> | null = await ctx.runQuery(internal.slack.knownChannel, { channel: e.channel });
  const sourceId: Id<"sources"> =
    known ??
    (await ctx.runMutation(internal.slack.ensureChannel, {
      channel: e.channel,
      name: token ? await channelName(token, e.channel) : undefined,
    }));
  await ctx.runMutation(internal.sources.write, { sourceId, passages: [slackPassage(e, await authorName(ctx, token, e.user))] });
  return done("stored");
});
```

In `convex/http.ts`, add `import { events } from "./slack";` and, before `export default http;`:
```ts
// The community Slack, through the "Intern Brain" app, signed with SLACK_BRAIN_SIGNING_SECRET.
http.route({ path: "/slack/events", method: "POST", handler: events });
```

Add `slack` to `convex/_generated/api.d.ts` by hand (after `send`).

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm test && npx vitest run`
Expected: PASS, including every existing `/composio/webhook` test in `convex/surfaces.test.ts`.

- [ ] **Step 9: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 10: Commit**

```bash
git add lib/slack.ts lib/slack.test.ts lib/inbound.ts convex/schema.ts convex/access.ts convex/sources.ts convex/slack.ts convex/http.ts convex/_generated/api.d.ts convex/ingest.test.ts
git commit -m "$(cat <<'EOF'
Community Slack: signed /slack/events, public-channel passages, 🧠 promotes, authors mapped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Slack backfill, the notice, and the join step after consent

**Files:**
- Modify: `lib/slack.ts`, `lib/slack.test.ts`, `convex/sources.ts` (`get`, `fail`), `components/Consent.tsx` (`NOTICE`, `JoinSlack`), `components/Gate.tsx`, `convex/_generated/api.d.ts` (add `ingest`), `convex/ingest.test.ts`
- Create: `convex/ingest.ts`

**Interfaces:**
- Consumes: `slackApi`, `SlackError`, `slackPassage`, `SlackMessage` (Task 4); `authorName`, `internal.slack.ensureChannel`, `internal.sources.write`, `stubSlackApi`, `slackCalls`, `slackEnv` (Task 4); `BACKFILL_DAYS` (Task 1); `api.connections.mine`'s Slack row `{ connected, invite }` (existing: `invite` is `COMMUNITY_SLACK_INVITE_URL` when it starts `https://`, else null, tested in `convex/surfaces.test.ts`).
- Produces:
  ```ts
  // lib/slack.ts
  export const HISTORY_PAGE = 200, HISTORY_DELAY_MS = 1_500;
  export function readChannels(json): { channels: { id: string; name: string }[]; next: string | null };
  export function readHistory(json, channel: string): { messages: SlackMessage[]; next: string | null };
  // convex/sources.ts
  internal.sources.get({ sourceId }) => Doc<"sources"> | null
  internal.sources.fail({ sourceId, error }) => null
  // convex/ingest.ts
  internal.ingest.backfillSlack({}) => { channels: number }        // admin: `ingest:backfillSlack`
  internal.ingest.backfillChannel({ sourceIds: Id<"sources">[], oldest: number }) => null
  // components/Consent.tsx
  export const NOTICE: string; // now names sources and the community Slack
  export function JoinSlack({ url, onDone }: { url: string; onDone: () => void }): JSX.Element;
  ```

- [ ] **Step 1: Confirm the backfill methods and their rate limits**

Fetch each page and confirm; record differences in `readChannels`, `readHistory`, `HISTORY_PAGE`, `HISTORY_DELAY_MS`, `backfillSlack`/`backfillChannel` and the Step 2 fixtures; put the date in the comment above `HISTORY_PAGE`.
1. `https://docs.slack.dev/reference/methods/conversations.list`: `types=public_channel`, `exclude_archived`, `limit` (≤ 1000), `cursor`; reply `channels[]` with `id`, `name`, `is_private`, `is_archived`; `response_metadata.next_cursor` (empty when done). Its rate-limit tier.
2. `https://docs.slack.dev/reference/methods/conversations.history`: `channel`, `oldest` (Unix seconds), `limit`, `cursor`; reply `messages[]`, `has_more`, `response_metadata.next_cursor`; the error when the bot isn't in the channel (`not_in_channel`).
3. `https://docs.slack.dev/reference/methods/conversations.join`: scope `channels:join`, public channels only; joining a channel the bot is already in succeeds.
4. `https://docs.slack.dev/apis/web-api/rate-limits` and the May 2025 changelog on `conversations.history` limits for non-Marketplace apps: confirm that an **internal** app (installed only in its own workspace, never distributed) keeps Tier 3 (50+ per minute) and the full `limit`. If it doesn't, set `HISTORY_DELAY_MS = 61_000` and `HISTORY_PAGE = 15`, and say so in the report.

- [ ] **Step 2: Write the failing tests**

Append to `lib/slack.test.ts` (extend the import with `readChannels, readHistory`):
```ts
// --- backfill ----------------------------------------------------------------

test("conversations.list keeps public, unarchived channels", () => {
  assert.deepEqual(
    readChannels({
      ok: true,
      channels: [
        { id: "C1", name: "general", is_private: false, is_archived: false, is_member: true },
        { id: "C2", name: "old", is_private: false, is_archived: true, is_member: false },
        { id: "C3", name: "secret", is_private: true, is_archived: false, is_member: true },
      ],
      response_metadata: { next_cursor: "dGVhbTpDMDYx" },
    }),
    { channels: [{ id: "C1", name: "general" }], next: "dGVhbTpDMDYx" },
  );
  assert.equal(readChannels({ ok: true, channels: [], response_metadata: { next_cursor: "" } }).next, null);
});

test("conversations.history keeps people's messages, and a cursor only while there's more", () => {
  const page = {
    ok: true,
    messages: [
      { type: "message", user: "U1", text: "We ship on Fridays", ts: "1758800000.000100" },
      { type: "message", subtype: "channel_join", user: "U2", text: "<@U2> has joined the channel", ts: "1758800001.000100" },
      { type: "message", subtype: "bot_message", bot_id: "B1", text: "deploy done", ts: "1758800002.000100" },
    ],
    has_more: true,
    response_metadata: { next_cursor: "bmV4dA==" },
  };
  assert.deepEqual(readHistory(page, "C1"), {
    messages: [{ channel: "C1", ts: "1758800000.000100", user: "U1", text: "We ship on Fridays" }],
    next: "bmV4dA==",
  });
  assert.equal(readHistory({ ...page, has_more: false }, "C1").next, null);
});
```

Append to `convex/ingest.test.ts`:
```ts
// --- backfill and joining ------------------------------------------------------

const person = (text: string, ts: string) => ({ type: "message", user: "U1", text, ts });

test("backfill joins each public channel and pages its history back 90 days", async () => {
  slackEnv();
  vi.stubEnv("SLACK_BRAIN_BOT_TOKEN", "xoxb-test");
  const { t } = setup();
  const f = stubSlackApi({
    "conversations.list": [
      { ok: true, channels: [{ id: "C1", name: "general", is_private: false, is_archived: false, is_member: false }], response_metadata: { next_cursor: "" } },
    ],
    "conversations.join": [{ ok: true, channel: { id: "C1" } }],
    "conversations.history": [
      { ok: true, messages: [person("newest", "1758800002.000100"), person("newer", "1758800001.000100")], has_more: true, response_metadata: { next_cursor: "c2" } },
      { ok: true, messages: [person("oldest", "1758800000.000100")], has_more: false, response_metadata: { next_cursor: "" } },
    ],
    "users.info": [{ ok: true, user: { id: "U1", name: "ann", profile: { display_name: "Ann" } } }],
  });
  const before = Math.floor(Date.now() / 1000);
  expect(await t.action(internal.ingest.backfillSlack, {})).toEqual({ channels: 1 });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(slackCalls(f, "conversations.join")).toEqual([{ channel: "C1" }]);
  const history = slackCalls(f, "conversations.history");
  expect(history.map((h) => h.cursor)).toEqual([undefined, "c2"]);
  expect(Number(history[0].oldest)).toBeGreaterThanOrEqual(before - 90 * 86_400);
  expect(Number(history[0].oldest)).toBeLessThanOrEqual(before - 90 * 86_400 + 5);
  expect((await allPassages(t)).map((p) => `${p.text}:${p.author}`).sort()).toEqual(["newer:Ann", "newest:Ann", "oldest:Ann"]);
  expect(slackCalls(f, "users.info")).toHaveLength(1);
  const [src] = await t.run((ctx) => ctx.db.query("sources").collect());
  expect(src).toMatchObject({ kind: "slack_channel", label: "#general", externalId: "C1", status: "active", visibility: "public" });
  expect(src.cursor).toBeUndefined();
  expect(src.lastSyncedAt).toBeTypeOf("number");
});

test("backfill resumes a channel from its source's cursor", async () => {
  vi.stubEnv("SLACK_BRAIN_BOT_TOKEN", "xoxb-test");
  const { t, seedSource } = setup();
  const sourceId = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1", cursor: "c2" });
  const f = stubSlackApi({ "conversations.history": [{ ok: true, messages: [person("older", "1758700000.000100")], has_more: false }] });
  await t.action(internal.ingest.backfillChannel, { sourceIds: [sourceId], oldest: 0 });
  expect(slackCalls(f, "conversations.join")).toEqual([]);
  expect(slackCalls(f, "conversations.history")).toEqual([{ channel: "C1", oldest: "0", limit: "200", cursor: "c2" }]);
  expect((await t.run((ctx) => ctx.db.get("sources", sourceId)))?.cursor).toBeUndefined();
  expect(await allPassages(t)).toHaveLength(1);
});
```

(The join step's link needs no new test: `connections.mine`'s `invite` is already https-only and tested in `convex/surfaces.test.ts`, "community Slack: the invite link reaches the rail only when it's https".)

- [ ] **Step 3: Run them to see them fail**

Run: `npm test && npx vitest run convex/ingest.test.ts`
Expected: FAIL — `readChannels is not a function`; `internal.ingest` is undefined.

- [ ] **Step 4: `lib/slack.ts` — backfill readers and pacing**

Append:
```ts
/**
 * Backfill pacing, confirmed on docs.slack.dev on YYYY-MM-DD (Task 5 Step 1):
 * conversations.history is Tier 3 (50+ a minute) for an internal app
 * installed in its own workspace. One call per HISTORY_DELAY_MS stays under it.
 */
export const HISTORY_PAGE = 200;
export const HISTORY_DELAY_MS = 1_500;

const rows = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);
const nextCursor = (json: Json) => str(obj(json.response_metadata).next_cursor) ?? null;

/** conversations.list, public and unarchived only, however it was asked. */
export function readChannels(json: Json): { channels: { id: string; name: string }[]; next: string | null } {
  return {
    channels: rows(json.channels).flatMap((c) => {
      const id = str(c.id);
      const name = str(c.name);
      return id && name && c.is_private === false && c.is_archived !== true ? [{ id, name }] : [];
    }),
    next: nextCursor(json),
  };
}

/** conversations.history: a person's own messages only, and a cursor only while there's more. */
export function readHistory(json: Json, channel: string): { messages: SlackMessage[]; next: string | null } {
  return {
    messages: rows(json.messages).flatMap((m) => {
      const ts = str(m.ts);
      const user = str(m.user);
      const text = str(m.text);
      return ts && user && text && !m.bot_id && PERSON_SUBTYPES.has(str(m.subtype)) ? [{ channel, ts, user, text }] : [];
    }),
    next: json.has_more === true ? nextCursor(json) : null,
  };
}
```

- [ ] **Step 5: `sources.get`, `sources.fail`**

In `convex/sources.ts`, change the server import to `import { type MutationCtx, internalMutation, internalQuery, mutation } from "./_generated/server";`, then append:
```ts
export const get = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => await ctx.db.get("sources", sourceId),
});

/** A read that failed, with a reason the member can act on. Passages already read stay. */
export const fail = internalMutation({
  args: { sourceId: v.id("sources"), error: v.string() },
  handler: async (ctx, a) => {
    const s = await ctx.db.get("sources", a.sourceId);
    if (s && s.status !== "removed") await ctx.db.patch("sources", s._id, { status: "failed", error: a.error.slice(0, 200) });
    return null;
  },
});
```

- [ ] **Step 6: `convex/ingest.ts`**

```ts
import { v } from "convex/values";
import { BACKFILL_DAYS } from "../lib/ingest.ts";
import { HISTORY_DELAY_MS, HISTORY_PAGE, SlackError, readChannels, readHistory, slackApi, slackPassage } from "../lib/slack.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { authorName } from "./slack";

/**
 * Reading sources that live elsewhere, in the default runtime over plain
 * fetch. No model calls. Documents are read in convex/documents.ts.
 */

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Admin, from the Convex dashboard's function runner: `ingest:backfillSlack {}`.
 * Lists the community workspace's public channels and reads each one's last
 * 90 days, one channel after another. Safe to re-run: passages upsert, a
 * channel part-way through resumes from its source's cursor, and a channel
 * created since is joined.
 */
export const backfillSlack = internalAction({
  args: {},
  handler: async (ctx): Promise<{ channels: number }> => {
    const token = process.env.SLACK_BRAIN_BOT_TOKEN;
    if (!token) throw new Error("Set SLACK_BRAIN_BOT_TOKEN first.");
    const oldest = Math.floor(Date.now() / 1000) - BACKFILL_DAYS * 86_400;
    const sourceIds: Id<"sources">[] = [];
    let cursor: string | undefined;
    do {
      const page = readChannels(
        await slackApi(token, "conversations.list", { types: "public_channel", exclude_archived: true, limit: 200, cursor }),
      );
      for (const c of page.channels) sourceIds.push(await ctx.runMutation(internal.slack.ensureChannel, { channel: c.id, name: c.name }));
      cursor = page.next ?? undefined;
    } while (cursor);
    await ctx.scheduler.runAfter(0, internal.ingest.backfillChannel, { sourceIds, oldest });
    return { channels: sourceIds.length };
  },
});

/**
 * One page of the first channel in `sourceIds`, then itself again: the same
 * channel while there's more, else the next one. One Slack history call per
 * HISTORY_DELAY_MS whatever the workspace's size; a 429 waits Slack's
 * Retry-After and tries the same page again.
 */
export const backfillChannel = internalAction({
  args: { sourceIds: v.array(v.id("sources")), oldest: v.number() },
  handler: async (ctx, { sourceIds, oldest }) => {
    const [sourceId, ...rest] = sourceIds;
    const token = process.env.SLACK_BRAIN_BOT_TOKEN;
    if (!sourceId || !token) return null;
    const next = async (ids: Id<"sources">[], delayMs = HISTORY_DELAY_MS) => {
      if (ids.length) await ctx.scheduler.runAfter(delayMs, internal.ingest.backfillChannel, { sourceIds: ids, oldest });
    };
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    if (!src || src.kind !== "slack_channel" || src.status === "removed") {
      await next(rest);
      return null;
    }
    try {
      // Starting a channel: join it first. A bot reads history, and hears new
      // messages, only where it's a member; `channels:join` reaches public
      // channels only, and joining one it's already in is a no-op.
      if (!src.cursor) await slackApi(token, "conversations.join", { channel: src.externalId });
      const page = readHistory(
        await slackApi(token, "conversations.history", { channel: src.externalId, oldest, limit: HISTORY_PAGE, cursor: src.cursor }),
        src.externalId,
      );
      const names = new Map<string, string | undefined>();
      for (const m of page.messages) if (!names.has(m.user)) names.set(m.user, await authorName(ctx, token, m.user));
      await ctx.runMutation(internal.sources.write, {
        sourceId,
        passages: page.messages.map((m) => slackPassage(m, names.get(m.user))),
        cursor: page.next,
        synced: !page.next,
      });
      await next(page.next ? sourceIds : rest);
    } catch (err) {
      if (err instanceof SlackError && err.retryAfterS) {
        await next(sourceIds, err.retryAfterS * 1000);
        return null;
      }
      console.log(`backfill: ${src.externalId} failed: ${errText(err)}`);
      await ctx.runMutation(internal.sources.fail, { sourceId, error: "Couldn't read this channel's history." });
      await next(rest);
    }
    return null;
  },
});
```

Add `ingest` to `convex/_generated/api.d.ts` by hand (after `inbound`).

- [ ] **Step 7: The notice, and the join step after consent**

In `components/Consent.tsx`, `NOTICE` names what else is now public (the same string is the cockpit's banner):
```tsx
export const NOTICE =
  "Public test brain: briefs, facts, the sources you add and the community Slack's public channels are visible to everyone. Your drafts, questions, sends and private documents are private to you. Don't put anything private in a brief.";
```

Append to `components/Consent.tsx`:
```tsx
/**
 * One step after consent: the community Slack, whose public channels feed
 * the brain. Shown once per browser, and only to a member whose Slack isn't
 * connected yet; the rail's accounts row carries the same link.
 */
export function JoinSlack({ url, onDone }: { url: string; onDone: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[420px] border border-line bg-panel p-4">
        <p className="label">one more thing</p>
        <p className="mt-3 leading-relaxed text-fg">
          The community talks in Slack. Its public channels are read into the brain, so your interns already know what was said there.
        </p>
        <div className="mt-4 flex gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onDone}
            className="flex-1 border border-accent/60 bg-accent/10 py-2 text-center text-accent hover:bg-accent/20"
          >
            Join the community Slack →
          </a>
          <button type="button" onClick={onDone} className="border border-line px-3 text-faint hover:text-fg">
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
```

In `components/Gate.tsx`, change the imports:
```tsx
import { useEffect, useState } from "react";
import Consent, { JoinSlack } from "./Consent";
```
add above `Member`:
```tsx
const JOIN_SEEN = "intern.slack_join_seen";

/** Blocked storage reads as seen: better never to show the step than to show it every load. */
const joinSeen = () => {
  try {
    return localStorage.getItem(JOIN_SEEN) === "1";
  } catch {
    return true;
  }
};
```
and replace `Member`:
```tsx
function Member() {
  const me = useQuery(api.users.viewer, {});
  // The invite is connections.mine's (https-only, env-driven); no second copy of that check.
  const slack = useQuery(api.connections.mine, {})?.find((c) => c.key === "slack");
  const [seen, setSeen] = useState(joinSeen);
  if (me === undefined) return <Wait text="loading" />;
  if (me === null) return <SignIn />;
  if (me.banned) return <Banned />;
  if (!me.accepted) return <Consent />;
  if (slack?.invite && !slack.connected && !seen) {
    const done = () => {
      try {
        localStorage.setItem(JOIN_SEEN, "1");
      } catch {
        // Storage blocked: the step shows again next time.
      }
      setSeen(true);
    };
    return <JoinSlack url={slack.invite} onDone={done} />;
  }
  return <Cockpit me={{ userId: me.userId, handle: me.handle, image: me.image }} />;
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm test && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 10: Commit**

```bash
git add lib/slack.ts lib/slack.test.ts convex/sources.ts convex/ingest.ts convex/_generated/api.d.ts convex/ingest.test.ts components/Consent.tsx components/Gate.tsx
git commit -m "$(cat <<'EOF'
Slack backfill (90 days, paced, resumable), the join-the-community step, and a notice that names sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 6: Documents — a link or an upload, read safely, chunked

**Files:**
- Modify: `lib/ingest.ts`, `lib/ingest.test.ts`, `convex/sources.ts` (`assertCanAdd`, `addLink`, `uploadUrl`, `addUpload`), `convex/access.ts` (`capExempt`'s comment), `convex/_generated/api.d.ts` (add `documents`), `convex/ingest.test.ts`, `package.json` / `package-lock.json` (`unpdf`)
- Create: `lib/pdf.ts`, `lib/pdf.test.ts`, `convex/documents.ts`

**Interfaces:**
- Consumes: `fetchDocument`, `htmlToText`, `chunk`, `urlProblem`, `IngestError`, `sourceError`, `UPLOAD_MAX_BYTES` (Task 1); `SOURCES_PER_DAY`, `sourceBlocked`, `dayStart` (`lib/caps.ts`); `capExempt` (`convex/access.ts`, existing); `internal.sources.write/get/fail` (Tasks 4, 5); `setup()`, `allPassages` (Task 2).
- Produces:
  ```ts
  // lib/ingest.ts
  export const NO_TEXT_LAYER: string;
  export const isPdf: (b: Uint8Array) => boolean;
  export function decodeText(b: Uint8Array): string; // throws IngestError
  export const hasTextLayer: (text: string) => boolean;
  // lib/pdf.ts
  export function pdfText(bytes: Uint8Array): Promise<string>;
  // convex/sources.ts
  async function assertCanAdd(ctx: MutationCtx, ownerId: Id<"users">): Promise<void>; // module-private
  api.sources.addLink({ input: string, private: boolean }) => Id<"sources">   // Task 7 routes repos through it too
  api.sources.uploadUrl({}) => string
  api.sources.addUpload({ storageId: Id<"_storage">, name: string, private: boolean }) => Id<"sources">
  // convex/documents.ts ("use node")
  internal.documents.readUrl({ sourceId }) => null
  internal.documents.readUpload({ sourceId }) => null
  // convex/ingest.test.ts helpers
  html(title, ...paragraphs), stubPage(body, contentType?, extra?, status?), settle(t)
  ```

- [ ] **Step 1: Confirm the PDF library, the Node runtime and `redirect: "manual"`**

Fetch each page and confirm. If (1) or (3) can't be confirmed, **stop here and report**: don't pick another library or runtime.
1. `https://github.com/unjs/unpdf` (README) and `https://www.npmjs.com/package/unpdf`: pure JS (a serverless build of pdf.js, no native dependencies, no canvas for text), runs in Node; MIT; exports `getDocumentProxy(data: Uint8Array)` and `extractText(pdf, { mergePages: false })` resolving to `{ totalPages: number; text: string[] }`. Note the current version; install exactly it: `npm install unpdf@<version>`.
2. `https://docs.convex.dev/functions/runtimes`: a `"use node"` file may export only actions, can use npm packages, and can read storage (`ctx.storage.get`). `https://docs.convex.dev/functions/bundling`: `node.externalPackages` in `convex.json`, for a package that won't bundle.
3. Node's `fetch` (`https://nodejs.org/api/globals.html#fetch`, which is undici; `https://github.com/nodejs/undici/blob/main/docs/docs/api/Fetch.md`): with `redirect: "manual"` it resolves to the 3xx response itself, `Location` readable (unlike a browser's opaque redirect). `fetchDocument` depends on this; it's why document reading runs in the `"use node"` file.
4. `https://docs.convex.dev/file-storage/upload-files`: `ctx.storage.generateUploadUrl()` in a mutation; the browser POSTs the file there and gets `{ storageId }` back; `ctx.db.system.get("_storage", id)` returns `size` and `_creationTime`.

Put the date in `lib/pdf.ts`'s header comment.

- [ ] **Step 2: Write the failing tests**

Append to `lib/ingest.test.ts` (extend the import with `decodeText, hasTextLayer, isPdf`):
```ts
// --- uploads -----------------------------------------------------------------

test("uploads: PDFs are sniffed, text must be UTF-8, and a PDF needs a text layer", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(isPdf(bytes("%PDF-1.7\n%âãÏÓ")), true);
  assert.equal(isPdf(bytes("# notes")), false);
  assert.equal(decodeText(bytes("# Notes ✓")), "# Notes ✓");
  assert.throws(() => decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0x80])), /markdown, text or PDF/);
  assert.equal(hasTextLayer(" \n\f "), false);
  assert.equal(hasTextLayer("We ship on Fridays"), true);
});
```

Create `lib/pdf.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { pdfText } from "./pdf.ts";

/** A one-page PDF whose page says `text` (nothing, for a scan), with a correct xref so pdf.js reads it without repair. */
function onePagePdf(text: string): Uint8Array {
  const stream = text ? `BT /F1 12 Tf 20 50 Td (${text}) Tj ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("a PDF's text layer is read", async () => {
  assert.match(await pdfText(onePagePdf("We ship on Fridays")), /We ship on Fridays/);
});

test("a page with no text layer reads as nothing", async () => {
  assert.equal((await pdfText(onePagePdf(""))).trim(), "");
});
```

Append to `convex/ingest.test.ts` (and add `import { UPLOAD_MAX_BYTES } from "../lib/ingest.ts";` to the imports):
```ts
// --- documents ---------------------------------------------------------------

const html = (title: string, ...paragraphs: string[]) =>
  `<html><head><title>${title}</title></head><body>${paragraphs.map((p) => `<p>${p}</p>`).join("")}</body></html>`;

/** A web server that answers every URL with this body. */
function stubPage(body: string, contentType = "text/html; charset=utf-8", extra: Record<string, string> = {}, status = 200) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status, headers: { "content-type": contentType, ...extra } }),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

/** Runs everything scheduled so far (the readers). */
const settle = async (t: T) => {
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};

test("a link is read, reduced to text and chunked into passages under the page's title", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  stubPage(html("Handbook", "a".repeat(500), "b".repeat(500), "c".repeat(500)));
  const sourceId = await asUser(a).mutation(api.sources.addLink, { input: "https://example.com/handbook", private: false });
  await settle(t);
  const rows = await allPassages(t);
  expect(rows.map((p) => p.externalId).sort()).toEqual(["0", "1"]);
  expect(rows.every((p) => p.visibility === "public" && p.ownerId === a && p.url === "https://example.com/handbook")).toBe(true);
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({ label: "Handbook", status: "active", visibility: "public" });
});

test("only https, and never a private address", async () => {
  const { seedUser, asUser } = setup();
  const a = await seedUser("a");
  const add = (input: string) => asUser(a).mutation(api.sources.addLink, { input, private: false });
  await expect(add("http://example.com/")).rejects.toThrow(/https/);
  await expect(add("https://localhost/admin")).rejects.toThrow(/private/);
  await expect(add("https://10.0.0.1/")).rejects.toThrow(/private/);
});

test("a redirect to a private address fails the source, and nothing is read", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  stubPage("", "text/html", { location: "https://169.254.169.254/latest/meta-data" }, 302);
  const sourceId = await asUser(a).mutation(api.sources.addLink, { input: "https://example.com/go", private: false });
  await settle(t);
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({ status: "failed", error: "That address is private." });
  expect(await allPassages(t)).toHaveLength(0);
});

test("five sources a day, and the same link once", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  stubPage("hi", "text/plain");
  const add = (input: string) => asUser(a).mutation(api.sources.addLink, { input, private: false });
  await add("https://example.com/1");
  await expect(add("https://example.com/1")).rejects.toThrow(/already added/);
  for (let i = 2; i <= 5; i++) await add(`https://example.com/${i}`);
  await expect(add("https://example.com/6")).rejects.toThrow(/5 sources/);
  // CAP_EXEMPT_HANDLES skips it, like every per-member cap.
  vi.stubEnv("CAP_EXEMPT_HANDLES", "a");
  await add("https://example.com/6");
  await settle(t); // let the six readers finish while fetch is still stubbed
});

test("a private document is invisible to another member's recall", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  stubPage("Pricing for Acme is 40k a year.", "text/plain");
  await asUser(a).mutation(api.sources.addLink, { input: "https://example.com/deal.txt", private: true });
  await settle(t);
  expect((await allPassages(t))[0]).toMatchObject({ visibility: "owner", ownerId: a });
  expect(await t.query(internal.facts.archive, { task: "pricing Acme", ownerId: b })).toEqual([]);
  expect((await t.query(internal.facts.archive, { task: "pricing Acme", ownerId: a })).map((p) => p.visibility)).toEqual(["owner"]);
});

test("a document stops at 200 passages", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  stubPage(Array(250).fill("x".repeat(900)).join("\n\n"), "text/plain");
  await asUser(a).mutation(api.sources.addLink, { input: "https://example.com/long.txt", private: false });
  await settle(t);
  expect(await allPassages(t)).toHaveLength(200);
});

test("a markdown upload becomes passages, and its file can't be claimed twice", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["# Notes\n\nWe ship on Fridays."], { type: "text/markdown" })));
  const sourceId = await asUser(a).mutation(api.sources.addUpload, { storageId, name: "notes.md", private: false });
  await settle(t);
  expect((await allPassages(t)).map((p) => p.text)).toEqual(["# Notes\n\nWe ship on Fridays."]);
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({ label: "notes.md", status: "active", storageId });
  await expect(asUser(b).mutation(api.sources.addUpload, { storageId, name: "mine.md", private: false })).rejects.toThrow(/expired/);
});

test("an upload over 5 MB, or one that isn't text, is refused", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const big = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(UPLOAD_MAX_BYTES + 1)])));
  await expect(asUser(a).mutation(api.sources.addUpload, { storageId: big, name: "big.txt", private: false })).rejects.toThrow(/under 5 MB/);
  const binary = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array([0xff, 0xfe, 0x00, 0x80])])));
  const sourceId = await asUser(a).mutation(api.sources.addUpload, { storageId: binary, name: "photo.md", private: false });
  await settle(t);
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({ status: "failed", error: "Upload a markdown, text or PDF file." });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm install unpdf@<version from Step 1> && npm test && npx vitest run convex/ingest.test.ts`
Expected: FAIL — `isPdf is not a function`, `Cannot find module '.../lib/pdf.ts'`, `api.sources.addLink` is undefined.

- [ ] **Step 4: `lib/ingest.ts` — uploads**

Append:
```ts
// --- uploads -----------------------------------------------------------------

export const NO_TEXT_LAYER = "That PDF has no text in it (it's probably a scan). Upload a version with selectable text.";

/** Sniffed from the bytes, never trusted from the file name or the browser's content type. */
export const isPdf = (b: Uint8Array) => b.length >= 5 && String.fromCharCode(...b.subarray(0, 5)) === "%PDF-";

/** Markdown and plain text are UTF-8; anything that isn't is refused. */
export function decodeText(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    throw new IngestError("Upload a markdown, text or PDF file.");
  }
}

/** ponytail: a scan's "text" is empty or a few stray marks; under ten letters in the whole file counts as none. */
export const hasTextLayer = (text: string) => text.replace(/\s+/g, "").length >= 10;
```

- [ ] **Step 5: `lib/pdf.ts`**

```ts
import { extractText, getDocumentProxy } from "unpdf";

/**
 * A PDF's text layer, pages separated by blank lines so the chunker splits
 * between them. unpdf is pdf.js's serverless build: pure JS, no native
 * dependencies; confirmed on YYYY-MM-DD (Task 6 Step 1). A scan comes back
 * empty; the caller refuses it.
 */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  return text.join("\n\n");
}
```

- [ ] **Step 6: `convex/sources.ts` — adding a link or an upload**

Change the imports at the top of `convex/sources.ts` to:
```ts
import { ConvexError, v } from "convex/values";
import { SOURCES_PER_DAY, dayStart, sourceBlocked } from "../lib/caps.ts";
import { UPLOAD_MAX_BYTES, passageFact, parseCitations, urlProblem } from "../lib/ingest.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, internalQuery, mutation } from "./_generated/server";
import { capExempt, requireMember, slackMember, visibleTo } from "./access";
import { factCapBlocked, insertFact } from "./facts";
```
Append:
```ts
/** An upload's id is accepted only this long after the file landed. */
const UPLOAD_WINDOW_MS = 60 * 60_000;

/**
 * SOURCES_PER_DAY, counted from every source this member added today, removed
 * ones included. Skipped for CAP_EXEMPT_HANDLES, like every per-member cap.
 */
async function assertCanAdd(ctx: MutationCtx, ownerId: Id<"users">) {
  const today = await ctx.db
    .query("sources")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId).gte("_creationTime", dayStart(Date.now())))
    .take(SOURCES_PER_DAY);
  const blocked = sourceBlocked(today.length, await capExempt(ctx, ownerId));
  if (blocked) throw new ConvexError(blocked);
}

/** A link a member pastes: a web page, plain text or markdown. Read in the background by documents.readUrl. */
export const addLink = mutation({
  args: { input: v.string(), private: v.boolean() },
  handler: async (ctx, a): Promise<Id<"sources">> => {
    const user = await requireMember(ctx);
    const problem = urlProblem(a.input);
    if (problem) throw new ConvexError(problem);
    const url = new URL(a.input.trim());
    const externalId = url.toString();
    // The member's own rows only: a match on someone else's private
    // document would tell them it exists.
    const mine = await ctx.db
      .query("sources")
      .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "document").eq("externalId", externalId))
      .take(50);
    if (mine.some((s) => s.ownerId === user._id && s.status !== "removed")) throw new ConvexError("You've already added that.");
    await assertCanAdd(ctx, user._id);
    const sourceId = await ctx.db.insert("sources", {
      kind: "document",
      label: `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`.slice(0, 120),
      url: externalId,
      externalId,
      ownerId: user._id,
      visibility: a.private ? "owner" : "public",
      status: "active",
    });
    await ctx.scheduler.runAfter(0, internal.documents.readUrl, { sourceId });
    return sourceId;
  },
});

/** Where the browser POSTs an upload. The day's cap is checked first, so a full day doesn't waste one. */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const user = await requireMember(ctx);
    await assertCanAdd(ctx, user._id);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * An uploaded markdown, text or PDF file, read in the background by
 * documents.readUpload. The storage id comes from the browser, so it's
 * checked, not trusted: the file landed in the last hour, is under 5 MB, and
 * no source has claimed it.
 * ponytail: an oversized file from a modified client stays in storage; the
 * cockpit never uploads one.
 */
export const addUpload = mutation({
  args: { storageId: v.id("_storage"), name: v.string(), private: v.boolean() },
  handler: async (ctx, a): Promise<Id<"sources">> => {
    const user = await requireMember(ctx);
    const externalId = `upload:${a.storageId}`;
    const file = await ctx.db.system.get("_storage", a.storageId);
    const claimed = await ctx.db
      .query("sources")
      .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "document").eq("externalId", externalId))
      .first();
    if (!file || claimed || Date.now() - file._creationTime > UPLOAD_WINDOW_MS) {
      throw new ConvexError("That upload expired. Upload it again.");
    }
    if (file.size > UPLOAD_MAX_BYTES) throw new ConvexError(`Keep uploads under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
    await assertCanAdd(ctx, user._id);
    const sourceId = await ctx.db.insert("sources", {
      kind: "document",
      label: a.name.trim().slice(0, 120) || "untitled",
      externalId,
      ownerId: user._id,
      visibility: a.private ? "owner" : "public",
      status: "active",
      storageId: a.storageId,
    });
    await ctx.scheduler.runAfter(0, internal.documents.readUpload, { sourceId });
    return sourceId;
  },
});
```

In `convex/access.ts`, `capExempt`'s comment lists the caps it skips; add sources/day to it: `… briefs/day, one-concurrent-intern, facts/day, sends/day, sources/day, connect-starts/hour. …`

- [ ] **Step 7: `convex/documents.ts`**

```ts
"use node";

import { v } from "convex/values";
import {
  IngestError,
  NO_TEXT_LAYER,
  UPLOAD_MAX_BYTES,
  chunk,
  decodeText,
  fetchDocument,
  hasTextLayer,
  htmlToText,
  isPdf,
  sourceError,
} from "../lib/ingest.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalAction } from "./_generated/server";

/**
 * Documents members add, read in Node: its fetch hands back a redirect's real
 * 3xx under `redirect: "manual"`, which fetchDocument's per-hop address check
 * depends on, and pdf.js runs here. No model calls.
 */

async function save(ctx: ActionCtx, sourceId: Id<"sources">, text: string, label?: string, url?: string) {
  const chunks = chunk(text);
  if (!chunks.length) throw new IngestError("There's no text in that to read.");
  const at = Date.now();
  await ctx.runMutation(internal.sources.write, {
    sourceId,
    label,
    passages: chunks.map((c, i) => ({ externalId: String(i), text: c, url, at })),
    synced: true,
  });
}

async function failed(ctx: ActionCtx, sourceId: Id<"sources">, err: unknown) {
  if (!(err instanceof IngestError)) console.log(`documents: ${sourceId} failed: ${err instanceof Error ? err.message : String(err)}`);
  await ctx.runMutation(internal.sources.fail, { sourceId, error: sourceError(err) });
}

export const readUrl = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    if (!src?.url || src.status === "removed") return null;
    try {
      const page = await fetchDocument(src.url);
      const doc = page.contentType === "text/html" ? htmlToText(page.text) : { title: null, text: page.text };
      await save(ctx, sourceId, doc.text, doc.title ?? undefined, page.url);
    } catch (err) {
      await failed(ctx, sourceId, err);
    }
    return null;
  },
});

export const readUpload = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    if (!src?.storageId || src.status === "removed") return null;
    try {
      const blob = await ctx.storage.get(src.storageId);
      if (!blob) throw new IngestError("That upload is gone. Upload it again.");
      if (blob.size > UPLOAD_MAX_BYTES) throw new IngestError(`Keep uploads under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text: string;
      if (isPdf(bytes)) {
        // Loaded only for a PDF, so reading text never pays for pdf.js.
        const { pdfText } = await import("../lib/pdf.ts");
        try {
          text = await pdfText(bytes);
        } catch {
          throw new IngestError("That PDF couldn't be read.");
        }
        if (!hasTextLayer(text)) throw new IngestError(NO_TEXT_LAYER);
      } else {
        text = decodeText(bytes);
      }
      await save(ctx, sourceId, text);
    } catch (err) {
      await failed(ctx, sourceId, err);
    }
    return null;
  },
});
```

Add `documents` to `convex/_generated/api.d.ts` by hand (after `connections`).

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm test && npx vitest run`
Expected: PASS. If convex-test refuses to load a `"use node"` module under `edge-runtime`, stop and report the exact error rather than moving the readers.

- [ ] **Step 9: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors. Bundling `convex/documents.ts` for Convex's Node runtime can only be checked by a deploy; the controller's deploy does it (Task 9 Step 6).

- [ ] **Step 10: Commit**

```bash
git add lib/ingest.ts lib/ingest.test.ts lib/pdf.ts lib/pdf.test.ts convex/sources.ts convex/access.ts convex/documents.ts convex/_generated/api.d.ts convex/ingest.test.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
Documents: links fetched safely and uploads (markdown, text, PDF) read into passages

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: GitHub repos, refreshed daily

**Files:**
- Create: `lib/github.ts`, `lib/github.test.ts`, `convex/crons.ts`
- Modify: `convex/sources.ts` (`addRepo`, `addLink`, `fail` gains `clear`, `repos`, new `setup`), `convex/ingest.ts` (`syncRepo`, `refreshRepos`), `convex/_generated/api.d.ts` (add `crons`), `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `chunk`, `CHUNK_MAX` (Task 1); `obj`, `str` (Task 4); `assertCanAdd`, `addLink` (Task 6); `internal.sources.write/get/fail`, `clearPassages`; `settle`, `setup` (Tasks 2, 6).
- Produces:
  ```ts
  // lib/github.ts
  export const GITHUB_API = "https://api.github.com", ISSUES_PER_REPO = 200, README_PASSAGES = 20, ISSUE_PAGE_SIZE = 100, ISSUE_PAGES = 2;
  export type RepoPath = { owner: string; repo: string };
  export function repoPath(input: string): RepoPath | null;
  export const githubHeaders: (token: string, accept?: string) => Record<string, string>;
  export const repoUrl, readmeUrl: (p: RepoPath) => string;  export const issuesUrl: (p: RepoPath, page: number) => string;
  export function readRepo(json: unknown): { fullName: string; htmlUrl: string; isPublic: boolean } | null;
  export type RepoPassage = { externalId: string; text: string; author?: string; url?: string; at: number };
  export function readIssues(json: unknown): RepoPassage[];
  export function readmePassages(markdown: string, htmlUrl: string, at: number): RepoPassage[];
  // convex/sources.ts
  internal.sources.fail({ sourceId, error, clear?: boolean })
  internal.sources.repos({}) => Id<"sources">[]
  api.sources.setup({}) => { github: boolean }   // the Slack invite is connections.mine's, not repeated here
  // convex/ingest.ts
  internal.ingest.syncRepo({ sourceId }) => null
  internal.ingest.refreshRepos({}) => null   // daily cron
  ```

- [ ] **Step 1: Confirm GitHub's endpoints against its docs**

Fetch each page and confirm; record differences in `lib/github.ts` and the Step 2 fixtures; put the date in its header.
1. `https://docs.github.com/en/rest/repos/repos#get-a-repository`: `GET /repos/{owner}/{repo}` returns `private` (boolean), `visibility`, `full_name`, `html_url`; a repo the token can't see is a 404.
2. `https://docs.github.com/en/rest/repos/contents#get-a-repository-readme`: `GET /repos/{owner}/{repo}/readme` with `Accept: application/vnd.github.raw+json` returns the raw file.
3. `https://docs.github.com/en/rest/issues/issues#list-repository-issues`: `state=all`, `sort=created`, `direction=desc`, `per_page` (max 100), `page`; pull requests are included and carry a `pull_request` key; each item has `number`, `title`, `body` (nullable), `html_url`, `created_at`, `user.login`.
4. `https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api`: 60 requests an hour unauthenticated, 5,000 with a token. `https://docs.github.com/en/rest/about-the-rest-api/api-versions`: `X-GitHub-Api-Version: 2022-11-28` is supported.

- [ ] **Step 2: Write the failing tests**

Create `lib/github.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { readIssues, readRepo, readmePassages, repoPath } from "./github.ts";

test("a repo is owner/repo or a github.com link to one", () => {
  assert.deepEqual(repoPath("acme/site"), { owner: "acme", repo: "site" });
  assert.deepEqual(repoPath(" https://github.com/acme/site.git "), { owner: "acme", repo: "site" });
  assert.deepEqual(repoPath("https://github.com/acme/site/"), { owner: "acme", repo: "site" });
  for (const bad of [
    "acme",
    "acme/site/issues",
    "https://example.com/acme/site",
    "https://github.com/acme/site/blob/main/README.md",
    "http://github.com/acme/site",
    "-acme/site",
    "acme/..",
  ]) {
    assert.equal(repoPath(bad), null, bad);
  }
});

test("a repo is public only when GitHub says so", () => {
  const repo = { full_name: "acme/site", html_url: "https://github.com/acme/site" };
  assert.deepEqual(readRepo({ ...repo, private: false, visibility: "public" }), { fullName: "acme/site", htmlUrl: "https://github.com/acme/site", isPublic: true });
  assert.equal(readRepo({ ...repo, private: true, visibility: "private" })?.isPublic, false);
  assert.equal(readRepo({ ...repo, private: false, visibility: "internal" })?.isPublic, false);
  assert.equal(readRepo({ ...repo })?.isPublic, false);
  assert.equal(readRepo({ message: "Not Found" }), null);
});

test("issues and PRs become one passage each", () => {
  assert.deepEqual(
    readIssues([
      { number: 2, title: "Add pricing page", body: "Per seat.", html_url: "https://github.com/acme/site/pull/2", created_at: "2026-09-20T10:00:00Z", user: { login: "ann" }, pull_request: {} },
      { number: 1, title: "Footer broken", body: null, html_url: "https://github.com/acme/site/issues/1", created_at: "2026-09-19T10:00:00Z", user: { login: "bo" } },
      { title: "no number" },
    ]),
    [
      { externalId: "pr:2", text: "PR #2: Add pricing page\n\nPer seat.", author: "ann", url: "https://github.com/acme/site/pull/2", at: Date.UTC(2026, 8, 20, 10) },
      { externalId: "issue:1", text: "Issue #1: Footer broken", author: "bo", url: "https://github.com/acme/site/issues/1", at: Date.UTC(2026, 8, 19, 10) },
    ],
  );
  assert.deepEqual(readIssues({ message: "Not Found" }), []);
});

test("a README is chunked, at most 20 passages, the first keyed `readme`", () => {
  assert.deepEqual(readmePassages("# Site\n\nThe marketing site.", "https://github.com/acme/site", 5), [
    { externalId: "readme", text: "# Site\n\nThe marketing site.", url: "https://github.com/acme/site#readme", at: 5 },
  ]);
  const long = readmePassages(Array(30).fill("x".repeat(900)).join("\n\n"), "https://github.com/acme/site", 5);
  assert.equal(long.length, 20);
  assert.equal(long[19].externalId, "readme:19");
});
```

Append to `convex/ingest.test.ts`:
```ts
// --- GitHub ------------------------------------------------------------------

/** GitHub's REST API for acme/site, shaped as docs.github.com shows it (Task 7 Step 1). */
function stubGithub(o: { private?: boolean } = {}) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.endsWith("/repos/acme/site/readme")) return new Response("# Site\n\nThe marketing site.");
    if (url.includes("/repos/acme/site/issues")) {
      return Response.json([
        {
          number: 2,
          title: "Add pricing page",
          body: "Per seat.",
          html_url: "https://github.com/acme/site/pull/2",
          created_at: "2026-09-20T10:00:00Z",
          user: { login: "ann" },
          pull_request: { url: "https://api.github.com/repos/acme/site/pulls/2" },
        },
        { number: 1, title: "Footer broken", body: null, html_url: "https://github.com/acme/site/issues/1", created_at: "2026-09-19T10:00:00Z", user: { login: "bo" } },
      ]);
    }
    if (url.endsWith("/repos/acme/site")) {
      return Response.json({
        full_name: "acme/site",
        html_url: "https://github.com/acme/site",
        private: !!o.private,
        visibility: o.private ? "private" : "public",
      });
    }
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

test("a public repo's README, issues and PRs become public passages, whatever 'keep private' said", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubGithub();
  const sourceId = await asUser(a).mutation(api.sources.addLink, { input: "https://github.com/acme/site", private: true });
  await settle(t);
  const rows = await allPassages(t);
  expect(rows.map((p) => p.externalId).sort()).toEqual(["issue:1", "pr:2", "readme"]);
  expect(rows.find((p) => p.externalId === "pr:2")).toMatchObject({
    text: "PR #2: Add pricing page\n\nPer seat.",
    author: "ann",
    visibility: "public",
    ownerId: a,
  });
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({
    kind: "github_repo",
    label: "acme/site",
    externalId: "acme/site",
    visibility: "public",
    status: "active",
  });
  expect(new Headers(f.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer github_pat_test");
});

test("a private repo is refused", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  stubGithub({ private: true });
  const sourceId = await asUser(a).mutation(api.sources.addLink, { input: "acme/site", private: false });
  await settle(t);
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({ status: "failed", error: "Only public repos can be added." });
  expect(await allPassages(t)).toHaveLength(0);
});

test("without a token GitHub isn't set up yet; with one, a repo is added once", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const add = (input: string) => asUser(a).mutation(api.sources.addLink, { input, private: false });
  await expect(add("acme/site")).rejects.toThrow(/not set up yet/);
  expect(await t.query(api.sources.setup, {})).toMatchObject({ github: false });
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  stubGithub();
  expect(await t.query(api.sources.setup, {})).toMatchObject({ github: true });
  await add("acme/site");
  await expect(add("ACME/Site")).rejects.toThrow(/already in the brain/);
  await settle(t);
});

test("the daily refresh reads every repo again", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedSource } = setup();
  await seedSource({ kind: "github_repo", label: "acme/site", externalId: "acme/site" });
  await seedSource({ kind: "github_repo", label: "acme/old", externalId: "acme/old", status: "removed" });
  const f = stubGithub();
  await t.action(internal.ingest.refreshRepos, {});
  await settle(t);
  expect(f.mock.calls.some(([url]) => url.endsWith("/repos/acme/site"))).toBe(true);
  expect(f.mock.calls.some(([url]) => url.includes("/repos/acme/old"))).toBe(false);
  expect(await allPassages(t)).toHaveLength(3);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test && npx vitest run convex/ingest.test.ts`
Expected: FAIL — `Cannot find module '.../lib/github.ts'`; `addLink` refuses `acme/site` as "That isn't a link."

- [ ] **Step 4: `lib/github.ts`**

```ts
import { CHUNK_MAX, chunk } from "./ingest.ts";
import { obj, str } from "./inbound.ts";

/**
 * Public GitHub repos, read with one fine-grained, read-only token: GitHub's
 * anonymous limit is 60 calls an hour, the token's 5,000. Endpoints and fields
 * confirmed against docs.github.com on YYYY-MM-DD (Task 7 Step 1):
 * /rest/repos/repos#get-a-repository, /rest/repos/contents#get-a-repository-readme,
 * /rest/issues/issues#list-repository-issues.
 */

export const GITHUB_API = "https://api.github.com";
export const ISSUES_PER_REPO = 200;
export const README_PASSAGES = 20;
export const ISSUE_PAGE_SIZE = 100;
export const ISSUE_PAGES = ISSUES_PER_REPO / ISSUE_PAGE_SIZE;

export type RepoPath = { owner: string; repo: string };

export const githubHeaders = (token: string, accept = "application/vnd.github+json") => ({
  accept,
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "intern-brain",
});

/** `owner/repo`, or a github.com link to one; nothing else. */
export function repoPath(input: string): RepoPath | null {
  const s = input
    .trim()
    .replace(/^https:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/);
  return m && m[2] !== "." && m[2] !== ".." ? { owner: m[1], repo: m[2] } : null;
}

export const repoUrl = (p: RepoPath) => `${GITHUB_API}/repos/${p.owner}/${p.repo}`;
export const readmeUrl = (p: RepoPath) => `${repoUrl(p)}/readme`;
/** Newest first. GitHub's issue list carries pull requests too. */
export const issuesUrl = (p: RepoPath, page: number) =>
  `${repoUrl(p)}/issues?state=all&sort=created&direction=desc&per_page=${ISSUE_PAGE_SIZE}&page=${page}`;

/** Public only when GitHub says `private: false` and, if it says, `visibility: "public"`. */
export function readRepo(json: unknown): { fullName: string; htmlUrl: string; isPublic: boolean } | null {
  const j = obj(json);
  const fullName = str(j.full_name);
  const htmlUrl = str(j.html_url);
  if (!fullName || !htmlUrl) return null;
  return { fullName, htmlUrl, isPublic: j.private === false && (j.visibility === undefined || j.visibility === "public") };
}

export type RepoPassage = { externalId: string; text: string; author?: string; url?: string; at: number };

/** Each issue or PR as one passage: `issue:N` / `pr:N`, title then body, cut to CHUNK_MAX. */
export function readIssues(json: unknown): RepoPassage[] {
  if (!Array.isArray(json)) return [];
  return json.map(obj).flatMap((i) => {
    const n = i.number;
    const title = str(i.title);
    const url = str(i.html_url);
    const at = Date.parse(str(i.created_at) ?? "");
    if (typeof n !== "number" || !title || !url || !Number.isFinite(at)) return [];
    const pr = !!i.pull_request;
    const text = `${pr ? "PR" : "Issue"} #${n}: ${title}\n\n${str(i.body) ?? ""}`.trim().slice(0, CHUNK_MAX);
    return [{ externalId: `${pr ? "pr" : "issue"}:${n}`, text, author: str(obj(i.user).login), url, at }];
  });
}

/** The README, chunked: `readme`, `readme:1`, … at most README_PASSAGES. */
export function readmePassages(markdown: string, htmlUrl: string, at: number): RepoPassage[] {
  return chunk(markdown.slice(0, 100_000))
    .slice(0, README_PASSAGES)
    .map((text, i) => ({ externalId: i ? `readme:${i}` : "readme", text, url: `${htmlUrl}#readme`, at }));
}
```

- [ ] **Step 5: `convex/sources.ts` — repos**

Add `import { type RepoPath, repoPath } from "../lib/github.ts";` to the imports.

Above `addLink`:
```ts
/** A public GitHub repo: public to everyone, one per repo across the community. Checked public each time it's read (ingest.syncRepo). */
async function addRepo(ctx: MutationCtx, ownerId: Id<"users">, p: RepoPath): Promise<Id<"sources">> {
  if (!process.env.GITHUB_TOKEN) throw new ConvexError("GitHub sources are not set up yet.");
  const externalId = `${p.owner}/${p.repo}`.toLowerCase();
  const rows = await ctx.db
    .query("sources")
    .withIndex("by_kind_and_externalId", (q) => q.eq("kind", "github_repo").eq("externalId", externalId))
    .take(20);
  if (rows.some((s) => s.status !== "removed")) throw new ConvexError("That repo is already in the brain.");
  await assertCanAdd(ctx, ownerId);
  const sourceId = await ctx.db.insert("sources", {
    kind: "github_repo",
    label: `${p.owner}/${p.repo}`,
    url: `https://github.com/${p.owner}/${p.repo}`,
    externalId,
    ownerId,
    visibility: "public",
    status: "active",
  });
  await ctx.scheduler.runAfter(0, internal.ingest.syncRepo, { sourceId });
  return sourceId;
}
```
In `addLink`, directly after `const user = await requireMember(ctx);`:
```ts
    // `owner/repo`, or a github.com link to one, is a repo; "keep private" doesn't apply.
    const repo = repoPath(a.input);
    if (repo) return await addRepo(ctx, user._id, repo);
```
and update its doc comment's first line to: `/** A link a member pastes: a public GitHub repo, a web page, plain text or markdown. Read in the background. */`

Replace `fail`:
```ts
/** A read that failed, with a reason the member can act on. `clear` also drops its passages (a repo gone private). */
export const fail = internalMutation({
  args: { sourceId: v.id("sources"), error: v.string(), clear: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const s = await ctx.db.get("sources", a.sourceId);
    if (!s || s.status === "removed") return null;
    if (a.clear) await clearPassages(ctx, s._id);
    await ctx.db.patch("sources", s._id, { status: "failed", error: a.error.slice(0, 200) });
    return null;
  },
});
```
Append:
```ts
/** Every repo the daily refresh reads again: active or failed, never removed. ponytail: first 500. */
export const repos = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"sources">[]> =>
    (await ctx.db.query("sources").withIndex("by_kind_and_externalId", (q) => q.eq("kind", "github_repo")).take(500))
      .filter((s) => s.status !== "removed")
      .map((s) => s._id),
});
```
Change the server import to `import { type MutationCtx, internalMutation, internalQuery, mutation, query } from "./_generated/server";` and append:
```ts
/** What this deployment can read, for the rail. Never a secret: only whether it's on. */
export const setup = query({
  args: {},
  handler: async () => ({ github: !!process.env.GITHUB_TOKEN }),
});
```

- [ ] **Step 6: `convex/ingest.ts` — sync and refresh**

Add to the imports:
```ts
import { ISSUE_PAGES, ISSUE_PAGE_SIZE, githubHeaders, issuesUrl, readIssues, readRepo, readmePassages, readmeUrl, repoPath, repoUrl } from "../lib/github.ts";
```
Append:
```ts
/**
 * A repo's README and its latest 200 issues and PRs, one passage each.
 * Checked public on every read: one that has gone private since is failed
 * and its passages cleared.
 */
export const syncRepo = internalAction({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const src: Doc<"sources"> | null = await ctx.runQuery(internal.sources.get, { sourceId });
    const path = src ? repoPath(src.externalId) : null;
    if (!src || src.kind !== "github_repo" || src.status === "removed" || !path) return null;
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      await ctx.runMutation(internal.sources.fail, { sourceId, error: "GitHub sources are not set up yet." });
      return null;
    }
    try {
      const get = (url: string, accept?: string) => fetch(url, { headers: githubHeaders(token, accept) });
      const repoRes = await get(repoUrl(path));
      // A private repo the token can't see is a 404, which reads the same way.
      const repo = repoRes.ok ? readRepo(await repoRes.json()) : null;
      if (!repo?.isPublic) {
        await ctx.runMutation(internal.sources.fail, { sourceId, error: "Only public repos can be added.", clear: true });
        return null;
      }
      const readmeRes = await get(readmeUrl(path), "application/vnd.github.raw+json");
      const passages = readmeRes.ok ? readmePassages(await readmeRes.text(), repo.htmlUrl, Date.now()) : [];
      for (let page = 1; page <= ISSUE_PAGES; page++) {
        const res = await get(issuesUrl(path, page));
        if (!res.ok) throw new Error(`issues page ${page}: ${res.status}`);
        const rows: unknown = await res.json();
        passages.push(...readIssues(rows));
        if (!Array.isArray(rows) || rows.length < ISSUE_PAGE_SIZE) break;
      }
      await ctx.runMutation(internal.sources.write, { sourceId, label: repo.fullName, passages, synced: true });
    } catch (err) {
      console.log(`github: ${src.externalId} failed: ${errText(err)}`);
      await ctx.runMutation(internal.sources.fail, { sourceId, error: "Couldn't read this repo from GitHub." });
    }
    return null;
  },
});

/** Daily, from crons.ts: every repo read again, ten seconds apart (four calls each, far under 5,000 an hour). */
export const refreshRepos = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!process.env.GITHUB_TOKEN) return null;
    const ids: Id<"sources">[] = await ctx.runQuery(internal.sources.repos, {});
    for (const [i, sourceId] of ids.entries()) await ctx.scheduler.runAfter(i * 10_000, internal.ingest.syncRepo, { sourceId });
    return null;
  },
});
```

- [ ] **Step 7: `convex/crons.ts`**

```ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// GitHub sources are read again once a day. Slack arrives live and needs no cron.
crons.interval("refresh github sources", { hours: 24 }, internal.ingest.refreshRepos, {});

export default crons;
```

Add `crons` to `convex/_generated/api.d.ts` by hand (after `connections`, before `documents`).

- [ ] **Step 8: Run the tests to see them pass**

Run: `npm test && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 10: Commit**

```bash
git add lib/github.ts lib/github.test.ts convex/sources.ts convex/ingest.ts convex/crons.ts convex/_generated/api.d.ts convex/ingest.test.ts
git commit -m "$(cat <<'EOF'
GitHub sources: public repos' README, issues and PRs, refreshed daily

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---
### Task 8: The UI — add a source, a source's passages, member pages, the feed and broadcast line

**Files:**
- Create: `components/Sources.tsx`
- Modify: `lib/broadcast.ts`, `lib/broadcast.test.ts`, `convex/sources.ts` (imports; `write` announces; `passages` query), `convex/facts.ts` (`graph`), `convex/community.ts` (`feed`, `member`), `components/BrainRail.tsx`, `components/MemberPage.tsx`, `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `api.sources.addLink/uploadUrl/addUpload/setup/promote/remove` (Tasks 3, 6, 7); `UPLOAD_MAX_BYTES`, `PASSAGE_EXCERPT` (Task 1); `broadcast()` (`convex/broadcast.ts`), `ownerView`, `visibleTo`, `redactEmails` (existing); the graph's `person`, `rootOf` and `src:seed` node (`convex/facts.ts`, existing); `settle`, `setup` (Tasks 2, 6).
- Produces:
  ```ts
  // lib/broadcast.ts
  BroadcastEvent gains { type: "added_source"; handle: string; label: string };
  export const stripLinks: (s: string) => string; // was the private `cut`
  // convex/sources.ts
  api.sources.passages({ sourceId }) => null | { label; kind; url: string | null; status; error: string | null; syncedAt: number | null; mine: boolean;
    passages: { _id: Id<"passages">; text: string; author: string | null; at: number; url: string | null; promoted: boolean }[] }
  // convex/facts.ts graph: node `src:<sourceId>` (kind "source") per visible source; edges `added` (member → source), `from` (source → promoted fact)
  // convex/community.ts member: + sources: { _id; label; kind; url: string | null; at }[]
  // components/Sources.tsx — each shows its own status line; no props into the cockpit's log
  export function AddSource(): JSX.Element;
  export function SourcePanel(p: { sourceId: Id<"sources"> }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `lib/broadcast.test.ts`:
```ts
test("adding a public source is one line, its label's links stripped", () => {
  assert.equal(
    broadcastText({ type: "added_source", handle: "ann", label: "acme/site" }, SITE),
    "@ann added a source: acme/site · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "added_source", handle: "ann", label: "Notes from https://evil.test/x" }, SITE),
    "@ann added a source: Notes from [link] · https://intern-brain.vercel.app/u/ann",
  );
});
```

Append to `convex/ingest.test.ts`:
```ts
// --- graph, rail, pages, feed, broadcast ---------------------------------------

test("a source is one node; facts promoted from it hang off it; a private one shows only to its owner", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const channel = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1" });
  const p = await seedPassage(channel, "We ship on Fridays");
  await seedPassage(channel, "not promoted, never drawn");
  await asUser(a).mutation(api.sources.promote, { passageId: p });
  const factId = (await allFacts(t))[0]._id;
  // A 🧠 from someone who isn't a member: nobody owns the fact, and it still hangs off its source, not "starter facts".
  const q = await seedPassage(channel, "QA is Thursday");
  const orphan = await t.run((ctx) =>
    ctx.db.insert("facts", { title: "QA is Thursday", body: "QA is Thursday", kind: "note", fromPassageId: q, text: "QA is Thursday\nQA is Thursday" }),
  );
  const secret = await seedSource({ label: "A's deal notes for ann@acme.com", ownerId: a, visibility: "owner" });

  const theirs = await asUser(b).query(api.facts.graph, {});
  expect(theirs.nodes.filter((n) => n.kind === "source").map((n) => n.label)).toEqual(["#general"]);
  expect(theirs.edges).toContainEqual({ source: `src:${channel}`, target: factId, rel: "from" });
  expect(theirs.edges).toContainEqual({ source: `src:${channel}`, target: orphan, rel: "from" });
  expect(JSON.stringify(theirs)).not.toMatch(/never drawn|deal notes/);

  const mine = await asUser(a).query(api.facts.graph, {});
  expect(mine.nodes.find((n) => n.id === `src:${secret}`)?.label).toBe("A's deal notes for [email]");
  expect(mine.edges).toContainEqual({ source: `user:${a}`, target: `src:${secret}`, rel: "added" });
});

test("a source's passages are listed for whoever can see them, redacted and cut to 400 characters", async () => {
  const { seedUser, asUser, seedSource, seedPassage } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const doc = await seedSource({ label: "A's notes", ownerId: a, visibility: "owner", lastSyncedAt: Date.UTC(2026, 8, 24) });
  const p = await seedPassage(doc, `mail ann@acme.com ${"x".repeat(600)}`, { ownerId: a, visibility: "owner" });
  expect(await asUser(b).query(api.sources.passages, { sourceId: doc })).toBeNull();
  const view = await asUser(a).query(api.sources.passages, { sourceId: doc });
  expect(view).toMatchObject({ label: "A's notes", mine: true, status: "active", syncedAt: Date.UTC(2026, 8, 24) });
  expect(view?.passages).toEqual([
    { _id: p, text: `mail [email] ${"x".repeat(387)}`, author: null, at: Date.UTC(2026, 8, 18), url: null, promoted: false },
  ]);
});

test("member pages list public sources; the feed says who added one, once it's read", async () => {
  const { t, seedUser, seedSource } = setup();
  const a = await seedUser("ann");
  await seedSource({ label: "Handbook", ownerId: a, url: "https://example.com/handbook", lastSyncedAt: Date.now() });
  await seedSource({ label: "Deal notes", ownerId: a, visibility: "owner", lastSyncedAt: Date.now() });
  await seedSource({ label: "Gone", ownerId: a, status: "removed", lastSyncedAt: Date.now() });
  await seedSource({ label: "Still reading", ownerId: a });

  const m = await t.query(api.community.member, { handle: "ann" });
  expect(m?.sources.map((s) => s.label).sort()).toEqual(["Handbook", "Still reading"]);
  expect(JSON.stringify(m)).not.toMatch(/Deal notes/);
  const feed = (await t.query(api.community.feed, {})).map((e) => e.text);
  expect(feed).toContain("added a source: Handbook");
  expect(feed.join("\n")).not.toMatch(/Deal notes|Gone|Still reading/);
});

test("the first read of a public source is announced once; a private one never", async () => {
  vi.stubEnv("BROADCAST_SLACK_WEBHOOK_URL", "https://hooks.slack.test/T1/B1/x");
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(""));
  vi.stubGlobal("fetch", f);
  const { t, seedUser, seedSource } = setup();
  const a = await seedUser("a");
  const pub = await seedSource({ ownerId: a });
  const priv = await seedSource({ ownerId: a, visibility: "owner" });
  const count = async () => (await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count ?? 0;

  await t.mutation(internal.sources.write, { sourceId: priv, passages: [], label: "Deal notes", synced: true });
  expect(await count()).toBe(0);
  await t.mutation(internal.sources.write, { sourceId: pub, passages: [], label: "Handbook", synced: true });
  await t.mutation(internal.sources.write, { sourceId: pub, passages: [], synced: true });
  expect(await count()).toBe(1);
  await settle(t);
  expect(JSON.parse(String(f.mock.calls[0][1]?.body)).text).toMatch(/^@a added a source: Handbook · /);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test && npx vitest run convex/ingest.test.ts`
Expected: FAIL — `added_source` renders as a Slack post; `api.sources.passages` is undefined; the graph has no source nodes (and the ownerless promoted fact hangs off `src:seed`); `m.sources` is undefined.

- [ ] **Step 3: `lib/broadcast.ts`**

Add to `BroadcastEvent`:
```ts
  | { type: "added_source"; handle: string; label: string }
```
Rename `cut` to an export (its comment stays):
```ts
export const stripLinks = (s: string) => s.replace(/(?:https?:\/\/|www\.)\S+/gi, "[link]").slice(0, 120);
```
and replace `broadcastText`'s `what`:
```ts
  const what =
    e.type === "joined"
      ? " joined the brain"
      : e.type === "taught"
        ? ` taught the brain: ${stripLinks(e.title)}`
        : e.type === "learned"
          ? ` corrected a draft and the brain learned: ${stripLinks(e.title)}`
          : e.type === "added_source"
            ? ` added a source: ${stripLinks(e.label)}`
            : e.type === "drafted"
              ? `'s intern finished with ${e.kind === "email" ? "an email" : `a ${e.kind}`} draft`
              : e.connector === "gmail"
                ? " sent an email"
                : " posted in Slack";
```

- [ ] **Step 4: `convex/sources.ts` — the announcement and the rail's listing**

Replace the import block with:
```ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { SOURCES_PER_DAY, dayStart, sourceBlocked } from "../lib/caps.ts";
import { type RepoPath, repoPath } from "../lib/github.ts";
import { PASSAGE_EXCERPT, UPLOAD_MAX_BYTES, passageFact, parseCitations, urlProblem } from "../lib/ingest.ts";
import { redactEmails } from "../lib/redact.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { capExempt, ownerView, requireMember, slackMember, visibleTo } from "./access";
import { broadcast } from "./broadcast";
import { factCapBlocked, insertFact } from "./facts";
```
In `write`, directly before the closing `await ctx.db.patch("sources", s._id, { … })`:
```ts
    // A member's public source is announced on its first read, under the
    // label it has by then (a page's title). Private ones never are.
    if (a.synced && !s.lastSyncedAt && s.ownerId && s.visibility === "public") {
      await broadcast(ctx, {
        type: "added_source",
        handle: (await ownerView(ctx, s.ownerId)).handle,
        label: redactEmails(a.label ?? s.label),
      });
    }
```
Append:
```ts
/**
 * A source node's recent passages, for the rail: newest 20, each redacted
 * (like every graph label) and cut to PASSAGE_EXCERPT, promotable. The id
 * comes from the client, so the source and every passage go through `visibleTo`.
 */
export const passages = query({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, { sourceId }) => {
    const viewer = await getAuthUserId(ctx);
    const s = await ctx.db.get("sources", sourceId);
    if (!s || s.status === "removed" || !visibleTo(s, viewer)) return null;
    const rows = (
      await ctx.db
        .query("passages")
        .withIndex("by_sourceId_and_at", (q) => q.eq("sourceId", sourceId))
        .order("desc")
        .take(20)
    ).filter((p) => visibleTo(p, viewer));
    return {
      label: redactEmails(s.label),
      kind: s.kind,
      url: s.url ?? null,
      status: s.status,
      error: s.error ?? null,
      syncedAt: s.lastSyncedAt ?? null,
      mine: viewer !== null && s.ownerId === viewer,
      passages: rows.map((p) => ({
        _id: p._id,
        // Redacted before the cut, so an address split at the edge can't slip through half-shown.
        text: redactEmails(p.text).slice(0, PASSAGE_EXCERPT),
        author: p.authorHandle ? `@${p.authorHandle}` : (p.author ?? null),
        at: p.at,
        url: p.url ?? null,
        promoted: !!p.promotedFactId,
      })),
    };
  },
});
```

- [ ] **Step 5: The graph**

In `convex/facts.ts` `graph`, the doc comment's ponytail becomes:
```ts
 * ponytail: newest 400 facts / 60 interns / 60 drafts / 60 sources. A
 * promoted fact whose source fell outside the 60 hangs off whoever promoted
 * it, or nothing. Paginate if the community outgrows one screen.
```
Read sources next to the others, after `const actions = …`:
```ts
    const sources = (await ctx.db.query("sources").order("desc").take(60)).filter((s) => s.status !== "removed" && visibleTo(s, viewer));
```
Between the interns loop (the one that ends `edges.push({ source: await person(root.ownerId), target: rootId, rel: "briefed" });`) and `for (const f of facts) {`:
```ts
    // One node per source; passages are never drawn. A private document
    // shows only to its owner. Labels are redacted like every other.
    for (const s of sources) {
      const key = `src:${s._id}`;
      nodes.set(key, {
        id: key,
        label: redactEmails(s.label).slice(0, 56),
        kind: "source",
        weight: 6,
        detail: `${s.kind.replace("_", " ")} · ${s.status}`,
      });
      if (s.ownerId) edges.push({ source: await person(s.ownerId), target: key, rel: "added" });
    }
```
In the facts loop, replace
```ts
      const filer = f.internId && rootOf(f.internId);
      if (filer) edges.push({ source: filer, target: f._id, rel: "filed" });
      else if (f.ownerId) edges.push({ source: await person(f.ownerId), target: f._id, rel: "taught" });
      else {
        nodes.set("src:seed", { id: "src:seed", label: "starter facts", kind: "source", weight: 6 });
        edges.push({ source: "src:seed", target: f._id, rel: "seeded" });
      }
```
with
```ts
      // A promoted fact hangs off its source while that's on the map, else
      // off whoever promoted it. Only a fact nobody filed, taught or promoted
      // is a starter fact: an ownerless 🧠 fact whose passage is gone floats.
      const from = f.fromPassageId ? await ctx.db.get("passages", f.fromPassageId) : null;
      const src = from ? `src:${from.sourceId}` : null;
      const filer = f.internId && rootOf(f.internId);
      if (src && nodes.has(src)) edges.push({ source: src, target: f._id, rel: "from" });
      else if (filer) edges.push({ source: filer, target: f._id, rel: "filed" });
      else if (f.ownerId) edges.push({ source: await person(f.ownerId), target: f._id, rel: "taught" });
      else if (!f.fromPassageId) {
        nodes.set("src:seed", { id: "src:seed", label: "starter facts", kind: "source", weight: 6 });
        edges.push({ source: "src:seed", target: f._id, rel: "seeded" });
      }
```

- [ ] **Step 6: Feed and member page**

In `convex/community.ts`, add `import { stripLinks } from "../lib/broadcast.ts";`.

`feed`: add a fifth read to the `Promise.all` and its destructuring (`const [interns, facts, approved, sent, sources] = …`):
```ts
      ctx.db.query("sources").order("desc").take(15),
```
and a fourth spread in `events`, after the facts one:
```ts
      // A member's public source, once it has been read: the line the broadcast posts.
      ...sources.flatMap((s) =>
        s.ownerId && s.visibility === "public" && s.status !== "removed" && s.lastSyncedAt
          ? [{ at: s.lastSyncedAt, ownerId: s.ownerId, text: `added a source: ${redactEmails(stripLinks(s.label))}` }]
          : [],
      ),
```

`member`: add a fourth read (`const [facts, interns, actions, sources] = …`):
```ts
      ctx.db.query("sources").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).order("desc").take(50),
```
and to the returned object:
```ts
      sources: sources
        .filter((s) => s.visibility === "public" && s.status !== "removed")
        .map((s) => ({ _id: s._id, label: redactEmails(s.label), kind: s.kind, url: s.url ?? null, at: s._creationTime })),
```
Add to its doc comment: `Sources: public, not removed; a private document never shows.`

- [ ] **Step 7: `components/Sources.tsx`**

```tsx
"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { UPLOAD_MAX_BYTES } from "@/lib/ingest";

/**
 * The rail's sources: adding one, and a source node's passages. Each shows
 * its own status line rather than echoing to the log, which is a tab behind
 * the graph the member is looking at.
 */

/** A ConvexError's message is the reason to show; anything else is a bug. Same rule as the cockpit's `why`. */
const why = (err: unknown) =>
  err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err);

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

type Note = { ok: boolean; text: string } | null;

const NoteLine = ({ note }: { note: Note }) =>
  note ? (
    <p role="status" className={`leading-snug ${note.ok ? "text-dim" : "text-err"}`}>
      {note.text}
    </p>
  ) : null;

/**
 * "Add a source": a link (a page, a text or markdown file, or a public
 * GitHub repo as owner/repo) or an upload. The server decides what a link
 * is and reads it in the background; its node appears when it's done.
 */
export function AddSource() {
  const setup = useQuery(api.sources.setup, {});
  const addLink = useMutation(api.sources.addLink);
  const uploadUrl = useMutation(api.sources.uploadUrl);
  const addUpload = useMutation(api.sources.addUpload);
  const [link, setLink] = useState("");
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const file = useRef<HTMLInputElement>(null);

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await work() });
      setLink("");
    } catch (err) {
      setNote({ ok: false, text: why(err) });
    } finally {
      setBusy(false);
    }
  };

  const submitLink = () =>
    run(async () => {
      const input = link.trim();
      await addLink({ input, private: keepPrivate });
      return `reading ${input}…`;
    });

  const upload = (f: File) =>
    run(async () => {
      if (f.size > UPLOAD_MAX_BYTES) throw new Error(`Keep uploads under ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
      const res = await fetch(await uploadUrl({}), {
        method: "POST",
        headers: { "content-type": f.type || "application/octet-stream" },
        body: f,
      });
      if (!res.ok) throw new Error("The upload didn't go through. Try again.");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await addUpload({ storageId, name: f.name, private: keepPrivate });
      return `reading ${f.name}…`;
    });

  return (
    <div className="space-y-1.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (link.trim()) void submitLink();
        }}
        className="flex gap-1"
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder={setup?.github ? "https://… or owner/repo" : "https://…"}
          aria-label="link to add"
          spellCheck={false}
          className="min-w-0 flex-1 border border-line bg-transparent px-1.5 py-0.5 placeholder:text-faint/70"
        />
        <button
          type="submit"
          disabled={busy || !link.trim()}
          className="border border-line px-1.5 text-dim hover:border-line-2 hover:text-fg disabled:opacity-40"
        >
          add
        </button>
      </form>
      <div className="flex items-center gap-2 text-faint">
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="hover:text-fg disabled:opacity-40">
          upload .md .txt .pdf
        </button>
        <input
          ref={file}
          type="file"
          accept=".md,.markdown,.txt,.pdf,text/markdown,text/plain,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <label className="ml-auto flex items-center gap-1" title="documents only; repos are always public">
          <input type="checkbox" checked={keepPrivate} onChange={(e) => setKeepPrivate(e.target.checked)} />
          keep private
        </label>
      </div>
      {setup && !setup.github ? <p className="text-faint">github repos: not set up yet</p> : null}
      <NoteLine note={note} />
    </div>
  );
}

/** A source node's recent passages, each promotable to a fact. Passages are never drawn; this is where a person sees them. */
export function SourcePanel({ sourceId }: { sourceId: Id<"sources"> }) {
  const s = useQuery(api.sources.passages, { sourceId });
  const promote = useMutation(api.sources.promote);
  const remove = useMutation(api.sources.remove);
  const [note, setNote] = useState<Note>(null);
  const fail = (err: unknown) => setNote({ ok: false, text: why(err) });

  if (s === undefined) return <p className="text-faint">loading…</p>;
  if (s === null) return <p className="text-faint">this source is gone.</p>;

  const removeIt = () => {
    if (window.confirm(`Remove ${s.label}? Its passages go; facts already promoted from it stay.`)) {
      void remove({ sourceId }).catch(fail);
    }
  };

  return (
    <div className="space-y-1.5 pt-1">
      <p className="text-faint">
        {s.status === "failed" ? (
          <span className="text-err">failed: {s.error ?? "couldn't read it"}</span>
        ) : s.syncedAt ? (
          `read ${day(s.syncedAt)}`
        ) : (
          "reading…"
        )}
        {s.mine ? (
          <>
            {" · "}
            <button type="button" onClick={removeIt} className="hover:text-err">
              remove
            </button>
          </>
        ) : null}
      </p>
      <NoteLine note={note} />
      <p className="label">passages · {s.passages.length}</p>
      {s.passages.map((p) => (
        <div key={p._id} className="border-b border-line/50 pb-1.5">
          <p className="text-faint">{[p.author, day(p.at)].filter(Boolean).join(" · ")}</p>
          <p className="whitespace-pre-line break-words leading-snug text-dim">{p.text}</p>
          {p.promoted ? (
            <span className="text-faint">promoted</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNote(null);
                void promote({ passageId: p._id }).catch(fail);
              }}
              className="text-accent hover:underline"
            >
              promote
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Mount both in the rail**

In `components/BrainRail.tsx`, add the imports:
```tsx
import type { Id } from "@/convex/_generated/dataModel";
import { AddSource, SourcePanel } from "./Sources";
```
Its props don't change. After the `accounts` section (the `</Section>` closing `<Section title="accounts">`), before `<Section title="layers">`:
```tsx
      <Section title="add a source">
        <AddSource />
      </Section>
```
and in the node section, directly after the `selected.meta ? … : null` block (before `neighbours.length ? …`):
```tsx
              {selected.kind === "source" && selected.id.startsWith("src:") && selected.id !== "src:seed" ? (
                <SourcePanel sourceId={selected.id.slice(4) as Id<"sources">} />
              ) : null}
```
`components/Cockpit.tsx` is not touched: `BrainRail`'s props are unchanged, and the Slack invite stays in the accounts rows it already renders.

- [ ] **Step 9: Member page**

In `components/MemberPage.tsx`, add above `export default`:
```tsx
const KIND_WORD = { slack_channel: "channel", document: "document", github_repo: "repo" } as const;
```
and after the "taught the brain" list (before `<p className="label mt-10">interns</p>`):
```tsx
            <p className="label mt-10">added sources</p>
            {m.sources.length ? (
              <ul className="mt-3">
                {m.sources.map((s) => (
                  <li key={s._id} className="flex items-start gap-2 border-b border-line/50 py-1.5">
                    <span className="mt-0.5">
                      <KindGlyph kind="source" size={11} />
                    </span>
                    <span className="min-w-0 text-dim">
                      <span className="text-faint">{KIND_WORD[s.kind]} · </span>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="nofollow noopener noreferrer" className="hover:underline">
                          {s.label}
                        </a>
                      ) : (
                        s.label
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-faint">none yet.</p>
            )}
```

- [ ] **Step 10: Run the tests to see them pass**

Run: `npm test && npx vitest run`
Expected: PASS, including the existing graph (resume chains, cancelled chains, redacted labels, starter facts), feed and member-page tests in `convex/surfaces.test.ts`.

- [ ] **Step 11: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass; lint 0 errors.

- [ ] **Step 12: Look at it**

Run `npm run dev` against a local or fresh dev deployment (see HANDOVER's checklist; never the old `graceful-albatross-202` data) only if the controller has one up; otherwise skip and say so. In the cockpit, on the brain tab: the rail shows "add a source" under accounts; adding `https://example.com` shows `reading https://example.com…` under the form and a source node appears; clicking it lists its passages, each with **promote**; **promote** turns into "promoted" and a fact hangs off the node. A sixth source that day shows the cap message under the form.

- [ ] **Step 13: Commit**

```bash
git add lib/broadcast.ts lib/broadcast.test.ts convex/sources.ts convex/facts.ts convex/community.ts convex/ingest.test.ts components/Sources.tsx components/BrainRail.tsx components/MemberPage.tsx
git commit -m "$(cat <<'EOF'
Sources in the UI: add a source, a source's passages with promote, member pages, feed and broadcast line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The seeded "What Intern is", and setup handoff in HANDOVER.md

**The only code here is one sentence of seed text.** The implementer confirms the external details (Step 1), fixes the seed (Step 2) and writes the HANDOVER section (Step 3) verbatim, with the confirmed values; every step in it marked (Mihir) is his to do with his own accounts. No `npx convex …` command is run by an agent.

**Files:**
- Modify: `convex/seed.ts` (one sentence of "What Intern is"), `HANDOVER.md` (append a section at the end, after "Community surfaces: setup" and its "Admin")

**Interfaces:**
- Consumes: every env var, route and admin function named in Tasks 1–8: new `SLACK_BRAIN_BOT_TOKEN`, `SLACK_BRAIN_SIGNING_SECRET`, `GITHUB_TOKEN`; existing `COMMUNITY_SLACK_TEAM_ID`, `COMMUNITY_SLACK_INVITE_URL` (set up under "Community Slack" in HANDOVER); `POST /slack/events`; `ingest:backfillSlack`; the `refresh github sources` cron; `convex/documents.ts` (`"use node"`, `unpdf`).
- Produces: the seed sentence and the HANDOVER section below.

- [ ] **Step 1: Confirm the setup details against the official pages**

1. `https://docs.slack.dev/reference/app-manifest`: the manifest keys used below (`display_information.name`, `features.bot_user.display_name`, `oauth_config.scopes.bot`, `settings.event_subscriptions.request_url`, `settings.event_subscriptions.bot_events`, `settings.org_deploy_enabled`, `settings.socket_mode_enabled`, `settings.token_rotation_enabled`), and that saving a `request_url` makes Slack send a `url_verification` to it.
2. `https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token`: the "Public repositories" repository-access option (read-only access to public repos, no extra permissions), and the expiry choices.
3. `https://docs.convex.dev/functions/bundling`: `node.externalPackages` in `convex.json`.

(The workspace id and the never-expiring invite link are already documented under "Community Slack" in HANDOVER, and both vars are set on prod.) Correct the section below wherever a page says otherwise.

- [ ] **Step 2: The seeded "What Intern is" stops saying this is the next step**

In `convex/seed.ts`, in the first `SEED` entry's `body`, replace the sentence
```
Feeding it continuously from Slack and documents is the next step, not something it does today.
```
with
```
It also reads the community Slack's public channels, documents members add and public GitHub repos into a searchable archive interns recall from; a person promotes a passage into a fact.
```
Nothing else in `seed.ts` changes. `seed:run` skips a deployment that already has ownerless facts, so prod's row is patched by hand (HANDOVER section 3, step 5).

- [ ] **Step 3: Append the section**

Append to the end of `HANDOVER.md`:

````markdown
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

All Convex env vars (`npx convex env set [--prod] NAME value`), never
Vercel. Each is optional; unset means that part is off.

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
   (`SLACK_BRAIN_SIGNING_SECRET`).
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

`github.com/settings/personal-access-tokens/new` → name `intern-brain-read`
→ expiration: the longest allowed (put the renewal in the calendar) →
Resource owner: your account → Repository access: **Public repositories**
(read-only) → no permissions → Generate. That's `GITHUB_TOKEN`: one token
for the whole community, because GitHub's anonymous limit is 60 calls an
hour. When it expires, every repo's next daily read fails with "Couldn't read
this repo from GitHub." until it's replaced.

### 3. Deploy and set env (needs Mihir's go-ahead)

1. `npx convex deploy` (prod). The schema is additive (`sources`,
   `passages`, `slackUsers`, `facts.fromPassageId`,
   `connections.by_externalUserId`), so it's safe before the frontend. It's
   also the first bundle of `convex/documents.ts` (`"use node"`, `unpdf`): if
   the bundler rejects `unpdf`, add `{ "node": { "externalPackages": ["unpdf"] } }`
   to `convex.json` and deploy again. The brief's `PROMPT_VERSION` changes
   with this deploy (the archive section), so `/stats` starts a new series.
2. Set the three new vars with `--prod` (the two `COMMUNITY_SLACK_*` ones
   are already there):
   ```bash
   npx convex env set --prod SLACK_BRAIN_SIGNING_SECRET <signing secret>
   npx convex env set --prod SLACK_BRAIN_BOT_TOKEN <xoxb-…>
   npx convex env set --prod GITHUB_TOKEN <github_pat_…>
   ```
3. Then Event Subscriptions (section 1, step 3).
4. Merge to `main`; Vercel deploys the cockpit.
5. **Patch the seeded "What Intern is" fact.** `seed:run` never re-runs on a
   deployment that has starter facts, so prod still says Slack and document
   feeding "is the next step". Prod dashboard → Data → `facts` → the row
   titled "What Intern is" → in **both** `body` and `text`, replace
   "Feeding it continuously from Slack and documents is the next step, not
   something it does today." with the sentence now in `convex/seed.ts`.

### 4. Backfill (Mihir, from the Convex dashboard)

Prod dashboard → Functions → `ingest:backfillSlack` → Run with `{}`. It
returns `{ channels: N }`, joins each public channel, and reads its last 90
days one page every 1.5 s, one channel after another; the logs show
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
````

- [ ] **Step 4: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit -p convex && npx tsc --noEmit && npm run build && npm run lint`
Expected: all pass (one seed string and markdown changed).

- [ ] **Step 5: Commit**

```bash
git add convex/seed.ts HANDOVER.md
git commit -m "$(cat <<'EOF'
Handover: ingestion setup (Intern Brain Slack app, new env, GitHub token, backfill); seed says what the brain reads now

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (redone at the refresh against `main` @ `1238905`)

- **Spec coverage:**
  - Frame, sources/sinks, the three sources: Tasks 4–7
  - Data (`sources`, `passages` with `search_text` and its filter fields, `facts.fromPassageId`): Task 2; `slackUsers`, `connections.by_externalUserId`, `sources.storageId`: Tasks 2, 4 (Decisions 6, 7)
  - Recall (6 passages, public + own private, merged and deduped), "FROM THE ARCHIVE" line format, `[p:…]` in `sources` only (the brief's rule for fact ids, `stripCites` for leaks), the ABOUT line, `PROMPT_VERSION`: Task 2
  - Promotion: automatic on approval, from the action's `sources` only (visibility rule, idempotent, no model call) Task 3; 🧠 Task 4; promote button with `visibleTo` and the 20/day cap Tasks 3, 8
  - Community Slack: separate app, scopes, signature (constant time, 5 minutes, 401 before parsing), `url_verification`, team filter, `message.channels`/`reaction_added`, new/changed/deleted/🧠, bots/joins/leaves/non-`channel` ignored: Task 4; backfill (admin-run, 90 days, rate limits, cursor): Task 5; authors: Task 4; joining step: Task 5 (the rail link and the https check were already on `main`, `connections.mine`'s `invite`); team filter reuses the existing `COMMUNITY_SLACK_TEAM_ID`; the workspace notice: Task 9
  - Documents: add-a-source panel and keep-private Task 8; URL safety, timeout, cap, types, HTML reduction Task 1; uploads, PDF library confirmed in Step 1, scanned refusal, chunking, 5/day, removal keeps promoted facts: Tasks 3, 6
  - GitHub: public check, README + latest 200 issues/PRs, daily `crons.interval`, token, "not set up yet": Task 7
  - Graph and pages: source nodes and `from` edges (fitting `main`'s resume-chain collapse, redacted labels and `src:seed`), member pages, feed and broadcast line with links stripped: Task 8
  - Privacy and abuse: visibility per source, deleted-in-Slack, purge with files, readers apply `visibleTo`, webhook logs ids and types only: Tasks 2, 3, 4, 8
  - Env: Tasks 4–7, documented in Task 9
  - Testing: every pure test the spec lists is in Tasks 1, 4, 5, 6, 7; every convex-test case is in Tasks 2–8 (events: 401, `url_verification`, ingest, wrong team/non-channel, edit, delete, 🧠; backfill resume; document added, chunked, capped; private document invisible; private repo refused; recall visibility; approval promotes once; purge)
- **External values still to confirm** (each the first step of its task, written against one name): Slack signing (`slackSignature`, `verifySlack`), event and Web API shapes (`readSlackEvent`, `PERSON_SUBTYPES`, `slackApi`, `readUserName`, `readChannelName`), backfill methods and pacing (`readChannels`, `readHistory`, `HISTORY_PAGE`, `HISTORY_DELAY_MS`), `unpdf` (`pdfText`) and Node's `redirect: "manual"` (`fetchDocument` in `convex/documents.ts`), GitHub (`lib/github.ts`), manifest and token steps (HANDOVER). The `YYYY-MM-DD` in four header comments is filled in at those steps.
- **Types used across tasks:**
  - `visibleTo(row, viewer)` takes any `{ visibility?, ownerId? }`; used for facts, passages and sources
  - `promotePassage(ctx, p, { ownerId?, visibility, source? })` is called by `promote`, `promoteCited` and `slack.react`
  - `internal.sources.write({ sourceId, passages, label?, cursor?, synced? })` is the only writer of passages: `slack.events`, `ingest.backfillChannel`, `ingest.syncRepo`, `documents.readUrl/readUpload`, and Task 8's test
  - `internal.sources.fail({ sourceId, error, clear? })`: `clear` from Task 7 on
  - `api.sources.setup` is born in Task 7 and returns `{ github }`; the Slack invite comes from `api.connections.mine` (existing) in the join step
  - `api.sources.addLink({ input, private })` handles URLs from Task 6 and repos from Task 7
  - `facts.archive` returns `Archived & { visibility }`; `brief(task, recalled, sendsFrom, self, slackChannel, archive)` takes `Archived[]` sixth; `scripts/eval.ts`'s five-argument call is untouched
  - Graph source node ids are `src:<sourceId>`; `SourcePanel` strips the prefix; `src:seed` is excluded
  - `sourceBlocked(addedToday, exempt)` gets `exempt` from `capExempt`, like `teachBlocked`/`sendBlocked`
- **Known soft spots:**
  - The URL check is hostname-only (no DNS rebinding cover); `ponytail:` in `urlProblem`.
  - Thread replies aren't backfilled; a new public channel needs a backfill re-run to be joined.
  - convex-test runs the `"use node"` readers in its own runtime; bundling `unpdf` for Convex's Node runtime is only proven by the first deploy (HANDOVER section 3).
  - An oversized upload from a modified client stays in storage (`ponytail:` in `addUpload`).
  - Passages are stored raw (an address in a Slack message or a document stays in `passages.text` and reaches the intern's prompt, like a fact would); every public display redacts. If that's too loose, redact in `sources.write` instead.
  - Auto-promoted facts are filed under the approver's `ownerId`, so they sit in `factCapBlocked`'s window and count toward that member's 20 manual facts that day (they aren't blocked by it). Same as a run's own facts on `main` today.
  - The rail's top sections don't scroll; "add a source" adds about four lines above "layers". Move it into the scrolling area if short screens complain.
