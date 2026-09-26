import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHUNK_MAX,
  FETCH_TIMEOUT_MS,
  MAX_PASSAGES_PER_DOCUMENT,
  URL_MAX_BYTES,
  chunk,
  decodeText,
  fetchDocument,
  hasTextLayer,
  htmlToText,
  isPdf,
  parseCitations,
  passageFact,
  urlProblem,
} from "./ingest.ts";

const x = (n: number, c = "x") => c.repeat(n);

// --- chunking --------------------------------------------------------------

test("short text is one passage", () => {
  assert.deepEqual(chunk("Hello.\n\nWorld."), ["Hello.\n\nWorld."]);
  assert.deepEqual(chunk("  \n\n "), []);
});

test("paragraphs gather into passages of about 800 to 1,200 characters", () => {
  assert.deepEqual(chunk([x(500, "a"), x(500, "b"), x(500, "c")].join("\n\n")), [
    `${x(500, "a")}\n\n${x(500, "b")}`,
    x(500, "c"),
  ]);
  assert.deepEqual(chunk([x(500, "a"), x(900, "b")].join("\r\n\r\n")), [x(500, "a"), x(900, "b")]);
});

test("a paragraph over 1,200 characters is cut at a sentence end where it can be", () => {
  const first = `${"Word ".repeat(180).trim()}.`; // 900 characters
  const second = `${"More ".repeat(200).trim()}.`; // 1,000 characters
  assert.deepEqual(chunk(`${first} ${second}`), [first, second]);
});

test("with no sentence end to cut at, a paragraph is cut at 1,200", () => {
  assert.deepEqual(chunk(x(3000)).map((c) => c.length), [CHUNK_MAX, CHUNK_MAX, 600]);
});

test("a document stops at 200 passages", () => {
  const out = chunk(Array(300).fill(x(900)).join("\n\n"));
  assert.equal(out.length, MAX_PASSAGES_PER_DOCUMENT);
  assert.ok(out.every((c) => c.length <= CHUNK_MAX));
});

// --- html ------------------------------------------------------------------

test("html becomes text: scripts, styles and nav go, blocks become paragraphs, entities decode", () => {
  const html = `<html><head><title>Ship &amp; tell</title><style>p{}</style></head><body><nav><a href="/">Home</a></nav><script>alert(1)</script><h1>Release notes</h1><p>We ship on&nbsp;Fridays.</p><p>QA is &lt;Thursday&gt;.<br>Always &#8212; &#x2713;</p></body></html>`;
  assert.deepEqual(htmlToText(html), {
    title: "Ship & tell",
    text: "Release notes\n\nWe ship on Fridays.\n\nQA is <Thursday>.\nAlways — ✓",
  });
  assert.deepEqual(htmlToText("<p>no title</p>"), { title: null, text: "no title" });
});

// --- url safety ------------------------------------------------------------

test("only public https URLs pass", () => {
  assert.equal(urlProblem("https://example.com/handbook"), null);
  assert.match(urlProblem("http://example.com/") ?? "", /https/);
  assert.match(urlProblem("not a url") ?? "", /isn't a link/);
  for (const u of [
    "https://localhost/",
    "https://app.localhost/",
    "https://printer.local/",
    "https://db.internal/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://[::1]/",
    "https://intranet/",
  ]) {
    assert.match(urlProblem(u) ?? "", /private/, u);
  }
  assert.ok(urlProblem("https://user:pw@example.com/"));
});

// --- fetching --------------------------------------------------------------

const page = (body: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }, status = 200) =>
  new Response(body, { status, headers });

test("a page is fetched with redirects handled here, not by fetch", async () => {
  const seen: (RequestInit | undefined)[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init);
    return page("<p>hi</p>");
  }) as typeof fetch;
  assert.deepEqual(await fetchDocument("https://example.com/a", f), {
    url: "https://example.com/a",
    contentType: "text/html",
    text: "<p>hi</p>",
  });
  assert.equal(seen[0]?.redirect, "manual");
});

test("a redirect is followed only to another public https address", async () => {
  const moved = (async (url: string | URL | Request) =>
    String(url) === "https://example.com/a" ? page("", { location: "/b" }, 301) : page("moved here", { "content-type": "text/plain" })) as typeof fetch;
  assert.equal((await fetchDocument("https://example.com/a", moved)).url, "https://example.com/b");

  const metadata = (async () => page("", { location: "https://169.254.169.254/latest" }, 302)) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/a", metadata), /private/);

  const loop = (async () => page("", { location: "/again" }, 302)) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/a", loop), /redirects too many times/);
});

test("only web pages, plain text and markdown", async () => {
  const pdf = (async () => page("%PDF-1.4", { "content-type": "application/pdf" })) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/a.pdf", pdf), /Only web pages, plain text and markdown/);
  const md = (async () => page("# Hi", { "content-type": "text/markdown; charset=utf-8" })) as typeof fetch;
  assert.equal((await fetchDocument("https://example.com/a.md", md)).contentType, "text/markdown");
});

test("a page over 2 MB is refused, whether it says so or not", async () => {
  const says = (async () => page("x", { "content-type": "text/plain", "content-length": String(URL_MAX_BYTES + 1) })) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/big", says), /over 2 MB/);
  const streams = (async () => page(x(URL_MAX_BYTES + 1), { "content-type": "text/plain" })) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/big", streams), /over 2 MB/);
});

test("an error page says so", async () => {
  const gone = (async () => page("nope", { "content-type": "text/html" }, 404)) as typeof fetch;
  await assert.rejects(fetchDocument("https://example.com/gone", gone), /answered 404/);
});

test("a page that hangs is given up on at ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hang = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  const pending = fetchDocument("https://example.com/slow", hang);
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await assert.rejects(pending, /longer than 10 seconds/);
});

// --- citations and promotion -----------------------------------------------

test("[p:…] citations are pulled out of a draft's sources, deduped", () => {
  assert.deepEqual(parseCitations(["[p:abc123]", "[f1]", "p:abc123 and [p:def456]", "mp:nope"]), ["abc123", "def456"]);
  assert.deepEqual(parseCitations([]), []);
});

test("a promoted passage's title is its first line, cut to 120", () => {
  assert.deepEqual(passageFact("\n  We ship on Fridays  \nbecause QA is Thursday\n"), {
    title: "We ship on Fridays",
    body: "We ship on Fridays  \nbecause QA is Thursday",
  });
  assert.equal(passageFact(x(200)).title.length, 120);
});

// --- uploads -----------------------------------------------------------------

test("uploads: PDFs are sniffed, text must be UTF-8, and a PDF needs a text layer", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(isPdf(bytes("%PDF-1.7\n%âãÏÓ")), true);
  assert.equal(isPdf(bytes("# notes")), false);
  assert.equal(decodeText(bytes("# Notes ✓")), "# Notes ✓");
  assert.throws(() => decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0x80])), /markdown, text or PDF/);
  assert.equal(hasTextLayer(" \n\f "), false);
  assert.equal(hasTextLayer("We ship on Fridays"), true);
});
