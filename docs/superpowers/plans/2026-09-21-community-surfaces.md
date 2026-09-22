# Community Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members send approved drafts from their own Gmail or Slack (through Composio) with a live write-back to the brain; the community mirrors its public activity into Discord/Slack channels; members add to the brain from Slack (🧠) and Gmail (the `Intern` label); every member gets a public `/u/<handle>` page.

**Architecture:**
- Pure logic lives in `lib/*.ts` with `node --test` tests: the connector registry, email redaction, the send cap, broadcast formatting, inbound payload mapping and the webhook signature check.
- Composio is called over plain REST with `fetch` from Convex's default runtime (no SDK, no `"use node"`). Every Composio host, path and field name is in `lib/composio.ts`; tool slugs are in `lib/connectors.ts`; trigger slugs and the webhook scheme are in `lib/inbound.ts`. Each is confirmed against the docs in the first step of the task that introduces it.
- Convex owns the flow: `outbox.decide` queues a send, `internal.send.go` calls Composio, `internal.send.finish` writes the status and the owner-only fact in one transaction. Two HTTP actions (`/composio/callback`, `/composio/webhook`) take Composio's redirects and events. Queries redact other people's private data server-side.

**Tech Stack:**
- Next.js 16.3 (App Router), React 19, Tailwind 4
- Convex 1.43, `@convex-dev/auth` 0.0.94 (GitHub)
- Composio REST v3 (free tier), Discord and Slack incoming webhooks
- `node --test --experimental-strip-types` for `lib/`, `vitest` + `convex-test` for `convex/`

**Spec:** `docs/superpowers/specs/2026-09-21-community-surfaces-design.md`
**Composio research:** `.superpowers/sdd/composio-research.md`

## Global Constraints

- `SENDS_PER_DAY = 20` (per member, UTC day). Lives in `lib/caps.ts`.
- Broadcast throttle: at most 30 broadcasts per hour, via a `broadcasts` counter row per UTC hour. Over the cap, events are dropped with a log, not queued.
- Notice copy, verbatim: `This is a public test brain. Briefs and facts are visible to every visitor; drafts and anything you send stay private to you. Don't enter anything private in a brief.`
- Privacy rules, verbatim from the spec:
  - Private drafts, shared brain. A draft to a real recipient is visible only to its owner. Others see that a draft or send happened, never the address or body.
  - Every send files a fact. Gmail sends are owner-only facts; only the owner's interns recall them.
  - `outbox.list`: owner rows in full. Other people's rows are reduced to `{ _id, kind, status, ownerId, handle, _creationTime }`, with no draft, subject or recipient.
  - `facts.graph` / `community.feed`: other people's `owner` facts are omitted. Other people's actions render as `✉ a draft` / `✉ sent`, with no subject.
  - `facts.recall` returns public facts plus the intern owner's own `owner` facts. It takes `ownerId`; the run action passes the intern's owner.
  - `interns.list`: for non-owners, email addresses in `task` are replaced with `[email]`.
  - `community.member`: no private facts, drafts or recipients.
- Carried from the public-MVP spec: GitHub sign-in, consent gate, per-user caps, $5/day model budget, **every write through `requireMember`**.
- **Never trust a user id from a query string.** The callback finds the user by its `state` row and checks Composio's own record of the account; the webhook maps Composio's signed payload through `connections`.
- **No paid services.** Composio's free tier (100k tool calls/month) and Discord/Slack incoming webhooks only.
- Discord is not an outbound connector. It appears only as a broadcast surface.
- No `@composio/core`, no `"use node"`. Plain `fetch` with the `x-api-key` header.
- Never invent a Composio endpoint, slug or field. The first step of Tasks 1, 3 and 7 fetches the docs page, confirms each value and records it in the one named constant or function; everything else in the task is written against that name.
- No test hits the network. Composio and webhook calls in `vitest` tests are stubbed with `vi.stubGlobal("fetch", …)`; env with `vi.stubEnv`; both are undone in `afterEach`.
- Every task ends green on its own: `npm test`, `npx vitest run`, `npx tsc --noEmit`, `npm run build`.
- Read `convex/_generated/ai/guidelines.md` before touching `convex/`. Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md` before Task 8.
- Runtime imports from `convex/` into `lib/`, and between `lib/` files, spell out the `.ts` extension. Env is read with `process.env`, as `lib/gemini.ts` already does.
- A task that adds a `convex/` module or changes `convex/schema.ts` runs `npx convex dev --once` before `tsc` (this regenerates `convex/_generated/api.d.ts` and pushes to the **dev** deployment `graceful-albatross-202` only).
- Branch `connectors` (already checked out). Commit after every task. Push to `origin` and deploy to prod only when Mihir says so.

## Decisions made while planning (flag to Mihir at handoff)

1. **Learning from a live draft stays private.** Today an edit or rejection files a public fact whose body quotes the draft and its recipients (`lib/edits.ts`). For a draft that can reach a real person (its connector is configured and connected), that fact is filed `visibility: "owner"` and its log line omits the title. Sandbox drafts keep today's public behaviour, so the "learned from an edit" broadcast still fires for them.
2. **The intern's streamed report and summary are owner-only.** `interns.logs` streams the raw report (including the ```action block with recipients, and anything recalled from the owner's private facts) to every visitor, and `interns.list` returns `summary`. Non-owners now get no `out` lines, no `summary`, and email addresses redacted in every other line. `questions.list` gets the same reduction as `outbox.list`.
3. **"Records the approval intent"** means: the draft stays `pending`, and any edits are saved on it as `accepted`, so they survive the trip to Composio's consent screen.
4. **Retrying a failed send** is a new mutation, `outbox.resend`. The spec says it can be retried from the outbox; `decide` only accepts pending drafts.
5. **Slack 🧠 needs the member's Slack user id** to check "the reactor is that member". `connections` gains `externalUserId`, read at connect time with Slack's who-am-I tool. Reaction events carry no message text, so the webhook fetches it with Slack's history tool.
6. **"connected as <label>"**: Composio's connected-account object has no address in the research. Slack gets `@user in team` from who-am-I (Task 7); Gmail shows `connected as Gmail`.
7. **Discord broadcasts set `allowed_mentions: { parse: [] }`** and Slack broadcasts escape `& < >`, so a fact titled `@everyone` or `<!channel>` pings nobody. The body keys the spec names are unchanged.
8. **`community.landing`'s "approved" count adds `sent`**, since a live approval never rests at `approved`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `lib/connectors.ts` (+test) | new | Connector registry, `connectorFor`, `isConfigured`, write-back fact text |
| `lib/redact.ts` (+test) | new | `redactEmails` |
| `lib/caps.ts` (+test) | modify | `SENDS_PER_DAY`, `sendBlocked`, `tooManySends` |
| `lib/composio.ts` | new | Composio host, paths, request bodies, response readers, `link`/`getAccount`/`deleteAccount`/`execute`/`upsertTrigger` |
| `lib/brief.ts` (+test) | modify | Live-send paragraph when the member has a connected account |
| `lib/broadcast.ts` (+test) | new | Broadcast events → one line; Discord/Slack bodies; hour key |
| `lib/inbound.ts` (+test) | new | Trigger slugs, Slack tool slugs, webhook signature, payload → capture → fact |
| `lib/types.ts` | modify | `ActionStatus` gains `sending/sent/failed`; `ProposedAction.connector/sendError` |
| `convex/schema.ts` | modify | `connections`, `broadcasts`; `actions` statuses and send fields; `facts.visibility` |
| `convex/access.ts` | modify | `visibleTo`, `memberProblem` |
| `convex/facts.ts` | modify | `insertFact` visibility, `recall({ task, ownerId })`, graph redaction, `factCapBlocked` |
| `convex/outbox.ts` | modify | List redaction; `decide` connect/send paths; `resend` |
| `convex/questions.ts` | modify | List redaction |
| `convex/interns.ts` | modify | List/logs redaction; `start` returns `ownerId` and `sendsFrom`; draft broadcast |
| `convex/run.ts` | modify | Pass `ownerId` to recall and `sendsFrom` to the brief |
| `convex/community.ts` | modify | Feed redaction; landing count; `member` query |
| `convex/users.ts` | modify | `accept` broadcasts once; `purge` removes connections |
| `convex/connections.ts` | new | `mine`, `start`, `disconnect`, `forget`, internal `begin/byState/settle/drop`, `callback` HTTP action, `activeConnection` |
| `convex/send.ts` | new | `load`, `go`, `finish` |
| `convex/broadcast.ts` | new | `broadcast()` helper (throttle + schedule), `post` action |
| `convex/inbound.ts` | new | `webhook` HTTP action, internal `member`, `capture` |
| `convex/http.ts` | modify | `/composio/callback` (GET), `/composio/webhook` (POST) |
| `convex/composio.test.ts` | new | `lib/composio.ts` against a stubbed `fetch` |
| `convex/surfaces.test.ts` | new | convex-test coverage for everything above |
| `components/Consent.tsx` | modify | New notice |
| `components/Outbox.tsx` | modify | New statuses, live approve copy, retry send |
| `components/BrainRail.tsx` | modify | "accounts" section: connect / connected as / not set up yet |
| `components/Cockpit.tsx` | modify | Narrow redacted rows; connect flow; `?connected=` echo; resend |
| `components/Feed.tsx` | modify | Handles link to `/u/<handle>` |
| `components/MemberPage.tsx` | new | The member page body |
| `app/u/[handle]/page.tsx` | new | Route |
| `HANDOVER.md` | modify | Setup and admin notes (Task 9) |

---

### Task 1: Connector registry, redaction and the send cap (pure)

**Files:**
- Create: `lib/connectors.ts`, `lib/connectors.test.ts`, `lib/redact.ts`, `lib/redact.test.ts`
- Modify: `lib/caps.ts` (append after `teachBlocked`, line 57), `lib/caps.test.ts`

**Interfaces:**
- Consumes: `ActionKind`, `Draft` from `lib/types.ts`.
- Produces (later tasks import these exact names):
  ```ts
  // lib/connectors.ts
  export type ConnectorKey = "gmail" | "slack";
  export type Connector = { key: ConnectorKey; label: string; toolkit: string; authConfigEnv: string; sendTool: string; forKind: ActionKind; toArguments(draft: Draft): Record<string, unknown> };
  export const CONNECTORS: Connector[];
  export function connectorFor(kind: ActionKind): Connector | null;
  export function connectorByKey(key: ConnectorKey): Connector;
  export function isConfigured(c: Connector, env: Record<string, string | undefined>): boolean;
  export function sentFact(key: ConnectorKey, d: Draft, now: number): { title: string; body: string };
  // lib/redact.ts
  export const redactEmails: (text: string) => string;
  // lib/caps.ts
  export const SENDS_PER_DAY = 20;
  export const sendBlocked: (sendsToday: number) => string | null;
  export const tooManySends: string;
  ```

- [ ] **Step 1: Confirm the send tools against Composio's docs**

Fetch each page and confirm the values below. Record any difference in the Step 3 `CONNECTORS` code **and** the Step 2 expectations before running anything. If a page can't be reached, stop and ask Mihir; don't guess.

1. `https://docs.composio.dev/toolkits/gmail` → the `GMAIL_SEND_EMAIL` tool's input schema. Confirm: the toolkit slug (`gmail`), the primary recipient field (`recipient_email`), the field for further `to` recipients (`extra_recipients`, an array), `cc` (array of strings), `subject`, `body`.
2. `https://docs.composio.dev/toolkits/slack` → the **Slack** toolkit's send-message tool. The research only found `SLACKBOT_SEND_MESSAGE`, which belongs to the separate Slackbot toolkit; our auth config is the Slack toolkit, so the tool must come from it. Confirm its slug (written below as `SLACK_SEND_MESSAGE`), the channel field (`channel`) and the text field (`markdown_text`).
3. Put the date you checked in the comment above `CONNECTORS`.

- [ ] **Step 2: Write the failing tests**

`lib/connectors.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONNECTORS, connectorByKey, connectorFor, isConfigured, sentFact } from "./connectors.ts";

const draft = { to: ["ann@acme.com", "bo@acme.com"], cc: ["cy@acme.com"], subject: "Pricing", body: "Hi Ann,\nhere it is." };

test("each draft kind has at most one connector, and calendar has none", () => {
  assert.equal(connectorFor("email")?.key, "gmail");
  assert.equal(connectorFor("slack")?.key, "slack");
  assert.equal(connectorFor("calendar"), null);
  assert.equal(new Set(CONNECTORS.map((c) => c.forKind)).size, CONNECTORS.length);
});

test("gmail sends to the first recipient and the rest ride along", () => {
  assert.deepEqual(connectorByKey("gmail").toArguments(draft), {
    recipient_email: "ann@acme.com",
    extra_recipients: ["bo@acme.com"],
    cc: ["cy@acme.com"],
    subject: "Pricing",
    body: "Hi Ann,\nhere it is.",
  });
});

test("slack posts to the channel and bolds a subject only when there is one", () => {
  const slack = connectorByKey("slack");
  assert.deepEqual(slack.toArguments({ to: ["#general"], subject: "", body: "ship it" }), {
    channel: "#general",
    markdown_text: "ship it",
  });
  assert.deepEqual(slack.toArguments({ to: ["#general"], subject: "Heads up", body: "ship it" }), {
    channel: "#general",
    markdown_text: "*Heads up*\nship it",
  });
});

test("a connector is configured only with the API key and its own auth config", () => {
  const gmail = connectorByKey("gmail");
  assert.equal(isConfigured(gmail, {}), false);
  assert.equal(isConfigured(gmail, { COMPOSIO_API_KEY: "k" }), false);
  assert.equal(isConfigured(gmail, { COMPOSIO_API_KEY: "k", COMPOSIO_AUTH_CONFIG_GMAIL: "ac_1" }), true);
  assert.equal(isConfigured(connectorByKey("slack"), { COMPOSIO_API_KEY: "k", COMPOSIO_AUTH_CONFIG_GMAIL: "ac_1" }), false);
});

test("the write-back fact says who, what and when", () => {
  const now = Date.UTC(2026, 8, 21, 12);
  assert.deepEqual(sentFact("gmail", draft, now), {
    title: "emailed ann@acme.com, bo@acme.com about Pricing",
    body: "2026-09-21 · Hi Ann,\nhere it is.",
  });
  assert.equal(sentFact("gmail", { ...draft, body: "x".repeat(400) }, now).body, `2026-09-21 · ${"x".repeat(280)}`);
  assert.deepEqual(sentFact("slack", { to: ["#general"], subject: "", body: "\nship it\nmore" }, now), {
    title: "posted in #general: ship it",
    body: "2026-09-21",
  });
});
```

`lib/redact.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEmails } from "./redact.ts";

test("addresses become [email] and everything else stays", () => {
  assert.equal(redactEmails("Email ann.lee+x@acme.co.uk about pricing"), "Email [email] about pricing");
  assert.equal(redactEmails("a@b.io, c@d.com"), "[email], [email]");
  assert.equal(redactEmails("ping @mihir in #general"), "ping @mihir in #general");
});
```

Append to `lib/caps.test.ts` (and add `SENDS_PER_DAY, sendBlocked` to its import list):
```ts
test("sends cap at twenty a day", () => {
  assert.equal(SENDS_PER_DAY, 20);
  assert.equal(sendBlocked(SENDS_PER_DAY - 1), null);
  assert.match(sendBlocked(SENDS_PER_DAY) ?? "", /20 sends/);
  assert.match(sendBlocked(SENDS_PER_DAY) ?? "", /00:00 UTC/);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../lib/connectors.ts'` (and `redact.ts`), and `sendBlocked is not a function`.

- [ ] **Step 4: Implement**

`lib/connectors.ts`:
```ts
/**
 * Every account a draft can go out through. One row per connector, so adding
 * one later is a row, not a module. Pure: Convex reads it, node tests it.
 *
 * Discord is deliberately absent: it forbids apps posting as a user, so it
 * only ever appears as a broadcast surface (lib/broadcast.ts).
 */

import type { ActionKind, Draft } from "./types";

export type ConnectorKey = "gmail" | "slack";

export type Connector = {
  key: ConnectorKey;
  label: string;
  /** Composio toolkit slug. */
  toolkit: string;
  /** Env var holding the Composio auth config id. */
  authConfigEnv: string;
  /** Composio tool slug that sends. */
  sendTool: string;
  /** Which draft kind it sends. */
  forKind: ActionKind;
  toArguments(draft: Draft): Record<string, unknown>;
};

// Tool slugs and argument names confirmed against docs.composio.dev/toolkits/{gmail,slack} on YYYY-MM-DD (Task 1 Step 1).
export const CONNECTORS: Connector[] = [
  {
    key: "gmail",
    label: "Gmail",
    toolkit: "gmail",
    authConfigEnv: "COMPOSIO_AUTH_CONFIG_GMAIL",
    sendTool: "GMAIL_SEND_EMAIL",
    forKind: "email",
    toArguments: (d) => ({
      recipient_email: d.to[0],
      extra_recipients: d.to.slice(1),
      cc: d.cc ?? [],
      subject: d.subject,
      body: d.body,
    }),
  },
  {
    key: "slack",
    label: "Slack",
    toolkit: "slack",
    authConfigEnv: "COMPOSIO_AUTH_CONFIG_SLACK",
    sendTool: "SLACK_SEND_MESSAGE",
    forKind: "slack",
    toArguments: (d) => ({
      channel: d.to[0],
      markdown_text: d.subject ? `*${d.subject}*\n${d.body}` : d.body,
    }),
  },
];

export const connectorFor = (kind: ActionKind): Connector | null =>
  CONNECTORS.find((c) => c.forKind === kind) ?? null;

export function connectorByKey(key: ConnectorKey): Connector {
  const c = CONNECTORS.find((x) => x.key === key);
  if (!c) throw new Error(`unknown connector ${key}`);
  return c;
}

/** The deployment has what this connector needs. Says nothing about whether *you* connected. */
export const isConfigured = (c: Connector, env: Record<string, string | undefined>) =>
  !!env.COMPOSIO_API_KEY && !!env[c.authConfigEnv];

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";

/** The owner-only fact a successful send files: the brain updates the moment it goes out. */
export function sentFact(key: ConnectorKey, d: Draft, now: number): { title: string; body: string } {
  const date = new Date(now).toISOString().slice(0, 10);
  if (key === "gmail") {
    return { title: `emailed ${d.to.join(", ")} about ${d.subject}`.slice(0, 200), body: `${date} · ${d.body.slice(0, 280)}` };
  }
  return { title: `posted in ${d.to[0]}: ${firstLine(d.body)}`.slice(0, 200), body: date };
}
```

