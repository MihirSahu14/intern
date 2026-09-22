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

/** Every env var the connect path reads, set to test values. Managed auth: no auth config. */
function composioEnv() {
  vi.stubEnv("COMPOSIO_API_KEY", "key");
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
  const seedPending = (userId: Id<"users">, connector: "gmail" | "slack" = "gmail", state = "s1", composioAccountId = "ca_1") =>
    t.run((ctx) =>
      ctx.db.insert("connections", { userId, connector, status: "pending", state, composioAccountId, createdAt: Date.now() }),
    );
  return { t, seedUser, asUser, seedDraft, seedPending };
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
      error: 'gemini rejected argument "body": "secret renewal terms"',
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
  expect(f.mock.calls[1][0]).toContain("/connected_accounts/ca_1");
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
  expect(f.mock.calls[1][0]).toContain("/connected_accounts/ca_0");
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
  expect(f.mock.calls[0][0]).toContain("/connected_accounts/ca_1");
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
  expect(f.mock.calls[0][0]).toContain("/connected_accounts/ca_1");
  expect(f.mock.calls[0][1]?.method).toBe("DELETE");
});
