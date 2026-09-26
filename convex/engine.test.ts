/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { DAILY_BUDGET_USD, DAY_WINDOW, costUsd, dayKey } from "../lib/caps.ts";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

test("a stray keystroke is not a brief, and costs nothing", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  await expect(asUser(a).mutation(api.interns.spawn, { task: "/" })).rejects.toThrow(/Say a bit more/);
  expect(await t.run((ctx) => ctx.db.query("interns").collect())).toHaveLength(0);
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

test("a missing MODEL_API_KEY fails the run through run.go with setup copy, no brief charged", async () => {
  vi.stubEnv("MODEL_API_KEY", "");
  // stream() must throw on the missing key before ever calling fetch — a
  // stray call here would be a real network attempt, which this test (and
  // the task's own rules) must never make.
  const f = vi.fn(async () => {
    throw new Error("run.go must not make a real network call");
  });
  vi.stubGlobal("fetch", f);

  const { t, seedUser } = setup();
  const userId = await seedUser("a");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "t", status: "queued", countsTowardCap: true }),
  );

  await t.action(internal.run.go, { internId });

  const row = await t.run((ctx) => ctx.db.get("interns", internId));
  expect(row?.status).toBe("failed");
  expect(row?.error).toBe("The model isn't set up yet.");
  expect(row?.countsTowardCap).toBe(false);
  expect(f).not.toHaveBeenCalled();
});

/** The model, stubbed: one SSE stream carrying `report`. Returns the fetch mock, whose body holds the prompt. */
function stubModel(report: string) {
  vi.stubEnv("MODEL_API_KEY", "test-key");
  const frames = [{ choices: [{ delta: { content: report } }] }, { usage: { prompt_tokens: 100, completion_tokens: 50 } }];
  const sse = frames.map((j) => `data: ${JSON.stringify(j)}\n\n`).join("") + "data: [DONE]\n\n";
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(sse));
  vi.stubGlobal("fetch", f);
  return f;
}
const promptOf = (f: ReturnType<typeof stubModel>, call = 0) => JSON.parse(String(f.mock.calls[call][1]?.body)).messages[0].content as string;

const ASKING = [
  "Drafted what I could.",
  "```question",
  '{"question":"Which features?","context":"writing the mail"}',
  "```",
  "```fact",
  '{"title":"Intern drafts, people approve","body":"Nothing sends without approval","kind":"note"}',
  "```",
].join("\n");

/** Composio configured and an active grant for `connector`: the run is briefed live. */
function seedLive(t: ReturnType<typeof setup>["t"], userId: Id<"users">, connector: "gmail" | "slack", accountLabel?: string) {
  vi.stubEnv("COMPOSIO_API_KEY", "key");
  vi.stubEnv("COMPOSIO_VERIFIER_URL", "https://site.test/app");
  return t.run((ctx) =>
    ctx.db.insert("connections", { userId, connector, status: "active", state: `s-${connector}`, composioAccountId: `ca-${connector}`, accountLabel, createdAt: Date.now() }),
  );
}

test("a fresh live run parks on its one question; dismissed and retried, it can't ask again", async () => {
  const f = stubModel(ASKING);
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");
  await seedLive(t, userId, "gmail");
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "mail the customer", status: "queued", countsTowardCap: true }));

  await t.action(internal.run.go, { internId });

  expect(promptOf(f)).toContain("```question");
  expect((await t.run((ctx) => ctx.db.get("interns", internId)))?.status).toBe("waiting");
  const [q] = await t.run((ctx) => ctx.db.query("questions").collect());
  expect(q).toBeDefined();

  // Dismissing cancels the intern; a retry runs the same row again — same brief, question spent.
  await asUser(userId).mutation(api.questions.dismiss, { questionId: q._id });
  await asUser(userId).mutation(api.interns.retry, { internId });
  await t.action(internal.run.go, { internId });

  expect(promptOf(f, 1)).toContain("You already asked your one question.");
  expect(await t.run((ctx) => ctx.db.query("questions").collect())).toHaveLength(1);
  expect((await t.run((ctx) => ctx.db.get("interns", internId)))?.status).toBe("done");
});

