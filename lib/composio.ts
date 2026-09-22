/**
 * Composio over plain REST: `fetch` plus `x-api-key`, so it runs in Convex's
 * default runtime. Every host, path and field name Composio owns lives in this
 * file and nowhere else.
 *
 * Sessions with Composio-managed auth, as Composio recommends for new Platform
 * integrations: a session scopes one of our users, `link` on it starts a
 * connection, `execute` on it runs a tool. The REST session endpoints are what
 * the SDK's `composio.create` / `session.authorize` / `session.execute` call.
 *
 * Confirmed against docs.composio.dev on 2026-09-21 (Task 3 Step 1):
 *   /reference.md (v3.1 base URL, x-api-key)
 *   /reference/api-reference/tool-router/postToolRouterSession.md
 *   /reference/api-reference/tool-router/postToolRouterSessionBySessionIdLink.md
 *   /reference/api-reference/tool-router/postToolRouterSessionBySessionIdExecute.md
 *   /reference/api-reference/connected-accounts/deleteConnectedAccountsByNanoid.md (revoke_on_delete)
 *   /reference/api-reference/connected-accounts.md#callback-identity-verification
 *   /reference/api-reference/connected-accounts/postConnectedAccountsCompleteAuth.md
 *   /reference/api-reference/triggers/postTriggerInstancesBySlugUpsert.md (Task 7)
 *   /reference/api-reference/triggers/deleteTriggerInstancesManageByTriggerId.md (Task 7)
 *
 * Re-confirmed 2026-09-21 (Task 4 fix round 2), the execute response's exact
 * shape: /reference/api-reference/tool-router/postToolRouterSessionBySessionIdExecute.md
 * documents the HTTP-200 body as `{ data: object, error: string|null,
 * log_id: string }` — `error: null` on a completed run, a non-null string
 * when Composio/the provider refused to run the tool. There is no documented
 * `successful` field for this endpoint. See `runSendTool`.
 *
 * Connections finish through callback identity verification: the project's
 * verifier URL (dashboard setting) is our cockpit, Composio sends the browser
 * that consented there with a single-use `session_uri`, and nothing activates
 * until we redeem it with the signed-in member's id. A link's callback_url is
 * not used once a verifier is set, so `connect` sends none.
 */

export const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";