`lib/redact.ts`:
```ts
/** Addresses are the private part of a public brief. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const redactEmails = (text: string) => text.replace(EMAIL, "[email]");
```

Append to `lib/caps.ts` after `teachBlocked`:
```ts
export const SENDS_PER_DAY = 20;

export const sendBlocked = (sendsToday: number): string | null =>
  sendsToday >= SENDS_PER_DAY ? `You've used your ${SENDS_PER_DAY} sends for today. ${RESETS}` : null;
```
and after `tooManyFacts`:
```ts
export const tooManySends = `You've decided too many drafts today to count your sends. ${RESETS}`;
```

- [ ] **Step 5: Run the gate**

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add lib/connectors.ts lib/connectors.test.ts lib/redact.ts lib/redact.test.ts lib/caps.ts lib/caps.test.ts
git commit -m "Connector registry, email redaction and the 20-sends/day cap"
```

---

### Task 2: Schema and privacy enforcement

Everything a query returns is redacted here, before any real send exists, so nothing private can ever be written into a table that leaks it.

**Files:**
- Modify: `convex/schema.ts`, `convex/access.ts`, `convex/facts.ts`, `convex/outbox.ts:47-64`, `convex/questions.ts:10-25`, `convex/interns.ts:142-153,157-174`, `convex/run.ts:34`, `convex/community.ts`, `convex/users.ts:50-75`
- Modify: `lib/types.ts:275-279,315-328`, `components/Outbox.tsx:10-14`, `components/Consent.tsx:8-9`, `components/Cockpit.tsx:103-143`
- Create: `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `redactEmails` (Task 1).
- Produces:
  ```ts
  // convex/schema.ts
  export const actionStatus;   // pending | approved | rejected | sending | sent | failed
  export const connectorKey;   // "gmail" | "slack"
  export const visibility;     // "public" | "owner"
  // tables: connections { userId, connector, composioAccountId?, accountLabel?, status: "pending"|"active"|"failed", state, createdAt }
  //   indexes by_userId_and_connector, by_state
  // actions gains sentAt?, sendError?, connector?; index by_ownerId_and_decidedAt
  // facts gains visibility?
  // convex/access.ts
  export const visibleTo: (f: Doc<"facts">, viewer: Id<"users"> | null) => boolean;
  // convex/facts.ts
  insertFact(ctx, { title, body, kind, ownerId?, internId?, visibility? })
  internal.facts.recall({ task: string, ownerId: Id<"users"> })
  // convex/interns.ts
  internal.interns.start({ internId }) => { task: string; ownerId: Id<"users"> } | null
  // api.outbox.list: owner rows are Doc<"actions"> & { handle }; others { _id, _creationTime, kind, status, ownerId, handle }
  // api.questions.list: owner rows are Doc<"questions">; others { _id, _creationTime, ownerId, internId, status }
  // lib/types.ts
  type ActionStatus = "pending" | "approved" | "rejected" | "sending" | "sent" | "failed";
  ProposedAction.connector?: string; ProposedAction.sendError?: string;
  ```

- [ ] **Step 1: Write the failing tests**

Create `convex/surfaces.test.ts`:
```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** engine.test.ts's setup, plus the rows this file keeps needing. */
function setup() {
  const t = convexTest(schema, modules);
  const seedUser = (handle: string) => t.run((ctx) => ctx.db.insert("users", { handle, acceptedAt: Date.now() }));
  const asUser = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session`, issuer: "https://local" });
  const seedDraft = (ownerId: Id<"users">, kind: "email" | "slack" = "email") =>
    t.run(async (ctx) => {
      const internId = await ctx.db.insert("interns", {
        ownerId,
        task: "email ann@acme.com about pricing",
        status: "done",
        countsTowardCap: true,
      });
      const actionId = await ctx.db.insert("actions", {
        ownerId,
        internId,
        kind,
        status: "pending",
        title: `${kind} to ann@acme.com — Pricing`,
        draft: { to: [kind === "email" ? "ann@acme.com" : "#general"], subject: "Pricing", body: "Secret body" },
        rationale: "because",
        sources: [],
        recalledCorrection: false,
      });
      return { internId, actionId };
    });
  return { t, seedUser, asUser, seedDraft };
}

test("other people's drafts come back as a bare status, never the draft", async () => {
  const { seedUser, asUser, seedDraft } = setup();
  const owner = await seedUser("owner");
  const other = await seedUser("other");
  const { actionId } = await seedDraft(owner);

  const mine = (await asUser(owner).query(api.outbox.list, {})).find((r) => r._id === actionId);
  expect(mine && "draft" in mine ? mine.draft.body : null).toBe("Secret body");

  const theirs = (await asUser(other).query(api.outbox.list, {})).find((r) => r._id === actionId);
  expect(theirs).toEqual({
    _id: actionId,
    _creationTime: expect.any(Number),
    kind: "email",
    status: "pending",
    ownerId: owner,
    handle: "owner",
  });
});

test("other people's questions come back without the question", async () => {
  const { t, seedUser, asUser } = setup();
  const owner = await seedUser("owner");
  const other = await seedUser("other");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: owner, task: "t", status: "waiting", countsTowardCap: true }),
  );
  const questionId = await t.run((ctx) =>
    ctx.db.insert("questions", { ownerId: owner, internId, question: "Ann's number?", context: "private", status: "open" }),
  );
  const theirs = (await asUser(other).query(api.questions.list, {})).find((q) => q._id === questionId);
  expect(theirs).toEqual({ _id: questionId, _creationTime: expect.any(Number), ownerId: owner, internId, status: "open" });
  const mine = (await asUser(owner).query(api.questions.list, {})).find((q) => q._id === questionId);
  expect(mine && "question" in mine ? mine.question : null).toBe("Ann's number?");
});

test("recall includes the owner's private facts and nobody else's", async () => {
  const { t, seedUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  await t.run(async (ctx) => {
    await ctx.db.insert("facts", {
      title: "emailed ann about pricing",
      body: "b",
      kind: "note",
      visibility: "owner",
      ownerId: a,
      text: "emailed ann about pricing\nb",
    });
    await ctx.db.insert("facts", { title: "pricing is public", body: "b", kind: "note", ownerId: b, text: "pricing is public\nb" });
  });
  const forA = await t.query(internal.facts.recall, { task: "pricing", ownerId: a });
  const forB = await t.query(internal.facts.recall, { task: "pricing", ownerId: b });
  expect(forA.map((f) => f.title).sort()).toEqual(["emailed ann about pricing", "pricing is public"]);
  expect(forB.map((f) => f.title)).toEqual(["pricing is public"]);
});

test("the graph and feed hide other people's private facts, subjects and addresses", async () => {
  const { t, seedUser, asUser, seedDraft } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedDraft(a);
  await t.run((ctx) =>
    ctx.db.insert("facts", { title: "private note", body: "", kind: "note", visibility: "owner", ownerId: a, text: "private note\n" }),
  );

  const forA = (await asUser(a).query(api.facts.graph, {})).nodes.map((n) => n.label);
  expect(forA).toEqual(expect.arrayContaining(["private note", "✉ Pricing", "email ann@acme.com about pricing"]));

  const forB = (await asUser(b).query(api.facts.graph, {})).nodes.map((n) => n.label);
  expect(forB).not.toContain("private note");
  expect(forB).toContain("✉ a draft");
  expect(forB).toContain("email [email] about pricing");

  const signedOut = (await t.query(api.facts.graph, {})).nodes.map((n) => n.label);
  expect(signedOut).not.toContain("private note");

  const feed = (await asUser(b).query(api.community.feed, {})).map((e) => e.text).join("\n");
  expect(feed).not.toMatch(/private note|ann@acme\.com/);
});

test("other people's interns: addresses redacted, report and streamed output withheld", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", {
      ownerId: a,
      task: "email ann@acme.com",
      status: "done",
      summary: "Ann's number is 555",
      countsTowardCap: true,
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("logs", { internId, level: "out", text: '```action {"to":["ann@acme.com"]}' });
    await ctx.db.insert("logs", { internId, level: "err", text: "send failed: bad address ann@acme.com" });
  });

  const mine = (await asUser(a).query(api.interns.list, {})).find((i) => i._id === internId);
  expect(mine?.task).toBe("email ann@acme.com");
  expect(mine?.summary).toBe("Ann's number is 555");
  const theirs = (await asUser(b).query(api.interns.list, {})).find((i) => i._id === internId);
  expect(theirs?.task).toBe("email [email]");
  expect(theirs?.summary).toBeUndefined();

  expect(await asUser(a).query(api.interns.logs, {})).toHaveLength(2);
  expect((await asUser(b).query(api.interns.logs, {})).map((l) => l.text)).toEqual(["send failed: bad address [email]"]);
  expect((await t.query(api.interns.logs, {})).map((l) => l.text)).toEqual(["send failed: bad address [email]"]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run convex/surfaces.test.ts`
Expected: FAIL — `visibility` is not in the `facts` validator; `recall` rejects the extra `ownerId` arg; the list assertions fail.

- [ ] **Step 3: Schema**

In `convex/schema.ts`, after `actionKind` (line 18) add:
```ts
export const actionStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  // Only a draft going out through a member's connected account reaches these.
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
);

export const connectorKey = v.union(v.literal("gmail"), v.literal("slack"));

/** Absent means public: every fact written before connectors existed. */
export const visibility = v.union(v.literal("public"), v.literal("owner"));
```
Replace the file's top comment with:
```ts
/**
 * The public community brain: private drafts, shared brain. Everyone reads
 * the public rows; owner-only facts and every draft's contents reach their
 * owner alone. Each row has one owner who alone can change it.
 */
```
In `facts`, after `internId` add `visibility: v.optional(visibility),`.
In `actions`, replace the `status` line with `status: actionStatus,` and after `decidedAt` add:
```ts
    /** Set when a connected account accepted the send. */
    sentAt: v.optional(v.number()),
    /** Composio's reason, when a send failed. */
    sendError: v.optional(v.string()),
    /** Which connected account it went through. Counts toward SENDS_PER_DAY. */
    connector: v.optional(connectorKey),
```
and add the index `.index("by_ownerId_and_decidedAt", ["ownerId", "decidedAt"])` after `by_internId`.
After the `usage` table add:
```ts
  /**
   * A member's link to one account at Composio. `state` is the single-use
   * nonce the callback is looked up by; the user id never comes from the URL.
   */
  connections: defineTable({
    userId: v.id("users"),
    connector: connectorKey,
    composioAccountId: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    state: v.string(),
    createdAt: v.number(),
  })
    .index("by_userId_and_connector", ["userId", "connector"])
    .index("by_state", ["state"]),
```

- [ ] **Step 4: `visibleTo` and fact visibility**

Append to `convex/access.ts`:
```ts
/** Owner-only facts reach their owner alone. Absent means public. */
export const visibleTo = (f: Doc<"facts">, viewer: Id<"users"> | null) =>
  f.visibility !== "owner" || (viewer !== null && f.ownerId === viewer);
```

In `convex/facts.ts`:
- Add imports: `import { getAuthUserId } from "@convex-dev/auth/server";`, `import { redactEmails } from "../lib/redact.ts";`, and change `import { requireMember } from "./access";` to `import { requireMember, visibleTo } from "./access";`.
- Replace `insertFact`:
```ts
export async function insertFact(
  ctx: MutationCtx,
  f: {
    title: string;
    body: string;
    kind: FactKind;
    ownerId?: Id<"users">;
    internId?: Id<"interns">;
    visibility?: Doc<"facts">["visibility"];
  },
) {
  return await ctx.db.insert("facts", { ...f, text: `${f.title}\n${f.body}` });
}
```
- Replace `recall`:
```ts
/**
 * What an intern reads before it starts: the newest house-style lessons
 * (preferences and corrections, the learning loop), then the best full-text
 * matches for the task. Public facts plus the intern owner's own private ones.
 *
 * ponytail: over-read, then filter. Other people's private facts take slots
 * in these windows; index by visibility if recall starts coming back thin.
 */
