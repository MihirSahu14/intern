/**
 * Any OpenAI-compatible chat-completions model, over plain fetch.
 *
 * No SDK, for the same reason the outbox connectors have none: one streaming
 * POST and an SSE parse is less code than a dependency, and it cannot drag a
 * transitive version conflict into the build.
 *
 * Groq by default — no card, 30 req/min · 1,000/day on `openai/gpt-oss-20b`
 * (console.groq.com/docs/rate-limits, console.groq.com/docs/models, both
 * dated 2026-09-22 in .superpowers/sdd/llm-providers-research.md) — because
 * Gemini's free tier rate-limits per Google Cloud project, not per key, so
 * every visitor to the public demo shared one 5-req/min bucket and 503s
 * failed 19 of 20 eval briefs.
 *
 * Any other OpenAI-compatible provider works by changing env, no code: paid
 * fallback is OpenAI `gpt-5-nano` (`MODEL_BASE_URL=https://api.openai.com/v1`).
 * Gemini itself stays reachable through its own OpenAI-compatibility shim —
 * `MODEL_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`,
 * `MODEL_NAME=gemini-flash-latest` — base URL, Bearer-header auth and SSE
 * `stream: true` support confirmed against Google's own docs
 * (ai.google.dev/gemini-api/docs/openai, fetched 2026-09-25); the research
 * doc had flagged this endpoint as a lower-confidence carryover, unverified.
 * Not exercised with a real call here — this task makes no live model call.
 *
 * Runs from a Convex action, not a free-tier browser session — the key lives
 * in the deployment's env, not the client's.
 */

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

// Read at call time, not cached at module load: a Convex action's env can
// change between deploys without a redeploy of this module, and tests stub
// `process.env` per case.
const baseUrl = () => process.env.MODEL_BASE_URL || DEFAULT_BASE_URL;
const modelName = () => process.env.MODEL_NAME || DEFAULT_MODEL;

export const key = () => process.env.MODEL_API_KEY;

/** Whether an intern can actually think, as opposed to being simulated. */
export const available = () => Boolean(key());

export const describe = () => modelName();

/**
 * The exact message `stream()` throws when `MODEL_API_KEY` is unset — a
 * stable marker callers (run.ts) match on, rather than comparing the whole
 * error message, so it stays a reliable signal even if this wording changes.
 */
export const NOT_CONFIGURED = "MODEL_API_KEY unset";

type Chunk = { text?: string; usage?: { in: number; out: number }; done?: boolean };

/**
 * Stream a completion, yielding text as it arrives.
 *
 * Yields rather than returning a whole string so the terminal fills the way a
 * thought does. The caller decides where to break lines.
 */
export async function* stream(
  prompt: string,
  opts: { signal?: AbortSignal; temperature?: number } = {},
): AsyncGenerator<Chunk> {
  const apiKey = key();
  if (!apiKey) throw new Error(NOT_CONFIGURED);

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    signal: opts.signal,
    body: JSON.stringify({
      model: modelName(),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 4096,
      temperature: opts.temperature ?? 0.4,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok || !res.body) {
    // Surface the provider's own message — "invalid api key" and "rate limit
    // exceeded" need very different reactions, and a bare status code hides
    // which.
    let detail = "request failed";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON error body — the status is all we get */
    }
    throw new Error(`model ${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame can span reads, so
    // only whole ones are consumed and the remainder stays buffered.
    //
    // The separator can be CRLFCRLF, not just LFLF — some providers (Google's
    // OpenAI-compat shim among them, per lib/gemini.ts's own history here)
    // send `\r\n` line endings, so splitting on "\n\n" alone would match
    // nothing and the stream would complete having yielded nothing.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = json.choices?.[0]?.delta?.content;
        if (text) yield { text };
        // The usage frame carries running or final totals; the caller keeps
        // the last one it sees.
        if (json.usage) {
          yield {
            usage: {
              in: json.usage.prompt_tokens ?? 0,
              out: json.usage.completion_tokens ?? 0,
            },
          };
        }
      } catch {
        /* a partial frame that split oddly — the next read completes it */
      }
    }
  }

  yield { done: true };
}
