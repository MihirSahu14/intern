/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { UPLOAD_MAX_BYTES } from "../lib/ingest.ts";
import { slackSignature } from "../lib/slack.ts";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { PASSAGE_BATCH, rewritePassage } from "./sources";

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

test("an owner-only approval of a public passage files the owner's fact once and leaves it promotable", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage, seedDraft } = setup();
  const a = await seedUser("a");
  const doc = await seedSource();
  const p = await seedPassage(doc, "Pricing is per seat");
  // Two drafts that could quote something private (as a connected member's always could), both citing it.
  for (let i = 0; i < 2; i++) {
    const actionId = await seedDraft(a, [`[p:${p}]`], { recalledPrivate: true });
    await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  }
  const facts = await allFacts(t);
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ title: "Pricing is per seat", visibility: "owner", ownerId: a, source: `passage:${p}`, fromPassageId: p });
  expect((await t.run((ctx) => ctx.db.get("passages", p)))?.promotedFactId).toBeUndefined();
  expect((await asUser(a).query(api.sources.passages, { sourceId: doc }))?.passages[0].promoted).toBe(false);

  // A later public promotion makes that same fact public: it says only what the passage says.
  expect(await asUser(a).mutation(api.sources.promote, { passageId: p })).toBe(facts[0]._id);
  const after = await allFacts(t);
  expect(after).toHaveLength(1);
  expect(after[0].visibility).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get("passages", p)))?.promotedFactId).toBe(facts[0]._id);
});

test("after an owner-only approval, someone else's promote still makes a public fact", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage, seedDraft } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const p = await seedPassage(await seedSource(), "Pricing is per seat");
  await asUser(a).mutation(api.outbox.decide, { actionId: await seedDraft(a, [`[p:${p}]`], { recalledPrivate: true }), decision: "approve" });
  const pub = await asUser(b).mutation(api.sources.promote, { passageId: p });
  expect(await t.run((ctx) => ctx.db.get("facts", pub))).toMatchObject({ ownerId: b, fromPassageId: p });
  expect((await t.run((ctx) => ctx.db.get("facts", pub)))?.visibility).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get("passages", p)))?.promotedFactId).toBe(pub);
  expect(await allFacts(t)).toHaveLength(2);
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

test("removing a source with more passages than one batch clears every one of them", async () => {
  const { t, seedUser, asUser, seedSource } = setup();
  const a = await seedUser("a");
  const doc = await seedSource({ ownerId: a });
  await t.run(async (ctx) => {
    for (let i = 0; i < PASSAGE_BATCH + 10; i++) {
      await ctx.db.insert("passages", { sourceId: doc, externalId: String(i), text: `pricing ${i}`, at: i, visibility: "public", ownerId: a });
    }
  });
  await asUser(a).mutation(api.sources.remove, { sourceId: doc });
  expect(await allPassages(t)).toHaveLength(10);
  await settle(t);
  expect(await allPassages(t)).toHaveLength(0);
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
  expect((await t.run((ctx) => ctx.db.get("facts", captured)))?.fromPassageId).toBe((await allPassages(t))[0]._id);
  await post(t, deleted());
  expect(await allFacts(t)).toHaveLength(1);
});

test("slack: a member's owner-only capture doesn't swallow a public 🧠: a public fact is filed beside it", async () => {
  slackEnv();
  const { t, seedUser } = setup();
  stubSlackApi({});
  const a = await seedUser("a");
  await linkSlack(t, a, "U2");
  await post(t, message());
  // Captured through Composio from someone else's message: owner-only, and shaped by slackFact, not passageFact.
  const captured = await t.run((ctx) =>
    ctx.db.insert("facts", {
      title: "We ship on Fridays",
      body: "because QA is Thursday",
      kind: "note",
      ownerId: a,
      visibility: "owner",
      source: `slack:C1:${TS}`,
      text: "We ship on Fridays\nbecause QA is Thursday",
    }),
  );
  await post(t, reaction("brain", "U2"));
  const facts = await allFacts(t);
  expect(facts).toHaveLength(2);
  const pub = facts.find((f) => f._id !== captured)!;
  expect(pub.visibility).toBeUndefined();
  expect((await allPassages(t))[0].promotedFactId).toBe(pub._id);
  expect(facts.find((f) => f._id === captured)?.visibility).toBe("owner");
});

