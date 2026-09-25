/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { SLACK_TOOLS, TRIGGERS, sign } from "../lib/inbound.ts";
import { broadcast } from "./broadcast";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Every env var the connect path reads, set to test values. Managed auth: no auth config. */
function composioEnv() {
  vi.stubEnv("COMPOSIO_API_KEY", "key");
  vi.stubEnv("COMPOSIO_VERIFIER_URL", "https://site.test/app");
}

/** Canned replies, one per outgoing request in order; the last repeats. No test reaches the network. */
function stubFetch(...bodies: unknown[]) {
  let i = 0;
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(bodies[Math.min(i++, bodies.length - 1)] ?? {})),
  );
  vi.stubGlobal("fetch", f);
  return f;
}

/** engine.test.ts's setup, plus the rows this file keeps needing. */
function setup() {
  const t = convexTest(schema, modules);
  const seedUser = (handle: string) => t.run((ctx) => ctx.db.insert("users", { handle, acceptedAt: Date.now() }));
  const asUser = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|session`, issuer: "https://local" });
  // Drafted live unless a test says otherwise: most model a run briefed for real sending.
  const seedDraft = (ownerId: Id<"users">, kind: "email" | "slack" = "email", extra: Partial<Doc<"actions">> = { draftedLive: true }) =>
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
        ...extra,
      });
      return { internId, actionId };
    });
  const seedPending = (userId: Id<"users">, connector: "gmail" | "slack" = "gmail", state = "s1", composioAccountId = "ca_1") =>
    t.run((ctx) =>
      ctx.db.insert("connections", { userId, connector, status: "pending", state, composioAccountId, createdAt: Date.now() }),
    );
  const seedActive = (userId: Id<"users">, connector: "gmail" | "slack" = "gmail", extra: Partial<Doc<"connections">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("connections", {
        userId,
        connector,
        status: "active",
        composioAccountId: "ca_1",
        state: "s0",
        createdAt: Date.now(),
        ...extra,
      }),
    );
  return { t, seedUser, asUser, seedDraft, seedPending, seedActive };
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
  // An `err` line can quote a rejected report (run.go's catch), so non-owners
  // get a fixed string, never the raw message — see interns.logs.
  expect((await asUser(b).query(api.interns.logs, {})).map((l) => l.text)).toEqual(["something went wrong"]);
  expect((await t.query(api.interns.logs, {})).map((l) => l.text)).toEqual(["something went wrong"]);
});

test("a stuck intern's warn log names no text, only that it asked", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: a, task: "email ann@acme.com", status: "running", countsTowardCap: true }),
  );
  await t.mutation(internal.interns.finish, {
    internId,
    report: "stuck",
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    facts: [],
    question: { question: "What is Ann's phone number?", context: "drafting the email" },
  });

  const forB = (await asUser(b).query(api.interns.logs, {})).map((l) => l.text);
  expect(forB.some((line) => line.includes("phone number"))).toBe(false);
  expect(forB).toContain("asks a question");

  const forA = (await asUser(a).query(api.interns.logs, {})).map((l) => l.text);
  expect(forA).toContain("asks a question");
});

test("answering a question files the answer owner-only and a resumed intern's task shows only the original ask", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: a, task: "email ann@acme.com", status: "waiting", countsTowardCap: true }),
  );
  const questionId = await t.run((ctx) =>
    ctx.db.insert("questions", { ownerId: a, internId, question: "What is Ann's phone number?", context: "c", status: "open" }),
  );

  const { resumed } = await asUser(a).mutation(api.questions.answer, { questionId, answer: "555-0100" });
  expect(resumed).toBe(true);

  // The answer became a fact titled with the question — owner-only, like the
  // question itself.
  const forB = await t.query(internal.facts.recall, { task: "phone number", ownerId: b });
  expect(forB.map((f) => f.title)).not.toContain("What is Ann's phone number?");
  const forA = await t.query(internal.facts.recall, { task: "phone number", ownerId: a });
  expect(forA.map((f) => f.title)).toContain("What is Ann's phone number?");

  const resumedId = (
    await t.run((ctx) => ctx.db.query("interns").withIndex("by_ownerId", (q) => q.eq("ownerId", a)).collect())
  ).find((i) => i.resumes === internId)!._id;
  const theirs = (await asUser(b).query(api.interns.list, {})).find((i) => i._id === resumedId);
  expect(theirs?.task).toBe("email [email]");
  expect(theirs?.task).not.toMatch(/phone number|555-0100/);
});

test("a resumed run's question and answer never show up in the graph or the feed", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: a, task: "email ann@acme.com", status: "waiting", countsTowardCap: true }),
  );
  const questionId = await t.run((ctx) =>
    ctx.db.insert("questions", { ownerId: a, internId, question: "What is Ann's phone number?", context: "c", status: "open" }),
  );
  await asUser(a).mutation(api.questions.answer, { questionId, answer: "555-0100" });

  const leak = /phone number|555-0100/;
  const graphForB = (await asUser(b).query(api.facts.graph, {})).nodes.map((n) => n.label).join("\n");
  expect(graphForB).not.toMatch(leak);
  const graphSignedOut = (await t.query(api.facts.graph, {})).nodes.map((n) => n.label).join("\n");
  expect(graphSignedOut).not.toMatch(leak);

  const feedForB = (await asUser(b).query(api.community.feed, {})).map((e) => e.text).join("\n");
  expect(feedForB).not.toMatch(leak);
  const feedSignedOut = (await t.query(api.community.feed, {})).map((e) => e.text).join("\n");
  expect(feedSignedOut).not.toMatch(leak);
});

test("a resumed run files its facts owner-only even when recall found no private fact", async () => {
  const { t, seedUser } = setup();
  const a = await seedUser("a");
  // Simulates recall's capped search missing the answer fact: `displayTask`
  // is what marks this run private, not what it happened to recall.
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", {
      ownerId: a,
      task: "You asked: What is Ann's phone number?\nThe answer is: 555-0100\n\nOriginal task: email ann@acme.com",
      displayTask: "email ann@acme.com",
      status: "running",
      countsTowardCap: true,
    }),
  );
  await t.mutation(internal.interns.noteRecall, { internId, recalled: [] });
  await t.mutation(internal.interns.finish, {
    internId,
    report: "done",
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    facts: [{ title: "Ann's number is 555-0100", body: "confirmed", kind: "note" }],
  });

  const filed = await t.run((ctx) =>
    ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", a)).collect(),
  );
  expect(filed.find((f) => f.title === "Ann's number is 555-0100")?.visibility).toBe("owner");
});

test("a run that recalled a private fact files its own facts owner-only", async () => {
  const { t, seedUser } = setup();
  const a = await seedUser("a");
  const privateFactId = await t.run((ctx) =>
    ctx.db.insert("facts", {
      title: "emailed ann about the $40k renewal",
      body: "",
      kind: "note",
      visibility: "owner",
      ownerId: a,
      text: "emailed ann about the $40k renewal\n",
    }),
  );
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: a, task: "renewal status", status: "running", countsTowardCap: true }),
  );
  await t.mutation(internal.interns.noteRecall, {
    internId,
    recalled: [{ id: privateFactId, kind: "note", visibility: "owner" }],
  });
  await t.mutation(internal.interns.finish, {
    internId,
    report: "done",
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    facts: [{ title: "Ann's renewal is $40k", body: "confirmed", kind: "note" }],
  });

  const filed = await t.run((ctx) =>
    ctx.db.query("facts").withIndex("by_ownerId", (q) => q.eq("ownerId", a)).collect(),
  );
  expect(filed.find((f) => f.title === "Ann's renewal is $40k")?.visibility).toBe("owner");

  const graph = (await t.query(api.facts.graph, {})).nodes.map((n) => n.label);
  expect(graph).not.toContain("Ann's renewal is $40k");
});

test("other people's interns show no error text, no recalledFactIds and no recalledPrivate", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const factId = await t.run((ctx) =>
    ctx.db.insert("facts", { title: "public fact", body: "", kind: "note", ownerId: a, text: "public fact\n" }),
  );
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", {
      ownerId: a,
      task: "t",
      status: "failed",
      error: 'model rejected argument "body": "secret renewal terms"',
      recalledFactIds: [factId],
      recalledPrivate: true,
      countsTowardCap: true,
    }),
  );

  const mine = (await asUser(a).query(api.interns.list, {})).find((i) => i._id === internId);
  expect(mine?.error).toMatch(/secret renewal terms/);
  expect(mine?.recalledFactIds).toEqual([factId]);
  expect(mine?.recalledPrivate).toBe(true);

  const theirs = (await asUser(b).query(api.interns.list, {})).find((i) => i._id === internId);
  expect(theirs?.error).toBe("failed");
  expect(theirs?.recalledFactIds).toBeUndefined();
  expect(theirs?.recalledPrivate).toBeUndefined();
});

test("signed-out visitors get only the reduced outbox and questions rows", async () => {
  const { t, seedUser, seedDraft } = setup();
  const owner = await seedUser("owner");
  const { actionId } = await seedDraft(owner);
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: owner, task: "t", status: "waiting", countsTowardCap: true }),
  );
  const questionId = await t.run((ctx) =>
    ctx.db.insert("questions", { ownerId: owner, internId, question: "secret?", context: "c", status: "open" }),
  );

  const action = (await t.query(api.outbox.list, {})).find((r) => r._id === actionId);
  expect(action).toEqual({
    _id: actionId,
    _creationTime: expect.any(Number),
    kind: "email",
    status: "pending",
    ownerId: owner,
    handle: "owner",
  });

  const question = (await t.query(api.questions.list, {})).find((q) => q._id === questionId);
  expect(question).toEqual({ _id: questionId, _creationTime: expect.any(Number), ownerId: owner, internId, status: "open" });
});

const linked = { redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_1" };

test("connect: start writes a pending row and hands back Composio's link", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubFetch({ session_id: "trs_1" }, linked);

  expect(await asUser(a).action(api.connections.start, { connector: "gmail" })).toBe(linked.redirect_url);
  const row = await t.run((ctx) => ctx.db.query("connections").first());
  expect(row).toMatchObject({ userId: a, connector: "gmail", status: "pending", composioAccountId: "ca_1" });
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ user_id: a });
  // No callback_url: with a verifier URL set, Composio sends the browser there instead.
  expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ toolkit: "gmail" });
});

test("connect: an auth-config override is config only", async () => {
  composioEnv();
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_SLACK", "ac_slack");
  const { seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubFetch({ session_id: "trs_1" }, linked);
  await asUser(a).action(api.connections.start, { connector: "slack" });
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ user_id: a, auth_configs: { slack: "ac_slack" } });
});

test("connect: a Composio failure leaves the row failed, not pending", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  stubFetch({ session_id: "trs_1" }, {});
  await expect(asUser(a).action(api.connections.start, { connector: "gmail" })).rejects.toThrow(/Couldn't reach Composio/);
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("failed");
});

test("connect: without Composio's key nothing is set up and nothing is written", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubFetch({});
  await expect(asUser(a).action(api.connections.start, { connector: "gmail" })).rejects.toThrow(/not set up yet/);
  expect(f).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("connections").collect())).toHaveLength(0);
  expect(await asUser(a).query(api.connections.mine, {})).toEqual([
    expect.objectContaining({ key: "gmail", configured: false, connected: false }),
    expect.objectContaining({ key: "slack", configured: false, connected: false }),
  ]);
});

test("connect: a visitor who hasn't accepted the notice can't start one", async () => {
  composioEnv();
  const { t, asUser } = setup();
  const u = await t.run((ctx) => ctx.db.insert("users", { handle: "new" }));
  const f = stubFetch({});
  await expect(asUser(u).action(api.connections.start, { connector: "gmail" })).rejects.toThrow(/Accept/);
  expect(f).not.toHaveBeenCalled();
});

const completed = { connected_account_id: "ca_1", toolkit_slug: "gmail" };
const status = (code: number, message: string) => ({ __status: code, error: { message, request_id: "req_1" } });

/** Like stubFetch, but a body carrying `__status` answers with that HTTP status. */
function stubComposio(...bodies: unknown[]) {
  let i = 0;
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    const b = (bodies[Math.min(i++, bodies.length - 1)] ?? {}) as { __status?: number };
    return new Response(JSON.stringify(b), { status: b.__status ?? 200 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

test("finish: the victim path — Composio refuses the consenting member's id and nothing goes active", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const attacker = await seedUser("attacker");
  const victim = await seedUser("victim");
  await seedPending(attacker);
  // Composio: user_id doesn't match the connection owner → 400, and it fails the connection itself.
  const f = stubComposio(status(400, "Callback identity verification failed"));

  const r = await asUser(victim).action(api.connections.finish, { sessionUri: "su_1" });
  expect(r).toMatchObject({ ok: false });
  expect(f).toHaveBeenCalledTimes(1);
  expect(f.mock.calls[0][0]).toContain("/connected_accounts/complete_auth");
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ session_uri: "su_1", user_id: victim });
  const rows = await t.run((ctx) => ctx.db.query("connections").collect());
  expect(rows.map((row) => row.status)).toEqual(["pending"]);
  expect(await asUser(attacker).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", connected: false }),
  );
});

test("finish: the member who consented on their own link is connected", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a);
  const f = stubComposio(completed);

  expect(await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).toEqual({ ok: true, connector: "gmail" });
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ session_uri: "su_1", user_id: a });
  expect(await t.run((ctx) => ctx.db.query("connections").first())).toMatchObject({ status: "active", composioAccountId: "ca_1" });
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", configured: true, connected: true }),
  );
});

test("finish: never takes a user id from its arguments", async () => {
  composioEnv();
  const { seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const f = stubComposio(completed);
  await expect(
    asUser(b).action(api.connections.finish, { sessionUri: "su_1", userId: a } as unknown as { sessionUri: string }),
  ).rejects.toThrow();
  expect(f).not.toHaveBeenCalled();
});

test("finish: a replayed session for an already-active connection changes nothing", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "active", composioAccountId: "ca_1", state: "s0", createdAt: Date.now() }),
  );
  const f = stubComposio(status(404, "session already consumed"));
  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(false);
  expect(f).toHaveBeenCalledTimes(1);
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("active");
});

test("finish: a link older than 15 minutes is refused and its account deleted", async () => {
  composioEnv();
  vi.useFakeTimers();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a);
  vi.setSystemTime(Date.now() + 16 * 60_000);
  const f = stubComposio(completed, { success: true });

  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(false);
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("failed");
  expect(f.mock.calls[1][0]).toMatch(/\/connected_accounts\/ca_1$/);
  expect(f.mock.calls[1][1]?.method).toBe("DELETE");
});

test("finish: an account we never linked for this member is deleted, not adopted", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubComposio({ connected_account_id: "ca_9", toolkit_slug: "gmail" }, { success: true });
  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(false);
  expect(await t.run((ctx) => ctx.db.query("connections").collect())).toHaveLength(0);
  expect(f.mock.calls[1][0]).toContain("/connected_accounts/ca_9");
  expect(f.mock.calls[1][1]?.method).toBe("DELETE");
});

test("finish: someone who hasn't accepted the notice can't finish anything", async () => {
  composioEnv();
  const { t, asUser } = setup();
  const u = await t.run((ctx) => ctx.db.insert("users", { handle: "new" }));
  const f = stubComposio(completed);
  await expect(asUser(u).action(api.connections.finish, { sessionUri: "su_1" })).rejects.toThrow(/Accept/);
  expect(f).not.toHaveBeenCalled();
});

test("finish: reconnecting retires the older grant here and at Composio", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  const old = await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "active", composioAccountId: "ca_0", state: "s0", createdAt: Date.now() }),
  );
  await seedPending(a);
  const f = stubComposio({ connected_account_id: "ca_1", toolkit_slug: "GMAIL" }, { success: true });

  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(true);
  expect((await t.run((ctx) => ctx.db.get("connections", old)))?.status).toBe("failed");
  // Retire deletes without revoking: same Google account, the revoke would kill the new grant.
  expect(f.mock.calls[1][0]).toMatch(/\/connected_accounts\/ca_0$/);
  expect(f.mock.calls[1][1]?.method).toBe("DELETE");
});

test("disconnect marks the row failed and deletes the account at Composio", async () => {
  composioEnv();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "active", composioAccountId: "ca_1", state: "s0", createdAt: Date.now() }),
  );
  const f = stubFetch({ success: true });
  await asUser(a).action(api.connections.disconnect, { connector: "gmail" });
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("failed");
  expect(f.mock.calls[0][0]).toMatch(/\/connected_accounts\/ca_1\?revoke_on_delete=true$/);
  expect(f.mock.calls[0][1]?.method).toBe("DELETE");
});

test("purge deletes the member's connections and their accounts at Composio", async () => {
  composioEnv();
  vi.useFakeTimers();
  const { t, seedUser } = setup();
  const a = await seedUser("a");
  await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "active", composioAccountId: "ca_1", state: "s0", createdAt: Date.now() }),
  );
  const f = stubFetch({ success: true });
  await t.mutation(internal.users.purge, { userId: a });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.run((ctx) => ctx.db.query("connections").collect())).toHaveLength(0);
  expect(f.mock.calls[0][0]).toMatch(/\/connected_accounts\/ca_1\?revoke_on_delete=true$/);
  expect(f.mock.calls[0][1]?.method).toBe("DELETE");
});

test("connect: the key without a verifier URL is not set up: no links, nothing written", async () => {
  vi.stubEnv("COMPOSIO_API_KEY", "key");
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubFetch({});
  await expect(asUser(a).action(api.connections.start, { connector: "gmail" })).rejects.toThrow(/not set up yet/);
  expect(f).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("connections").collect())).toHaveLength(0);
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", configured: false }),
  );
});

test("finish: without Composio's key it says not set up yet, before any fetch", async () => {
  const { seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = stubComposio(completed);
  await expect(asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).rejects.toThrow(/not set up yet/);
  expect(f).not.toHaveBeenCalled();
});

test("finish: Composio's 200 for an account on another member's link is still refused, and the grant deleted", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedPending(a);
  const f = stubComposio(completed, { success: true });

  expect((await asUser(b).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(false);
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.status).toBe("failed");
  expect(f.mock.calls[1][0]).toContain("/connected_accounts/ca_1");
  expect(f.mock.calls[1][1]?.method).toBe("DELETE");
});

test("finish: a member with more than 50 earlier attempts still connects, and the newest old grant is retired", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  const old = await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "active", composioAccountId: "ca_0", state: "s0", createdAt: Date.now() }),
  );
  await t.run(async (ctx) => {
    for (let i = 0; i < 60; i++) {
      await ctx.db.insert("connections", { userId: a, connector: "gmail", status: "failed", state: `f${i}`, createdAt: Date.now() });
    }
  });
  await seedPending(a);
  const f = stubComposio(completed, { success: true });

  expect(await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).toEqual({ ok: true, connector: "gmail" });
  expect(await t.run((ctx) => ctx.db.query("connections").withIndex("by_composioAccountId", (q) => q.eq("composioAccountId", "ca_1")).unique())).toMatchObject({ status: "active" });
  expect((await t.run((ctx) => ctx.db.get("connections", old)))?.status).toBe("failed");
  // Retire deletes without revoking: same Google account, the revoke would kill the new grant.
  expect(f.mock.calls[1][0]).toMatch(/\/connected_accounts\/ca_0$/);
});

test("finish: Composio's own error text never reaches the client", async () => {
  composioEnv();
  const { seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a);
  stubComposio(status(500, "internal detail xyz"));
  const r = await asUser(a).action(api.connections.finish, { sessionUri: "su_1" });
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toMatch(/xyz|req_1|500/);
});

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
  // execute() is two Composio calls: create the send-only session, then run
  // the tool on it — see lib/composio.ts.
  const f = stubFetch({ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" });

  expect(await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" })).toBe(null);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("sending");

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const sent = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(sent).toMatchObject({ status: "sent", connector: "gmail" });
  expect(sent?.sentAt).toBeTypeOf("number");
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toMatchObject({
    user_id: a,
    connected_accounts: { gmail: ["ca_1"] },
    tools: { gmail: { enable: ["GMAIL_SEND_EMAIL"] } },
  });
  expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toMatchObject({
    tool_slug: "GMAIL_SEND_EMAIL",
    arguments: { recipient_email: "ann@acme.com", subject: "Pricing", body: "Secret body" },
  });
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toEqual([
    expect.objectContaining({ title: "emailed ann@acme.com about Pricing", kind: "note", visibility: "owner", ownerId: a }),
  ]);
});

test("a failed send never shows Composio's raw reason — only a fixed, connector-labeled copy — and can be retried", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId, internId } = await seedDraft(a);
  await seedActive(a);
  // A dead-grant-shaped message: the owner should be told to reconnect, never
  // shown Composio's own words.
  stubFetch({ session_id: "trs_1" }, { error: "invalid_grant", data: {}, log_id: "log_1" });

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const failed = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(failed?.status).toBe("failed");
  expect(failed?.sendError).toMatch(/gmail refused the send\. reconnect it and retry\./i);
  expect(failed?.sendError).not.toMatch(/invalid_grant/);
  const lines = (await t.run((ctx) => ctx.db.query("logs").withIndex("by_internId", (q) => q.eq("internId", internId)).collect())).map((l) => l.text);
  expect(lines.join("\n")).not.toMatch(/invalid_grant/);
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);

  stubFetch({ session_id: "trs_2" }, { data: {}, error: null, log_id: "log_1" });
  await asUser(a).mutation(api.outbox.resend, { actionId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const retried = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(retried?.status).toBe("sent");
  expect(retried?.sendError).toBeUndefined();
});

test("revert after needsConnect sends the original, not the discarded edit", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);

  // Edited while not connected: saved as `accepted`, waiting for the account.
  expect(
    await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Edited body" } }),
  ).toEqual({ needsConnect: "gmail" });
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.accepted?.body).toBe("Edited body");

  await seedActive(a);
  const f = stubFetch({ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" });
  // Approved again, this time restoring the intern's original body: no net edit.
  expect(
    await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Secret body" } }),
  ).toBe(null);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("sending");
  expect(row?.accepted).toBeUndefined();
  expect(row?.editedFields).toBeUndefined();
  expect(row?.decision).toBe("approved_unedited");

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(JSON.parse(String(f.mock.calls[1][1]?.body)).arguments.body).toBe("Secret body");
});

test("an edited approval sends the edited text", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  const f = stubFetch({ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" });

  expect(
    await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Edited body" } }),
  ).toBe(null);
  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.accepted?.body).toBe("Edited body");
  expect(row?.decision).toBe("edited");

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(JSON.parse(String(f.mock.calls[1][1]?.body)).arguments.body).toBe("Edited body");
  // Both the edit's preference fact and the send's write-back fact land, both owner-only.
  const facts = await t.run((ctx) => ctx.db.query("facts").collect());
  expect(facts).toHaveLength(2);
  expect(facts).toContainEqual(expect.objectContaining({ kind: "preference", visibility: "owner", ownerId: a }));
  expect(facts).toContainEqual(expect.objectContaining({ kind: "note", visibility: "owner", ownerId: a, body: expect.stringContaining("Edited body") }));
});

test("a 5xx on the execute call is `unsure`, not `failed`, and can't be resent until confirmed", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  // The session opened; the execute call itself is the one that could have
  // already reached Gmail before failing.
  stubComposio({ session_id: "trs_1" }, status(502, "upstream timeout"));

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("unsure");
  expect(row?.sendError).toMatch(/may have been sent/i);
  expect(row?.sendError).not.toMatch(/upstream timeout/);

  await expect(asUser(a).mutation(api.outbox.resend, { actionId })).rejects.toThrow(/Only a failed send/);

  // Not the owner: can't confirm it either.
  await expect(asUser(b).mutation(api.outbox.confirmUnsent, { actionId })).rejects.toThrow(/Only the person/);

  await asUser(a).mutation(api.outbox.confirmUnsent, { actionId });
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("failed");
  // Confirming again, now that it's `failed` not `unsure`, is refused.
  await expect(asUser(a).mutation(api.outbox.confirmUnsent, { actionId })).rejects.toThrow(/Only an uncertain send/);

  stubComposio({ session_id: "trs_2" }, { data: {}, error: null, log_id: "log_1" });
  await asUser(a).mutation(api.outbox.resend, { actionId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("sent");
});

test("a 4xx on the execute call is a definite `failed`, resendable right away", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  stubComposio({ session_id: "trs_1" }, status(400, "bad recipient"));

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("failed");
  expect(row?.sendError).not.toMatch(/bad recipient/);

  stubComposio({ session_id: "trs_2" }, { data: {}, error: null, log_id: "log_1" });
  await asUser(a).mutation(api.outbox.resend, { actionId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("sent");
});

test("a 408 on the execute call is `unsure` like a 5xx, not a definite failed", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  stubComposio({ session_id: "trs_1" }, status(408, "request timeout"));

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("unsure");
  expect(row?.sendError).not.toMatch(/request timeout/);
});

test("a network throw during the execute call is unsure, never sent", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  // The session opens fine; the execute request itself never comes back at all.
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ session_id: "trs_1" }));
      throw new TypeError("fetch failed");
    }),
  );

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("unsure");
  expect(row?.sendError).toMatch(/may have been sent/i);
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);
});

test("a non-JSON 200 on the execute call is unsure, never sent", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      n++;
      return n === 1 ? new Response(JSON.stringify({ session_id: "trs_1" })) : new Response("<not json>");
    }),
  );

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("unsure");
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);
});

test("a `successful: false` 200 with no `error` field is unsure, never sent", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  // Not the documented shape (`error` missing) — never a positive success signal.
  stubFetch({ session_id: "trs_1" }, { successful: false, data: {} });

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const row = await t.run((ctx) => ctx.db.get("actions", actionId));
  expect(row?.status).toBe("unsure");
  expect(await t.run((ctx) => ctx.db.query("facts").collect())).toHaveLength(0);
});

test("resend excludes the row being retried from today's send count", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const { actionId, internId } = await seedDraft(a);
  // 19 other sends today; this row's own first (failed) attempt already
  // carries a `connector` and today's `decidedAt` too. Counting it as well
  // would read 20 and wrongly refuse the retry.
  await t.run(async (ctx) => {
    for (let i = 0; i < 19; i++) {
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
  stubFetch({ session_id: "trs_1" }, { error: "invalid_grant", data: {}, log_id: "log_1" });
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("failed");

  stubFetch({ session_id: "trs_2" }, { data: {}, error: null, log_id: "log_1" });
  await asUser(a).mutation(api.outbox.resend, { actionId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("sent");
});

test("deciding an already-decided draft is refused, either way", async () => {
  const { seedUser, asUser, seedDraft } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  await expect(asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" })).rejects.toThrow(/Already decided/);
  await expect(
    asUser(a).mutation(api.outbox.decide, { actionId, decision: "reject", reason: "x" }),
  ).rejects.toThrow(/Already decided/);
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
  // A stub, drained below: an unfinished scheduled action's real timer would
  // otherwise fire mid-way through a later test and reach that test's fetch.
  stubFetch({});
  const { t, asUser } = setup();
  const a = await t.run((ctx) => ctx.db.insert("users", { handle: "ann" }));
  await asUser(a).mutation(api.users.accept, {});
  await asUser(a).mutation(api.users.accept, {});
  await asUser(a).mutation(api.facts.teach, { title: "We ship Fridays", body: "", kind: "note" });
  expect((await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count).toBe(2);
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
});

test("a successful send broadcasts who sent, never to whom", async () => {
  composioEnv();
  broadcastEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const { actionId } = await seedDraft(a);
  await seedActive(a);
  const f = stubFetch({ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" });

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const posts = f.mock.calls.filter(([url]) => url === "https://discord.test/hook").map(([, init]) => String(init?.body));
  expect(posts).toEqual([JSON.stringify(discordLine("@a sent an email · https://site.test/u/a"))]);
});

/**
 * `outbox.decide`'s `if (!visibility) await broadcast(...)` is the entire
 * enforcement that an owner-only edit lesson never reaches the community's
 * channels — everything above it (the fact itself, the log line) is already
 * owner-only regardless. Checked right after `decide` returns, before its
 * scheduled send ever runs: at that point `decide`'s own mutation is the only
 * thing that could have queued a `learned` broadcast, so a clean `broadcasts`
 * table and an untouched fetch stub prove the gate held, not just that the
 * later send hadn't gotten around to posting yet.
 */
test("an edited approval that could reach a real person doesn't broadcast the lesson it learns", async () => {
  composioEnv();
  broadcastEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const { actionId } = await seedDraft(a);
  const f = stubFetch({ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" });

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Edited body" } });

  expect(await t.run((ctx) => ctx.db.query("broadcasts").collect())).toHaveLength(0);
  expect(f).not.toHaveBeenCalled();

  // Drain the scheduled send so its real timer can't fire mid-way through a
  // later test (see the "broadcast hooks" test above) — its outcome (a `sent`
  // broadcast) isn't what this test is about.
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
});

/** The mirror of the test above: a sandbox draft's edit lesson is public, so it does broadcast. */
test("an edited sandbox approval does broadcast the lesson it learns", async () => {
  broadcastEnv();
  const { t, seedUser, asUser, seedDraft } = setup();
  const a = await seedUser("a");
  // A real sandbox draft is never draftedLive: interns.ts only sets it true
  // when a connector was configured and connected as the run started.
  const { actionId } = await seedDraft(a, "email", { draftedLive: false });
  const f = stubFetch({});

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { body: "Edited body" } });
  expect((await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count).toBe(1);

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const posts = f.mock.calls.filter(([url]) => url === "https://discord.test/hook").map(([, init]) => String(init?.body));
  expect(posts).toEqual([JSON.stringify(discordLine("@a corrected a draft and the brain learned: email: body rewritten before approval · https://site.test/u/a"))]);
});

const discordLine = (content: string) => ({ content, username: "Intern", allowed_mentions: { parse: [] } });

// --- inbound: 🧠 in Slack, the Intern label in Gmail -------------------------

const WEBHOOK_SECRET = "test-webhook-secret";

/** Replies by URL: the first key contained in the request URL wins; anything else is a 404. */
function route(table: [string, unknown][]) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const hit = table.find(([k]) => url.includes(k));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

/** A webhook request signed the way Composio signs one (see lib/inbound.ts). */
async function signed(payload: unknown, secret = WEBHOOK_SECRET) {
  const body = JSON.stringify(payload);
  const id = "msg_1";
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    method: "POST",
    body,
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${await sign(secret, id, ts, body)}` },
  };
}