export const recall = internalQuery({
  args: { task: v.string(), ownerId: v.id("users") },
  handler: async (ctx, { task, ownerId }) => {
    const usable = (rows: Doc<"facts">[], n: number) => rows.filter((f) => visibleTo(f, ownerId)).slice(0, n);
    const lessons = [
      ...usable(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "preference")).order("desc").take(12), 3),
      ...usable(await ctx.db.query("facts").withIndex("by_kind", (q) => q.eq("kind", "correction")).order("desc").take(12), 3),
    ];
    // Convex search takes at most 16 terms.
    const terms = task.split(/\s+/).filter(Boolean).slice(0, 16).join(" ");
    const hits = terms
      ? usable(await ctx.db.query("facts").withSearchIndex("search_text", (q) => q.search("text", terms)).take(15), 5)
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
```
- In `graph`: change the doc comment's second sentence to `Public, minus what is private: other people's owner-only facts are left out, and other people's drafts show only that they exist.` Then change the three reads and the two label lines:
```ts
    const viewer = await getAuthUserId(ctx);
    const facts = (await ctx.db.query("facts").order("desc").take(400)).filter((f) => visibleTo(f, viewer));
```
```ts
    for (const i of interns) {
      const task = i.ownerId === viewer ? i.task : redactEmails(i.task);
      nodes.set(i._id, { id: i._id, label: task.slice(0, 56), kind: "intern", weight: 5, detail: i.status });
```
```ts
    for (const a of actions) {
      const label =
        a.ownerId === viewer ? `✉ ${a.draft.subject || a.title}`.slice(0, 56) : a.status === "sent" ? "✉ sent" : "✉ a draft";
      nodes.set(a._id, { id: a._id, label, kind: "action", weight: 4, detail: a.status });
```

- [ ] **Step 5: Outbox and questions lists**

In `convex/outbox.ts`, replace `list`'s handler body:
```ts
  handler: async (ctx) => {
    const rows = await ctx.db.query("actions").order("desc").take(30);
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const mine = await ctx.db
        .query("actions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
        .order("desc")
        .take(15);
      const seen = new Set(rows.map((r) => r._id));
      rows.push(...mine.filter((m) => !seen.has(m._id)));
      rows.sort((a, b) => b._creationTime - a._creationTime);
    }
    return await Promise.all(
      rows.map(async (a) => {
        const handle = (await ownerView(ctx, a.ownerId)).handle;
        // Private drafts, shared brain: the owner gets the draft, everyone
        // else only that one exists.
        if (a.ownerId === userId) return { ...a, handle };
        return { _id: a._id, _creationTime: a._creationTime, kind: a.kind, status: a.status, ownerId: a.ownerId, handle };
      }),
    );
  },
```
Add to its doc comment: `Other people's rows carry no draft, subject or recipient.`

In `convex/questions.ts`, replace `list`'s handler body:
```ts
  handler: async (ctx) => {
    const rows = await ctx.db.query("questions").order("desc").take(30);
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const mine = await ctx.db
        .query("questions")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
        .order("desc")
        .take(15);
      const seen = new Set(rows.map((r) => r._id));
      rows.push(...mine.filter((m) => !seen.has(m._id)));
      rows.sort((a, b) => b._creationTime - a._creationTime);
    }
    // A question can quote the owner's private facts; others see only that it exists.
    return rows.map((q) =>
      q.ownerId === userId ? q : { _id: q._id, _creationTime: q._creationTime, ownerId: q.ownerId, internId: q.internId, status: q.status },
    );
  },
```

- [ ] **Step 6: Interns list, logs and start; run passes the owner**

In `convex/interns.ts` add imports `import { getAuthUserId } from "@convex-dev/auth/server";` and `import { redactEmails } from "../lib/redact.ts";`, and change `import type { Id } from "./_generated/dataModel";` to `import type { Doc, Id } from "./_generated/dataModel";`. Replace `list` and `logs`:
```ts
export const list = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const rows = await ctx.db.query("interns").order("desc").take(40);
    return await Promise.all(
      rows.map(async (i) => ({
        ...i,
        ...(await ownerView(ctx, i.ownerId)),
        // A brief is public, an address in it isn't. The report may quote the
        // owner's private facts, so only the owner reads it.
        ...(i.ownerId === viewer ? {} : { task: redactEmails(i.task), summary: undefined }),
      })),
    );
  },
});

/**
 * Oldest→newest, last 400. Other people's streamed output (`out`) is withheld:
 * it carries the draft and whatever the intern recalled from its owner's
 * private facts. Their other lines come through with addresses redacted.
 */
export const logs = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const rows = (await ctx.db.query("logs").order("desc").take(400)).reverse();
    const owners = new Map<Id<"interns">, Id<"users"> | null>();
    const out: Doc<"logs">[] = [];
    for (const l of rows) {
      if (!owners.has(l.internId)) owners.set(l.internId, (await ctx.db.get("interns", l.internId))?.ownerId ?? null);
      const owner = owners.get(l.internId);
      if (viewer !== null && owner === viewer) out.push(l);
      else if (l.level !== "out") out.push({ ...l, text: redactEmails(l.text) });
    }
    return out;
  },
});
```
In `start`, change the last line to `return { task: i.task, ownerId: i.ownerId };`.

In `convex/run.ts` line 34, change the recall call to:
```ts
      const recalled = await ctx.runQuery(internal.facts.recall, { task: started.task, ownerId: started.ownerId });
```

- [ ] **Step 7: Feed and landing**

In `convex/community.ts` add imports `import { getAuthUserId } from "@convex-dev/auth/server";`, `import { redactEmails } from "../lib/redact.ts";` and change the access import to `import { ownerView, visibleTo } from "./access";`. Replace `feed`:
```ts
/** Newest 30 things anyone did, for the right rail. Public information only. */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getAuthUserId(ctx);
    const [interns, facts, approved, sent] = await Promise.all([
      ctx.db.query("interns").order("desc").take(30),
      ctx.db.query("facts").order("desc").take(30),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).order("desc").take(15),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "sent")).order("desc").take(15),
    ]);
    const events: { at: number; ownerId: (typeof interns)[number]["ownerId"]; text: string }[] = [
      ...interns.map((i) => ({ at: i._creationTime, ownerId: i.ownerId, text: `briefed an intern: ${redactEmails(i.task).slice(0, 80)}` })),
      ...facts
        .filter((f) => visibleTo(f, viewer))
        .flatMap((f) =>
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
      ...[...approved, ...sent].map((a) => ({
        at: a.sentAt ?? a.decidedAt ?? a._creationTime,
        ownerId: a.ownerId,
        text: a.status === "sent" ? "✉ sent" : "approved ✉ a draft",
      })),
    ];
    events.sort((a, b) => b.at - a.at);
    return await Promise.all(
      events.slice(0, 30).map(async (e) => ({ at: e.at, text: e.text, ...(await ownerView(ctx, e.ownerId)) })),
    );
  },
});
```
In `landing`, read sent drafts too and count them as approved:
```ts
    const [users, facts, approved, sent] = await Promise.all([
      ctx.db.query("users").take(cap),
      ctx.db.query("facts").take(cap),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "approved")).take(cap),
      ctx.db.query("actions").withIndex("by_status", (q) => q.eq("status", "sent")).take(cap),
    ]);
    return {
      people: users.filter((u) => u.acceptedAt).length,
      facts: facts.length,
      approved: approved.length + sent.length,
      cap,
    };
```

- [ ] **Step 8: Purge removes connections**

In `convex/users.ts` `purge`, before the `more = …` line add:
```ts
    const connections = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", userId))
      .take(BATCH);
    for (const r of connections) await ctx.db.delete("connections", r._id);
```
and change the `more` line to `more = [facts, actions, questions, interns, connections].some((rows) => rows.length === BATCH);`.

- [ ] **Step 9: Client types, statuses and copy**

`lib/types.ts`: replace the `ActionStatus` comment and type:
```ts
/**
 * What `actions.status` stores. A sandbox approval stops at `approved`;
 * `sending`/`sent`/`failed` exist only for a draft going out through a
 * member's connected account.
 */
export type ActionStatus = "pending" | "approved" | "rejected" | "sending" | "sent" | "failed";
```
and add to `ProposedAction`, after `result?: string;`:
```ts
  /** Which connected account it went out through, if it went out at all. */
  connector?: string;
  /** Composio's reason, when a send failed. */
  sendError?: string;
```

`components/Outbox.tsx`: add three rows to `STATUS`:
```ts
  sending: { dot: "bg-k-action pulse-slow", text: "text-k-action" },
  sent: { dot: "bg-ok", text: "text-ok" },
  failed: { dot: "bg-err", text: "text-err" },
```

`components/Consent.tsx`: replace `NOTICE`:
```ts
export const NOTICE =
  "This is a public test brain. Briefs and facts are visible to every visitor; drafts and anything you send stay private to you. Don't enter anything private in a brief.";
```

`components/Cockpit.tsx`: the two lists now contain redacted rows, so narrow before mapping. Replace the `outbox` and `questions` memos:
```ts
  // Your own drafts and questions only: only you can act on them, and only
  // your own rows carry their contents.
  const outbox = useMemo<ProposedAction[]>(
    () =>
      (actionRows ?? []).flatMap((a) =>
        "draft" in a && a.ownerId === me.userId
          ? [{
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
              decidedVia: "cockpit" as const,
              result: a.reason,
              connector: a.connector,
              sendError: a.sendError,
            }]
          : [],
      ),
    [actionRows, me.userId],
  );

  const questions = useMemo<Question[]>(
    () =>
      (questionRows ?? []).flatMap((q) =>
        "question" in q && q.ownerId === me.userId
          ? [{
              id: q._id,
              internId: q.internId,
              ownerId: q.ownerId,
              question: q.question,
              context: q.context,
              status: q.status,
              answer: q.answer,
              askedAt: q._creationTime,
              resumedBy: q.resumedBy,
            }]
          : [],
      ),
    [questionRows, me.userId],
  );
```

- [ ] **Step 10: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!` The schema change is additive, so existing dev rows validate.

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass, including the five new tests and every test in `engine.test.ts`.

- [ ] **Step 11: Commit**

```bash
git add convex/schema.ts convex/access.ts convex/facts.ts convex/outbox.ts convex/questions.ts convex/interns.ts convex/run.ts convex/community.ts convex/users.ts convex/surfaces.test.ts convex/_generated lib/types.ts components/Outbox.tsx components/Consent.tsx components/Cockpit.tsx
git commit -m "Private drafts, shared brain: redact other people's drafts, private facts and addresses server-side"
```

---
### Task 3: Composio REST client, the connect flow and its callback

**Files:**
- Create: `lib/composio.ts`, `convex/connections.ts`, `convex/composio.test.ts`
- Modify: `convex/http.ts`, `convex/users.ts` (`purge`), `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `CONNECTORS`, `ConnectorKey`, `connectorByKey`, `isConfigured` (Task 1); the `connections` table, `connectorKey` validator and `requireMember` (Task 2).
- Produces:
  ```ts
  // lib/composio.ts
  export const COMPOSIO_HOST: string;
  export const PATHS: { link: string; account(id: string): string; execute(tool: string): string };
  export class ComposioError extends Error {}
  export function link(apiKey: string, a: { authConfigId: string; userId: string; callbackUrl: string }): Promise<string>; // redirect URL
  export type Account = { id: string; userId: string; status: string; authConfigId: string };
  export function getAccount(apiKey: string, id: string): Promise<Account>;
  export function deleteAccount(apiKey: string, id: string): Promise<void>;
  export function execute(apiKey: string, tool: string, a: { userId: string; accountId: string; arguments: Record<string, unknown> }): Promise<Record<string, unknown>>; // the tool's `data`
  // convex/connections.ts
  export function activeConnection(ctx: QueryCtx, userId: Id<"users">, connector: ConnectorKey): Promise<Doc<"connections"> | null>;
  export function forgetAccount(composioAccountId: string): Promise<void>;
  api.connections.mine({}) => { key: ConnectorKey; label: string; forKind: ActionKind; configured: boolean; connected: boolean; accountLabel: string | null }[]
  api.connections.start({ connector }) => string            // Composio's redirect URL
  api.connections.disconnect({ connector }) => null
  internal.connections.begin / byState / settle / drop / forget
  export const callback                                      // httpAction, GET /composio/callback
  ```

- [ ] **Step 1: Confirm Composio's REST surface against the docs**

Fetch each page and confirm the value written in Step 4. Record every difference in `lib/composio.ts` (Step 4) **and** its expectation in `convex/composio.test.ts` (Step 2) together, then fill in the date in the file's header comment. Nothing outside `lib/composio.ts` names a Composio host, path or field. If a page can't be reached, stop and ask Mihir.

1. `https://docs.composio.dev/reference` → the API host (`COMPOSIO_HOST`, written as `https://backend.composio.dev`; the research could not rule out `https://api.composio.dev`) and the auth header (`x-api-key`).
2. `https://docs.composio.dev/reference/api-reference/connected-accounts` →
   - the link endpoint (`PATHS.link`, written as `/api/v3/connected_accounts/link`), its body fields (`auth_config_id`, `user_id`, `callback_url`) and the response field holding the URL (`redirect_url`);
   - the get-account endpoint (`PATHS.account`, `/api/v3/connected_accounts/{id}`) and its response fields: `id`, `user_id`, `status` (the active value is `ACTIVE`), and the auth config id (written as `auth_config.id`);
   - that `DELETE` on the same path removes the account.
3. `https://docs.composio.dev/reference/api-reference/tools` → the execute endpoint (`PATHS.execute`, `/api/v3.1/tools/execute/{tool_slug}`), its body fields (written in `executeBody` as `user_id`, `connected_account_id`, `arguments`, `version: "latest"`; the research quoted `connectedAccountId`/`input`, which may be an older API version), and its response fields (`successful`, `data`, `error`).
4. `https://docs.composio.dev/docs/authenticating-users/manually-authenticating` → the callback's query parameters (`status=success|failed`, `connected_account_id`) and that our own `?state=` survives the redirect.

- [ ] **Step 2: Write the failing tests**

`convex/composio.test.ts` (vitest, so it can use `vi.stubGlobal`):
```ts
import { afterEach, expect, test, vi } from "vitest";
import { COMPOSIO_HOST, ComposioError, PATHS, execute, getAccount, link } from "../lib/composio.ts";

afterEach(() => vi.unstubAllGlobals());

const reply = (body: unknown, status = 200) => {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
};

test("link posts our user id and callback and returns Composio's redirect", async () => {
  const f = reply({ redirect_url: "https://connect.composio.dev/x", connected_account_id: "ca_1" });
  expect(await link("key", { authConfigId: "ac_1", userId: "u1", callbackUrl: "https://site/cb?state=s" })).toBe(
    "https://connect.composio.dev/x",
  );
  const [url, init] = f.mock.calls[0];
  expect(url).toBe(`${COMPOSIO_HOST}${PATHS.link}`);
  expect(init?.method).toBe("POST");
  expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
  expect(JSON.parse(String(init?.body))).toEqual({ auth_config_id: "ac_1", user_id: "u1", callback_url: "https://site/cb?state=s" });
});

test("a link reply without a URL is an error, not an empty redirect", async () => {
  reply({});
  await expect(link("key", { authConfigId: "ac_1", userId: "u1", callbackUrl: "x" })).rejects.toBeInstanceOf(ComposioError);
});

test("an account is read from Composio's own record", async () => {
  const f = reply({ id: "ca_1", user_id: "u1", status: "ACTIVE", auth_config: { id: "ac_1" } });
  expect(await getAccount("key", "ca_1")).toEqual({ id: "ca_1", userId: "u1", status: "ACTIVE", authConfigId: "ac_1" });
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_HOST}${PATHS.account("ca_1")}`);
});

test("execute sends the tool's arguments as the member and returns its data", async () => {
  const f = reply({ successful: true, data: { id: "m1" } });
  expect(await execute("key", "GMAIL_SEND_EMAIL", { userId: "u1", accountId: "ca_1", arguments: { subject: "s" } })).toEqual({
    id: "m1",
  });
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_HOST}${PATHS.execute("GMAIL_SEND_EMAIL")}`);
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({
    user_id: "u1",
    connected_account_id: "ca_1",
    arguments: { subject: "s" },
    version: "latest",
  });
});

test("execute surfaces Composio's reason, on HTTP errors and on unsuccessful calls", async () => {
  const args = { userId: "u1", accountId: "ca_1", arguments: {} };
  reply({ error: { message: "invalid_grant" } }, 400);
  await expect(execute("key", "GMAIL_SEND_EMAIL", args)).rejects.toThrow(/composio 400: invalid_grant/);
  reply({ successful: false, error: "no_text" });
  await expect(execute("key", "GMAIL_SEND_EMAIL", args)).rejects.toThrow(/no_text/);
});
```

In `convex/surfaces.test.ts`, add below the `afterEach` block:
```ts
/** Every env var the connect and send paths read, set to test values. */
function composioEnv() {
  vi.stubEnv("COMPOSIO_API_KEY", "key");
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL", "ac_gmail");
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_SLACK", "ac_slack");
  vi.stubEnv("SITE_URL", "https://site.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://deploy.convex.site");
}

/** One canned reply for every outgoing request. No test reaches the network. */
function stubFetch(body: unknown, status = 200) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", f);
  return f;
}
```
Inside `setup()`, before `return`, add the helper below, and add `seedPending` to the returned object:
```ts
  const seedPending = (userId: Id<"users">, connector: "gmail" | "slack" = "gmail", state = "s1") =>
    t.run((ctx) => ctx.db.insert("connections", { userId, connector, status: "pending", state, createdAt: Date.now() }));
```
Append the tests:
```ts
test("connect: start writes a pending row and hands back Composio's link", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubFetch({ redirect_url: "https://connect.composio.dev/x" });

  expect(await asUser(a).action(api.connections.start, { connector: "gmail" })).toBe("https://connect.composio.dev/x");
  const row = await t.run((ctx) => ctx.db.query("connections").first());
  expect(row).toMatchObject({ userId: a, connector: "gmail", status: "pending" });
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({
    auth_config_id: "ac_gmail",
    user_id: a,
    callback_url: `https://deploy.convex.site/composio/callback?state=${row?.state}`,
  });
});

test("connect: without Composio's env nothing is set up and nothing is written", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  await expect(asUser(a).action(api.connections.start, { connector: "gmail" })).rejects.toThrow(/not set up yet/);
  expect(await t.run((ctx) => ctx.db.query("connections").collect())).toHaveLength(0);
  expect(await asUser(a).query(api.connections.mine, {})).toEqual([
    expect.objectContaining({ key: "gmail", configured: false, connected: false }),
    expect.objectContaining({ key: "slack", configured: false, connected: false }),
  ]);
});

test("callback: an unknown state is refused without calling Composio", async () => {
  composioEnv();
  const { t } = setup();
  const f = stubFetch({});
  const res = await t.fetch("/composio/callback?state=nope&status=success&connected_account_id=ca_1");
  expect(res.status).toBe(400);
  expect(f).not.toHaveBeenCalled();
});

test("callback: an account Composio says is someone else's is refused", async () => {
  composioEnv();
  const { t, seedUser, seedPending } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedPending(a);
  stubFetch({ id: "ca_1", user_id: b, status: "ACTIVE", auth_config: { id: "ac_gmail" } });

  // The query string even claims to be a. Only Composio's record counts.
  const res = await t.fetch(`/composio/callback?state=s1&status=success&connected_account_id=ca_1&user_id=${a}`);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("https://site.test/app?connect_failed=gmail");
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("failed");
});

test("callback: a matching account goes active, and the link can't be replayed", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a);
  stubFetch({ id: "ca_1", user_id: a, status: "ACTIVE", auth_config: { id: "ac_gmail" } });

  const res = await t.fetch("/composio/callback?state=s1&status=success&connected_account_id=ca_1");
  expect(res.headers.get("location")).toBe("https://site.test/app?connected=gmail");
  expect(await t.run((ctx) => ctx.db.query("connections").first())).toMatchObject({ status: "active", composioAccountId: "ca_1" });
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", configured: true, connected: true }),
  );
  expect((await t.fetch("/composio/callback?state=s1&status=success&connected_account_id=ca_1")).status).toBe(400);
});

test("disconnect marks the row failed and deletes the account at Composio", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "active", composioAccountId: "ca_1", state: "s0", createdAt: Date.now() }),
  );
  const f = stubFetch({});
  await asUser(a).action(api.connections.disconnect, { connector: "gmail" });
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("failed");
  expect(f.mock.calls[0][0]).toContain("/connected_accounts/ca_1");
  expect(f.mock.calls[0][1]?.method).toBe("DELETE");
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run`
Expected: FAIL — `Cannot find module '../lib/composio.ts'`, and `api.connections` does not exist.

- [ ] **Step 4: `lib/composio.ts`**

```ts
/**
 * Composio over plain REST: `fetch` plus `x-api-key`, so it runs in Convex's
 * default runtime (the SDK needs Node >= 22.22.3). Every host, path and field
 * name Composio owns lives in this file and nowhere else.
 *
 * Confirmed against docs.composio.dev/reference on YYYY-MM-DD (Task 3 Step 1).
 */

export const COMPOSIO_HOST = "https://backend.composio.dev";

