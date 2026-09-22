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
 *   /reference/api-reference/connected-accounts/getConnectedAccountsByNanoid.md
 *   /reference/api-reference/connected-accounts/deleteConnectedAccountsByNanoid.md
 *   /docs/authentication/manually-authenticating.md (callback's status, connected_account_id)
 */

export const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";

const enc = encodeURIComponent;
export const PATHS = {
  session: "/tool_router/session",
  link: (sessionId: string) => `/tool_router/session/${enc(sessionId)}/link`,
  execute: (sessionId: string) => `/tool_router/session/${enc(sessionId)}/execute`,
  account: (id: string) => `/connected_accounts/${enc(id)}`,
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export class ComposioError extends Error {}

/** Composio's own words for what went wrong, plus the id its support asks for. */
function reason(j: Json): string | undefined {
  const e = obj(j.error);
  const msg = str(e.message) ?? str(j.error) ?? str(j.message);
  const id = str(e.request_id) ?? str(j.log_id);
  return msg && (id ? `${msg} (${id})` : msg);
}

async function call(apiKey: string, method: "GET" | "POST" | "DELETE", path: string, body?: Json): Promise<Json> {
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
  if (!res.ok) throw new ComposioError(`composio ${res.status}: ${reason(json) ?? text.slice(0, 200)}`);
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
 * and the account Composio created for it, which the callback must match.
 */
export async function connect(
  apiKey: string,
  a: { userId: string; toolkit: string; authConfigId?: string; callbackUrl: string },
): Promise<{ redirectUrl: string; accountId: string }> {
  const id = await session(apiKey, {
    user_id: a.userId,
    ...(a.authConfigId ? { auth_configs: { [a.toolkit]: a.authConfigId } } : {}),
  });
  const j = await call(apiKey, "POST", PATHS.link(id), { toolkit: a.toolkit, callback_url: a.callbackUrl });
  const redirectUrl = str(j.redirect_url);
  const accountId = str(j.connected_account_id);
  if (!redirectUrl || !accountId) throw new ComposioError("composio link returned no redirect_url or connected_account_id");
  return { redirectUrl, accountId };
}

/** `userId` is deprecated on this endpoint and may stop coming back. */
export type Account = { id: string; status: string; toolkit: string; userId?: string };

export async function getAccount(apiKey: string, id: string): Promise<Account> {
  const j = await call(apiKey, "GET", PATHS.account(id));
  return {
    id: str(j.id) ?? "",
    status: str(j.status) ?? "",
    toolkit: (str(obj(j.toolkit).slug) ?? "").toLowerCase(),
    ...(str(j.user_id) ? { userId: str(j.user_id) } : {}),
  };
}

export async function deleteAccount(apiKey: string, id: string): Promise<void> {
  await call(apiKey, "DELETE", PATHS.account(id));
}

/**
 * Runs one tool as one member, on a session pinned to their account (Composio
 * refuses an account that isn't that user's). Throws ComposioError carrying
 * Composio's reason and log id.
 * ponytail: a session per send; persist its id on the connection if volume grows.
 */
export async function execute(
  apiKey: string,
  tool: string,
  a: { userId: string; toolkit: string; accountId: string; arguments: Json },
): Promise<Json> {
  const id = await session(apiKey, { user_id: a.userId, connected_accounts: { [a.toolkit]: [a.accountId] } });
  const j = await call(apiKey, "POST", PATHS.execute(id), { tool_slug: tool, arguments: a.arguments });
  if (j.error) throw new ComposioError(reason(j) ?? `${tool} failed`);
  return obj(j.data);
}