// The V3 envelope with each trigger's documented `data` fields.
const slackEvent = (
  userId: string,
  o: { reactor?: string; reaction?: string; accountId?: string; channel?: string; author?: string } = {},
) => ({
  id: "msg_abc",
  type: "composio.trigger.message",
  metadata: { trigger_slug: TRIGGERS.slack.slug, trigger_id: "ti_s", user_id: userId, connected_account_id: o.accountId ?? "ca_1" },
  data: {
    reaction: o.reaction ?? "brain",
    user: o.reactor ?? "U123",
    message_channel: o.channel ?? "C1",
    message_ts: "1726900000.000100",
    message_user: o.author ?? "U123",
    event_ts: "1726900001.000200",
  },
  timestamp: "2026-09-21T12:00:00Z",
});

const gmailEvent = (userId: string, accountId = "ca_1") => ({
  id: "msg_def",
  type: "composio.trigger.message",
  metadata: { trigger_slug: TRIGGERS.gmail.slug, trigger_id: "ti_g", user_id: userId, connected_account_id: accountId },
  data: { id: "18f0a1", message_id: "18f0a1", subject: "Pricing decision", message_text: "We charge per seat.", label_ids: ["Label_7"] },
  timestamp: "2026-09-21T12:00:00Z",
});

/** Slack's conversations.info for a public channel the member is in. */
const PUBLIC_CHANNEL = { ok: true, channel: { id: "C1", is_channel: true, is_private: false, is_im: false, is_mpim: false } };