export const PATHS = {
  link: "/api/v3/connected_accounts/link",
  account: (id: string) => `/api/v3/connected_accounts/${encodeURIComponent(id)}`,
  execute: (tool: string) => `/api/v3.1/tools/execute/${encodeURIComponent(tool)}`,
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export class ComposioError extends Error {}

/** Composio's own words for what went wrong, wherever this response keeps them. */
const reason = (j: Json) => str(j.message) ?? str(obj(j.error).message) ?? str(j.error);

async function call(apiKey: string, method: "GET" | "POST" | "DELETE", path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${COMPOSIO_HOST}${path}`, {
    method,
    headers: body ? { "x-api-key": apiKey, "content-type": "application/json" } : { "x-api-key": apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = obj(JSON.parse(text));
  } catch {
    // Not JSON: the raw text goes into the error below.
  }
  if (!res.ok) throw new ComposioError(`composio ${res.status}: ${reason(json) ?? text.slice(0, 200)}`);
  return json;
}

export const linkBody = (a: { authConfigId: string; userId: string; callbackUrl: string }) => ({
  auth_config_id: a.authConfigId,
  user_id: a.userId,
  callback_url: a.callbackUrl,
});

/** Starts a connection for one of our users. Returns where to send the browser. */
export async function link(apiKey: string, a: { authConfigId: string; userId: string; callbackUrl: string }): Promise<string> {
  const url = str((await call(apiKey, "POST", PATHS.link, linkBody(a))).redirect_url);
  if (!url) throw new ComposioError("composio link returned no redirect_url");
  return url;
}

export type Account = { id: string; userId: string; status: string; authConfigId: string };

export const readAccount = (j: Json): Account => ({
  id: str(j.id) ?? "",
  userId: str(j.user_id) ?? "",
  status: str(j.status) ?? "",
  authConfigId: str(obj(j.auth_config).id) ?? "",
});

export const getAccount = async (apiKey: string, id: string) => readAccount(await call(apiKey, "GET", PATHS.account(id)));

export async function deleteAccount(apiKey: string, id: string): Promise<void> {
  await call(apiKey, "DELETE", PATHS.account(id));
}

export const executeBody = (a: { userId: string; accountId: string; arguments: Json }) => ({
  user_id: a.userId,
  connected_account_id: a.accountId,
  arguments: a.arguments,
  version: "latest",
});

/** Runs one tool as one member. Throws ComposioError carrying Composio's reason. */
export async function execute(
  apiKey: string,
  tool: string,
  a: { userId: string; accountId: string; arguments: Json },
): Promise<Json> {
  const j = await call(apiKey, "POST", PATHS.execute(tool), executeBody(a));
  if (j.successful === false) throw new ComposioError(reason(j) ?? `${tool} failed`);
  return obj(j.data);
}
```

- [ ] **Step 5: `convex/connections.ts`, the route, and purge**

`convex/connections.ts`:
```ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { type Account, deleteAccount, getAccount, link } from "../lib/composio.ts";
import { CONNECTORS, type ConnectorKey, connectorByKey, isConfigured } from "../lib/connectors.ts";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type QueryCtx,
  action,
  httpAction,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { requireMember } from "./access";
import { connectorKey } from "./schema";

/**
 * A member's accounts at Composio. One hop, inline: approve → Composio's
 * consent screen → `/composio/callback` → back to the cockpit. There is no
 * settings page; the rail is the only place to connect or disconnect.
 */

/** The member's live grant for one connector, if any. */
export async function activeConnection(
  ctx: QueryCtx,
  userId: Id<"users">,
  connector: ConnectorKey,
): Promise<Doc<"connections"> | null> {
  return await ctx.db
    .query("connections")
    .withIndex("by_userId_and_connector", (q) => q.eq("userId", userId).eq("connector", connector))
    .order("desc")
    .filter((q) => q.eq(q.field("status"), "active"))
    .first();
}

/** Deletes the account at Composio. Best-effort: our own row is already failed or gone. */
export async function forgetAccount(composioAccountId: string): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return;
  try {
    await deleteAccount(apiKey, composioAccountId);
  } catch (err) {
    console.log(`composio delete ${composioAccountId} failed: ${String(err)}`);
  }
}

/** One row per connector for the rail. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return await Promise.all(
      CONNECTORS.map(async (c) => {
        const row = userId ? await activeConnection(ctx, userId, c.key) : null;
        return {
          key: c.key,
          label: c.label,
          forKind: c.forKind,
          configured: isConfigured(c, process.env),
          connected: !!row,
          accountLabel: row?.accountLabel ?? null,
        };
      }),
    );
  },
});

/** The write behind `start`, so it goes through requireMember like every other write. */
export const begin = internalMutation({
  args: { connector: connectorKey, state: v.string() },
  handler: async (ctx, a) => {
    const user = await requireMember(ctx);
    await ctx.db.insert("connections", {
      userId: user._id,
      connector: a.connector,
      status: "pending",
      state: a.state,
      createdAt: Date.now(),
    });
    return user._id;
  },
});

export const start = action({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }): Promise<string> => {
    const c = connectorByKey(connector);
    const apiKey = process.env.COMPOSIO_API_KEY;
    const authConfigId = process.env[c.authConfigEnv];
    if (!apiKey || !authConfigId) throw new ConvexError(`${c.label} is not set up yet.`);

    // Minted in an action, where randomness is real. Single use: the callback
    // only accepts a row that is still pending.
    const state = crypto.randomUUID();
    const userId: Id<"users"> = await ctx.runMutation(internal.connections.begin, { connector, state });
    try {
      return await link(apiKey, {
        authConfigId,
        userId,
        callbackUrl: `${process.env.CONVEX_SITE_URL}/composio/callback?state=${state}`,
      });
    } catch (err) {
      await ctx.runMutation(internal.connections.settle, { state, ok: false });
      throw new ConvexError(`Couldn't reach Composio: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export const byState = internalQuery({
  args: { state: v.string() },
  handler: async (ctx, { state }) =>
    await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", state)).unique(),
});

/** Ends a pending row: active (replacing any older grant) or failed. */
export const settle = internalMutation({
  args: {
    state: v.string(),
    ok: v.boolean(),
    composioAccountId: v.optional(v.string()),
    accountLabel: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("connections").withIndex("by_state", (q) => q.eq("state", a.state)).unique();
    if (!row || row.status !== "pending") return null;
    if (!a.ok) {
      await ctx.db.patch("connections", row._id, { status: "failed" });
      return null;
    }
    const older = await ctx.db
      .query("connections")
      .withIndex("by_userId_and_connector", (q) => q.eq("userId", row.userId).eq("connector", row.connector))
      .take(50);
    for (const o of older) if (o.status === "active") await ctx.db.patch("connections", o._id, { status: "failed" });
    await ctx.db.patch("connections", row._id, {
      status: "active",
      composioAccountId: a.composioAccountId,
      accountLabel: a.accountLabel,
    });
    return null;
  },
});

export const drop = internalMutation({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }) => {
    const user = await requireMember(ctx);
    const row = await activeConnection(ctx, user._id, connector);
    if (!row) return null;
    await ctx.db.patch("connections", row._id, { status: "failed" });
    return row.composioAccountId ?? null;
  },
});

export const disconnect = action({
  args: { connector: connectorKey },
  handler: async (ctx, { connector }): Promise<null> => {
    const accountId: string | null = await ctx.runMutation(internal.connections.drop, { connector });
    if (accountId) await forgetAccount(accountId);
    return null;
  },
});

/** Scheduled by `users.purge` for each live grant it deletes. */
export const forget = internalAction({
  args: { composioAccountId: v.string() },
  handler: async (_ctx, { composioAccountId }) => {
    await forgetAccount(composioAccountId);
    return null;
  },
});

/**
 * GET /composio/callback?state=…&status=…&connected_account_id=…
 *
 * The query string is only the browser's word. The user is whoever the
 * `state` row says, and Composio's own record of the account must agree
 * before anything goes active. A user id in the URL is never read.
 */
export const callback = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const state = url.searchParams.get("state");
  const row: Doc<"connections"> | null = state ? await ctx.runQuery(internal.connections.byState, { state }) : null;
  if (!state || !row || row.status !== "pending") {
    return new Response("This connect link is unknown or was already used.", { status: 400 });
  }
  const c = connectorByKey(row.connector);
  const back = (query: string) =>
    new Response(null, { status: 302, headers: { Location: `${process.env.SITE_URL}/app?${query}` } });
  const fail = async () => {
    await ctx.runMutation(internal.connections.settle, { state, ok: false });
    return back(`connect_failed=${c.key}`);
  };

  const accountId = url.searchParams.get("connected_account_id");
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (url.searchParams.get("status") !== "success" || !accountId || !apiKey) return await fail();

  let account: Account;
  try {
    account = await getAccount(apiKey, accountId);
  } catch {
    return await fail();
  }
  if (account.userId !== row.userId || account.authConfigId !== process.env[c.authConfigEnv] || account.status !== "ACTIVE") {
    return await fail();
  }

  await ctx.runMutation(internal.connections.settle, { state, ok: true, composioAccountId: account.id });
  return back(`connected=${c.key}`);
});
```

`convex/http.ts`:
```ts
import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { callback } from "./connections";

const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ path: "/composio/callback", method: "GET", handler: callback });
export default http;
```

In `convex/users.ts` `purge`, replace the connections loop from Task 2 with:
```ts
    for (const r of connections) {
      // Our row goes now; Composio's copy of the grant goes with it.
      if (r.status === "active" && r.composioAccountId) {
        await ctx.scheduler.runAfter(0, internal.connections.forget, { composioAccountId: r.composioAccountId });
      }
      await ctx.db.delete("connections", r._id);
    }
```

- [ ] **Step 6: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/composio.ts convex/connections.ts convex/composio.test.ts convex/http.ts convex/users.ts convex/surfaces.test.ts convex/_generated
git commit -m "Connect Gmail/Slack through Composio: REST client, one-hop connect, verified callback"
```

---

### Task 4: Send on approval, and write the send back into the brain

**Files:**
- Create: `convex/send.ts`
- Modify: `convex/outbox.ts` (imports, new `assertCanSend`, `decide`, new `resend`), `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `connectorFor`, `connectorByKey`, `isConfigured`, `sentFact`, `ConnectorKey` (Task 1); `sendBlocked`, `tooManySends`, `DAY_WINDOW`, `dayStart` (`lib/caps.ts`); `execute` and `activeConnection` (Task 3); `insertFact` with `visibility` (Task 2).
- Produces:
  ```ts
  api.outbox.decide({ actionId, decision, edits?, reason? }) => null | { needsConnect: ConnectorKey }
  api.outbox.resend({ actionId }) => null
  internal.send.load({ actionId }) => { ownerId: Id<"users">; connector: ConnectorKey; draft: Draft; composioAccountId: string | null } | null
  internal.send.go({ actionId }) => null
  internal.send.finish({ actionId, ok: boolean, error?: string }) => null
  ```

- [ ] **Step 1: Write the failing tests**

In `convex/surfaces.test.ts` `setup()`, add before `return` (and add `seedActive` to the returned object):
```ts
  const seedActive = (userId: Id<"users">, connector: "gmail" | "slack" = "gmail") =>
    t.run((ctx) =>
      ctx.db.insert("connections", { userId, connector, status: "active", composioAccountId: "ca_1", state: "s0", createdAt: Date.now() }),
    );
```
Append the tests:
```ts
test("approving without a connected account asks to connect and keeps the edits", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);

  expect(
    await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Edited body" } }),
  ).toEqual({ needsConnect: "gmail" });
  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("pending");
  expect(row?.accepted?.body).toBe("Edited body");
  // Nothing is learned until it's actually decided.
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);
});

test("approving with a connected account sends it and files an owner-only fact", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  const f = stubFetch({ successful: true, data: {} });

  expect(await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" })).toBe(null);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("sending");

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const sent = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(sent).toMatchObject({ status: "sent", connector: "gmail" });
  expect(sent?.sentAt).toBeTypeOf("number");
  expect(String(f.mock.calls[0][0])).toContain("GMAIL_SEND_EMAIL");
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toMatchObject({
    user_id: a,
    connected_account_id: "ca_1",
    arguments: { recipient_email: "ann@acme.com", subject: "Pricing", body: "Secret body" },
  });
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toEqual([
    expect.objectContaining({ title: "emailed ann@acme.com about Pricing", kind: "note", visibility: "owner", ownerId: a }),
  ]);
});

test("a failed send keeps Composio's reason and can be retried", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  stubFetch({ error: { message: "invalid_grant" } }, 401);

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const failed = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(failed?.status).toBe("failed");
  expect(failed?.sendError).toMatch(/invalid_grant/);
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);

  stubFetch({ successful: true, data: {} });
  await asUser(a).mutation(api.outbox.resend, { actionId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const retried = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(retried?.status).toBe("sent");
  expect(retried?.sendError).toBeUndefined();
});

test("the twenty-first send of the day is refused", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const { actionId, internId } = await seedDraft(a);
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) {
      await ctx.db.insert("actions", {
        ownerId: a,
        internId,
        kind: "email",
        status: "sent",
        title: "t",
        draft: { to: ["x@example.com"], subject: "s", body: "b" },
        rationale: "because",
        sources: [],
        recalledCorrection: false,
        decidedAt: Date.now(),
        connector: "gmail",
      });
    }
  });
  await expect(asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" })).rejects.toThrow(/20 sends/);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("pending");
});

test("a lesson from a draft that could reach a real person stays private", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const { actionId } = await seedDraft(a);
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "reject", reason: "wrong person" });
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toEqual([
    expect.objectContaining({ kind: "correction", visibility: "owner" }),
  ]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run convex/surfaces.test.ts`
Expected: FAIL — `decide` returns `null` instead of `{ needsConnect: "gmail" }`; `api.outbox.resend` does not exist.

- [ ] **Step 3: `convex/send.ts`**

```ts
import { v } from "convex/values";
import { execute } from "../lib/composio.ts";
import { type ConnectorKey, connectorByKey, sentFact } from "../lib/connectors.ts";
import type { Draft } from "../lib/types.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { activeConnection } from "./connections";
import { insertFact } from "./facts";

/**
 * One approved draft going out through its owner's own account. Plain fetch,
 * so no "use node". `outbox.decide` / `outbox.resend` set `sending` and
 * schedule `go`; `finish` records the outcome and the write-back fact in one
 * transaction.
 */

type Job = { ownerId: Id<"users">; connector: ConnectorKey; draft: Draft; composioAccountId: string | null };

export const load = internalQuery({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }): Promise<Job | null> => {
    const a = await ctx.db.get("actions", actionId);
    if (!a || a.status !== "sending" || !a.connector) return null;
    const conn = await activeConnection(ctx, a.ownerId, a.connector);
    return {
      ownerId: a.ownerId,
      connector: a.connector,
      draft: a.accepted ?? a.draft,
      composioAccountId: conn?.composioAccountId ?? null,
    };
  },
});

export const go = internalAction({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const job: Job | null = await ctx.runQuery(internal.send.load, { actionId });
    if (!job) return null;
    const c = connectorByKey(job.connector);
    const apiKey = process.env.COMPOSIO_API_KEY;

    // Only the Composio call is inside the try: if recording a success threw
    // and landed in the catch, the draft would read `failed` and a retry
    // would send it twice.
    let error: string | null = null;
    try {
      if (!apiKey || !job.composioAccountId) throw new Error(`${c.label} isn't connected any more. Reconnect it and retry.`);
      await execute(apiKey, c.sendTool, {
        userId: job.ownerId,
        accountId: job.composioAccountId,
        arguments: c.toArguments(job.draft),
      });
    } catch (err) {
      error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    }
    await ctx.runMutation(internal.send.finish, error ? { actionId, ok: false, error } : { actionId, ok: true });
    return null;
  },
});

export const finish = internalMutation({
  args: { actionId: v.id("actions"), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.status !== "sending" || !action.connector) return null;
    const c = connectorByKey(action.connector);
    const log = (level: "ok" | "err", text: string) => ctx.db.insert("logs", { internId: action.internId, level, text });

    if (!a.ok) {
      const reason = a.error ?? "send failed";
      await ctx.db.patch("actions", action._id, { status: "failed", sendError: reason });
      await log("err", `send failed: ${reason}`);
      return null;
    }

    const now = Date.now();
    await ctx.db.patch("actions", action._id, { status: "sent", sentAt: now });
    // The brain updates the moment it goes out. Owner-only: it's their account.
    const fact = sentFact(c.key, action.accepted ?? action.draft, now);
    await insertFact(ctx, { ...fact, kind: "note", visibility: "owner", ownerId: action.ownerId, internId: action.internId });
    await log("ok", `Sent from your ${c.label}.`);
    return null;
  },
});
```

- [ ] **Step 4: `decide`, `resend` and the send cap in `convex/outbox.ts`**

Replace the imports with:
```ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  DAY_WINDOW,
  MAX_FACT_CHARS,
  MAX_RECIPIENT_CHARS,
  MAX_RECIPIENTS,
  dayStart,
  sendBlocked,
  tooManySends,
} from "../lib/caps.ts";
import { type ConnectorKey, connectorByKey, connectorFor, isConfigured } from "../lib/connectors.ts";
import { changedFields, correctionFromEdit, correctionFromReject, editRatio } from "../lib/edits.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { ownerView, requireMember } from "./access";
import { activeConnection } from "./connections";
import { insertFact } from "./facts";
```
Add above `decide`:
```ts
/**
 * SENDS_PER_DAY, counted from drafts decided today that went through a
 * connected account. Same overflow rule as `dispatch`: a day that doesn't
 * fit the read window is refused rather than miscounted.
 */
async function assertCanSend(ctx: MutationCtx, ownerId: Id<"users">) {
  const today = await ctx.db
    .query("actions")
    .withIndex("by_ownerId_and_decidedAt", (q) => q.eq("ownerId", ownerId).gte("decidedAt", dayStart(Date.now())))
    .take(DAY_WINDOW + 1);
  if (today.length > DAY_WINDOW) throw new ConvexError(tooManySends);
  const blocked = sendBlocked(today.filter((a) => a.connector).length);
  if (blocked) throw new ConvexError(blocked);
}
```
Replace `decide` and its doc comment:
```ts
/**
 * Approve (optionally edited) or reject. An edit becomes a preference fact and
 * a rejection becomes a correction fact, which the next intern recalls. That
 * is the learning loop.
 *
 * Sandbox unless this kind of draft has a connector the deployment is set up
 * for. Then: no connected account → `{ needsConnect }` and the draft waits
 * with its edits saved; a connected account → `sending`, and `send.go` takes it.
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
  handler: async (ctx, a): Promise<null | { needsConnect: ConnectorKey }> => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", a.actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can decide on its draft.");
    }
    if (action.status !== "pending") throw new ConvexError("Already decided.");
    const now = Date.now();
    const log = (level: "ok" | "warn", text: string) =>
      ctx.db.insert("logs", { internId: action.internId, level, text });

    const connector = connectorFor(action.kind);
    const live = connector && isConfigured(connector, process.env) ? connector : null;
    const connection = live ? await activeConnection(ctx, user._id, live.key) : null;
    // A draft that can reach a real person may name one, so what's learned
    // from it stays with its owner. A sandbox draft only ever had placeholders.
    const visibility = connection ? ("owner" as const) : undefined;

    if (a.decision === "reject") {
      const reason = (a.reason ?? "").trim().slice(0, 500) || "no reason given";
      await ctx.db.patch("actions", action._id, { status: "rejected", decision: "rejected", reason, decidedAt: now });
      const c = correctionFromReject(action.kind, action.draft, reason);
      await insertFact(ctx, { ...c, kind: "correction", visibility, ownerId: user._id, internId: action.internId });
      await log("warn", visibility ? "rejected · learned a correction, private to you" : `rejected · learned: ${c.title}`);
      return null;
    }

    // No edits this time means: keep the ones saved while the person went to
    // connect their account.
    const accepted = a.edits ? { ...action.draft, ...capEdits(a.edits) } : (action.accepted ?? action.draft);
    const fields = changedFields(action.draft, accepted);

    if (live && !connection) {
      // Approving is the intent; sending waits for the account.
      if (fields.length) await ctx.db.patch("actions", action._id, { accepted, editedFields: fields });
      return { needsConnect: live.key };
    }
    if (live) await assertCanSend(ctx, user._id);

    await ctx.db.patch("actions", action._id, {
      status: live ? "sending" : "approved",
      decision: fields.length ? "edited" : "approved_unedited",
      editRatio: editRatio(action.draft, accepted),
      decidedAt: now,
      ...(live ? { connector: live.key } : {}),
      ...(fields.length ? { accepted, editedFields: fields } : {}),
    });
    if (fields.length) {
      const c = correctionFromEdit(action.kind, action.draft, accepted, fields);
      await insertFact(ctx, { ...c, kind: "preference", visibility, ownerId: user._id, internId: action.internId });
      await log("ok", visibility ? "learned a preference from your edit, private to you" : `learned: ${c.title}`);
    }
    if (live) {
      await ctx.scheduler.runAfter(0, internal.send.go, { actionId: action._id });
      await log("ok", `Approved. Sending from your ${live.label}…`);
    } else {
      await log("ok", "Approved. Sandbox: nothing was sent.");
    }
    return null;
  },
});

/** A failed send, tried again as it was approved. Costs a send like any other. */
export const resend = mutation({
  args: { actionId: v.id("actions") },
  handler: async (ctx, { actionId }) => {
    const user = await requireMember(ctx);
    const action = await ctx.db.get("actions", actionId);
    if (!action || action.ownerId !== user._id) {
      throw new ConvexError("Only the person who briefed this intern can send its draft.");
    }
    if (action.status !== "failed" || !action.connector) throw new ConvexError("Only a failed send can be retried.");
    const c = connectorByKey(action.connector);
    if (!isConfigured(c, process.env) || !(await activeConnection(ctx, user._id, c.key))) {
      throw new ConvexError(`Connect ${c.label} first.`);
    }
    await assertCanSend(ctx, user._id);
    await ctx.db.patch("actions", actionId, { status: "sending", sendError: undefined, decidedAt: Date.now() });
    await ctx.db.insert("logs", { internId: action.internId, level: "ok", text: `Retrying from your ${c.label}…` });
    await ctx.scheduler.runAfter(0, internal.send.go, { actionId });
    return null;
  },
});
```

- [ ] **Step 5: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass. `engine.test.ts` passes unchanged: with no Composio env, every approval takes the sandbox path and returns `null`.

- [ ] **Step 6: Commit**

```bash
git add convex/send.ts convex/outbox.ts convex/surfaces.test.ts convex/_generated
git commit -m "Send approved drafts from the member's own account, and file each send as an owner-only fact"
```

---

### Task 5: The brief knows when drafts are real; the cockpit connects, sends and retries

**Files:**
- Modify: `lib/brief.ts`, `lib/brief.test.ts`, `convex/interns.ts` (`start`), `convex/run.ts:42`
- Modify: `components/BrainRail.tsx`, `components/Outbox.tsx`, `components/Cockpit.tsx`
- Test: `lib/brief.test.ts`, `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `CONNECTORS`, `isConfigured`, `ConnectorKey` (Task 1); `activeConnection`, `api.connections.mine/start/disconnect` (Task 3); `api.outbox.decide` result and `api.outbox.resend` (Task 4).
- Produces:
  ```ts
  brief(task: string, recalled: Recalled[], sendsFrom?: string[]): string   // labels, e.g. ["Gmail"]
  internal.interns.start({ internId }) => { task: string; ownerId: Id<"users">; sendsFrom: string[] } | null
  // components/BrainRail.tsx
  export type ConnectorRow = { key: ConnectorKey; label: string; forKind: ActionKind; configured: boolean; connected: boolean; accountLabel: string | null };
  // components/Outbox.tsx props gain: sendsVia: Partial<Record<ActionKind, string>>; onResend: (id: string) => void
  ```