/** A Slack message, then a connected member's approval of a draft citing it: an owner-only fact from a public passage. */
async function ownerOnlyFromSlack() {
  slackEnv();
  const { t, seedUser, asUser, seedDraft } = setup();
  stubSlackApi({});
  const a = await seedUser("a");
  await post(t, message());
  const [p] = await allPassages(t);
  await asUser(a).mutation(api.outbox.decide, { actionId: await seedDraft(a, [`[p:${p._id}]`], { recalledPrivate: true }), decision: "approve" });
  expect(await allFacts(t)).toEqual([expect.objectContaining({ visibility: "owner", ownerId: a, fromPassageId: p._id })]);
  return t;
}

test("slack: a delete removes an owner-only fact promoted from the message too", async () => {
  const t = await ownerOnlyFromSlack();
  await post(t, deleted());
  expect(await allFacts(t)).toHaveLength(0);
});

test("slack: an edit rewrites an owner-only fact promoted from the message too", async () => {
  const t = await ownerOnlyFromSlack();
  await post(t, edited("We ship on Thursdays"));
  expect((await allFacts(t))[0]).toMatchObject({ title: "We ship on Thursdays", body: "We ship on Thursdays", visibility: "owner" });
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

test("the watchdog fails a source never read, and leaves a read one alone", async () => {
  const { t, seedUser, asUser, seedSource } = setup();
  const a = await seedUser("a");
  const stuck = await seedSource({ ownerId: a });
  const read = await seedSource({ ownerId: a, lastSyncedAt: Date.now() });
  await t.mutation(internal.sources.stale, { sourceId: stuck });
  await t.mutation(internal.sources.stale, { sourceId: read });
  expect(await t.run((ctx) => ctx.db.get("sources", stuck))).toMatchObject({ status: "failed", error: "Couldn't read that source." });
  expect(await t.run((ctx) => ctx.db.get("sources", read))).toMatchObject({ status: "active" });

  // Every add path sets it.
  stubPage("hi", "text/plain");
  await asUser(a).mutation(api.sources.addLink, { input: "https://example.com/new", private: false });
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(scheduled.map((s) => s.name).sort()).toEqual(["documents:readUrl", "sources:stale"]);
  await settle(t);
});

test("unclaimed uploads past the hour are swept daily; a source's file and a fresh one stay", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const claimed = await t.run((ctx) => ctx.storage.store(new Blob(["# kept"], { type: "text/markdown" })));
  await asUser(a).mutation(api.sources.addUpload, { storageId: claimed, name: "kept.md", private: false });
  await t.run((ctx) => ctx.storage.store(new Blob(["never added"])));
  await settle(t);
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  const fresh = await t.run((ctx) => ctx.storage.store(new Blob(["uploading now"])));

  await t.mutation(internal.sources.sweepUploads, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const left = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).map((f) => f._id));
  expect(left.sort()).toEqual([claimed, fresh].sort());
});

test("a sweep longer than one page keeps its first run's cutoff, so every page's cursor still fits", async () => {
  const { t } = setup();
  await t.run(async (ctx) => {
    for (let i = 0; i < 101; i++) await ctx.storage.store(new Blob([`never added ${i}`]));
  });
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  await t.mutation(internal.sources.sweepUploads, {});
  const [next] = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect(next.name).toBe("sources:sweepUploads");
  expect(next.args[0]).toMatchObject({ cutoff: Date.now() - 60 * 60_000, cursor: expect.any(String) });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.system.query("_storage").collect())).toHaveLength(0);
});

test("adding the same link twice is refused however many others added it first", async () => {
  const { seedUser, asUser, seedSource } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  for (let i = 0; i < 50; i++) await seedSource({ ownerId: b, externalId: "https://example.com/doc" });
  await seedSource({ ownerId: a, externalId: "https://example.com/doc" });
  await expect(asUser(a).mutation(api.sources.addLink, { input: "https://example.com/doc", private: false })).rejects.toThrow(/already added/);
});