/**
 * Slack tools through a session, answered by tool slug: history returns
 * `text` at `ts`; conversations.info returns `info`, or a 500 for "fail".
 */
function stubSlack(o: { text: string; ts?: string; info?: unknown }) {
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    if (url.includes("/execute")) {
      const tool = JSON.parse(String(init?.body)).tool_slug;
      if (tool === SLACK_TOOLS.history) {
        const messages = [{ type: "message", text: o.text, ts: o.ts ?? "1726900000.000100" }];
        return new Response(JSON.stringify({ data: { ok: true, messages }, error: null, log_id: "log_1" }));
      }
      if (tool === SLACK_TOOLS.info) {
        if (o.info === "fail") return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
        return new Response(JSON.stringify({ data: o.info ?? PUBLIC_CHANNEL, error: null, log_id: "log_2" }));
      }
    }
    if (url.includes("/tool_router/session")) return new Response(JSON.stringify({ session_id: "trs_1" }));
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

const toolsCalled = (f: ReturnType<typeof stubSlack>) =>
  f.mock.calls.filter(([url]) => url.includes("/execute")).map(([, init]) => JSON.parse(String(init?.body)).tool_slug);

const allFacts = (t: ReturnType<typeof setup>["t"]) => t.run((ctx) => ctx.db.query("facts").collect());
const path = (url: string) => url.replace(/^.*\/api\/v3\.1/, "");

function inboundEnv() {
  composioEnv();
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", WEBHOOK_SECRET);
}

test("connecting Slack learns who the member is there and subscribes to their 🧠", async () => {
  inboundEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a, "slack");
  const f = route([
    ["/connected_accounts/complete_auth", { connected_account_id: "ca_1", toolkit_slug: "slack" }],
    ["/execute", { data: { ok: true, user_id: "U123", user: "ann", team: "acme" }, error: null, log_id: "log_1" }],
    ["/tool_router/session", { session_id: "trs_1" }],
    [`/trigger_instances/${TRIGGERS.slack.slug}/upsert`, { trigger_id: "ti_s" }],
  ]);

  expect(await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).toEqual({ ok: true, connector: "slack" });
  expect(await t.run((ctx) => ctx.db.query("connections").first())).toMatchObject({
    status: "active",
    externalUserId: "U123",
    accountLabel: "@ann in acme",
    triggerId: "ti_s",
  });
  const whoami = f.mock.calls.find(([url]) => url.includes("/execute"));
  expect(JSON.parse(String(whoami?.[1]?.body)).tool_slug).toBe(SLACK_TOOLS.whoami);
  const trigger = f.mock.calls.find(([url]) => url.includes("/trigger_instances/"));
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({ user_id: a, connected_account_id: "ca_1", trigger_config: TRIGGERS.slack.config });
});