- [ ] **Step 1: Write the failing tests**

Append to `lib/brief.test.ts`:
```ts
test("a connected member's intern is told drafts go out for real", () => {
  const text = brief("Email Ann", [], ["Gmail", "Slack"]);
  assert.match(text, /Drafts go out for real from Gmail and Slack once the person approves\./);
  assert.match(text, /Use real recipients only if the task names them; never invent an address\./);
  assert.ok(!text.includes("public sandbox"));
});

test("with nothing connected the sandbox rule stays", () => {
  assert.match(brief("x", [], []), /public sandbox/);
  assert.ok(!brief("x", []).includes("go out for real"));
});
```

Append to `convex/surfaces.test.ts`:
```ts
test("an intern whose owner connected Gmail is briefed to send for real", async () => {
  composioEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: a, task: "t", status: "queued", countsTowardCap: true }));
  expect(await t.mutation(internal.interns.start, { internId })).toEqual({ task: "t", ownerId: a, sendsFrom: ["Gmail"] });
});

test("without Composio's env the intern stays in the sandbox", async () => {
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: a, task: "t", status: "queued", countsTowardCap: true }));
  expect(await t.mutation(internal.interns.start, { internId })).toEqual({ task: "t", ownerId: a, sendsFrom: [] });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test && npx vitest run convex/surfaces.test.ts`
Expected: FAIL — the brief still says "public sandbox"; `start` returns no `sendsFrom`.

- [ ] **Step 3: The brief**

