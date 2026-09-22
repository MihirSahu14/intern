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
 * Deletes the account at Composio and revokes its credentials at the provider
 * (`revoke_on_delete=true`), so the Google/Slack grant dies with it rather
 * than sitting in Composio's store.
 * Trade-off: providers revoke per app grant, not per token, so revoking an
 * old Gmail account can also kill a newer grant the same person just gave
 * Composio's app for the same Google account (a reconnect). They then connect
 * once more; we accept that over leaving grants behind.
 */
export async function deleteAccount(apiKey: string, id: string): Promise<void> {
  await call(apiKey, "DELETE", `${PATHS.account(id)}?revoke_on_delete=true`);
}

/**
 * Runs one tool as one member, on a session pinned to their account (Composio
 * refuses an account that isn't that user's: "Each account must exist ... and
 * belong to the same `user_id` as the session", `connected_accounts` in
 * /reference/api-reference/tool-router/postToolRouterSession.md). The session
 * can run only this one tool, with no workbench. Throws ComposioError carrying
 * Composio's reason and log id.
 * ponytail: a session per send; persist its id on the connection if volume grows.
 */
export async function execute(
  apiKey: string,
  tool: string,
  a: { userId: string; toolkit: string; accountId: string; arguments: Json },
): Promise<Json> {
  const id = await session(apiKey, {
    user_id: a.userId,
    connected_accounts: { [a.toolkit]: [a.accountId] },
    toolkits: { enable: [a.toolkit] },
    tools: { [a.toolkit]: { enable: [tool] } },
    workbench: { enable: false },
  });
  const j = await call(apiKey, "POST", PATHS.execute(id), { tool_slug: tool, arguments: a.arguments });
  if (j.error) throw new ComposioError(reason(j) ?? `${tool} failed`);
  return obj(j.data);
}