test("connecting Slack subscribes to nothing without a webhook secret", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a, "slack");
  const f = route([["/connected_accounts/complete_auth", { connected_account_id: "ca_1", toolkit_slug: "slack" }]]);
  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(true);
  expect(f).toHaveBeenCalledTimes(1);
  expect((await t.run((ctx) => ctx.db.query("connections").first()))?.triggerId).toBeUndefined();
});

test("connecting Gmail to send never starts reading mail", async () => {
  inboundEnv();
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE", "ac_read");
  const { seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a, "gmail");
  const f = route([["/connected_accounts/complete_auth", { connected_account_id: "ca_1", toolkit_slug: "gmail" }]]);
  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(true);
  expect(f.mock.calls.map(([url]) => path(url))).toEqual(["/connected_accounts/complete_auth"]);
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", connected: true, capture: false }),
  );
});

test("the Intern-label toggle isn't offered until the deployment sets up a read-only grant and a webhook secret", async () => {
  inboundEnv();
  const { seedUser, asUser } = setup();
  const a = await seedUser("a");
  const f = route([]);
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(expect.objectContaining({ key: "gmail", capture: null }));
  await expect(asUser(a).action(api.connections.start, { connector: "gmail", capture: true })).rejects.toThrow(/not set up yet/);
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE", "ac_read");
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "");
  await expect(asUser(a).action(api.connections.start, { connector: "gmail", capture: true })).rejects.toThrow(/not set up yet/);
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", WEBHOOK_SECRET);
  await expect(asUser(a).action(api.connections.start, { connector: "slack", capture: true })).rejects.toThrow(/not set up yet/);
  expect(f).not.toHaveBeenCalled();
});

