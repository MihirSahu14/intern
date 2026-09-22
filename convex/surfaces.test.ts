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
