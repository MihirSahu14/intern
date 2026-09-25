/**
 * `npm test`
 *
 * `stream()` talks to any OpenAI-compatible `/chat/completions` endpoint over
 * plain `fetch`. These tests stub `fetch` and drive a real `ReadableStream`
 * so the SSE-framing logic (blank-line and CRLFCRLF separators, `[DONE]`,
 * the usage frame, a malformed frame) is exercised without any network call.
 *
 * `MODEL_*` env vars are read at call time (see model.ts), so a single static
 * import is enough — no module-cache tricks needed between tests.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { available, describe, stream } from "./model.ts";

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"]) {
    if (realEnv[k] === undefined) delete process.env[k];
    else process.env[k] = realEnv[k];
  }
});

/** A fetch stub whose body streams the given raw SSE text, in as many chunks as `splits` says. */
function stubStream(sseText: string, splits: number[] = [sseText.length], init: { status?: number } = {}) {
  const encoder = new TextEncoder();
  let last = 0;
  const chunks = splits.map((end) => {
    const c = sseText.slice(last, end);
    last = end;
    return c;
  });
  let i = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      else controller.close();
    },
  });
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, reqInit: RequestInit) => {
    calls.push({ url, init: reqInit });
    return new Response(body, { status: init.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

function stubError(status: number, errorBody: unknown) {
  globalThis.fetch = (async () => new Response(JSON.stringify(errorBody), { status })) as typeof fetch;
}

async function collect(gen: AsyncGenerator<{ text?: string; usage?: { in: number; out: number }; done?: boolean }>) {
  const out: { text?: string; usage?: { in: number; out: number }; done?: boolean }[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

test("MODEL_API_KEY unset fails before any fetch", async () => {
  delete process.env.MODEL_API_KEY;
  await assert.rejects(async () => {
    await collect(stream("hi"));
  }, /MODEL_API_KEY unset/);
});

test("yields text deltas split across frames separated by a blank line", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse =
    `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n` +
    `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n` +
    `data: [DONE]\n\n`;
  stubStream(sse);
  const chunks = await collect(stream("hi"));
  const text = chunks.map((c) => c.text ?? "").join("");
  assert.equal(text, "Hello");
});

test("handles CRLFCRLF frame separators", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse =
    `data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n` +
    `data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n` +
    `data: [DONE]\r\n\r\n`;
  stubStream(sse);
  const chunks = await collect(stream("hi"));
  const text = chunks.map((c) => c.text ?? "").join("");
  assert.equal(text, "Hello");
});

test("a frame split across two reads is still parsed whole", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse = `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n`;
  // Break mid-frame: the boundary lands inside the JSON payload.
  stubStream(sse, [20, sse.length]);
  const chunks = await collect(stream("hi"));
  const text = chunks.map((c) => c.text ?? "").join("");
  assert.equal(text, "Hello");
});

test("[DONE] yields no text chunk", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse = `data: [DONE]\n\n`;
  stubStream(sse);
  const chunks = await collect(stream("hi"));
  assert.deepEqual(
    chunks.filter((c) => c.text !== undefined),
    [],
  );
});

test("the usage frame becomes { usage: { in, out } } from prompt_tokens/completion_tokens", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse =
    `data: {"choices":[{"delta":{"content":"hi"}}]}\n\n` +
    `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n` +
    `data: [DONE]\n\n`;
  stubStream(sse);
  const chunks = await collect(stream("hi"));
  const usage = chunks.find((c) => c.usage)?.usage;
  assert.deepEqual(usage, { in: 12, out: 34 });
});

test("a malformed frame is skipped, not thrown", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse =
    `data: {not json at all\n\n` +
    `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` +
    `data: [DONE]\n\n`;
  stubStream(sse);
  const chunks = await collect(stream("hi"));
  const text = chunks.map((c) => c.text ?? "").join("");
  assert.equal(text, "ok");
});

test("a frame with no data: line is skipped", async () => {
  process.env.MODEL_API_KEY = "k";
  const sse = `: keep-alive comment\n\n` + `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n` + `data: [DONE]\n\n`;
  stubStream(sse);
  const chunks = await collect(stream("hi"));
  const text = chunks.map((c) => c.text ?? "").join("");
  assert.equal(text, "ok");
});

test("non-2xx throws `model <status>: <message>` using the error body's message", async () => {
  process.env.MODEL_API_KEY = "k";
  stubError(429, { error: { message: "rate limit exceeded" } });
  await assert.rejects(async () => {
    await collect(stream("hi"));
  }, /^Error: model 429: rate limit exceeded$/);
});

test("non-2xx with a non-JSON body still throws with the status", async () => {
  process.env.MODEL_API_KEY = "k";
  globalThis.fetch = (async () => new Response("<html>gateway timeout</html>", { status: 503 })) as typeof fetch;
  await assert.rejects(async () => {
    await collect(stream("hi"));
  }, /^Error: model 503: request failed$/);
});

test("the request shape: OpenAI-compatible POST with the configured model and bearer key", async () => {
  process.env.MODEL_API_KEY = "sekrit";
  process.env.MODEL_BASE_URL = "https://example.test/v1";
  process.env.MODEL_NAME = "some/model";
  const calls = stubStream(`data: [DONE]\n\n`);
  await collect(stream("hello there", { temperature: 0.7 }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/v1/chat/completions");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer sekrit");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "some/model");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, 0.7);
  assert.deepEqual(body.messages, [{ role: "user", content: "hello there" }]);
});

test("defaults: Groq base URL and gpt-oss-20b when unset", async () => {
  process.env.MODEL_API_KEY = "k";
  delete process.env.MODEL_BASE_URL;
  delete process.env.MODEL_NAME;
  const calls = stubStream(`data: [DONE]\n\n`);
  await collect(stream("hi"));
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "openai/gpt-oss-20b");
});

test("available() and describe() reflect the current env", async () => {
  delete process.env.MODEL_API_KEY;
  assert.equal(available(), false);
  process.env.MODEL_API_KEY = "k";
  assert.equal(available(), true);
  process.env.MODEL_NAME = "openai/gpt-oss-20b";
  assert.equal(describe(), "openai/gpt-oss-20b");
});