test("turning the Intern label on is its own consent, through the read-only auth config, and only then a Gmail trigger", async () => {
  inboundEnv();
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE", "ac_read");
  const { seedUser, asUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail", { composioAccountId: "ca_send" });
  const f = route([
    ["/link", { redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_read" }],
    ["/tool_router/session", { session_id: "trs_1" }],
  ]);
  expect(await asUser(a).action(api.connections.start, { connector: "gmail", capture: true })).toBe("https://connect.composio.dev/link/ln_1");
  expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ user_id: a, auth_configs: { gmail: "ac_read" } });
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(expect.objectContaining({ key: "gmail", capture: false }));

  const g = route([
    ["/connected_accounts/complete_auth", { connected_account_id: "ca_read", toolkit_slug: "gmail" }],
    [`/trigger_instances/${TRIGGERS.gmail.slug}/upsert`, { trigger_id: "ti_g" }],
  ]);
  expect(await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).toEqual({ ok: true, connector: "gmail", capture: true });
  const trigger = g.mock.calls.find(([url]) => url.includes("/trigger_instances/"));
  expect(JSON.parse(String(trigger?.[1]?.body))).toEqual({ user_id: a, connected_account_id: "ca_read", trigger_config: TRIGGERS.gmail.config });
  // The send grant is untouched: capture is a second account, not a replacement.
  expect(g.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", connected: true, capture: true }),
  );
});

test("turning the Intern label off deletes the trigger and the read grant, and keeps sending", async () => {
  inboundEnv();
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE", "ac_read");
  const { seedUser, asUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail", { composioAccountId: "ca_send" });
  await seedActive(a, "gmail", { composioAccountId: "ca_read", capture: true, triggerId: "ti_g" });
  const f = route([["/trigger_instances/manage/ti_g", { trigger_id: "ti_g" }], ["/connected_accounts/ca_read", { success: true }]]);

  await asUser(a).action(api.connections.stopCapture, {});
  expect(f.mock.calls.map(([url, init]) => [path(url), init?.method])).toEqual([
    ["/trigger_instances/manage/ti_g", "DELETE"],
    // No revoke: with the same OAuth app it would take the send grant down too.
    ["/connected_accounts/ca_read", "DELETE"],
  ]);
  expect(await asUser(a).query(api.connections.mine, {})).toContainEqual(
    expect.objectContaining({ key: "gmail", connected: true, capture: false }),
  );
});

test("a Gmail trigger that can't be created turns capture straight back off, so no read grant sits unused", async () => {
  inboundEnv();
  vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL_CAPTURE", "ac_read");
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  const row = await seedPending(a, "gmail", "s1", "ca_read");
  await t.run((ctx) => ctx.db.patch("connections", row, { capture: true }));
  const f = route([
    ["/connected_accounts/complete_auth", { connected_account_id: "ca_read", toolkit_slug: "gmail" }],
    ["/connected_accounts/ca_read", { success: true }],
  ]);
  expect((await asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).ok).toBe(false);
  expect((await t.run((ctx) => ctx.db.get("connections", row)))?.status).toBe("failed");
  expect(f.mock.calls.map(([url, init]) => [path(url), init?.method]).at(-1)).toEqual(["/connected_accounts/ca_read", "DELETE"]);
});

test("disconnecting deletes the account's trigger before the account", async () => {
  inboundEnv();
  const { seedUser, asUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", { externalUserId: "U123", triggerId: "ti_s" });
  const f = route([["/trigger_instances/manage/ti_s", {}], ["/connected_accounts/ca_1", { success: true }]]);
  await asUser(a).action(api.connections.disconnect, { connector: "slack" });
  expect(f.mock.calls.map(([url]) => path(url))).toEqual(["/trigger_instances/manage/ti_s", "/connected_accounts/ca_1?revoke_on_delete=true"]);
});

test("disconnecting Gmail also switches the Intern label off", async () => {
  inboundEnv();
  const { seedUser, asUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail", { composioAccountId: "ca_send" });
  await seedActive(a, "gmail", { composioAccountId: "ca_read", capture: true, triggerId: "ti_g" });
  const f = route([["/trigger_instances/manage/ti_g", {}], ["/connected_accounts/", { success: true }]]);
  await asUser(a).action(api.connections.disconnect, { connector: "gmail" });
  expect(f.mock.calls.map(([url]) => path(url)).sort()).toEqual([
    "/connected_accounts/ca_read",
    "/connected_accounts/ca_send?revoke_on_delete=true",
    "/trigger_instances/manage/ti_g",
  ]);
});

test("purge deletes a connection's trigger along with its account", async () => {
  inboundEnv();
  vi.useFakeTimers();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", { triggerId: "ti_s" });
  const f = route([["/trigger_instances/manage/ti_s", {}], ["/connected_accounts/ca_1", { success: true }]]);
  await t.mutation(internal.users.purge, { userId: a });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f.mock.calls.map(([url]) => path(url))).toEqual(["/trigger_instances/manage/ti_s", "/connected_accounts/ca_1?revoke_on_delete=true"]);
});

test("webhook: a bad signature, or no secret configured, is refused with 401 before anything is read", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", { externalUserId: "U123" });
  const f = stubSlack({ text: "hello" });
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a), "wrong"))).status).toBe(401);
  expect((await t.fetch("/composio/webhook", { method: "POST", body: JSON.stringify(slackEvent(a)) })).status).toBe(401);
  vi.stubEnv("COMPOSIO_WEBHOOK_SECRET", "");
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a)))).status).toBe(401);
  expect(f).not.toHaveBeenCalled();
  expect(await allFacts(t)).toHaveLength(0);
});

