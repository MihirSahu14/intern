/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { slackSignature } from "../lib/slack.ts";
import { api, internal } from "./_generated/api";
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
const reaction = (name: string, user: string, team = "T1") =>
  envelope(
    { type: "reaction_added", user, reaction: name, item: { type: "message", channel: "C1", ts: TS }, item_user: "U1", event_ts: "1758800300.000400" },
    team,
  );
const edited = (text: string, team = "T1") =>
  envelope(
    {
      type: "message",
      subtype: "message_changed",
      channel: "C1",
      channel_type: "channel",
      message: { type: "message", user: "U1", text, ts: TS },
      previous_message: { type: "message", user: "U1", text: "old", ts: TS },
      ts: "1758800100.000200",
    },
    team,
  );
const deleted = (team = "T1") =>
  envelope(
    {
      type: "message",
      subtype: "message_deleted",
      channel: "C1",
      channel_type: "channel",
      hidden: true,
      deleted_ts: TS,
      previous_message: { type: "message", user: "U1", text: "old", ts: TS },
      ts: "1758800200.000300",
    },
    team,
  );

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

test("slack: a retried delivery can't undo a delete or an edit", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  await post(t, message());
  await post(t, reaction("brain", "U3"));

  // Deleted, then the original "message" event is redelivered (a retry): it must not come back.
  await post(t, deleted());
  expect(await post(t, message())).toBe(200);
  expect(await allPassages(t)).toHaveLength(0);
  expect(await allFacts(t)).toHaveLength(0);
});

test("slack: a retried original message can't revert an edit", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  await post(t, message());
  await post(t, reaction("brain", "U3"));
  await post(t, edited("We ship on Thursdays"));

  // The original (pre-edit) "message" event redelivered: the edit stands.
  expect(await post(t, message())).toBe(200);
  expect((await allPassages(t))[0].text).toBe("We ship on Thursdays");
  expect((await allFacts(t))[0]).toMatchObject({ title: "We ship on Thursdays", body: "We ship on Thursdays" });
});

test("slack: a banned or unconsented linked member's 🧠 promotes nothing", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  const banned = await t.run((ctx) => ctx.db.insert("users", { handle: "x", acceptedAt: Date.now(), bannedAt: Date.now() }));
  const unconsented = await t.run((ctx) => ctx.db.insert("users", { handle: "y" }));
  await linkSlack(t, banned, "U2");
  await linkSlack(t, unconsented, "U4");
  await post(t, message());
  await post(t, reaction("brain", "U2"));
  await post(t, reaction("brain", "U4"));
  expect(await allFacts(t)).toHaveLength(0);
});

test("slack: an edit, a delete or a reaction from another team is ignored", async () => {
  slackEnv();
  const { t } = setup();
  stubSlackApi({});
  await post(t, message());

  expect(await post(t, reaction("brain", "U3", "T9"))).toBe(200);
  expect(await allFacts(t)).toHaveLength(0);
  await post(t, reaction("brain", "U3"));
  expect(await allFacts(t)).toHaveLength(1);

  expect(await post(t, edited("hijacked", "T9"))).toBe(200);
  expect((await allPassages(t))[0].text).toBe("We ship on Fridays\nbecause QA is Thursday");

  expect(await post(t, deleted("T9"))).toBe(200);
  expect(await allPassages(t)).toHaveLength(1);
  expect(await allFacts(t)).toHaveLength(1);
});

test("slack: a validly-signed request with bad JSON is a 400", async () => {
  slackEnv();
  const { t } = setup();
  const body = "{not json";
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await t.fetch("/slack/events", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": await slackSignature(SLACK_SECRET, ts, body),
    },
  });
  expect(res.status).toBe(400);
});

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

test("backfill never resurrects a message deleted in Slack while its page was in flight", async () => {
  vi.stubEnv("SLACK_BRAIN_BOT_TOKEN", "xoxb-test");
  const { t, seedSource } = setup();
  const sourceId = await seedSource({ kind: "slack_channel", label: "#general", externalId: "C1", cursor: "c2" });
  // Deleted (and tombstoned by the webhook) after this history page was fetched, before backfill wrote it.
  await t.run((ctx) => ctx.db.insert("slackTombstones", { sourceId, externalId: "C1:1758700000.000100" }));
  stubSlackApi({
    "conversations.history": [
      { ok: true, messages: [person("deleted meanwhile", "1758700000.000100"), person("still there", "1758700001.000100")], has_more: false },
    ],
  });
  await t.action(internal.ingest.backfillChannel, { sourceIds: [sourceId], oldest: 0 });
  expect((await allPassages(t)).map((p) => p.text)).toEqual(["still there"]);
});
