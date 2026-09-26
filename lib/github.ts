import { CHUNK_MAX, chunk } from "./ingest.ts";
import { obj, str } from "./inbound.ts";

/**
 * Public GitHub repos, read with one fine-grained, read-only token: GitHub's
 * anonymous limit is 60 calls an hour, the token's 5,000. Endpoints and fields
 * confirmed against docs.github.com on 2026-09-25 (Task 7 Step 1):
 * /rest/repos/repos#get-a-repository (private, visibility, full_name, html_url;
 * a repo the token can't see answers 403 or 404 — either way `readRepo` never
 * runs), /rest/repos/contents#get-a-repository-readme (`Accept:
 * application/vnd.github.raw+json` returns the raw file), /rest/issues/issues#list-repository-issues
 * (state=all, sort=created, direction=desc, per_page max 100, page; a pull
 * request carries a `pull_request` key; number, title, body, html_url,
 * created_at, user.login). Rate limits and `X-GitHub-Api-Version:
 * 2022-11-28` from /rest/using-the-rest-api/rate-limits-for-the-rest-api and
 * /rest/about-the-rest-api/api-versions — 2022-11-28 is still the default and
 * supported through March 2028, even though 2026-03-10 now also exists.
 */

export const GITHUB_API = "https://api.github.com";
export const ISSUES_PER_REPO = 200;
export const README_PASSAGES = 20;
export const ISSUE_PAGE_SIZE = 100;
export const ISSUE_PAGES = ISSUES_PER_REPO / ISSUE_PAGE_SIZE;

export type RepoPath = { owner: string; repo: string };

export const githubHeaders = (token: string, accept = "application/vnd.github+json") => ({
  accept,
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "intern-brain",
});

/** `owner/repo`, or a github.com link to one; nothing else. */
export function repoPath(input: string): RepoPath | null {
  const s = input
    .trim()
    .replace(/^https:\/\/(www\.)?github\.com\//i, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/);
  return m && m[2] !== "." && m[2] !== ".." ? { owner: m[1], repo: m[2] } : null;
}

export const repoUrl = (p: RepoPath) => `${GITHUB_API}/repos/${p.owner}/${p.repo}`;
export const readmeUrl = (p: RepoPath) => `${repoUrl(p)}/readme`;
/** Newest first. GitHub's issue list carries pull requests too. */
export const issuesUrl = (p: RepoPath, page: number) =>
  `${repoUrl(p)}/issues?state=all&sort=created&direction=desc&per_page=${ISSUE_PAGE_SIZE}&page=${page}`;

/** Public only when GitHub says `private: false` and, if it says, `visibility: "public"`. */
export function readRepo(json: unknown): { fullName: string; htmlUrl: string; isPublic: boolean } | null {
  const j = obj(json);
  const fullName = str(j.full_name);
  const htmlUrl = str(j.html_url);
  if (!fullName || !htmlUrl) return null;
  return { fullName, htmlUrl, isPublic: j.private === false && (j.visibility === undefined || j.visibility === "public") };
}

export type RepoPassage = { externalId: string; text: string; author?: string; url?: string; at: number };

/** Each issue or PR as one passage: `issue:N` / `pr:N`, title then body, cut to CHUNK_MAX. */
export function readIssues(json: unknown): RepoPassage[] {
  if (!Array.isArray(json)) return [];
  return json.map(obj).flatMap((i) => {
    const n = i.number;
    const title = str(i.title);
    const url = str(i.html_url);
    const at = Date.parse(str(i.created_at) ?? "");
    if (typeof n !== "number" || !title || !url || !Number.isFinite(at)) return [];
    const pr = !!i.pull_request;
    const text = `${pr ? "PR" : "Issue"} #${n}: ${title}\n\n${str(i.body) ?? ""}`.trim().slice(0, CHUNK_MAX);
    return [{ externalId: `${pr ? "pr" : "issue"}:${n}`, text, author: str(obj(i.user).login), url, at }];
  });
}

/** The README, chunked: `readme`, `readme:1`, … at most README_PASSAGES. */
export function readmePassages(markdown: string, htmlUrl: string, at: number): RepoPassage[] {
  return chunk(markdown.slice(0, 100_000))
    .slice(0, README_PASSAGES)
    .map((text, i) => ({ externalId: i ? `readme:${i}` : "readme", text, url: `${htmlUrl}#readme`, at }));
}
