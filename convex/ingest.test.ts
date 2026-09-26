/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
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