In `lib/brief.ts`, above `brief` add:
```ts
const SANDBOX = `This is a public sandbox shared by everyone trying Intern. Nothing you draft is
ever sent. Use plausible placeholders for recipients (#general, name@example.com)
and never ask for or repeat anyone's real contact details.`;

/** Said instead of SANDBOX once the member has connected an account a draft can go out through. */
const live = (labels: string[]) =>
  `Drafts go out for real from ${labels.join(" and ")} once the person approves. Use real recipients only if the task names them; never invent an address.`;
```
Change the signature to `export function brief(task: string, recalled: Recalled[], sendsFrom: string[] = []): string {` and replace the three template lines
```
This is a public sandbox shared by everyone trying Intern. Nothing you draft is
ever sent. Use plausible placeholders for recipients (#general, name@example.com)
and never ask for or repeat anyone's real contact details.
```
with the single line
```
${sendsFrom.length ? live(sendsFrom) : SANDBOX}
```
Replace the last line with (the version now covers both variants, so it changes, which the spec intends):
```ts
export const PROMPT_VERSION = fnv(brief("{task}", []) + brief("{task}", [], ["{label}"]));
```

- [ ] **Step 4: `start` reports the member's live accounts; `run` passes them on**

In `convex/interns.ts` add imports:
```ts
import { CONNECTORS, isConfigured } from "../lib/connectors.ts";
import { activeConnection } from "./connections";
```
In `start`, replace the final `patch` + `return` with:
```ts
    // Which of the owner's accounts a draft from this run would really go out through.
    const sendsFrom: string[] = [];
    for (const c of CONNECTORS) {
      if (isConfigured(c, process.env) && (await activeConnection(ctx, i.ownerId, c.key))) sendsFrom.push(c.label);
    }
    await ctx.db.patch("interns", internId, { status: "running", startedAt: Date.now(), promptVersion: PROMPT_VERSION });
    return { task: i.task, ownerId: i.ownerId, sendsFrom };
```
In `convex/run.ts` line 42: `const prompt = brief(started.task, recalled, started.sendsFrom);`

- [ ] **Step 5: The accounts rail**

In `components/BrainRail.tsx`, change the imports and add the row type:
```tsx
import type { ConnectorKey } from "@/lib/connectors";
import type { ActionKind, Graph, GraphNode, NodeKind } from "@/lib/types";

export type ConnectorRow = {
  key: ConnectorKey;
  label: string;
  forKind: ActionKind;
  configured: boolean;
  connected: boolean;
  accountLabel: string | null;
};
```
Add three props to the component (destructuring and type):
```tsx
  connectors,
  onConnect,
  onDisconnect,
```
```tsx
  connectors: ConnectorRow[];
  onConnect: (key: ConnectorKey) => void;
  onDisconnect: (key: ConnectorKey) => void;
```
Insert after the `brain` section:
```tsx
      <Section title="accounts">
        {connectors.map((c) => (
          <Row key={c.key} k={c.label.toLowerCase()}>
            {!c.configured ? (
              <span className="text-faint">not set up yet</span>
            ) : c.connected ? (
              <span className="text-dim">
                connected as {c.accountLabel ?? c.label} ·{" "}
                <button type="button" onClick={() => onDisconnect(c.key)} className="text-faint hover:text-err">
                  disconnect
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => onConnect(c.key)} className="text-accent hover:underline">
                connect
              </button>
            )}
          </Row>
        ))}
      </Section>
```

- [ ] **Step 6: The outbox**

In `components/Outbox.tsx`:
- Imports: add `import { CONNECTORS } from "@/lib/connectors";` and add `ActionKind` to the `@/lib/types` type import.
- Replace the `Outbox` signature and first line of its body:
```tsx
export default function Outbox({
  actions,
  sendsVia,
  onDecide,
  onResend,
}: {
  actions: ProposedAction[];
  /** The connected account each draft kind goes out through. Empty means sandbox. */
  sendsVia: Partial<Record<ActionKind, string>>;
  onDecide: (id: string, decision: Decision) => void;
  onResend: (id: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const live = Object.keys(sendsVia).length > 0;
```
- Replace `<span className="border border-warn/40 px-1 text-warn">sandbox</span>` with:
```tsx
          {live ? (
            <span className="border border-ok/40 px-1 text-ok">live</span>
          ) : (
            <span className="border border-warn/40 px-1 text-warn">sandbox</span>
          )}
```
- Replace the empty-state paragraph's text with:
```tsx
            nothing waiting. your interns&rsquo; drafts land here.{" "}
            {live ? "approving sends from your connected account." : "approving never sends anything, this is a sandbox."}
```
- Pass the new props down: `<Pending … via={sendsVia[a.kind]} />` and `<Settled … onResend={onResend} />`.
- In `Pending`, add `via` to the props (`via?: string;` in the type, `via,` in the destructuring), and start the fields from any edits saved while the person went to connect:
```tsx
  const start = action.accepted ?? action.draft;
  const [to, setTo] = useState(start.to.join(", "));
  const [subject, setSubject] = useState(start.subject);
  const [body, setBody] = useState(start.body);
```
  and replace the approve button's label expression with:
```tsx
            {via
              ? `${changed.length ? "send with edits" : "approve & send"} via ${via}`
              : changed.length
                ? "approve with edits"
                : "approve (sandbox)"}
```
- In `Settled`, add `onResend: (id: string) => void;` to the props type and `onResend,` to the destructuring, add `const via = CONNECTORS.find((c) => c.key === action.connector)?.label ?? "account";` after `const edited = …`, and replace the `approved` footer block with:
```tsx
      {action.status === "approved" ? <p className="mt-1.5 text-faint">Approved. Sandbox: nothing was sent.</p> : null}
      {action.status === "sending" ? <p className="mt-1.5 text-k-action">sending…</p> : null}
      {action.status === "sent" ? <p className="mt-1.5 text-ok">Sent from your {via}.</p> : null}
      {action.status === "failed" ? (
        <div className="mt-1.5 space-y-1">
          <p className="text-err">{action.sendError ?? "send failed"}</p>
          <button
            type="button"
            onClick={() => onResend(action.id)}
            className="w-full border border-ok/40 py-0.5 text-ok transition-colors hover:bg-ok/10"
          >
            retry send
          </button>
        </div>
      ) : null}
```

- [ ] **Step 7: The cockpit**

In `components/Cockpit.tsx`:
- Imports: `import { useAction, useMutation, useQuery } from "convex/react";`, `import { CONNECTORS, type ConnectorKey } from "@/lib/connectors";`, and add `ActionKind` to the `@/lib/types` type import.
- After `const graphData = …` add `const connectorRows = useQuery(api.connections.mine, {});`
- After `const deleteMineM = …` add:
```ts
  const resendM = useMutation(api.outbox.resend);
  const startConnectA = useAction(api.connections.start);
  const disconnectA = useAction(api.connections.disconnect);
```
- After the `graph` memo add:
```ts
  const sendsVia = useMemo(
    () =>
      Object.fromEntries(
        (connectorRows ?? []).filter((c) => c.configured && c.connected).map((c) => [c.forKind, c.label]),
      ) as Partial<Record<ActionKind, string>>,
    [connectorRows],
  );

  // Back from Composio's consent screen: say how it went, then tidy the URL.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const ok = p.get("connected");
    const bad = p.get("connect_failed");
    if (ok) echo("ok", `connected ${ok}. approve the draft again to send it.`);
    if (bad) echo("err", `couldn't connect ${bad}. try again from the accounts rail.`);
    if (ok || bad) window.history.replaceState(null, "", "/app");
  }, [echo]);
```
- Replace the `decide` callback with these four:
```ts
  const connect = useCallback(
    async (key: ConnectorKey) => {
      try {
        window.location.href = await startConnectA({ connector: key });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [startConnectA, echo],
  );

  const disconnect = useCallback(
    async (key: ConnectorKey) => {
      try {
        await disconnectA({ connector: key });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [disconnectA, echo],
  );

  const decide = useCallback(
    async (id: string, d: Decision) => {
      try {
        if (d.decision === "approve") {
          const { to, cc, subject, body } = d.edits ?? {};
          const r = await decideM({
            actionId: id as Id<"actions">,
            decision: "approve",
            edits: d.edits ? { to, cc, subject, body } : undefined,
          });
          if (r?.needsConnect) {
            const label = CONNECTORS.find((c) => c.key === r.needsConnect)?.label ?? r.needsConnect;
            echo("warn", `connect ${label} to send this. the draft waits here with your edits.`);
            await connect(r.needsConnect);
          }
        } else {
          await decideM({ actionId: id as Id<"actions">, decision: "reject", reason: d.reason });
        }
      } catch (err) {
        echo("err", why(err));
      }
    },
    [decideM, connect, echo],
  );

  const resend = useCallback(
    async (id: string) => {
      try {
        await resendM({ actionId: id as Id<"actions"> });
      } catch (err) {
        echo("err", why(err));
      }
    },
    [resendM, echo],
  );
```
- Render: `<BrainRail graph={graph} hidden={hidden} onToggleKind={toggleKind} selected={selected} onSelect={select} connectors={connectorRows ?? []} onConnect={(k) => void connect(k)} onDisconnect={(k) => void disconnect(k)} />` and `<Outbox actions={outbox} sendsVia={sendsVia} onDecide={decide} onResend={(id) => void resend(id)} />`.

- [ ] **Step 8: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 9: Look at it**

Run: `npm run dev` and open `http://localhost:3000/app` signed in. Dev has no Composio env yet, so the rail's `accounts` section reads `gmail not set up yet` / `slack not set up yet`, the outbox says `sandbox`, and approving a draft still logs `Approved. Sandbox: nothing was sent.` Stop the server.

- [ ] **Step 10: Commit**

```bash
git add lib/brief.ts lib/brief.test.ts convex/interns.ts convex/run.ts convex/surfaces.test.ts components/BrainRail.tsx components/Outbox.tsx components/Cockpit.tsx convex/_generated
git commit -m "Cockpit: connect accounts from the rail, send and retry from the outbox, brief says when drafts are real"
```

---

### Task 6: Broadcast public activity to Discord and Slack

**Files:**
- Create: `lib/broadcast.ts`, `lib/broadcast.test.ts`, `convex/broadcast.ts`
- Modify: `convex/schema.ts` (`broadcasts`), `convex/users.ts` (`accept`), `convex/facts.ts` (`teach`), `convex/outbox.ts` (`decide`), `convex/interns.ts` (`finish`), `convex/send.ts` (`finish`), `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `ownerView` (`convex/access.ts`); the hook points from Tasks 2–4.
- Produces:
  ```ts
  // lib/broadcast.ts
  export const BROADCASTS_PER_HOUR = 30;
  export type BroadcastEvent =
    | { type: "joined"; handle: string }
    | { type: "taught"; handle: string; title: string }
    | { type: "learned"; handle: string; title: string }
    | { type: "drafted"; handle: string; kind: "email" | "slack" | "calendar" }
    | { type: "sent"; handle: string; connector: "gmail" | "slack" };
  export function broadcastText(e: BroadcastEvent, siteUrl: string): string;
  export const discordBody: (text: string) => { content: string; username: "Intern"; allowed_mentions: { parse: never[] } };
  export const slackBody: (text: string) => { text: string };
  export const hourKey: (now: number) => string;   // "2026-09-21T14"
  // convex/broadcast.ts
  export function broadcast(ctx: MutationCtx, e: BroadcastEvent): Promise<void>;
  internal.broadcast.post({ text }) => null
  ```

- [ ] **Step 1: Write the failing tests**

`lib/broadcast.test.ts`:
```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { BROADCASTS_PER_HOUR, broadcastText, discordBody, hourKey, slackBody } from "./broadcast.ts";

const SITE = "https://intern-brain.vercel.app";

test("each event is one public line that links to the member", () => {
  assert.equal(broadcastText({ type: "joined", handle: "ann" }, SITE), "@ann joined the brain · https://intern-brain.vercel.app/u/ann");
  assert.equal(
    broadcastText({ type: "taught", handle: "ann", title: "We ship on Fridays" }, SITE),
    "@ann taught the brain: We ship on Fridays · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "learned", handle: "ann", title: "email: body rewritten before approval" }, SITE),
    "@ann corrected a draft and the brain learned: email: body rewritten before approval · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "drafted", handle: "ann", kind: "email" }, SITE),
    "@ann's intern finished with an email draft · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(
    broadcastText({ type: "drafted", handle: "ann", kind: "slack" }, SITE),
    "@ann's intern finished with a slack draft · https://intern-brain.vercel.app/u/ann",
  );
  assert.equal(broadcastText({ type: "sent", handle: "ann", connector: "gmail" }, SITE), "@ann sent an email · https://intern-brain.vercel.app/u/ann");
  assert.equal(broadcastText({ type: "sent", handle: "ann", connector: "slack" }, SITE), "@ann posted in Slack · https://intern-brain.vercel.app/u/ann");
});

test("long titles are cut to 120 characters", () => {
  const line = broadcastText({ type: "taught", handle: "ann", title: "x".repeat(300) }, SITE);
  assert.ok(line.includes(`: ${"x".repeat(120)} · `));
});

test("Discord pings nobody; Slack's control characters are escaped", () => {
  assert.deepEqual(discordBody("@everyone hi"), { content: "@everyone hi", username: "Intern", allowed_mentions: { parse: [] } });
  assert.deepEqual(slackBody("<!channel> & co"), { text: "&lt;!channel&gt; &amp; co" });
});

test("the throttle counts per UTC hour, thirty to an hour", () => {
  assert.equal(hourKey(Date.UTC(2026, 8, 21, 14, 59)), "2026-09-21T14");
  assert.equal(hourKey(Date.UTC(2026, 8, 21, 15, 0)), "2026-09-21T15");
  assert.equal(BROADCASTS_PER_HOUR, 30);
});
```

Append to `convex/surfaces.test.ts` (and add `import { broadcast } from "./broadcast";` to its imports):
```ts
function broadcastEnv() {
  vi.stubEnv("BROADCAST_DISCORD_WEBHOOK_URL", "https://discord.test/hook");
  vi.stubEnv("BROADCAST_SLACK_WEBHOOK_URL", "https://slack.test/hook");
  vi.stubEnv("SITE_URL", "https://site.test");
}

test("broadcast: off when no webhook is set", async () => {
  const { t } = setup();
  await t.run((ctx) => broadcast(ctx, { type: "joined", handle: "a" }));
  expect(await t.run((ctx) => ctx.db.query("broadcasts").collect())).toHaveLength(0);
});

test("broadcast: thirty an hour reach both webhooks, the thirty-first is dropped", async () => {
  broadcastEnv();
  const f = stubFetch({});
  const { t } = setup();
  for (let i = 0; i < 31; i++) await t.run((ctx) => broadcast(ctx, { type: "joined", handle: `m${i}` }));
  expect((await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count).toBe(30);

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f).toHaveBeenCalledTimes(60);
  const calls = f.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))]);
  expect(calls).toContainEqual([
    "https://discord.test/hook",
    { content: "@m0 joined the brain · https://site.test/u/m0", username: "Intern", allowed_mentions: { parse: [] } },
  ]);
  expect(calls).toContainEqual(["https://slack.test/hook", { text: "@m0 joined the brain · https://site.test/u/m0" }]);
  expect(JSON.stringify(calls)).not.toContain("m30");
});

test("broadcast hooks: joining once and teaching post; accepting again does not", async () => {
  broadcastEnv();
  const { t, asUser } = setup();
  const a = await t.run((ctx) => ctx.db.insert("users", { handle: "ann" }));
  await asUser(a).mutation(api.users.accept, {});
  await asUser(a).mutation(api.users.accept, {});
  await asUser(a).mutation(api.facts.teach, { title: "We ship Fridays", body: "", kind: "note" });
  expect((await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count).toBe(2);
});

test("a successful send broadcasts who sent, never to whom", async () => {
  composioEnv();
  broadcastEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  const f = stubFetch({ successful: true, data: {} });

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const posts = f.mock.calls.filter(([url]) => url === "https://discord.test/hook").map(([, init]) => String(init?.body));
  expect(posts).toEqual([JSON.stringify(discordLine("@a sent an email · https://site.test/u/a"))]);
});

const discordLine = (content: string) => ({ content, username: "Intern", allowed_mentions: { parse: [] } });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test && npx vitest run convex/surfaces.test.ts`
Expected: FAIL — `Cannot find module './broadcast.ts'` and `./broadcast`.

- [ ] **Step 3: `lib/broadcast.ts`**

```ts
/**
 * The community speaking in its own channels. Public information only: who
 * did what, never a recipient, a draft or a private fact. Pure, so node tests it.
 */

export const BROADCASTS_PER_HOUR = 30;

export type BroadcastEvent =
  | { type: "joined"; handle: string }
  | { type: "taught"; handle: string; title: string }
  | { type: "learned"; handle: string; title: string }
  | { type: "drafted"; handle: string; kind: "email" | "slack" | "calendar" }
  | { type: "sent"; handle: string; connector: "gmail" | "slack" };

const cut = (s: string) => s.slice(0, 120);

export function broadcastText(e: BroadcastEvent, siteUrl: string): string {
  const what =
    e.type === "joined"
      ? " joined the brain"
      : e.type === "taught"
        ? ` taught the brain: ${cut(e.title)}`
        : e.type === "learned"
          ? ` corrected a draft and the brain learned: ${cut(e.title)}`
          : e.type === "drafted"
            ? `'s intern finished with ${e.kind === "email" ? "an email" : `a ${e.kind}`} draft`
            : e.connector === "gmail"
              ? " sent an email"
              : " posted in Slack";
  return `@${e.handle}${what} · ${siteUrl}/u/${encodeURIComponent(e.handle)}`;
}

/** Discord: posts as "Intern", and a title reading "@everyone" pings nobody. */
export const discordBody = (text: string) => ({
  content: text,
  username: "Intern" as const,
  allowed_mentions: { parse: [] as never[] },
});

/** Slack: `<` `>` `&` are its control characters, so `<!channel>` in a title stays text. */
export const slackBody = (text: string) => ({
  text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
});

export const hourKey = (now: number) => new Date(now).toISOString().slice(0, 13);
```

- [ ] **Step 4: Schema and `convex/broadcast.ts`**

In `convex/schema.ts` add after `connections`:
```ts
  /** One row per UTC hour: how many broadcasts went out. */
  broadcasts: defineTable({
    hour: v.string(),
    count: v.number(),
  }).index("by_hour", ["hour"]),
```

`convex/broadcast.ts`:
```ts
import { v } from "convex/values";
import { BROADCASTS_PER_HOUR, type BroadcastEvent, broadcastText, discordBody, hourKey, slackBody } from "../lib/broadcast.ts";
import { internal } from "./_generated/api";
import { type MutationCtx, internalAction } from "./_generated/server";

/**
 * Queue one public line for the community's channels. Called from the
 * mutation that made the event, so it only happens if that commits.
 * Throttled per UTC hour; over the cap it's dropped with a log, not queued.
 */
export async function broadcast(ctx: MutationCtx, e: BroadcastEvent): Promise<void> {
  if (!process.env.BROADCAST_DISCORD_WEBHOOK_URL && !process.env.BROADCAST_SLACK_WEBHOOK_URL) return;
  const hour = hourKey(Date.now());
  const row = await ctx.db.query("broadcasts").withIndex("by_hour", (q) => q.eq("hour", hour)).unique();
  if ((row?.count ?? 0) >= BROADCASTS_PER_HOUR) {
    console.log(`broadcast dropped, over ${BROADCASTS_PER_HOUR}/hour: ${e.type} @${e.handle}`);
    return;
  }
  if (row) await ctx.db.patch("broadcasts", row._id, { count: row.count + 1 });
  else await ctx.db.insert("broadcasts", { hour, count: 1 });
  await ctx.scheduler.runAfter(0, internal.broadcast.post, { text: broadcastText(e, process.env.SITE_URL ?? "") });
}

/** POSTs the line to each configured webhook. A dead webhook is logged, never retried. */
export const post = internalAction({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => {
    const targets: [string | undefined, unknown][] = [
      [process.env.BROADCAST_DISCORD_WEBHOOK_URL, discordBody(text)],
      [process.env.BROADCAST_SLACK_WEBHOOK_URL, slackBody(text)],
    ];
    await Promise.all(
      targets.map(async ([url, body]) => {
        if (!url) return;
        try {
          const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (!res.ok) console.log(`broadcast webhook ${res.status}`);
        } catch (err) {
          console.log(`broadcast webhook failed: ${String(err)}`);
        }
      }),
    );
    return null;
  },
});
```

- [ ] **Step 5: Hook the five events**

Each hook imports `import { broadcast } from "./broadcast";` (and `ownerView` from `./access` where not already imported).

`convex/users.ts`, replace `accept` (a second accept is now a no-op, so "joined" fires once):
```ts
export const accept = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const user = userId ? await ctx.db.get("users", userId) : null;
    if (!user) throw new ConvexError("Sign in first.");
    if (user.acceptedAt) return null;
    await ctx.db.patch("users", user._id, { acceptedAt: Date.now() });
    if (!user.bannedAt) await broadcast(ctx, { type: "joined", handle: user.handle ?? user.name ?? "someone" });
    return null;
  },
});
```

`convex/facts.ts`, end of `teach` (a taught fact is always public):
```ts
    const id = await insertFact(ctx, { title, body, kind: args.kind, ownerId: user._id });
    await broadcast(ctx, { type: "taught", handle: user.handle ?? user.name ?? "someone", title });
    return id;
```

`convex/outbox.ts`, in `decide`'s `if (fields.length)` block, after the `log(...)` line (only a public lesson is public information):
```ts
      if (!visibility) await broadcast(ctx, { type: "learned", handle: user.handle ?? user.name ?? "someone", title: c.title });
```

`convex/interns.ts`, in `finish`'s `if (a.action)` block, after the `log("warn", …)` line:
```ts
      await broadcast(ctx, { type: "drafted", handle: (await ownerView(ctx, intern.ownerId)).handle, kind: a.action.kind });
```

`convex/send.ts`, in `finish`'s success path, after the `Sent from your …` log line (add `import { ownerView } from "./access";`):
```ts
    await broadcast(ctx, { type: "sent", handle: (await ownerView(ctx, action.ownerId)).handle, connector: c.key });
```

- [ ] **Step 6: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/broadcast.ts lib/broadcast.test.ts convex/broadcast.ts convex/schema.ts convex/users.ts convex/facts.ts convex/outbox.ts convex/interns.ts convex/send.ts convex/surfaces.test.ts convex/_generated
git commit -m "Broadcast public activity to Discord/Slack webhooks, 30 an hour"
```

---

### Task 7: Inbound — 🧠 in Slack and the `Intern` label in Gmail

**Files:**
- Create: `lib/inbound.ts`, `lib/inbound.test.ts`, `convex/inbound.ts`
- Modify: `convex/schema.ts` (`connections.externalUserId`), `convex/access.ts` (`memberProblem`), `convex/facts.ts` (`factCapBlocked`), `lib/composio.ts` (triggers), `convex/connections.ts` (`settle`, `callback`), `convex/http.ts`, `convex/composio.test.ts`, `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `execute` (Task 3), `activeConnection` (Task 3), `insertFact` (Task 2), `broadcast` (Task 6), `teachBlocked`, `tooManyFacts`, `DAY_WINDOW`, `dayStart`, `MAX_FACT_CHARS` (`lib/caps.ts`).
- Produces:
  ```ts
  // lib/inbound.ts
  export const BRAIN_REACTION = "brain";
  export const TRIGGERS: { slack: { slug: string; config: Record<string, unknown> }; gmail: { slug: string; config: Record<string, unknown> } };
  export const SLACK_TOOLS: { whoami: string; history: string };
  export function sign(secret: string, id: string, timestamp: string, body: string): Promise<string>;
  export function verifyWebhook(secret: string, h: { id: string | null; timestamp: string | null; signature: string | null }, body: string, nowMs?: number): Promise<boolean>;
  export type Envelope = { userId: string; accountId: string | null; trigger: string; data: Record<string, unknown> };
  export function readEnvelope(json: unknown): Envelope | null;
  export type Capture = { connector: "slack"; reaction: string; reactor: string; channel: string; ts: string } | { connector: "gmail"; subject: string; body: string };
  export function toCapture(e: Envelope): Capture | null;
  export function slackFact(text: string): { title: string; body: string } | null;
  export function gmailFact(c: { subject: string; body: string }): { title: string; body: string } | null;
  export const slackHistoryArgs: (channel: string, ts: string) => Record<string, unknown>;
  export function readHistoryText(data: Record<string, unknown>): string | null;
  export function readWhoami(data: Record<string, unknown>): { userId: string | null; label: string | null };
  // lib/composio.ts
  PATHS.triggerUpsert(slug: string): string;
  export function upsertTrigger(apiKey: string, slug: string, a: { accountId: string; config: Record<string, unknown> }): Promise<void>;
  // convex/access.ts
  export function memberProblem(user: Doc<"users"> | null): string | null;
  // convex/facts.ts
  export function factCapBlocked(ctx: QueryCtx, ownerId: Id<"users">): Promise<string | null>;
  // convex/inbound.ts
  export const webhook;   // httpAction, POST /composio/webhook
  internal.inbound.member({ userId: string, accountId: string | null, connector }) => { userId; composioAccountId; externalUserId } | null
  internal.inbound.capture({ userId, title, body, visibility }) => { stored: boolean; reason: string | null }
  ```

- [ ] **Step 1: Confirm triggers, payloads and the webhook scheme against the docs**

Fetch each page and confirm the value written below. Record every difference in `lib/inbound.ts` / `lib/composio.ts` **and** the matching fixtures and expectations in `lib/inbound.test.ts`, `convex/composio.test.ts` and `convex/surfaces.test.ts` together; put the date in `lib/inbound.ts`'s header comment. If a page can't be reached, stop and ask Mihir.

1. `https://docs.composio.dev/docs/triggers` and `https://docs.composio.dev/reference/api-reference/triggers` → how a trigger instance is created for one connected account: the path (`PATHS.triggerUpsert`, written as `/api/v3/trigger_instances/{slug}/upsert`) and body (`triggerBody`: `connected_account_id`, `trigger_config`). Also whether deleting a connected account removes its triggers (if not, add the trigger delete call to `forgetAccount` in this task, with its path in `PATHS`).
2. `https://docs.composio.dev/toolkits/slack` (Triggers section) → the reaction-added trigger slug (`TRIGGERS.slack.slug`, written as `SLACK_REACTION_ADDED`), its config (written as `{}`), and its payload fields: the emoji name (`reaction`), the reactor's Slack user id (`user`), the message's channel and timestamp (`item.channel`, `item.ts`). Copy the docs' example payload's `data` into `SLACK_EVENT` in Step 2. Also note whether a **custom** Slack auth config needs Event Subscriptions pointed at a Composio URL; if so, add that URL to Task 9 Step 3.
3. Same page, Tools section → Slack's who-am-I tool (`SLACK_TOOLS.whoami`, written as `SLACK_TEST_AUTH`, returning `user_id`, `user`, `team`) and its history tool (`SLACK_TOOLS.history`, written as `SLACK_FETCH_CONVERSATION_HISTORY`, arguments `channel`, `latest`, `inclusive`, `limit`, response `messages[].text`).
4. `https://docs.composio.dev/toolkits/gmail` (Triggers section) → the new-message trigger slug (`TRIGGERS.gmail.slug`, written as `GMAIL_NEW_GMAIL_MESSAGE`) and whether its config can filter by label **name** (written as `{ query: "label:Intern" }`). Copy the example payload's `data` into `GMAIL_EVENT`; confirm the subject and body fields (`subject`, `messageText`). **If the trigger can only filter by a label id, stop and ask Mihir** — the fallback (look the id up with Gmail's list-labels tool at connect time) needs the label to exist before connecting, which changes Task 9's setup order.
5. Search the docs for `webhook-signature` (likely `https://docs.composio.dev/docs/webhook-verification`) → the envelope (`metadata.user_id`, `metadata.connected_account_id`, `metadata.trigger_slug`, `data`) and the signature scheme: header names (`webhook-id`, `webhook-timestamp`, `webhook-signature`), signed content (`${id}.${timestamp}.${body}`), HMAC-SHA256, base64, the `v1,` prefix, the tolerance, and whether the secret is used as raw text (written that way) or base64-decoded after a `whsec_` prefix. Change only `sign` / `verifyWebhook` / `readEnvelope` if they differ.

- [ ] **Step 2: Write the failing tests**

`lib/inbound.test.ts`:
```ts
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { TRIGGERS, gmailFact, readEnvelope, readHistoryText, readWhoami, slackFact, toCapture, verifyWebhook } from "./inbound.ts";

const SECRET = "whsec_test";
/** Independent of lib/inbound.ts's own signer, so the scheme is checked, not echoed. */
const nodeSign = (id: string, ts: string, body: string) => createHmac("sha256", SECRET).update(`${id}.${ts}.${body}`).digest("base64");
const now = Date.UTC(2026, 8, 21, 12);
const ts = String(Math.floor(now / 1000));

// Shaped after the docs' example payloads (Task 7 Step 1 replaces `data` with the docs' own).
const SLACK_EVENT = {
  type: "composio.trigger.message",
  metadata: { trigger_slug: TRIGGERS.slack.slug, user_id: "u1", connected_account_id: "ca_1" },
  data: { reaction: "brain", user: "U123", item: { type: "message", channel: "C1", ts: "1726900000.000100" } },
};
const GMAIL_EVENT = {
  type: "composio.trigger.message",
  metadata: { trigger_slug: TRIGGERS.gmail.slug, user_id: "u1", connected_account_id: "ca_2" },
  data: { subject: "Pricing decision", messageText: "We charge per seat." },
};

test("a correctly signed, fresh webhook verifies", async () => {
  const body = JSON.stringify(SLACK_EVENT);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,${nodeSign("msg_1", ts, body)}` }, body, now), true);
  // Several signatures, space-separated, during a secret rotation.
  assert.equal(
    await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,old v1,${nodeSign("msg_1", ts, body)}` }, body, now),
    true,
  );
});

test("a wrong secret, an edited body, a stale timestamp or a missing header fails", async () => {
  const body = JSON.stringify(SLACK_EVENT);
  const sig = `v1,${nodeSign("msg_1", ts, body)}`;
  assert.equal(await verifyWebhook("other", { id: "msg_1", timestamp: ts, signature: sig }, body, now), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, `${body} `, now), false);
  assert.equal(await verifyWebhook(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, body, now + 10 * 60_000), false);
  assert.equal(await verifyWebhook(SECRET, { id: null, timestamp: ts, signature: sig }, body, now), false);
  assert.equal(await verifyWebhook("", { id: "msg_1", timestamp: ts, signature: sig }, body, now), false);
});

test("slack: a reaction maps to who reacted with what, on which message", () => {
  const e = readEnvelope(SLACK_EVENT);
  assert.deepEqual(e && { userId: e.userId, accountId: e.accountId }, { userId: "u1", accountId: "ca_1" });
  assert.deepEqual(e && toCapture(e), { connector: "slack", reaction: "brain", reactor: "U123", channel: "C1", ts: "1726900000.000100" });
});

test("gmail: a labelled message maps to its subject and body", () => {
  const e = readEnvelope(GMAIL_EVENT);
  assert.deepEqual(e && toCapture(e), { connector: "gmail", subject: "Pricing decision", body: "We charge per seat." });
});

test("an unknown trigger, or a payload with no user, is ignored", () => {
  assert.equal(readEnvelope({ data: {} }), null);
  const e = readEnvelope({ ...SLACK_EVENT, metadata: { ...SLACK_EVENT.metadata, trigger_slug: "SOMETHING_ELSE" } });
  assert.equal(e && toCapture(e), null);
});

test("facts from captures: the first line or the subject is the title", () => {
  assert.deepEqual(slackFact("\nWe ship on Fridays\nbecause QA is Thursday"), { title: "We ship on Fridays", body: "because QA is Thursday" });
  assert.equal(slackFact("   "), null);
  assert.deepEqual(gmailFact({ subject: "Pricing decision", body: "We charge per seat." }), {
    title: "Pricing decision",
    body: "We charge per seat.",
  });
  assert.deepEqual(gmailFact({ subject: "", body: "Seat pricing\nmore" }), { title: "Seat pricing", body: "Seat pricing\nmore" });
  assert.ok((gmailFact({ subject: "s", body: "x".repeat(5000) })?.body.length ?? 0) <= 999);
});

test("slack tool replies: the message text and the member's own id", () => {
  assert.equal(readHistoryText({ messages: [{ text: "hello" }] }), "hello");
  assert.equal(readHistoryText({}), null);
  assert.deepEqual(readWhoami({ user_id: "U123", user: "ann", team: "acme" }), { userId: "U123", label: "@ann in acme" });
  assert.deepEqual(readWhoami({}), { userId: null, label: null });
});
```

Append to `convex/composio.test.ts` (and add `upsertTrigger` to its import):
```ts
test("a trigger is created for one connected account", async () => {
  const f = reply({});
  await upsertTrigger("key", "SLACK_REACTION_ADDED", { accountId: "ca_1", config: {} });
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_HOST}${PATHS.triggerUpsert("SLACK_REACTION_ADDED")}`);
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ connected_account_id: "ca_1", trigger_config: {} });
});
```

In `convex/surfaces.test.ts`: add to the imports `import { SLACK_TOOLS, TRIGGERS, sign } from "../lib/inbound.ts";`. Replace `seedActive` in `setup()` with:
```ts
  const seedActive = (userId: Id<"users">, connector: "gmail" | "slack" = "gmail", externalUserId?: string) =>
    t.run((ctx) =>
      ctx.db.insert("connections", {
        userId,
        connector,
        status: "active",
        composioAccountId: "ca_1",
        state: "s0",
        createdAt: Date.now(),
        externalUserId,
      }),
    );
