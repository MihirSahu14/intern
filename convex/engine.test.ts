/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { DAILY_BUDGET_USD, DAY_WINDOW, costUsd, dayKey } from "../lib/caps.ts";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * A fresh mock backend plus two closures that only exist to cut boilerplate:
 * `seedUser` inserts an accepted, unbanned member; `asUser` mints the identity
 * convex-auth's `getAuthUserId` expects (`<userId>|<session>`). Both close
 * over this call's own `t`, so their types come from the real schema instead
 * of a generic `ReturnType<typeof convexTest>`.
 */
function setup() {
  const t = convexTest(schema, modules);
  const seedUser = (handle: string) => t.run((ctx) => ctx.db.insert("users", { handle, acceptedAt: Date.now() }));
  const asUser = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session`, issuer: "https://local" });
  return { t, seedUser, asUser };
}

test("the sixth brief of the day is refused", async () => {
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  for (let i = 0; i < 5; i++) {
    const internId = await as.mutation(api.interns.spawn, { task: `task ${i}` });
    // Free the one-concurrent-intern slot so only the daily count is at play.
    await t.run((ctx) => ctx.db.patch("interns", internId, { status: "done", endedAt: Date.now() }));
  }
  await expect(as.mutation(api.interns.spawn, { task: "task 5" })).rejects.toThrow(/5 briefs/);
});

test("a second intern while one is queued is refused", async () => {
  const { seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  await as.mutation(api.interns.spawn, { task: "first" });
  await expect(as.mutation(api.interns.spawn, { task: "second" })).rejects.toThrow(/already/);
});

test("a failed run on a busy model does not consume a brief", async () => {
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");
  const as = asUser(userId);

  const briefsToday = () =>
    t.run(async (ctx) => {
      const rows = await ctx.db.query("interns").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).collect();
      return rows.filter((r) => r.countsTowardCap).length;
    });

  const internA = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "running", countsTowardCap: true }),
  );
  await t.mutation(internal.interns.fail, {
    internId: internA,
    error: "model 429 quota",
    countsTowardCap: false,
    tokensIn: 0,
    tokensOut: 0,
  });
  expect(await briefsToday()).toBe(0);

  const freshId = await as.mutation(api.interns.spawn, { task: "fresh" });
  await t.run((ctx) => ctx.db.patch("interns", freshId, { status: "done", endedAt: Date.now() }));
  expect(await briefsToday()).toBe(1);

  const internB = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "running", countsTowardCap: true }),
  );
  await t.mutation(internal.interns.fail, {
    internId: internB,
    error: "boom",
    countsTowardCap: true,
    tokensIn: 10,
    tokensOut: 5,
  });
  expect(await briefsToday()).toBe(2);
});

test("the global budget stops everyone", async () => {
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  await t.run((ctx) => ctx.db.insert("usage", { date: dayKey(Date.now()), costUsd: DAILY_BUDGET_USD, runs: 1 }));
  await expect(as.mutation(api.interns.spawn, { task: "x" })).rejects.toThrow(/budget/);
});

test("only the owner can decide on a draft", async () => {
  const { t, seedUser, asUser } = setup();
  const owner = await seedUser("owner");
  const other = await seedUser("other");

  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: owner, task: "t", status: "done", countsTowardCap: true }),
  );
  const actionId = await t.run((ctx) =>
    ctx.db.insert("actions", {
      ownerId: owner,
      internId,
      kind: "email",
      status: "pending",
      title: "Reply to X",
      draft: { to: ["x@example.com"], subject: "Subj", body: "Body" },
      rationale: "because",
      sources: [],
      recalledCorrection: false,
    }),
  );

  await expect(
    asUser(other).mutation(api.outbox.decide, { actionId, decision: "approve" }),
  ).rejects.toThrow(/Only the person who briefed/);

  await asUser(owner).mutation(api.outbox.decide, { actionId, decision: "approve" });
  const action = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(action?.status).toBe("approved");
});

test("only the owner can cancel an intern or answer its question", async () => {
  const { t, seedUser, asUser } = setup();
  const owner = await seedUser("owner");
  const other = await seedUser("other");

  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: owner, task: "t", status: "queued", countsTowardCap: true }),
  );
  await expect(asUser(other).mutation(api.interns.cancel, { internId })).rejects.toThrow(/Only whoever briefed/);
  await asUser(owner).mutation(api.interns.cancel, { internId });
  expect((await t.run((ctx) => ctx.db.get("interns", internId)))?.status).toBe("cancelled");

  const parkedId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: owner, task: "parked", status: "waiting", countsTowardCap: true }),
  );
  const questionId = await t.run((ctx) =>
    ctx.db.insert("questions", { ownerId: owner, internId: parkedId, question: "Which repo?", context: "", status: "open" }),
  );
  await expect(
    asUser(other).mutation(api.questions.answer, { questionId, answer: "repo-a" }),
  ).rejects.toThrow(/isn't open for you/);
  await asUser(owner).mutation(api.questions.answer, { questionId, answer: "repo-a" });
  expect((await t.run((ctx) => ctx.db.get("questions", questionId)))?.status).toBe("answered");
});

test("a banned or unconsented user cannot write", async () => {
  const { t, asUser } = setup();
  const bannedId = await t.run((ctx) => ctx.db.insert("users", { handle: "banned", acceptedAt: Date.now(), bannedAt: Date.now() }));
  const unconsentedId = await t.run((ctx) => ctx.db.insert("users", { handle: "unconsented" }));

  await expect(
    asUser(bannedId).mutation(api.facts.teach, { title: "t", body: "b", kind: "note" }),
  ).rejects.toThrow(/blocked/);
  await expect(
    asUser(unconsentedId).mutation(api.facts.teach, { title: "t", body: "b", kind: "note" }),
  ).rejects.toThrow(/Accept the public-brain notice/);
});

test("approving with edits stores the accepted draft and learns a fact", async () => {
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");
  const as = asUser(userId);

  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "done", countsTowardCap: true }),
  );
  const actionId = await t.run((ctx) =>
    ctx.db.insert("actions", {
      ownerId: userId,
      internId,
      kind: "email",
      status: "pending",
      title: "Reply to X",
      draft: { to: ["x@example.com"], subject: "Subj", body: "Original body" },
      rationale: "because",
      sources: [],
      recalledCorrection: false,
    }),
  );

  await as.mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Edited body" } });

  const action = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(action?.decision).toBe("edited");
  expect(action?.accepted?.body).toBe("Edited body");
  expect(action?.editedFields).toContain("body");

  const facts = await t.run((ctx) => ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", userId)).collect());
  const learned = facts.find((f) => f.kind === "preference");
  expect(learned).toBeDefined();
  expect(learned?.body).toContain("Original body");
  expect(learned?.body).toContain("Edited body");
});

test("the twenty-first fact of the day is refused", async () => {
  const { seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  for (let i = 0; i < 20; i++) {
    await as.mutation(api.facts.teach, { title: `fact ${i}`, body: "b", kind: "note" });
  }
  await expect(as.mutation(api.facts.teach, { title: "fact 20", body: "b", kind: "note" })).rejects.toThrow(
    /20 facts/,
  );
});

test("usage is recorded even when the run is cancelled", async () => {
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");
  const as = asUser(userId);

  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "running", countsTowardCap: true }),
  );
  await as.mutation(api.interns.cancel, { internId });

  await t.mutation(internal.interns.finish, {
    internId,
    report: "done",
    tokensIn: 1000,
    tokensOut: 500,
    latencyMs: 1234,
    facts: [],
  });

  const intern = await t.run((ctx) => ctx.db.get("interns", internId));
  expect(intern?.status).toBe("cancelled");

  const usage = await t.run((ctx) => ctx.db.query("usage").withIndex("by_date", (q) => q.eq("date", dayKey(Date.now()))).unique());
  expect(usage?.costUsd).toBeCloseTo(costUsd(1000, 500));
  expect(usage?.runs).toBe(1);
});

test("evals: only action-block outcomes count as draft attempts", async () => {
  const { t, seedUser } = setup();
  const userId = await seedUser("a");

  const mkRun = (parseOutcome: string) =>
    t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "t", status: "done", countsTowardCap: true, parseOutcome }));
  await mkRun("action");
  await mkRun("action_malformed:no body");
  await mkRun("question_malformed:no question");

  const s = await t.query(api.community.evals, {});
  expect(s.runs).toBe(3);
  expect(s.actionBlocks).toBe(2);
  expect(s.parseRate).toBe(0.5);
});

test("evals: edit rate splits by whether a correction was recalled", async () => {
  const { t, seedUser } = setup();
  const userId = await seedUser("a");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "done", countsTowardCap: true }),
  );
  const mkAction = (recalledCorrection: boolean, decision: "approved_unedited" | "edited" | "rejected") =>
    t.run((ctx) =>
      ctx.db.insert("actions", {
        ownerId: userId,
        internId,
        kind: "email",
        status: decision === "rejected" ? "rejected" : "approved",
        title: "t",
        draft: { to: ["x@example.com"], subject: "s", body: "b" },
        rationale: "because",
        sources: [],
        recalledCorrection,
        decision,
        decidedAt: Date.now(),
      }),
    );
  await mkAction(true, "approved_unedited");
  await mkAction(true, "approved_unedited");
  await mkAction(false, "edited");
  await mkAction(false, "rejected");

  const s = await t.query(api.community.evals, {});
  expect(s.withCorrection).toBe(2);
  expect(s.editRateWithCorrection).toBe(0);
  expect(s.without).toBe(2);
  expect(s.editRateWithout).toBe(1);
});

test("a day that overflows the read window refuses further briefs", async () => {
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");

  // Runs that cost nothing and count toward nothing — a failure with zero
  // output tokens. Fifty of them used to push the day's real briefs out of the
  // window, switching both the 5/day and the 1-concurrent cap off until 00:00.
  await t.run(async (ctx) => {
    for (let i = 0; i < DAY_WINDOW + 1; i++) {
      await ctx.db.insert("interns", {
        ownerId: userId,
        task: `free failure ${i}`,
        status: "failed",
        countsTowardCap: false,
        endedAt: Date.now(),
      });
    }
  });

  await expect(asUser(userId).mutation(api.interns.spawn, { task: "one more" })).rejects.toThrow(
    /too many interns/,
  );
});

test("a day that overflows the read window refuses further facts", async () => {
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");

  // Facts an intern filed: they share the window without going through `teach`
  // or counting against the 20/day cap.
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "done", countsTowardCap: true }),
  );
  await t.run(async (ctx) => {
    for (let i = 0; i < DAY_WINDOW + 1; i++) {
      await ctx.db.insert("facts", { title: `f${i}`, body: "b", kind: "note", text: `f${i}\nb`, ownerId: userId, internId });
    }
  });

  await expect(
    asUser(userId).mutation(api.facts.teach, { title: "one more", body: "b", kind: "note" }),
  ).rejects.toThrow(/too many facts/);
});

test("your own pending draft survives thirty newer ones from other people", async () => {
  const { t, seedUser, asUser } = setup();
  const owner = await seedUser("owner");
  const other = await seedUser("other");

  const mkAction = (ownerId: Id<"users">, title: string) =>
    t.run(async (ctx) => {
      const internId = await ctx.db.insert("interns", { ownerId, task: "t", status: "done", countsTowardCap: true });
      return await ctx.db.insert("actions", {
        ownerId,
        internId,
        kind: "email" as const,
        status: "pending" as const,
        title,
        draft: { to: ["x@example.com"], subject: title, body: "b" },
        rationale: "because",
        sources: [],
        recalledCorrection: false,
      });
    });

  const mine = await mkAction(owner, "mine");
  for (let i = 0; i < 31; i++) await mkAction(other, `theirs ${i}`);

  // The global window alone buries it, and the cockpit filters to the viewer,
  // so it would vanish from the only UI that can approve or reject it.
  const rows = await asUser(owner).query(api.outbox.list, {});
  expect(rows.map((r) => r._id)).toContain(mine);
  expect(await asUser(owner).mutation(api.outbox.decide, { actionId: mine, decision: "approve" })).toBe(null);

  // Signed out, the global window is all there is.
  expect((await t.query(api.outbox.list, {})).map((r) => r._id)).not.toContain(mine);
});

test("retry re-runs the same intern instead of making a second one", async () => {
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  const internId = await as.mutation(api.interns.spawn, { task: "draft a hello" });
  await t.mutation(internal.interns.fail, {
    internId,
    error: "The free model is busy, try again in a minute.",
    countsTowardCap: false,
    tokensIn: 0,
    tokensOut: 0,
  });

  await as.mutation(api.interns.retry, { internId });

  const after = await t.run((ctx) => ctx.db.get("interns", internId));
  expect(after?.status).toBe("queued");
  expect(after?.error).toBeUndefined();
  const all = await t.run((ctx) => ctx.db.query("interns").collect());
  expect(all).toHaveLength(1);
  // The failure and the retry both stay in this intern's own log.
  const lines = await t.run((ctx) => ctx.db.query("logs").collect());
  expect(lines.every((l) => l.internId === internId)).toBe(true);
  expect(lines.some((l) => l.text === "running it again")).toBe(true);
});

test("only the owner can retry, and only a finished-badly brief", async () => {
  const { t, seedUser, asUser } = setup();
  const mine = asUser(await seedUser("a"));
  const theirs = asUser(await seedUser("b"));

  const internId = await mine.mutation(api.interns.spawn, { task: "draft a hello" });
  // Still queued: there is nothing to retry yet.
  await expect(mine.mutation(api.interns.retry, { internId })).rejects.toThrow(/failed or cancelled/);

  await t.mutation(internal.interns.fail, { internId, error: "boom", countsTowardCap: true, tokensIn: 0, tokensOut: 0 });
  await expect(theirs.mutation(api.interns.retry, { internId })).rejects.toThrow(/your own/);
});