const enc = encodeURIComponent;
export const PATHS = {
  session: "/tool_router/session",
  link: (sessionId: string) => `/tool_router/session/${enc(sessionId)}/link`,
  execute: (sessionId: string) => `/tool_router/session/${enc(sessionId)}/execute`,
  account: (id: string) => `/connected_accounts/${enc(id)}`,
  completeAuth: "/connected_accounts/complete_auth",
  triggerUpsert: (slug: string) => `/trigger_instances/${enc(slug)}/upsert`,
  trigger: (triggerId: string) => `/trigger_instances/manage/${enc(triggerId)}`,
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export class ComposioError extends Error {
  constructor(
    message: string,
    /** Composio's HTTP status, when it answered with one. */
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Composio's own words for what went wrong, plus the id its support asks for. */
function reason(j: Json): string | undefined {
  const e = obj(j.error);
  const msg = str(e.message) ?? str(j.error) ?? str(j.message);
  const id = str(e.request_id) ?? str(j.log_id);
  return msg && (id ? `${msg} (${id})` : msg);
}

async function call(apiKey: string, method: "POST" | "DELETE", path: string, body?: Json): Promise<Json> {
  const res = await fetch(`${COMPOSIO_API}${path}`, {
    method,
    headers: body ? { "x-api-key": apiKey, "content-type": "application/json" } : { "x-api-key": apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = obj(JSON.parse(text));
  } catch {
    // Not JSON: the raw text goes into the error below.
  }
  if (!res.ok) throw new ComposioError(`composio ${res.status}: ${reason(json) ?? text.slice(0, 200)}`, res.status);
  return json;
}

/** A session for one of our users. `auth_configs` only when the deployment overrides managed auth. */
async function session(apiKey: string, body: Json): Promise<string> {
  const id = str((await call(apiKey, "POST", PATHS.session, body)).session_id);
  if (!id) throw new ComposioError("composio session returned no session_id");
  return id;
}

/**
 * Starts a connection for one of our users. Returns where to send the browser
 * and the account Composio created for it, which `finish` must match.
 */
export async function connect(
  apiKey: string,
  a: { userId: string; toolkit: string; authConfigId?: string },
): Promise<{ redirectUrl: string; accountId: string }> {
  const id = await session(apiKey, {
    user_id: a.userId,
    ...(a.authConfigId ? { auth_configs: { [a.toolkit]: a.authConfigId } } : {}),
  });
  const j = await call(apiKey, "POST", PATHS.link(id), { toolkit: a.toolkit });
  const redirectUrl = str(j.redirect_url);
  const accountId = str(j.connected_account_id);
  if (!redirectUrl || !accountId) throw new ComposioError("composio link returned no redirect_url or connected_account_id");
  return { redirectUrl, accountId };
}

/**
 * Redeems the verifier's `session_uri` for the signed-in member. Composio
 * activates the connection only if `userId` owns it: a mismatch is a 400 and
 * fails the connection; a spent, expired or unknown session is a 404.
 */
export async function completeAuth(
  apiKey: string,
  a: { sessionUri: string; userId: string },
): Promise<{ accountId: string; toolkit: string }> {
  const j = await call(apiKey, "POST", PATHS.completeAuth, { session_uri: a.sessionUri, user_id: a.userId });
  const accountId = str(j.connected_account_id);
  if (!accountId) throw new ComposioError("composio complete_auth returned no connected_account_id");
  return { accountId, toolkit: (str(j.toolkit_slug) ?? "").toLowerCase() };
}

/**
 * Deletes the account at Composio. `revoke` also revokes its credentials at
 * the provider (`revoke_on_delete=true`), so the Google/Slack grant dies with
 * it. Providers revoke per app grant, not per token, so revoking can also kill
 * a newer grant the same person gave Composio's app for the same account:
 * revoke only when the member is done with the account, never on a reconnect.
 */
export async function deleteAccount(apiKey: string, id: string, a: { revoke: boolean }): Promise<void> {
  await call(apiKey, "DELETE", a.revoke ? `${PATHS.account(id)}?revoke_on_delete=true` : PATHS.account(id));
}

/**
 * Opens a session pinned to one member's account (Composio refuses an account
 * that isn't that user's: "Each account must exist ... and belong to the same
 * `user_id` as the session", `connected_accounts` in
 * /reference/api-reference/tool-router/postToolRouterSession.md), scoped to
 * run only this one tool, with no workbench. Split out from `runSendTool` so a
 * caller can tell "the session never opened" (nothing was sent, always safe
 * to retry) apart from "the tool call itself failed" (maybe sent) — see
 * `convex/send.ts`'s `go`.
 * ponytail: a session per send; persist its id on the connection if volume grows.
 */
export async function startSendSession(
  apiKey: string,
  a: { userId: string; toolkit: string; accountId: string; tool: string },
): Promise<string> {
  return await session(apiKey, {
    user_id: a.userId,
    connected_accounts: { [a.toolkit]: [a.accountId] },
    toolkits: { enable: [a.toolkit] },
    tools: { [a.toolkit]: { enable: [a.tool] } },
    workbench: { enable: false },
  });
}

/**
 * Runs `tool` on a session `startSendSession` already opened. The documented
 * response shape (see the header) gives exactly two definite answers —
 * `error: null` (ran) and `error: "<message>"` (Composio/the provider
 * refused it, tagged `status: 200` so a caller can tell it apart from a
 * dropped connection) — and this throws ComposioError for anything short of
 * those: a body `call` couldn't parse to JSON (it swallows that and returns
 * `{}`), one missing `error` outright, or a stray field like
 * `successful: false` with no `error`. That third case is a *statusless*
 * ComposioError — Composio never gave either documented answer, so the tool
 * may or may not have run — which `convex/send.ts` reads as `unsure`, never
 * a confirmed send.
 */
export async function runSendTool(apiKey: string, sessionId: string, tool: string, args: Json): Promise<Json> {
  const j = await call(apiKey, "POST", PATHS.execute(sessionId), { tool_slug: tool, arguments: args });
  if (typeof j.error === "string") throw new ComposioError(reason(j) ?? `${tool} failed`, 200);
  if (j.error !== null) throw new ComposioError(`${tool}: composio's response didn't confirm the tool ran`);
  return obj(j.data);
}

/** Convenience wrapper over `startSendSession` + `runSendTool` for callers that don't need to tell the two failure classes apart. */
export async function execute(
  apiKey: string,
  tool: string,
  a: { userId: string; toolkit: string; accountId: string; arguments: Json },
): Promise<Json> {
  const id = await startSendSession(apiKey, { userId: a.userId, toolkit: a.toolkit, accountId: a.accountId, tool });
  return await runSendTool(apiKey, id, tool, a.arguments);
}

/**
 * Subscribes one member's connected account to one trigger; its events go to
 * the project's webhook. `user_id` rides along so Composio can check it owns
 * the account. Returns the `ti_*` id, which is what deletes it later: the
 * docs don't say deleting an account takes its triggers with it.
 */
export async function upsertTrigger(
  apiKey: string,
  slug: string,
  a: { userId: string; accountId: string; config: Json },
): Promise<string> {
  const j = await call(apiKey, "POST", PATHS.triggerUpsert(slug), {
    user_id: a.userId,
    connected_account_id: a.accountId,
    trigger_config: a.config,
  });
  const id = str(j.trigger_id);
  if (!id) throw new ComposioError("composio trigger upsert returned no trigger_id");
  return id;
}

export async function deleteTrigger(apiKey: string, triggerId: string): Promise<void> {
  await call(apiKey, "DELETE", PATHS.trigger(triggerId));
}