```
Add below `stubFetch`:
```ts
/** Replies by URL: the first key contained in the request URL wins; anything else is a 404. */
function route(table: Record<string, unknown>) {
  const f = vi.fn(async (url: string, _init?: RequestInit) => {
    const hit = Object.entries(table).find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

/** A webhook request signed the way Composio signs one. */
async function signed(payload: unknown, secret = "whsec_test") {
  const body = JSON.stringify(payload);
  const id = "msg_1";
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    body,
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${await sign(secret, id, ts, body)}` },
  };
}

const slackEvent = (userId: string, reactor = "U123", reaction = "brain") => ({
  type: "composio.trigger.message",
  metadata: { trigger_slug: TRIGGERS.slack.slug, user_id: userId, connected_account_id: "ca_1" },
  data: { reaction, user: reactor, item: { type: "message", channel: "C1", ts: "1726900000.000100" } },
});

const gmailEvent = (userId: string) => ({
  type: "composio.trigger.message",
  metadata: { trigger_slug: TRIGGERS.gmail.slug, user_id: userId, connected_account_id: "ca_1" },
  data: { subject: "Pricing decision", messageText: "We charge per seat." },
});
```
Append the tests:
```ts
test("connecting Slack remembers who the member is there and subscribes to reactions", async () => {
  composioEnv();
  const { t, seedUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a, "slack");
  const f = route({
    "/connected_accounts/ca_1": { id: "ca_1", user_id: a, status: "ACTIVE", auth_config: { id: "ac_slack" } },
    [SLACK_TOOLS.whoami]: { successful: true, data: { user_id: "U123", user: "ann", team: "acme" } },
    [TRIGGERS.slack.slug]: {},
  });

  const res = await t.fetch("/composio/callback?state=s1&status=success&connected_account_id=ca_1");
  expect(res.headers.get("location")).toBe("https://site.test/app?connected=slack");
  expect(await t.run((ctx) => ctx.db.query("connections").first())).toMatchObject({
    status: "active",
    externalUserId: "U123",
    accountLabel: "@ann in acme",
  });
  const trigger = f.mock.calls.find(([url]) => url.includes(TRIGGERS.slack.slug));
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({ connected_account_id: "ca_1", trigger_config: TRIGGERS.slack.config });
});

test("webhook: a bad signature is refused with 401", async () => {
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "whsec_test");
  const { t, seedUser } = setup();
  const a = await seedUser("a");
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a), "wrong"))).status).toBe(401);
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);
});

test("webhook: the member's own 🧠 puts the message in the public brain", async () => {
  composioEnv();
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "whsec_test");
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", "U123");
  const f = route({
    [SLACK_TOOLS.history]: { successful: true, data: { messages: [{ text: "We ship on Fridays\nbecause QA is Thursday" }] } },
  });

  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a)))).status).toBe(200);
  expect(JSON.parse(String(f.mock.calls[0][1]?.body)).arguments).toEqual({
    channel: "C1",
    latest: "1726900000.000100",
    inclusive: true,
    limit: 1,
  });
  const facts = await t.run((ctx) => ctx.db.query("facts").collect());
  expect(facts).toEqual([expect.objectContaining({ title: "We ship on Fridays", body: "because QA is Thursday", ownerId: a, kind: "note" })]);
  expect(facts[0]?.visibility).toBeUndefined();
});

test("webhook: someone else's 🧠, or the member's 👍, captures nothing", async () => {
  composioEnv();
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "whsec_test");
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", "U123");
  const f = route({ [SLACK_TOOLS.history]: { successful: true, data: { messages: [{ text: "nope" }] } } });

  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a, "U999")))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a, "U123", "thumbsup")))).status).toBe(200);
  expect(f).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);
});

test("webhook: an Intern-labelled email becomes an owner-only fact", async () => {
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "whsec_test");
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail");
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(a)))).status).toBe(200);
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toEqual([
    expect.objectContaining({ title: "Pricing decision", body: "We charge per seat.", ownerId: a, visibility: "owner" }),
  ]);
});

test("webhook: non-members, unknown users and a full day capture nothing", async () => {
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "whsec_test");
  const { t, seedUser, seedActive } = setup();
  const unconsented = await t.run((ctx) => ctx.db.insert("users", { handle: "u" }));
  await seedActive(unconsented, "gmail");
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(unconsented)))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent("not-an-id")))).status).toBe(200);
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);

  const a = await seedUser("a");
  await seedActive(a, "gmail");
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) await ctx.db.insert("facts", { title: `f${i}`, body: "", kind: "note", ownerId: a, text: `f${i}\n` });
  });
  await t.fetch("/composio/webhook", await signed(gmailEvent(a)));
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(20);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npm test && npx vitest run`
Expected: FAIL — `Cannot find module './inbound.ts'`; `upsertTrigger` is not exported; `/composio/webhook` returns 404.

- [ ] **Step 4: `lib/inbound.ts`**

```ts
import { MAX_FACT_CHARS } from "./caps.ts";

/**
 * Inbound: members add to the brain from their own tools. Every trigger slug,
 * tool slug, payload field and the signature scheme Composio owns lives here.
 * Pure (Web Crypto only), so node tests it with recorded payloads.
 *
 * Confirmed against docs.composio.dev on YYYY-MM-DD (Task 7 Step 1).
 */

export const BRAIN_REACTION = "brain";

export const TRIGGERS = {
  slack: { slug: "SLACK_REACTION_ADDED", config: {} as Record<string, unknown> },
  gmail: { slug: "GMAIL_NEW_GMAIL_MESSAGE", config: { query: "label:Intern" } as Record<string, unknown> },
};

export const SLACK_TOOLS = {
  whoami: "SLACK_TEST_AUTH",
  history: "SLACK_FETCH_CONVERSATION_HISTORY",
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

// --- signature -------------------------------------------------------------

const enc = new TextEncoder();
export const TOLERANCE_S = 300;

/** base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)). */
export async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${id}.${timestamp}.${body}`)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export async function verifyWebhook(
  secret: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_S) return false;
  const expected = await sign(secret, h.id, h.timestamp, body);
  // Several space-separated `v1,<sig>` entries during a secret rotation.
  return h.signature.split(" ").some((s) => same(s.startsWith("v1,") ? s.slice(3) : s, expected));
}

// --- payload ---------------------------------------------------------------

export type Envelope = { userId: string; accountId: string | null; trigger: string; data: Json };

export function readEnvelope(json: unknown): Envelope | null {
  const j = obj(json);
  const m = obj(j.metadata);
  const userId = str(m.user_id);
  const trigger = str(m.trigger_slug);
  if (!userId || !trigger) return null;
  return { userId, accountId: str(m.connected_account_id) ?? null, trigger, data: obj(j.data) };
}

export type Capture =
  | { connector: "slack"; reaction: string; reactor: string; channel: string; ts: string }
  | { connector: "gmail"; subject: string; body: string };

export function toCapture(e: Envelope): Capture | null {
  const d = e.data;
  if (e.trigger === TRIGGERS.slack.slug) {
    const item = obj(d.item);
    const reaction = str(d.reaction);
    const reactor = str(d.user);
    const channel = str(item.channel);
    const ts = str(item.ts);
    if (!reaction || !reactor || !channel || !ts) return null;
    return { connector: "slack", reaction, reactor, channel, ts };
  }
  if (e.trigger === TRIGGERS.gmail.slug) {
    const subject = str(d.subject) ?? "";
    const body = str(d.messageText) ?? "";
    if (!subject && !body) return null;
    return { connector: "gmail", subject, body };
  }
  return null;
}

// --- facts -----------------------------------------------------------------

export function slackFact(text: string): { title: string; body: string } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const title = lines[0].slice(0, 200);
  return { title, body: lines.slice(1).join("\n").slice(0, MAX_FACT_CHARS - title.length) };
}

export function gmailFact(c: { subject: string; body: string }): { title: string; body: string } | null {
  const body = c.body.trim();
  const title = (c.subject.trim() || body.split("\n")[0] || "").slice(0, 200);
  if (!title) return null;
  return { title, body: body.slice(0, MAX_FACT_CHARS - title.length) };
}

// --- slack tool calls ------------------------------------------------------

export const slackHistoryArgs = (channel: string, ts: string): Json => ({ channel, latest: ts, inclusive: true, limit: 1 });

export function readHistoryText(data: Json): string | null {
  const first = Array.isArray(data.messages) ? obj(data.messages[0]) : {};
  return str(first.text) ?? null;
}

export function readWhoami(data: Json): { userId: string | null; label: string | null } {
  const user = str(data.user);
  const team = str(data.team);
  return { userId: str(data.user_id) ?? null, label: user && team ? `@${user} in ${team}` : null };
}
```

- [ ] **Step 5: Triggers in `lib/composio.ts`**

Add to `PATHS`:
```ts
  triggerUpsert: (slug: string) => `/api/v3/trigger_instances/${encodeURIComponent(slug)}/upsert`,
```
Append:
```ts
export const triggerBody = (a: { accountId: string; config: Json }) => ({
  connected_account_id: a.accountId,
  trigger_config: a.config,
});

/** Subscribes one connected account to one trigger; events arrive at the project's webhook. */
export async function upsertTrigger(apiKey: string, slug: string, a: { accountId: string; config: Json }): Promise<void> {
  await call(apiKey, "POST", PATHS.triggerUpsert(slug), triggerBody(a));
}
```

- [ ] **Step 6: Shared member and fact-cap rules**

`convex/access.ts`, replace `requireMember` with:
```ts
/** Why this person may not write to the public brain, or null if they may. */
export function memberProblem(user: Doc<"users"> | null): string | null {
  if (!user) return "Sign in first.";
  if (user.bannedAt) return "This account is blocked from the public brain.";
  if (!user.acceptedAt) return "Accept the public-brain notice first.";
  return null;
}

/**
 * The caller, if they may write to the public brain: signed in, consented,
 * not banned. Every mutation that writes starts here; the inbound webhook,
 * which has no session, applies `memberProblem` itself.
 */
export async function requireMember(ctx: QueryCtx): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get("users", userId) : null;
  const problem = memberProblem(user);
  if (problem !== null || !user) throw new ConvexError(problem ?? "Sign in first.");
  return user;
}
```

`convex/facts.ts`: change the server import to `import { type MutationCtx, type QueryCtx, internalQuery, mutation, query } from "./_generated/server";`. Add above `teach`:
```ts
/** The 20-facts/day rule for anything a person adds, from the cockpit or from their own tools. */
export async function factCapBlocked(ctx: QueryCtx, ownerId: Id<"users">): Promise<string | null> {
  const today = await ctx.db
    .query("facts")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId).gte("_creationTime", dayStart(Date.now())))
    .take(DAY_WINDOW + 1);
  // Same guard as `dispatch`: run-filed facts, corrections and answers share
  // this window without counting, so an overflowed day can't be counted at
  // all — refuse rather than read the first fifty and call it twenty.
  if (today.length > DAY_WINDOW) return tooManyFacts;
  return teachBlocked(today.length);
}
```
In `teach`, replace everything from `const today = …` through `if (blocked) throw new ConvexError(blocked);` with:
```ts
    const blocked = await factCapBlocked(ctx, user._id);
    if (blocked) throw new ConvexError(blocked);
```

- [ ] **Step 7: Remember the Slack member and subscribe at connect**

`convex/schema.ts`, in `connections` after `accountLabel`:
```ts
    /** The member's own id inside the connected tool (Slack user id): who a 🧠 must come from. */
    externalUserId: v.optional(v.string()),
```

`convex/connections.ts`:
- Imports: `import { type Account, deleteAccount, execute, getAccount, link, upsertTrigger } from "../lib/composio.ts";` and `import { SLACK_TOOLS, TRIGGERS, readWhoami } from "../lib/inbound.ts";`.
- `settle`: add `externalUserId: v.optional(v.string()),` to `args`, and `externalUserId: a.externalUserId,` to the final `patch`.
- In `callback`, replace the last two statements (`await ctx.runMutation(internal.connections.settle, …)` and `return back(…)`) with:
```ts
  // Slack names a reactor by Slack user id, so learn which one is this member.
  let who: { userId: string | null; label: string | null } = { userId: null, label: null };
  if (c.key === "slack") {
    try {
      who = readWhoami(await execute(apiKey, SLACK_TOOLS.whoami, { userId: row.userId, accountId: account.id, arguments: {} }));
    } catch (err) {
      console.log(`slack who-am-I failed: ${String(err)}`);
    }
  }
  await ctx.runMutation(internal.connections.settle, {
    state,
    ok: true,
    composioAccountId: account.id,
    externalUserId: who.userId ?? undefined,
    accountLabel: who.label ?? undefined,
  });

  // Inbound is best-effort: an account that can send but not listen is still worth connecting.
  try {
    await upsertTrigger(apiKey, TRIGGERS[c.key].slug, { accountId: account.id, config: TRIGGERS[c.key].config });
  } catch (err) {
    console.log(`composio trigger for ${c.key} failed: ${String(err)}`);
  }
  return back(`connected=${c.key}`);
```

- [ ] **Step 8: `convex/inbound.ts` and the route**

```ts
import { v } from "convex/values";
import { execute } from "../lib/composio.ts";
import {
  BRAIN_REACTION,
  SLACK_TOOLS,
  gmailFact,
  readEnvelope,
  readHistoryText,
  slackFact,
  slackHistoryArgs,
  toCapture,
  verifyWebhook,
} from "../lib/inbound.ts";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { memberProblem, ownerView } from "./access";
import { broadcast } from "./broadcast";
import { activeConnection } from "./connections";
import { factCapBlocked, insertFact } from "./facts";
import { connectorKey, visibility } from "./schema";

/**
 * POST /composio/webhook: members adding to the brain from their own tools.
 * 🧠 on a Slack message → a public fact (reacting is choosing to share it).
 * The `Intern` label on an email → an owner-only fact (it's their mail).
 *
 * Replies 200 to anything signed that it ignores, so Composio doesn't retry.
 */

type Member = { userId: Id<"users">; composioAccountId: string | null; externalUserId: string | null };

/** The payload's user id, mapped through `connections`: a real member with a live grant for this account. */
export const member = internalQuery({
  args: { userId: v.string(), accountId: v.union(v.string(), v.null()), connector: connectorKey },
  handler: async (ctx, a): Promise<Member | null> => {
    const id = ctx.db.normalizeId("users", a.userId);
    const user = id ? await ctx.db.get("users", id) : null;
    if (!user || memberProblem(user)) return null;
    const conn = await activeConnection(ctx, user._id, a.connector);
    if (!conn || (a.accountId !== null && conn.composioAccountId !== a.accountId)) return null;
    return { userId: user._id, composioAccountId: conn.composioAccountId ?? null, externalUserId: conn.externalUserId ?? null };
  },
});

/** requireMember's rules and the 20 facts/day cap, re-checked inside the write. */
export const capture = internalMutation({
  args: { userId: v.id("users"), title: v.string(), body: v.string(), visibility },
  handler: async (ctx, a): Promise<{ stored: boolean; reason: string | null }> => {
    const problem = memberProblem(await ctx.db.get("users", a.userId)) ?? (await factCapBlocked(ctx, a.userId));
    if (problem) return { stored: false, reason: problem };
    await insertFact(ctx, {
      title: a.title,
      body: a.body,
      kind: "note",
      ownerId: a.userId,
      visibility: a.visibility === "owner" ? "owner" : undefined,
    });
    if (a.visibility === "public") {
      await broadcast(ctx, { type: "taught", handle: (await ownerView(ctx, a.userId)).handle, title: a.title });
    }
    return { stored: true, reason: null };
  },
});