// --- GitHub ------------------------------------------------------------------

/** GitHub's REST API for acme/site, shaped as docs.github.com shows it (Task 7 Step 1). */
function stubGithub(o: { private?: boolean; readme?: string } = {}) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.endsWith("/repos/acme/site/readme")) return new Response(o.readme ?? "# Site\n\nThe marketing site.");
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

test("a repo GitHub 404s reads as gone private, same as a private repo: cleared", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedSource, seedPassage } = setup();
  const sourceId = await seedSource({ kind: "github_repo", label: "acme/site", externalId: "acme/site" });
  await seedPassage(sourceId, "old readme text");
  vi.stubGlobal("fetch", vi.fn<(url: string) => Promise<Response>>(async () => new Response("{}", { status: 404 })));
  await t.action(internal.ingest.syncRepo, { sourceId });
  expect(await t.run((ctx) => ctx.db.get("sources", sourceId))).toMatchObject({ status: "failed", error: "Only public repos can be added." });
  expect(await allPassages(t)).toHaveLength(0);
});

test("a repo gone private leaves nothing recallable, listed or promotable, then nothing at all", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedUser, asUser, seedSource, seedDraft } = setup();
  const a = await seedUser("a");
  const sourceId = await seedSource({ kind: "github_repo", label: "acme/site", externalId: "acme/site", ownerId: a });
  await t.run(async (ctx) => {
    for (let i = 0; i < PASSAGE_BATCH + 10; i++) {
      await ctx.db.insert("passages", { sourceId, externalId: `issue:${i}`, text: `pricing ${i}`, at: i, visibility: "public", ownerId: a });
    }
  });
  vi.stubGlobal("fetch", vi.fn<(url: string) => Promise<Response>>(async () => new Response("{}", { status: 404 })));
  await t.action(internal.ingest.syncRepo, { sourceId });

  // One batch is gone; what's left is already out of reach.
  expect(await allPassages(t)).toHaveLength(10);
  expect(await t.query(internal.facts.archive, { task: "pricing", ownerId: a })).toEqual([]);
  expect(await asUser(a).query(api.sources.passages, { sourceId })).toMatchObject({ status: "failed", passages: [] });
  const left = (await allPassages(t))[0]._id;
  await expect(asUser(a).mutation(api.sources.promote, { passageId: left })).rejects.toThrow(/isn't there/);
  await asUser(a).mutation(api.outbox.decide, { actionId: await seedDraft(a, [`[p:${left}]`]), decision: "approve" });
  expect(await allFacts(t)).toHaveLength(0);

  await settle(t);
  expect(await allPassages(t)).toHaveLength(0);
});

test("a repo's read keeps only what it has now: a README that shrank drops its old chunks", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedSource } = setup();
  const sourceId = await seedSource({ kind: "github_repo", label: "acme/site", externalId: "acme/site" });
  stubGithub({ readme: ["a", "b", "c"].map((c) => c.repeat(900)).join("\n\n") });
  await t.action(internal.ingest.syncRepo, { sourceId });
  expect((await allPassages(t)).map((p) => p.externalId).sort()).toEqual(["issue:1", "pr:2", "readme", "readme:1", "readme:2"]);
  stubGithub({ readme: "# Site\n\nShorter now." });
  await t.action(internal.ingest.syncRepo, { sourceId });
  expect((await allPassages(t)).map((p) => p.externalId).sort()).toEqual(["issue:1", "pr:2", "readme"]);
});

test("a README GitHub doesn't answer for keeps its chunks; the issues are still pruned", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  const { t, seedSource, seedPassage } = setup();
  const sourceId = await seedSource({ kind: "github_repo", label: "acme/site", externalId: "acme/site" });
  await seedPassage(sourceId, "old readme", { externalId: "readme" });
  await seedPassage(sourceId, "old readme part", { externalId: "readme:1" });
  await seedPassage(sourceId, "an old issue", { externalId: "issue:99" });
  const github = stubGithub();
  vi.stubGlobal(
    "fetch",
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) =>
      url.endsWith("/readme") ? new Response("busy", { status: 503 }) : github(url, init),
    ),
  );
  await t.action(internal.ingest.syncRepo, { sourceId });
  expect((await allPassages(t)).map((p) => p.externalId).sort()).toEqual(["issue:1", "pr:2", "readme", "readme:1"]);
});