test("webhook: the member's own 🧠 on their own message in a confirmed public channel is public and broadcast, once", async () => {
  inboundEnv();
  broadcastEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", { externalUserId: "U123" });
  const f = stubSlack({ text: "We ship on Fridays\nbecause QA is Thursday" });

  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a)))).status).toBe(200);
  const exec = f.mock.calls.filter(([url]) => url.includes("/execute")).map(([, init]) => JSON.parse(String(init?.body)));
  expect(exec).toEqual([
    { tool_slug: SLACK_TOOLS.history, arguments: { channel: "C1", latest: "1726900000.000100", inclusive: true, limit: 1 } },
    { tool_slug: SLACK_TOOLS.info, arguments: { channel: "C1" } },
  ]);
  const rows = await allFacts(t);
  expect(rows).toEqual([expect.objectContaining({ title: "We ship on Fridays", body: "because QA is Thursday", ownerId: a, kind: "note" })]);
  expect(rows[0]?.visibility).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count).toBe(1);

  // Composio redelivers: same message, no second fact.
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a)))).status).toBe(200);
  expect(await allFacts(t)).toHaveLength(1);

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
});

test("webhook: someone else's 🧠, another reaction, or a message that's gone captures nothing", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", { externalUserId: "U123" });
  const f = stubSlack({ text: "nope" });

  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a, { reactor: "U999" })))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a, { reaction: "thumbsup" })))).status).toBe(200);
  expect(f).not.toHaveBeenCalled();

  stubSlack({ text: "an older message", ts: "1726899999.000000" });
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a)))).status).toBe(200);
  expect(await allFacts(t)).toHaveLength(0);
});

test("webhook: a payload's user id counts only through that user's own live connection", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedActive(a, "slack", { externalUserId: "U123" });
  const f = stubSlack({ text: "hello" });

  // b claims a's account; an account nobody has; not an id at all.
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(b)))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(a, { accountId: "ca_9" })))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(slackEvent("not-an-id")))).status).toBe(200);
  expect(f).not.toHaveBeenCalled();
  expect(await allFacts(t)).toHaveLength(0);
});

test("webhook: banned or unconsented members capture nothing", async () => {
  inboundEnv();
  const { t, seedActive } = setup();
  const banned = await t.run((ctx) => ctx.db.insert("users", { handle: "x", acceptedAt: Date.now(), bannedAt: Date.now() }));
  const unconsented = await t.run((ctx) => ctx.db.insert("users", { handle: "u" }));
  await seedActive(banned, "slack", { externalUserId: "U123" });
  await seedActive(unconsented, "gmail", { composioAccountId: "ca_2", capture: true, triggerId: "ti_g" });
  const f = stubSlack({ text: "hello" });
  expect((await t.fetch("/composio/webhook", await signed(slackEvent(banned)))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(unconsented, "ca_2")))).status).toBe(200);
  expect(f).not.toHaveBeenCalled();
  expect(await allFacts(t)).toHaveLength(0);
});

test("webhook: an Intern-labelled email becomes an owner-only fact, never broadcast, once", async () => {
  inboundEnv();
  broadcastEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail", { capture: true, triggerId: "ti_g" });
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(a)))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(a)))).status).toBe(200);
  expect(await allFacts(t)).toEqual([
    expect.objectContaining({ title: "Pricing decision", body: "We charge per seat.", ownerId: a, visibility: "owner" }),
  ]);
  expect(await t.run((ctx) => ctx.db.query("broadcasts").collect())).toHaveLength(0);
});

test("webhook: with the Intern label off, a Gmail event captures nothing", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  // Only the send grant, plus a capture grant the member switched off.
  await seedActive(a, "gmail");
  await seedActive(a, "gmail", { composioAccountId: "ca_2", capture: true, triggerId: "ti_g", status: "failed" });
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(a)))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(a, "ca_2")))).status).toBe(200);
  expect(await allFacts(t)).toHaveLength(0);
});

test("webhook: a full day captures nothing", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail", { capture: true, triggerId: "ti_g" });
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) await ctx.db.insert("facts", { title: `f${i}`, body: "", kind: "note", ownerId: a, text: `f${i}\n` });
  });
  expect((await t.fetch("/composio/webhook", await signed(gmailEvent(a)))).status).toBe(200);
  expect(await allFacts(t)).toHaveLength(20);
});

