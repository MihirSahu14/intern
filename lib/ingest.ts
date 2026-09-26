/**
 * Ingestion: sources feed the brain. Pure, apart from `fetchDocument`, which
 * takes `fetch` as an argument so node tests it with no network. No imports,
 * so client components can read the constants.
 *
 * There are no model calls anywhere in ingestion, by design: every source is
 * on a free plan.
 */

/** Archive passages an intern recalls per run. */
export const PASSAGES_RECALLED = 6;
/** How much of a passage the brief and the rail show. */
export const PASSAGE_EXCERPT = 400;
export const CHUNK_MIN = 800;
export const CHUNK_MAX = 1200;
export const MAX_PASSAGES_PER_DOCUMENT = 200;
export const URL_MAX_BYTES = 2 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const BACKFILL_DAYS = 90;
export const DOCUMENT_TYPES = ["text/html", "text/plain", "text/markdown"];
const MAX_REDIRECTS = 3;

/** Why a source couldn't be read, in words the member can act on. */
export class IngestError extends Error {}

/** What a failed source shows. Anything that isn't an IngestError is a bug: the caller logs it, the member sees a fixed copy. */
export const sourceError = (err: unknown) => (err instanceof IngestError ? err.message : "Couldn't read that source.");

// --- chunking ------------------------------------------------------------

/** One paragraph over CHUNK_MAX, cut at the last sentence end past CHUNK_MIN, else hard at CHUNK_MAX. */
function splitLong(p: string): string[] {
  const out: string[] = [];
  let rest = p;
  while (rest.length > CHUNK_MAX) {
    const window = rest.slice(0, CHUNK_MAX);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const at = cut >= CHUNK_MIN ? cut + 1 : CHUNK_MAX;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Splits on blank lines and gathers paragraphs into passages of about
 * CHUNK_MIN–CHUNK_MAX characters, at most MAX_PASSAGES_PER_DOCUMENT. A passage
 * comes in under CHUNK_MIN only when the next paragraph wouldn't fit, or at
 * the end.
 */
export function chunk(text: string): string[] {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap(splitLong);
  const out: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (out.length >= MAX_PASSAGES_PER_DOCUMENT) break;
    if (cur && cur.length + 2 + p.length > CHUNK_MAX) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    if (cur.length >= CHUNK_MIN) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, MAX_PASSAGES_PER_DOCUMENT);
}

// --- html ------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? whole;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
  });

/**
 * A page reduced to readable text. Scripts, styles, nav and the head go;
 * block elements become blank lines, so the chunker splits between them.
 * ponytail: regex, not a parser. Good enough for text; swap for a real
 * parser only if pages start coming back mangled.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|article|main|aside|li|ul|ol|h[1-6]|tr|table|blockquote|pre|header|footer)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  const text = decode(stripped)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = decode(rawTitle).replace(/\s+/g, " ").trim();
  return { title: title || null, text };
}

// --- url safety --------------------------------------------------------------

/** 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, and multicast and up. */
function privateIPv4(host: string): boolean {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Why this URL may not be fetched, or null. Reads the host the way the URL
 * parser normalizes it, so `https://2130706433/` is caught as 127.0.0.1.
 * ponytail: every IPv6 literal and every dotless host is refused outright;
 * nobody shares a document that way. DNS rebinding isn't covered — that
 * needs resolving the name first, which Convex doesn't expose.
 */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "That isn't a link.";
  }
  if (u.protocol !== "https:") return "Only https:// links can be added.";
  if (u.username || u.password) return "Links with a username or password can't be added.";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[") ||
    !host.includes(".") ||
    privateIPv4(host)
  ) {
    return "That address is private.";
  }
  return null;
}

// --- fetching ----------------------------------------------------------------

export type Fetched = { url: string; contentType: string; text: string };

const tooBig = () => new IngestError(`That page is over ${URL_MAX_BYTES / 1024 / 1024} MB.`);

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > URL_MAX_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * GETs a member's link. Every hop is checked with `urlProblem`: redirects are
 * followed here (at most three), never by `fetch`. Ten seconds for the whole
 * thing, 2 MB, and html, plain text or markdown only. Throws IngestError.
 */
export async function fetchDocument(raw: string, f: typeof fetch = fetch): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    let url = raw.trim();
    for (let hop = 0; ; hop++) {
      const problem = urlProblem(url);
      if (problem) throw new IngestError(problem);
      const res = await f(url, { redirect: "manual", signal: ctl.signal, headers: { accept: DOCUMENT_TYPES.join(", ") } });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next || hop >= MAX_REDIRECTS) throw new IngestError("That link redirects too many times.");
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok) throw new IngestError(`That page answered ${res.status}.`);
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!DOCUMENT_TYPES.includes(contentType)) throw new IngestError("Only web pages, plain text and markdown can be added.");
      if (Number(res.headers.get("content-length") ?? 0) > URL_MAX_BYTES) throw tooBig();
      return { url, contentType, text: await readCapped(res) };
    }
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError(
      ctl.signal.aborted ? `That page took longer than ${FETCH_TIMEOUT_MS / 1000} seconds.` : "Couldn't reach that page.",
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- citations and promotion -------------------------------------------------

/** `[p:<id>]` citations in a draft's `sources`, deduped. The caller looks each id up; none is trusted. */
export function parseCitations(sources: string[]): string[] {
  const ids = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(/(?<![a-z0-9])p:([a-z0-9]+)/g)) ids.add(m[1]);
  return [...ids].slice(0, 20);
}

/** The fact a promoted passage becomes: its first line (max 120) as the title, the passage as the body. */
export function passageFact(text: string): { title: string; body: string } {
  const body = text.trim();
  return { title: (body.split("\n")[0] ?? "").trim().slice(0, 120), body };
}
