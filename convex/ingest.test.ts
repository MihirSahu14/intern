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