test("a draft always wins over a question in the same report", async () => {
  vi.stubEnv("COMMUNITY_SLACK_TEAM_ID", "T_COMMUNITY");
  vi.stubEnv("COMMUNITY_SLACK_CHANNEL", "#welcome");
  const f = stubModel(
    [
      "Drafted it.",
      "```action",
      '{"kind":"slack","to":["#welcome"],"body":"Welcome, new members!","rationale":"asked to","sources":[]}',
      "```",
      "```question",
      '{"question":"Which channel?","context":"posting"}',
      "```",
    ].join("\n"),
  );
  const { t, seedUser } = setup();
  const userId = await seedUser("a");
  await seedLive(t, userId, "slack");
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "welcome the new members", status: "queued", countsTowardCap: true }));

  await t.action(internal.run.go, { internId });

  expect(promptOf(f)).toContain("A Slack post with no channel goes to #welcome.");
  expect(await t.run((ctx) => ctx.db.query("questions").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("actions").collect())).toEqual([expect.objectContaining({ kind: "slack", status: "pending" })]);
  expect(await t.run((ctx) => ctx.db.get("interns", internId))).toMatchObject({ status: "done", parseOutcome: "action" });
  const logs = await t.run((ctx) => ctx.db.query("logs").collect());
  expect(logs).toContainEqual(expect.objectContaining({ level: "sys", text: "drafted instead of asking" }));
});

test("an email with no recipient is drafted to [recipient] and can't send until 'to' is filled in", async () => {
  stubModel(
    'Drafted.\n```action\n{"kind":"email","to":["[recipient]"],"subject":"Welcome","body":"Glad to have you.","rationale":"asked to","sources":[]}\n```',
  );
  const { t, seedUser, asUser } = setup();
  const userId = await seedUser("a");
  await seedLive(t, userId, "gmail");
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "email the new customer a welcome note", status: "queued", countsTowardCap: true }));

  await t.action(internal.run.go, { internId });

  const [action] = await t.run((ctx) => ctx.db.query("actions").collect());
  expect(action).toMatchObject({ status: "pending", draftedLive: true, draft: { to: ["[recipient]"], subject: "Welcome" } });
  const as = asUser(userId);
  await expect(as.mutation(api.outbox.decide, { actionId: action._id, decision: "approve" })).rejects.toThrow(
    "Fill in the [bracketed] parts before sending.",
  );
  await expect(
    as.mutation(api.outbox.decide, { actionId: action._id, decision: "approve", edits: { body: "Glad to have you, truly." } }),
  ).rejects.toThrow(/Fill in the \[bracketed\] parts/);

  // Composio: open the send session, then run the send.
  let call = 0;
  const bodies = [{ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" }];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(bodies[Math.min(call++, 1)]))));
  await as.mutation(api.outbox.decide, { actionId: action._id, decision: "approve", edits: { to: ["new@customer.com"] } });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  expect(await t.run((ctx) => ctx.db.get("actions", action._id))).toMatchObject({ status: "sent", accepted: { to: ["new@customer.com"] } });
});

test("a resumed run never asks again: its question is dropped, the rest still counts", async () => {
  const f = stubModel(ASKING);
  const { t, seedUser } = setup();
  const userId = await seedUser("a");
  const parked = await t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "mail me", status: "done", countsTowardCap: true }));
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", {
      ownerId: userId,
      task: "mail me\n\nANSWERS YOU WERE GIVEN (settled, do not ask again):\n- Who is me? → mine",
      displayTask: "mail me",
      status: "queued",
      resumes: parked,
      countsTowardCap: true,
    }),
  );

  await t.action(internal.run.go, { internId });

  const prompt = promptOf(f);
  expect(prompt).not.toContain("```question");
  expect(prompt).toContain("You already asked your one question.");
  expect(await t.run((ctx) => ctx.db.query("questions").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.get("interns", internId))).toMatchObject({ status: "done", parseOutcome: "none" });
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(1);
  const logs = await t.run((ctx) => ctx.db.query("logs").collect());
  expect(logs).toContainEqual(expect.objectContaining({ level: "sys", text: "didn't ask again — one question per brief" }));
  expect(logs.some((l) => /No question was asked/.test(l.text))).toBe(false);
});

test("the owner's intern is told who \"me\" is, and the address goes nowhere else", async () => {
  vi.stubEnv("COMPOSIO_API_KEY", "key");
  vi.stubEnv("COMPOSIO_VERIFIER_URL", "https://site.test/app");
  const f = stubModel("Drafted it.");
  const { t, seedUser } = setup();
  const userId = await seedUser("ann");
  await t.run((ctx) =>
    ctx.db.insert("connections", {
      userId,
      connector: "gmail",
      status: "active",
      state: "s1",
      composioAccountId: "ca_1",
      accountLabel: "ann@acme.com",
      createdAt: Date.now(),
    }),
  );
  const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "mail myself", status: "queued", countsTowardCap: true }));

  await t.action(internal.run.go, { internId });

  expect(promptOf(f)).toContain('YOU WORK FOR: @ann. "Me", "myself" and "my" in the task mean them — their email is ann@acme.com.');
  const written = await t.run(async (ctx) => [
    await ctx.db.query("logs").collect(),
    await ctx.db.query("facts").collect(),
    await ctx.db.query("interns").collect(),
  ]);
  expect(JSON.stringify(written)).not.toContain("ann@acme.com");
});