/** A 🧠 that could reach the public brain, but for one reason is filed owner-only and never broadcast. */
async function capturedPrivately(event: (a: string) => unknown, info?: unknown) {
  inboundEnv();
  broadcastEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack", { externalUserId: "U123" });
  const f = stubSlack({ text: "Salary bands\nare private", info });
  expect((await t.fetch("/composio/webhook", await signed(event(a)))).status).toBe(200);
  expect(await allFacts(t)).toEqual([
    expect.objectContaining({ title: "Salary bands", body: "are private", ownerId: a, visibility: "owner" }),
  ]);
  expect(await t.run((ctx) => ctx.db.query("broadcasts").collect())).toHaveLength(0);
  return f;
}

test("webhook: a 🧠 in a DM is saved owner-only, without even asking Slack about the channel", async () => {
  const f = await capturedPrivately((a) => slackEvent(a, { channel: "D0123" }));
  expect(toolsCalled(f)).toEqual([SLACK_TOOLS.history]);
});

test("webhook: a 🧠 in a legacy private channel or group DM is saved owner-only", async () => {
  await capturedPrivately((a) => slackEvent(a, { channel: "G0123" }));
});

test("webhook: a 🧠 in a channel Slack reports private is saved owner-only", async () => {
  await capturedPrivately((a) => slackEvent(a), { ok: true, channel: { id: "C1", is_private: true, is_im: false, is_mpim: false } });
});

test("webhook: when the channel lookup fails, the 🧠 is saved owner-only", async () => {
  const f = await capturedPrivately((a) => slackEvent(a), "fail");
  expect(toolsCalled(f)).toEqual([SLACK_TOOLS.history, SLACK_TOOLS.info]);
});

test("webhook: a channel reply without the privacy flags counts as private", async () => {
  await capturedPrivately((a) => slackEvent(a), { ok: true, channel: { id: "C1" } });
});

test("webhook: a 🧠 on someone else's message in a public channel is saved owner-only", async () => {
  await capturedPrivately((a) => slackEvent(a, { author: "U777" }));
});

test("webhook: a Gmail event with no message id is dropped, not keyed on the delivery id", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail", { capture: true, triggerId: "ti_g" });
  const e = gmailEvent(a);
  const noId = { ...e, data: { subject: "Pricing decision", message_text: "We charge per seat." } };
  // A re-poll delivers the same mail under a new delivery id.
  expect((await t.fetch("/composio/webhook", await signed(noId))).status).toBe(200);
  expect((await t.fetch("/composio/webhook", await signed({ ...noId, id: "msg_other" }))).status).toBe(200);
  expect(await allFacts(t)).toHaveLength(0);
});

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

// --- final review fix wave ---------------------------------------------------

test("a lesson from a draft whose run read something private stays private, even with no connector", async () => {
  broadcastEnv();
  const f = stubFetch({});
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  // A send's write-back: owner-only, and exactly what a later draft can quote.
  const writeBack = await t.run((ctx) =>
    ctx.db.insert("facts", {
      title: "emailed ann@acme.com about the renewal",
      body: "$40k, signed Friday",
      kind: "note",
      visibility: "owner",
      ownerId: a,
      text: "emailed ann@acme.com about the renewal\n$40k, signed Friday",
    }),
  );
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: a, task: "book the renewal call", status: "running", countsTowardCap: true }),
  );
  await t.mutation(internal.interns.noteRecall, { internId, recalled: [{ id: writeBack, kind: "note", visibility: "owner" }] });
  await t.mutation(internal.interns.finish, {
    internId,
    report: "drafted",
    tokensIn: 1,
    tokensOut: 1,
    latencyMs: 1,
    facts: [],
    action: {
      kind: "calendar",
      title: "renewal call",
      draft: { to: ["ann@acme.com"], subject: "Renewal 40k", body: "Signing the 40k renewal" },
      rationale: "because",
      sources: [],
    },
  });
  const action = await t.run((ctx) => ctx.db.query("actions").first());
  expect(action?.recalledPrivate).toBe(true);
  const broadcastsBefore = (await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count ?? 0;

  await asUser(a).mutation(api.outbox.decide, { actionId: action!._id, decision: "reject", reason: "wrong day" });

  const correction = (await allFacts(t)).find((x) => x.kind === "correction");
  expect(correction).toMatchObject({ visibility: "owner", ownerId: a });
  const forB = (await asUser(b).query(api.facts.graph, {})).nodes.map((n) => n.label).join("\n");
  expect(forB).not.toMatch(/40k|do not send/);
  const feed = (await asUser(b).query(api.community.feed, {})).map((e) => e.text).join("\n");
  expect(feed).not.toMatch(/40k|do not send|ann@acme/);
  const recalled = await t.query(internal.facts.recall, { task: "renewal 40k", ownerId: b });
  expect(recalled.map((r) => r.id)).not.toContain(correction?._id);
  expect((await t.run((ctx) => ctx.db.query("broadcasts").collect()))[0]?.count ?? 0).toBe(broadcastsBefore);

  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(JSON.stringify(f.mock.calls)).not.toMatch(/40k|do not send/);
});

test("a lesson from a draft drafted live stays owner-only even after the member disconnects", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  const connId = await seedActive(a, "gmail");
  const { actionId } = await seedDraft(a, "email", { draftedLive: true, recalledPrivate: false });
  // Disconnected before the decision: no live connection at decide time, so
  // `connection` alone would read this as safe to make public.
  await t.run((ctx) => ctx.db.patch("connections", connId, { status: "failed" }));

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "reject", reason: "changed my mind" });

  const correction = (await allFacts(t)).find((x) => x.kind === "correction");
  expect(correction).toMatchObject({ visibility: "owner", ownerId: a });
});

test("an action row with no recalledPrivate field falls back to its intern's recalledPrivate", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  // Modeled on a row from before `actions.recalledPrivate` existed: the
  // intern carries it, the action doesn't carry the field at all (not `false`).
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", { ownerId: a, task: "t", status: "done", countsTowardCap: true, recalledPrivate: true }),
  );
  const actionId = await t.run((ctx) =>
    ctx.db.insert("actions", {
      ownerId: a,
      internId,
      kind: "email",
      status: "pending",
      title: "email to ann@acme.com — Pricing",
      draft: { to: ["ann@acme.com"], subject: "Pricing", body: "Secret body" },
      rationale: "because",
      sources: [],
      recalledCorrection: false,
    }),
  );

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "reject", reason: "wrong person" });

  const correction = (await allFacts(t)).find((x) => x.kind === "correction");
  expect(correction).toMatchObject({ visibility: "owner", ownerId: a });
});

test("a public lesson names no address, and its log line quotes none of the draft", async () => {
  const { t, seedUser, asUser, seedDraft } = setup();
  const a = await seedUser("a");
  // A real sandbox draft is never draftedLive: interns.ts only sets it true
  // when a connector was configured and connected as the run started.
  const { actionId, internId } = await seedDraft(a, "email", { draftedLive: false });
  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "reject", reason: "cc bob@acme.com instead" });
  const [fact] = await allFacts(t);
  expect(fact.visibility).toBeUndefined();
  expect(`${fact.title}\n${fact.body}`).not.toMatch(/@acme\.com/);
  expect(fact.body).toContain("[email]");
  const lines = (
    await t.run((ctx) => ctx.db.query("logs").withIndex("by_internId", (q) => q.eq("internId", internId)).collect())
  ).map((l) => l.text);
  expect(lines).toEqual(["rejected · learned a correction"]);
});