export const webhook = httpAction(async (ctx, req) => {
  const body = await req.text();
  const signedOk = await verifyWebhook(
    process.env.COMPOSIO_WEBHOOK_SECRET ?? "",
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    body,
  );
  if (!signedOk) return new Response("bad signature", { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const done = (why: string) => new Response(why, { status: 200 });

  const envelope = readEnvelope(json);
  const cap = envelope ? toCapture(envelope) : null;
  if (!envelope || !cap) return done("ignored");
  const who: Member | null = await ctx.runQuery(internal.inbound.member, {
    userId: envelope.userId,
    accountId: envelope.accountId,
    connector: cap.connector,
  });
  if (!who) return done("not a member");

  let fact: { title: string; body: string } | null;
  if (cap.connector === "slack") {
    // Only the member's own 🧠 puts a message in the public brain.
    if (cap.reaction !== BRAIN_REACTION || !who.externalUserId || cap.reactor !== who.externalUserId) return done("ignored");
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey || !who.composioAccountId) return done("not connected");
    try {
      const data = await execute(apiKey, SLACK_TOOLS.history, {
        userId: who.userId,
        accountId: who.composioAccountId,
        arguments: slackHistoryArgs(cap.channel, cap.ts),
      });
      const text = readHistoryText(data);
      fact = text ? slackFact(text) : null;
    } catch (err) {
      console.log(`slack history lookup failed: ${String(err)}`);
      return done("lookup failed");
    }
  } else {
    fact = gmailFact(cap);
  }
  if (!fact) return done("empty");

  const r: { stored: boolean; reason: string | null } = await ctx.runMutation(internal.inbound.capture, {
    userId: who.userId,
    ...fact,
    visibility: cap.connector === "slack" ? "public" : "owner",
  });
  return done(r.stored ? "captured" : (r.reason ?? "dropped"));
});
```

`convex/http.ts`, add the import `import { webhook } from "./inbound";` and the route:
```ts
http.route({ path: "/composio/webhook", method: "POST", handler: webhook });
```

- [ ] **Step 9: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add lib/inbound.ts lib/inbound.test.ts lib/composio.ts convex/inbound.ts convex/schema.ts convex/access.ts convex/facts.ts convex/connections.ts convex/http.ts convex/composio.test.ts convex/surfaces.test.ts convex/_generated
git commit -m "Inbound: 🧠 in Slack and the Intern label in Gmail add to the brain, through a signed webhook"
```

---

### Task 8: Member pages at `/u/<handle>`

**Files:**
- Modify: `convex/community.ts` (new `member` query), `components/Feed.tsx`
- Create: `components/MemberPage.tsx`, `app/u/[handle]/page.tsx`
- Test: `convex/surfaces.test.ts`

**Interfaces:**
- Consumes: `redactEmails` (Task 1); `visibility`, `sent` status (Task 2/4).
- Produces:
  ```ts
  api.community.member({ handle: string }) => null | {
    handle: string; image: string | null; joinedAt: number;
    facts: { _id: Id<"facts">; title: string; kind: FactKind; at: number }[];      // public only, newest 50
    interns: { _id: Id<"interns">; task: string; status: InternStatus; at: number }[]; // emails redacted, newest 50
    approved: number; sent: number;
  }
  ```

- [ ] **Step 1: Write the failing test**

Append to `convex/surfaces.test.ts`:
```ts
test("a member page shows public work and nothing private", async () => {
  const { t, seedUser, seedDraft } = setup();
  const a = await seedUser("ann");
  const { actionId } = await seedDraft(a);
  await t.run(async (ctx) => {
    await ctx.db.patch("actions", actionId, { status: "sent", decision: "approved_unedited", connector: "gmail", sentAt: Date.now() });
    await ctx.db.insert("facts", { title: "We ship Fridays", body: "", kind: "note", ownerId: a, text: "We ship Fridays\n" });
    await ctx.db.insert("facts", {
      title: "emailed ann@acme.com about Pricing",
      body: "",
      kind: "note",
      visibility: "owner",
      ownerId: a,
      text: "emailed ann@acme.com about Pricing\n",
    });
  });

  const m = await t.query(api.community.member, { handle: "ann" });
  expect(m?.facts.map((f) => f.title)).toEqual(["We ship Fridays"]);
  expect(m?.interns.map((i) => i.task)).toEqual(["email [email] about pricing"]);
  expect(m).toMatchObject({ handle: "ann", approved: 1, sent: 1 });
  expect(JSON.stringify(m)).not.toMatch(/acme\.com|Secret body|Pricing/);

  expect(await t.query(api.community.member, { handle: "nobody" })).toBeNull();
  await t.run((ctx) => ctx.db.insert("users", { handle: "lurker" }));
  expect(await t.query(api.community.member, { handle: "lurker" })).toBeNull();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run convex/surfaces.test.ts`
Expected: FAIL — `api.community.member` does not exist.

- [ ] **Step 3: The query**

Append to `convex/community.ts` (add `import { v } from "convex/values";`):
```ts
/**
 * One member's public page: what they taught the brain and what their
 * interns did. No private facts, drafts or recipients. Unknown, unconsented
 * or banned handles are null, and the page says so.
 *
 * ponytail: newest 200 facts filtered to 50 public ones; last 1,000 drafts
 * for the counts. Aggregate if anyone outgrows that.
 */
export const member = query({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const u = await ctx.db.query("users").withIndex("by_handle", (q) => q.eq("handle", handle)).unique();
    if (!u || !u.acceptedAt || u.bannedAt) return null;
    const joinedAt = u.acceptedAt;
    const [facts, interns, actions] = await Promise.all([
      ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).order("desc").take(200),
      ctx.db.query("interns").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).order("desc").take(50),
      ctx.db.query("actions").withIndex("by_ownerId", (q) => q.eq("ownerId", u._id)).take(1000),
    ]);
    return {
      handle: u.handle ?? handle,
      image: u.image ?? null,
      joinedAt,
      facts: facts
        .filter((f) => f.visibility !== "owner")
        .slice(0, 50)
        .map((f) => ({ _id: f._id, title: f.title, kind: f.kind, at: f._creationTime })),
      interns: interns.map((i) => ({ _id: i._id, task: redactEmails(i.task), status: i.status, at: i._creationTime })),
      approved: actions.filter((a) => a.decision === "approved_unedited" || a.decision === "edited").length,
      sent: actions.filter((a) => a.status === "sent").length,
    };
  },
});
```

- [ ] **Step 4: The page**

`components/MemberPage.tsx`:
```tsx
"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export default function MemberPage({ handle }: { handle: string }) {
  const m = useQuery(api.community.member, { handle });

  if (m === undefined) return <p className="p-6 text-faint">loading…</p>;
  if (m === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
        <p className="text-faint">nobody here by that name.</p>
        <Link href="/" className="border border-line px-3 py-1 text-faint transition-colors hover:border-line-2 hover:text-fg">
          back to the brain
        </Link>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {m.image ? <img src={m.image} alt="" className="size-10 rounded-full" /> : null}
          <div>
            <p className="text-lg text-fg">@{m.handle}</p>
            <p className="text-faint">
              joined {day(m.joinedAt)} · {m.approved} drafts approved · {m.sent} sent
            </p>
          </div>
        </div>

        <p className="label mt-10">taught the brain</p>
        {m.facts.length ? (
          <ul className="mt-3">
            {m.facts.map((f) => (
              <li key={f._id} className="border-b border-line/50 py-1.5 text-dim">
                <span className="text-faint">{f.kind} · </span>
                {f.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-faint">nothing yet.</p>
        )}

        <p className="label mt-10">interns</p>
        {m.interns.length ? (
          <ul className="mt-3">
            {m.interns.map((i) => (
              <li key={i._id} className="flex gap-3 border-b border-line/50 py-1.5">
                <span className="w-16 shrink-0 text-faint">{i.status}</span>
                <span className="min-w-0 text-dim">{i.task}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-faint">none yet.</p>
        )}

        <Link href="/app" className="mt-10 inline-block text-faint hover:text-fg">
          ← the brain
        </Link>
      </div>
    </div>
  );
}
```

`app/u/[handle]/page.tsx` (`@` is reserved for parallel routes in Next, hence `/u/`):
```tsx
import MemberPage from "@/components/MemberPage";

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <MemberPage handle={handle} />;
}
```

`components/Feed.tsx`: add `import Link from "next/link";` and replace `<span className="text-fg">@{e.handle}</span>` with:
```tsx
                <Link href={`/u/${encodeURIComponent(e.handle)}`} className="text-fg hover:underline">
                  @{e.handle}
                </Link>
```

- [ ] **Step 5: Run the gate**

Run: `npx convex dev --once`
Expected: `Convex functions ready!`

Run: `npm test && npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass; the build lists the route `ƒ /u/[handle]`.

- [ ] **Step 6: Look at it**

Run: `npm run dev`. Open `http://localhost:3000/u/<your GitHub handle>`: avatar, join date, counts, your public facts, your interns with addresses shown as `[email]`. Open `http://localhost:3000/u/nobody-here-xyz`: "nobody here by that name." Click a handle in the cockpit's community rail: it opens that page. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add convex/community.ts components/MemberPage.tsx "app/u/[handle]/page.tsx" components/Feed.tsx convex/surfaces.test.ts convex/_generated
git commit -m "Member pages at /u/<handle>: public facts, interns and counts, nothing private"
```

---

### Task 9: Manual setup handoff

**Nothing here is code. Steps marked (Mihir) need his accounts; the agent writes the HANDOVER section and hands him this list verbatim.** Deployments: dev `graceful-albatross-202`, prod `neighborly-peacock-427`; site `https://intern-brain.vercel.app`.

**Files:**
- Modify: `HANDOVER.md` (append a section)

- [ ] **Step 1 (Mihir): Check Composio's trust page first**

Read `https://trust.composio.dev` for the reported May 2026 incident (unconfirmed, from a secondary source) and decide whether Composio may hold members' Gmail/Slack tokens. Don't connect a real member's account before this.

- [ ] **Step 2 (Mihir): Composio projects and API keys**

Create a free Composio account. Make two projects, `intern-dev` and `intern-prod`: the API key and the webhook are per project, and dev and prod need different webhook URLs. Each project's API key is that deployment's `COMPOSIO_API_KEY`.

- [ ] **Step 3 (Mihir): Auth configs, in each project**

- **Gmail:** a Composio-managed Gmail auth config whose scopes include sending (`gmail.send`). Its id (`ac_…`) is `COMPOSIO_AUTH_CONFIG_GMAIL`. The consent screen will say "Composio wants to access your account". Connect a throwaway Gmail first: if Google shows an unverified-app block for sending, switch this auth config to your own Google OAuth app. That is config only; no code changes.
- **Slack:** a **custom** Slack auth config using your Slack app, with **user** scopes (in `user_scopes`, not bot scopes) `chat:write`, `reactions:read`, `channels:history`, `users:read`. In the Slack app (`slack-app-manifest.yml` is the old manifest), set the OAuth redirect URL to the one Composio shows on this auth config's page. If Task 7 Step 1 found the Slack trigger needs Event Subscriptions, set the request URL Composio names there. The auth config's id is `COMPOSIO_AUTH_CONFIG_SLACK`.

- [ ] **Step 4 (Mihir): Webhooks and callbacks**

In each Composio project, set the webhook URL, and copy its signing secret into `COMPOSIO_WEBHOOK_SECRET`:
- dev: `https://graceful-albatross-202.convex.site/composio/webhook`
- prod: `https://neighborly-peacock-427.convex.site/composio/webhook`

Callback URLs. The code sends these itself with every connect link (built from `CONVEX_SITE_URL`). If Composio asks for an allowed-redirect list, add:
- dev: `https://graceful-albatross-202.convex.site/composio/callback`
- prod: `https://neighborly-peacock-427.convex.site/composio/callback`

- [ ] **Step 5 (Mihir): Broadcast channels (optional; unset means off)**

- Discord: channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL → `BROADCAST_DISCORD_WEBHOOK_URL`.
- Slack: api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook to Workspace → pick the channel → `BROADCAST_SLACK_WEBHOOK_URL`.

Use a separate test channel for dev.

- [ ] **Step 6 (Mihir): Set the env on both deployments**

Everything is read by Convex, so Vercel's env doesn't change.

Dev:
```bash
npx convex env set COMPOSIO_API_KEY <intern-dev API key>
npx convex env set COMPOSIO_AUTH_CONFIG_GMAIL <ac_… from intern-dev>
npx convex env set COMPOSIO_AUTH_CONFIG_SLACK <ac_… from intern-dev>
npx convex env set COMPOSIO_WEBHOOK_SECRET <intern-dev webhook secret>
npx convex env set BROADCAST_DISCORD_WEBHOOK_URL <dev channel webhook>
npx convex env set BROADCAST_SLACK_WEBHOOK_URL <dev channel webhook>
npx convex env get SITE_URL
```
Expected last line: `http://localhost:3000`. The callback sends the browser back to `SITE_URL/app`.

Prod: the same six `set` commands with `--prod` and the `intern-prod` values, then:
```bash
npx convex env get SITE_URL --prod
```
Expected: `https://intern-brain.vercel.app`.

- [ ] **Step 7 (Mihir): Gmail label**

In the Gmail account you'll connect, create a label named exactly `Intern`.

- [ ] **Step 8 (Mihir's go-ahead): Deploy, backend first**

1. Push `connectors` to `origin` and open a PR to `main`.
2. `npx convex deploy` (prod, `neighborly-peacock-427`). This needs Mihir's explicit yes in chat. Backend first is safe: the schema is additive, and today's cockpit already filters the outbox to your own rows before reading a draft.
3. Merge the PR; Vercel deploys `main` to production.

- [ ] **Step 9 (Mihir): End-to-end, on dev (`npm run dev`) first, then on prod**

Use two GitHub accounts; the second one in a private window.
1. A: rail → gmail → `connect` → Composio consent → back at `/app`, terminal says `connected gmail`, rail says `connected as Gmail`.
2. A: brief "Email <A's other address> to say hello". Approve → `approve & send via Gmail`. The email arrives; the outbox says `Sent from your Gmail.`; A's graph gains `emailed … about …`.
3. B: the feed shows `@A ✉ sent`; B's graph shows `✉ sent`, no recipient, and not A's `emailed …` fact; B's terminal shows none of A's streamed output.
4. A: connect Slack, brief a post to a test channel, approve: it posts as A.
5. A: react 🧠 to a Slack message: within a minute it's a public fact titled with its first line. React 👍: nothing.
6. A: label an email `Intern`: an owner-only fact appears for A only.
7. The broadcast channels show `@A joined the brain`, `@A taught the brain: …`, `@A sent an email`, each with a `/u/A` link and no recipient.
8. `/u/A` shows A's public facts, interns (addresses as `[email]`) and counts. `/u/nobody-here-xyz` says `nobody here by that name.`
9. A: `disconnect` Gmail: the rail says `connect`, and the account is gone from Composio's dashboard.

- [ ] **Step 10: Record it in HANDOVER.md and commit**

Append a "Community surfaces (YYYY-MM-DD)" section to `HANDOVER.md`:
- Composio projects: `intern-dev` → `graceful-albatross-202`, `intern-prod` → `neighborly-peacock-427`
- The six env vars, and that unset `COMPOSIO_*` means sandbox and unset `BROADCAST_*` means no broadcasts
- The callback and webhook URLs from Step 4
- Caps: 20 sends/day per member, 30 broadcasts/hour
- The `Intern` Gmail label and 🧠 reaction
- Admin: `connections` rows in the Convex dashboard; `users:ban` still purges everything, connections included

```bash
git add HANDOVER.md
git commit -m "Handover: community surfaces setup, env and URLs"
```

---

## Self-review (done while writing)

- **Spec coverage:**
  - Registry, `connectorFor`, calendar draft-only: Task 1
  - `connections` table, `actions` statuses and fields, `facts.visibility`, `SENDS_PER_DAY`: Tasks 1, 2
  - Connect flow (`needsConnect`, `connections.start`, callback with Composio verification, redirect, rail): Tasks 3, 4, 5
  - Send flow (cap, `sending`, `send.go`, success and failure, retry): Task 4
  - "Not set up yet" and sandbox when Composio isn't configured: Tasks 3 (`mine`), 4 (`decide`), 5 (rail, outbox)
  - Write-back facts: Tasks 1 (`sentFact`), 4 (`send.finish`)
  - Privacy enforcement (outbox, graph, feed, recall, interns, notice copy): Task 2
  - Brief and `PROMPT_VERSION`: Task 5
  - Broadcast (env, the four events, bodies, 30/hour, link): Task 6
  - Inbound (🧠, Gmail label, signed webhook, member rules, facts cap, pure mapping): Task 7
  - Member pages (route, query, links, unknown handle): Task 8
  - Tests the spec lists: pure ones in Tasks 1, 6, 7; convex-test ones in Tasks 2, 3, 4, 7, 8; `fetch` stubbed everywhere
  - Setup Mihir does, and the manual checks: Task 9
- **Composio values still to confirm** (each is the first step of its task, written against one name): host and paths (`COMPOSIO_HOST`, `PATHS`), request and response fields (`linkBody`, `readAccount`, `executeBody`, `triggerBody`), send tool slugs and arguments (`CONNECTORS`), trigger slugs and config (`TRIGGERS`), Slack tool slugs (`SLACK_TOOLS`), payload fields (`readEnvelope`, `toCapture`, `readHistoryText`, `readWhoami`), and the signature scheme (`sign`, `verifyWebhook`). The `YYYY-MM-DD` in three header comments is filled in at those steps.
- **Types used across tasks:**
  - `ConnectorKey` and `connectorKey` (lib vs. validator) are both `"gmail" | "slack"`
  - `activeConnection(ctx, userId, connector)` is used by `mine`, `decide`, `resend`, `send.load`, `interns.start` and `inbound.member`
  - `insertFact`'s `visibility` is used by `decide`, `send.finish` and `inbound.capture`
  - `decide` returns `null | { needsConnect: ConnectorKey }`, which Cockpit reads as `r?.needsConnect`
  - `interns.start` returns `{ task, ownerId, sendsFrom }`, which `run.go` passes to `recall` and `brief`
  - `broadcast(ctx, BroadcastEvent)` is called from `users.accept`, `facts.teach`, `outbox.decide`, `interns.finish`, `send.finish` and `inbound.capture`
  - `setup()` in `surfaces.test.ts` grows by `seedPending` (Task 3) and `seedActive` (Task 4, widened in Task 7)
- **Known soft spots:**
  - `recall`'s over-read (12 lessons and 15 hits, filtered) can come back thin if many private facts crowd the windows. It's marked `ponytail:`.
  - The Gmail label filter depends on the trigger accepting a label name. Task 7 Step 1 stops for Mihir if it doesn't.
  - Webhook retries after a timeout could file the same 🧠 twice; the handler answers quickly and returns 200 for everything it ignores.