test("a fact a run files carries no address or account label when public, and stays verbatim when private", async () => {
  stubModel(
    'Done.\n```fact\n{"title":"ann@acme.com wants weekly mail","body":"write to ann@acme.com, or ping @ann in Intern Community","kind":"preference"}\n```',
  );
  const { t, seedUser } = setup();
  const userId = await seedUser("ann");
  await seedLive(t, userId, "slack", "@ann in Intern Community");
  const fresh = await t.run((ctx) => ctx.db.insert("interns", { ownerId: userId, task: "mail me", status: "queued", countsTowardCap: true }));
  // A question-resumed run (displayTask set) is private by construction; see noteRecall.
  const resumed = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: userId, task: "mail me\n- Who? → me", displayTask: "mail me", status: "queued", resumes: fresh, countsTowardCap: true }),
  );

  await t.action(internal.run.go, { internId: fresh });
  await t.action(internal.run.go, { internId: resumed });

  const facts = await t.run((ctx) => ctx.db.query("facts").collect());
  const pub = facts.find((f) => f.internId === fresh);
  expect(pub?.visibility).toBeUndefined();
  expect(pub).toMatchObject({
    title: "[email] wants weekly mail",
    body: "write to [email], or ping [account]",
    text: "[email] wants weekly mail\nwrite to [email], or ping [account]",
  });
  expect(facts.find((f) => f.internId === resumed)).toMatchObject({
    visibility: "owner",
    title: "ann@acme.com wants weekly mail",
    body: "write to ann@acme.com, or ping @ann in Intern Community",
  });
});

test("the global budget stops everyone", async () => {
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  await t.run((ctx) => ctx.db.insert("usage", { date: dayKey(Date.now()), costUsd: DAILY_BUDGET_USD, runs: 1 }));
  await expect(as.mutation(api.interns.spawn, { task: "draft a hello" })).rejects.toThrow(/budget/);
});

test("CAP_EXEMPT_HANDLES: an exempt member can spawn a sixth brief and a second concurrent intern", async () => {
  vi.stubEnv("CAP_EXEMPT_HANDLES", "a");
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  for (let i = 0; i < 5; i++) {
    const internId = await as.mutation(api.interns.spawn, { task: `task ${i}` });
    // Free the one-concurrent-intern slot so only the daily count is at play,
    // same as the non-exempt version of this test above.
    await t.run((ctx) => ctx.db.patch("interns", internId, { status: "done", endedAt: Date.now() }));
  }
  // The sixth brief: over BRIEFS_PER_DAY for anyone else.
  await expect(as.mutation(api.interns.spawn, { task: "task 5" })).resolves.toBeTruthy();
  // A seventh while the sixth is still queued: past the one-concurrent-intern cap too.
  await expect(as.mutation(api.interns.spawn, { task: "task 6" })).resolves.toBeTruthy();
});

test("CAP_EXEMPT_HANDLES: a member whose handle isn't listed is still refused", async () => {
  vi.stubEnv("CAP_EXEMPT_HANDLES", "someone-else");
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  for (let i = 0; i < 5; i++) {
    const internId = await as.mutation(api.interns.spawn, { task: `task ${i}` });
    await t.run((ctx) => ctx.db.patch("interns", internId, { status: "done", endedAt: Date.now() }));
  }
  await expect(as.mutation(api.interns.spawn, { task: "task 5" })).rejects.toThrow(/5 briefs/);
});

test("CAP_EXEMPT_HANDLES: exemption never clears the shared $5 budget", async () => {
  vi.stubEnv("CAP_EXEMPT_HANDLES", "a");
  const { t, seedUser, asUser } = setup();
  const as = asUser(await seedUser("a"));

  await t.run((ctx) => ctx.db.insert("usage", { date: dayKey(Date.now()), costUsd: DAILY_BUDGET_USD, runs: 1 }));
  await expect(as.mutation(api.interns.spawn, { task: "draft a hello" })).rejects.toThrow(/budget/);
});

test("CAP_EXEMPT_HANDLES matches case-insensitively and ignores stray whitespace", async () => {
  vi.stubEnv("CAP_EXEMPT_HANDLES", " Mihir , ANN ,bob");
  const { t, seedUser, asUser } = setup();
  // Stored handle is lower-case "ann"; the env list has "ANN" with padding on both sides.
  const as = asUser(await seedUser("ann"));

  for (let i = 0; i < 5; i++) {
    const internId = await as.mutation(api.interns.spawn, { task: `task ${i}` });
    await t.run((ctx) => ctx.db.patch("interns", internId, { status: "done", endedAt: Date.now() }));
  }
  await expect(as.mutation(api.interns.spawn, { task: "task 5" })).resolves.toBeTruthy();
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