test("a 403 rate limit or a 503 from GitHub is transient, not a repo gone private: passages and status stay untouched", async () => {
  vi.stubEnv("GITHUB_TOKEN", "github_pat_test");
  for (const status of [403, 503]) {
    const { t, seedSource, seedPassage } = setup();
    const sourceId = await seedSource({ kind: "github_repo", label: "acme/site", externalId: "acme/site" });
    await seedPassage(sourceId, "old readme text");
    vi.stubGlobal(
      "fetch",
      vi.fn<(url: string) => Promise<Response>>(async () => new Response("{}", { status, headers: { "x-ratelimit-remaining": "0" } })),
    );
    await t.action(internal.ingest.syncRepo, { sourceId });
    const s = await t.run((ctx) => ctx.db.get("sources", sourceId));
    expect(s?.status).toBe("failed");
    expect(s?.error).not.toBe("Only public repos can be added.");
    expect(await allPassages(t)).toHaveLength(1);
  }
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
  // An author is redacted like the text.
  await seedPassage(doc, "later", { ownerId: a, visibility: "owner", author: "ann@acme.com", at: Date.UTC(2026, 8, 19) });
  expect((await asUser(a).query(api.sources.passages, { sourceId: doc }))?.passages[0].author).toBe("[email]");
});

test("a re-read that changes nothing writes nothing", async () => {
  const { t, seedSource, seedPassage } = setup();
  const pid = await seedPassage(await seedSource(), "same", { author: "ann", url: "https://example.com/x" });
  await t.run(async (ctx) => {
    const p = (await ctx.db.get("passages", pid))!;
    const patch = vi.spyOn(ctx.db, "patch");
    await rewritePassage(ctx, p, "same", { author: "ann", authorHandle: undefined, url: "https://example.com/x", at: p.at });
    expect(patch).not.toHaveBeenCalled();
    await rewritePassage(ctx, p, "same", { author: "bo" });
    expect(patch).toHaveBeenCalledTimes(1);
  });
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
  const events = await t.query(api.community.feed, {});
  const feed = events.map((e) => e.text);
  expect(feed).toContain("added a source: Handbook");
  // Dated when it was added, not when it was last read: a repo's daily read doesn't bring it back up.
  const handbook = (await t.run((ctx) => ctx.db.query("sources").collect())).find((s) => s.label === "Handbook");
  expect(events.find((e) => e.text === "added a source: Handbook")?.at).toBe(handbook?._creationTime);
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

test("a URL carrying an address is never shown; a clean one is", async () => {
  const { t, seedUser, asUser, seedSource, seedPassage } = setup();
  const a = await seedUser("ann");
  const leaky = await seedSource({ label: "Leaky", ownerId: a, url: "https://example.com/doc?email=ann@acme.com" });
  const clean = await seedSource({ label: "Clean", ownerId: a, url: "https://example.com/handbook" });
  await seedPassage(leaky, "one", { url: "https://example.com/doc?to=bob@acme.com#p1" });
  await seedPassage(clean, "two", { url: "https://example.com/handbook#p2" });

  const l = await asUser(a).query(api.sources.passages, { sourceId: leaky });
  expect(l?.url).toBeNull();
  expect(l?.passages[0].url).toBeNull();
  const c = await asUser(a).query(api.sources.passages, { sourceId: clean });
  expect(c?.url).toBe("https://example.com/handbook");
  expect(c?.passages[0].url).toBe("https://example.com/handbook#p2");

  const m = await t.query(api.community.member, { handle: "ann" });
  expect(Object.fromEntries(m!.sources.map((s) => [s.label, s.url]))).toEqual({ Leaky: null, Clean: "https://example.com/handbook" });
  expect(JSON.stringify(m)).not.toMatch(/acme\.com/);
});
