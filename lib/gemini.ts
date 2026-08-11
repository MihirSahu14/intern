/**
 * Gemini, over plain fetch.
 *
 * No SDK, for the same reason the outbox connectors have none: one streaming
 * POST and an SSE parse is less code than a dependency, and it cannot drag a
 * transitive version conflict into the build.
 *
 * This is what makes an intern real without Scout. Scout is a Python service
 * with its own Postgres; when it is reachable it still wins, because it has
 * tools this does not. When it isn't — which is every deployment right now —
 * the intern runs here instead of falling back to a script.
 */

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * `gemini-flash-latest`, and specifically not `gemini-2.5-flash`.
 *
 * The models endpoint still lists the pinned 2.5 names, but calling them on a
 * new key returns "no longer available to new users" — listed is not the same
 * as callable. The `-latest` aliases are what a new free-tier key can actually
 * reach; `gemini-pro-latest` and `2.5-pro` come back quota-exceeded, as does
 * Google Search grounding, so an intern here reasons over the brain rather
 * than browsing.
 */
export const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";

export const key = () => process.env.GEMINI_API_KEY;

/** Whether an intern can actually think, as opposed to being simulated. */
export const available = () => Boolean(key());

export const describe = () => `${MODEL} · gemini`;

type Chunk = { text?: string; done?: boolean };

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
  if (!apiKey) throw new Error("GEMINI_API_KEY unset");

  const res = await fetch(
    `${ENDPOINT}/${MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts.temperature ?? 0.4,
          maxOutputTokens: 4096,
        },
      }),
    },
  );

  if (!res.ok || !res.body) {
    // Surface Google's own message — "API key not valid" and "quota exceeded"
    // need very different reactions, and a bare status code hides which.
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON error body — the status is all we get */
    }
    throw new Error(`gemini: ${detail}`);
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
    // The separator is CRLFCRLF, not LFLF — Google sends `\r\n` line endings,
    // so splitting on "\n\n" matches nothing, the buffer never flushes, and
    // the stream completes having yielded not one character.
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame
        .split(/\r?\n/)
        .find((l) => l.startsWith("data:"));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const json = JSON.parse(payload) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = json.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? "")
          .join("");
        if (text) yield { text };
      } catch {
        /* a partial frame that split oddly — the next read completes it */
      }
    }
  }

  yield { done: true };
}