test("other people's interns carry no displayTask, parser verdict, lesson flag or connected accounts", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  const internId = await t.run((ctx) =>
    ctx.db.insert("interns", {
      ownerId: a,
      task: "follow up: the answer was ann@acme.com",
      displayTask: "who owns pricing? ask ann@acme.com",
      status: "done",
      parseOutcome: "action_malformed:bad to",
      recalledCorrection: true,
      sendsFrom: ["gmail"],
      countsTowardCap: true,
    }),
  );
  const theirs = (await asUser(b).query(api.interns.list, {})).find((i) => i._id === internId);
  expect(theirs?.task).toBe("who owns pricing? ask [email]");
  expect(theirs?.displayTask).toBeUndefined();
  expect(theirs?.parseOutcome).toBeUndefined();
  expect(theirs?.recalledCorrection).toBeUndefined();
  expect(theirs?.sendsFrom).toBeUndefined();
  const mine = (await asUser(a).query(api.interns.list, {})).find((i) => i._id === internId);
  expect(mine?.parseOutcome).toBe("action_malformed:bad to");
});

test("resend stops after three attempts in all", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a);
  const { actionId } = await seedDraft(a);
  const f = stubFetch({ session_id: "trs_1" }, { error: "invalid_grant", data: {}, log_id: "log_1" });
  vi.useFakeTimers();

  await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  for (let i = 0; i < 2; i++) {
    await asUser(a).mutation(api.outbox.resend, { actionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }
  expect(await t.run((ctx) => ctx.db.get("actions", actionId))).toMatchObject({ status: "failed", attempts: 3 });
  const calls = f.mock.calls.length;

  await expect(asUser(a).mutation(api.outbox.resend, { actionId })).rejects.toThrow(/tried 3 times/);
  expect(f.mock.calls.length).toBe(calls);
});

test("a sandbox-drafted message can't go out unchanged once connected; with its recipient edited, it sends", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedDraft, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "slack");
  const { actionId } = await seedDraft(a, "slack", {});
  const f = stubFetch({ session_id: "trs_1" }, { data: {}, error: null, log_id: "log_1" });

  await expect(asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve" })).rejects.toThrow(/placeholders/);
  // Retyping the same placeholder isn't choosing a recipient.
  await expect(
    asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { to: ["#general"] } }),
  ).rejects.toThrow(/placeholders/);
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("pending");
  expect(f).not.toHaveBeenCalled();

  expect(
    await asUser(a).mutation(api.outbox.decide, { actionId, decision: "approve", edits: { to: ["#team-pricing"] } }),
  ).toBe(null);
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(JSON.parse(String(f.mock.calls[1][1]?.body)).arguments.channel).toBe("#team-pricing");
  expect((await t.run((ctx) => ctx.db.get("actions", actionId)))?.status).toBe("sent");
});

test("a draft is marked live only when its own kind's account was connected as the run started", async () => {
  composioEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  await seedActive(a, "gmail");
  const draftFrom = async (kind: "email" | "slack") => {
    const internId = await t.run((ctx) => ctx.db.insert("interns", { ownerId: a, task: "t", status: "queued", countsTowardCap: true }));
    await t.mutation(internal.interns.start, { internId });
    await t.mutation(internal.interns.finish, {
      internId,
      report: "r",
      tokensIn: 1,
      tokensOut: 1,
      latencyMs: 1,
      facts: [],
      action: { kind, title: "t", draft: { to: ["x"], subject: "s", body: "b" }, rationale: "r", sources: [] },
    });
    const row = await t.run((ctx) => ctx.db.query("actions").withIndex("by_internId", (q) => q.eq("internId", internId)).first());
    return row?.draftedLive;
  };
  expect(await draftFrom("email")).toBe(true);
  expect(await draftFrom("slack")).toBe(false);
});

test("a send's write-back doesn't use up the day's twenty facts", async () => {
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) {
      await ctx.db.insert("facts", { title: `sent ${i}`, body: "", kind: "note", ownerId: a, visibility: "owner", source: `send:${i}`, text: "" });
    }
  });
  await asUser(a).mutation(api.facts.teach, { title: "We ship Fridays", body: "", kind: "note" });
  expect(await allFacts(t)).toHaveLength(21);
});

// --- metering Composio, and grants nobody owns ------------------------------

// --- metering Composio, and grants nobody owns ------------------------------

test("connect: a sixth link in an hour is refused before Composio is called", async () => {
  composioEnv();
  vi.useFakeTimers();
  const { t, seedUser, asUser } = setup();
  const a = await seedUser("a");
  for (let i = 0; i < 5; i++) {
    await t.run((ctx) =>
      ctx.db.insert("connections", { userId: a, connector: "gmail", status: "failed", state: `s${i}`, createdAt: Date.now() }),
    );
  }
  const f = stubFetch({ session_id: "trs_1" }, linked);
  await expect(asUser(a).action(api.connections.start, { connector: "gmail" })).rejects.toThrow(/Too many connect attempts/);
  expect(f).not.toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("connections").collect())).toHaveLength(5);

  // An hour on, the old attempts no longer count.
  vi.setSystemTime(Date.now() + 61 * 60_000);
  expect(await asUser(a).action(api.connections.start, { connector: "gmail" })).toBe(linked.redirect_url);
});

test("webhook: a repeated 🧠 or a full day makes no Composio call at all", async () => {
  inboundEnv();
  const { t, seedUser, seedActive } = setup();
  const a = await seedUser("a");
  const b = await seedUser("b");
  await seedActive(a, "slack", { externalUserId: "U123" });
  await t.run((ctx) =>
    ctx.db.insert("facts", {
      title: "x",
      body: "",
      kind: "note",
      ownerId: a,
      visibility: "owner",
      source: "slack:C1:1726900000.000100",
      text: "x\n",
    }),
  );
  const f = stubSlack({ text: "hello" });
  expect(await (await t.fetch("/composio/webhook", await signed(slackEvent(a)))).text()).toBe("duplicate");
  expect(f).not.toHaveBeenCalled();

  await t.run(async (ctx) => {
    await ctx.db.insert("connections", {
      userId: b,
      connector: "slack",
      status: "active",
      composioAccountId: "ca_2",
      externalUserId: "U123",
      state: "s",
      createdAt: Date.now(),
    });
    for (let i = 0; i < 20; i++) await ctx.db.insert("facts", { title: `f${i}`, body: "", kind: "note", ownerId: b, text: `f${i}\n` });
  });
  expect(await (await t.fetch("/composio/webhook", await signed(slackEvent(b, { accountId: "ca_2" })))).text()).toBe("over the daily cap");
  expect(f).not.toHaveBeenCalled();
});

test("finish: if activation fails after Composio verified the grant, the account is deleted", async () => {
  composioEnv();
  const { t, seedUser, asUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a);
  let call = 0;
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    // Banned between Composio's answer and our write: `activate` refuses.
    if (call++ === 0) await t.run((ctx) => ctx.db.patch("users", a, { bannedAt: Date.now() }));
    return new Response(JSON.stringify(call === 1 ? completed : { success: true }));
  });
  vi.stubGlobal("fetch", f);
  await expect(asUser(a).action(api.connections.finish, { sessionUri: "su_1" })).rejects.toThrow(/blocked/);
  expect(f.mock.calls[1][0]).toMatch(/\/connected_accounts\/ca_1$/);
  expect(f.mock.calls[1][1]?.method).toBe("DELETE");
});

test("purge also deletes the account a still-pending link made at Composio", async () => {
  composioEnv();
  vi.useFakeTimers();
  const { t, seedUser, seedPending } = setup();
  const a = await seedUser("a");
  await seedPending(a, "slack", "s1", "ca_7");
  await t.run((ctx) =>
    ctx.db.insert("connections", { userId: a, connector: "gmail", status: "pending", state: "s2", createdAt: Date.now() }),
  );
  const f = stubFetch({ success: true });
  await t.mutation(internal.users.purge, { userId: a });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(f.mock.calls.map(([url]) => path(url))).toEqual(["/connected_accounts/ca_7?revoke_on_delete=true"]);
});
