import { afterEach, expect, test, vi } from "vitest";
import { COMPOSIO_API, ComposioError, PATHS, completeAuth, connect, deleteAccount, deleteTrigger, execute, upsertTrigger } from "../lib/composio.ts";

afterEach(() => vi.unstubAllGlobals());

/** Canned replies, one per request in order; the last one repeats. */
const replies = (...bodies: [unknown, number?][]) => {
  let i = 0;
  const f = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
    const [body, status = 200] = bodies[Math.min(i++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", f);
  return f;
};
const sent = (f: ReturnType<typeof replies>, n: number) => JSON.parse(String(f.mock.calls[n][1]?.body));

test("connect opens a session for our user, then a link for the toolkit", async () => {
  const f = replies(
    [{ session_id: "trs_1" }],
    [{ redirect_url: "https://connect.composio.dev/link/ln_1", connected_account_id: "ca_1" }],
  );
  expect(await connect("key", { userId: "u1", toolkit: "gmail" })).toEqual({
    redirectUrl: "https://connect.composio.dev/link/ln_1",
    accountId: "ca_1",
  });
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_API}${PATHS.session}`);
  expect(f.mock.calls[0][1]?.method).toBe("POST");
  expect(new Headers(f.mock.calls[0][1]?.headers).get("x-api-key")).toBe("key");
  // Managed auth: no auth config unless the deployment names one.
  expect(sent(f, 0)).toEqual({ user_id: "u1" });
  expect(f.mock.calls[1][0]).toBe(`${COMPOSIO_API}${PATHS.link("trs_1")}`);
  expect(sent(f, 1)).toEqual({ toolkit: "gmail" });
});

test("a custom auth config rides on the session, keyed by toolkit", async () => {
  const f = replies([{ session_id: "trs_1" }], [{ redirect_url: "https://x", connected_account_id: "ca_1" }]);
  await connect("key", { userId: "u1", toolkit: "slack", authConfigId: "ac_9" });
  expect(sent(f, 0)).toEqual({ user_id: "u1", auth_configs: { slack: "ac_9" } });
});

test("a link reply without a URL or account is an error, not an empty redirect", async () => {
  replies([{ session_id: "trs_1" }], [{ redirect_url: "https://x" }]);
  await expect(connect("key", { userId: "u1", toolkit: "gmail" })).rejects.toBeInstanceOf(ComposioError);
});

test("deleteAccount revokes upstream only when asked", async () => {
  const f = replies([{ success: true }]);
  await deleteAccount("key", "ca_1", { revoke: true });
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_API}${PATHS.account("ca_1")}?revoke_on_delete=true`);
  await deleteAccount("key", "ca_1", { revoke: false });
  expect(f.mock.calls[1][0]).toBe(`${COMPOSIO_API}${PATHS.account("ca_1")}`);
  expect(f.mock.calls[0][1]?.method).toBe("DELETE");
});

test("execute pins the member's account on a session that can run only that tool", async () => {
  const f = replies([{ session_id: "trs_1" }], [{ data: { id: "m1" }, error: null, log_id: "log_1" }]);
  const args = { userId: "u1", toolkit: "gmail", accountId: "ca_1", arguments: { subject: "s" } };
  expect(await execute("key", "GMAIL_SEND_EMAIL", args)).toEqual({ id: "m1" });
  expect(sent(f, 0)).toEqual({
    user_id: "u1",
    connected_accounts: { gmail: ["ca_1"] },
    toolkits: { enable: ["gmail"] },
    tools: { gmail: { enable: ["GMAIL_SEND_EMAIL"] } },
    workbench: { enable: false },
  });
  expect(f.mock.calls[1][0]).toBe(`${COMPOSIO_API}${PATHS.execute("trs_1")}`);
  expect(sent(f, 1)).toEqual({ tool_slug: "GMAIL_SEND_EMAIL", arguments: { subject: "s" } });
});

test("errors carry Composio's reason and its request or log id", async () => {
  const args = { userId: "u1", toolkit: "gmail", accountId: "ca_1", arguments: {} };
  replies([{ error: { message: "invalid api key", request_id: "req_1" } }, 401]);
  await expect(execute("key", "GMAIL_SEND_EMAIL", args)).rejects.toThrow(/composio 401: invalid api key \(req_1\)/);
  replies([{ session_id: "trs_1" }], [{ data: {}, error: "invalid_grant", log_id: "log_2" }]);
  await expect(execute("key", "GMAIL_SEND_EMAIL", args)).rejects.toThrow(/invalid_grant \(log_2\)/);
});

test("completeAuth redeems the verifier session for the signed-in user", async () => {
  const f = replies([{ connected_account_id: "ca_1", toolkit_slug: "GMAIL" }]);
  expect(await completeAuth("key", { sessionUri: "su_1", userId: "u1" })).toEqual({ accountId: "ca_1", toolkit: "gmail" });
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_API}${PATHS.completeAuth}`);
  expect(sent(f, 0)).toEqual({ session_uri: "su_1", user_id: "u1" });
});

test("a refused completeAuth keeps the HTTP status, so a mismatch reads apart from a spent session", async () => {
  replies([{ error: { message: "Callback identity verification failed" } }, 400]);
  await expect(completeAuth("key", { sessionUri: "su_1", userId: "u1" })).rejects.toMatchObject({ status: 400 });
  replies([{ error: { message: "not found" } }, 404]);
  await expect(completeAuth("key", { sessionUri: "su_1", userId: "u1" })).rejects.toMatchObject({ status: 404 });
});

test("a trigger is created for one member's connected account, and its id kept", async () => {
  const f = replies([{ trigger_id: "ti_1" }]);
  expect(await upsertTrigger("key", "SLACK_MESSAGE_REACTION_ADDED", { userId: "u1", accountId: "ca_1", config: { emoji_name: "brain" } })).toBe(
    "ti_1",
  );
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_API}/trigger_instances/SLACK_MESSAGE_REACTION_ADDED/upsert`);
  expect(f.mock.calls[0][1]?.method).toBe("POST");
  expect(sent(f, 0)).toEqual({ user_id: "u1", connected_account_id: "ca_1", trigger_config: { emoji_name: "brain" } });
  replies([{}]);
  await expect(upsertTrigger("key", "X", { userId: "u1", accountId: "ca_1", config: {} })).rejects.toBeInstanceOf(ComposioError);
});

test("a trigger is deleted by its id", async () => {
  const f = replies([{ trigger_id: "ti_1" }]);
  await deleteTrigger("key", "ti_1");
  expect(f.mock.calls[0][0]).toBe(`${COMPOSIO_API}/trigger_instances/manage/ti_1`);
  expect(f.mock.calls[0][1]?.method).toBe("DELETE");
});
