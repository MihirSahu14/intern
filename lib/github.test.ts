import assert from "node:assert/strict";
import { test } from "node:test";
import { readIssues, readRepo, readmePassages, repoPath } from "./github.ts";

test("a repo is owner/repo or a github.com link to one", () => {
  assert.deepEqual(repoPath("acme/site"), { owner: "acme", repo: "site" });
  assert.deepEqual(repoPath(" https://github.com/acme/site.git "), { owner: "acme", repo: "site" });
  assert.deepEqual(repoPath("https://github.com/acme/site/"), { owner: "acme", repo: "site" });
  for (const bad of [
    "acme",
    "acme/site/issues",
    "https://example.com/acme/site",
    "https://github.com/acme/site/blob/main/README.md",
    "http://github.com/acme/site",
    "-acme/site",
    "acme/..",
  ]) {
    assert.equal(repoPath(bad), null, bad);
  }
});

test("a repo is public only when GitHub says so", () => {
  const repo = { full_name: "acme/site", html_url: "https://github.com/acme/site" };
  assert.deepEqual(readRepo({ ...repo, private: false, visibility: "public" }), { fullName: "acme/site", htmlUrl: "https://github.com/acme/site", isPublic: true });
  assert.equal(readRepo({ ...repo, private: true, visibility: "private" })?.isPublic, false);
  assert.equal(readRepo({ ...repo, private: false, visibility: "internal" })?.isPublic, false);
  assert.equal(readRepo({ ...repo })?.isPublic, false);
  assert.equal(readRepo({ message: "Not Found" }), null);
});

test("issues and PRs become one passage each", () => {
  assert.deepEqual(
    readIssues([
      { number: 2, title: "Add pricing page", body: "Per seat.", html_url: "https://github.com/acme/site/pull/2", created_at: "2026-09-20T10:00:00Z", user: { login: "ann" }, pull_request: {} },
      { number: 1, title: "Footer broken", body: null, html_url: "https://github.com/acme/site/issues/1", created_at: "2026-09-19T10:00:00Z", user: { login: "bo" } },
      { title: "no number" },
    ]),
    [
      { externalId: "pr:2", text: "PR #2: Add pricing page\n\nPer seat.", author: "ann", url: "https://github.com/acme/site/pull/2", at: Date.UTC(2026, 8, 20, 10) },
      { externalId: "issue:1", text: "Issue #1: Footer broken", author: "bo", url: "https://github.com/acme/site/issues/1", at: Date.UTC(2026, 8, 19, 10) },
    ],
  );
  assert.deepEqual(readIssues({ message: "Not Found" }), []);
});

test("a README is chunked, at most 20 passages, the first keyed `readme`", () => {
  assert.deepEqual(readmePassages("# Site\n\nThe marketing site.", "https://github.com/acme/site", 5), [
    { externalId: "readme", text: "# Site\n\nThe marketing site.", url: "https://github.com/acme/site#readme", at: 5 },
  ]);
  const long = readmePassages(Array(30).fill("x".repeat(900)).join("\n\n"), "https://github.com/acme/site", 5);
  assert.equal(long.length, 20);
  assert.equal(long[19].externalId, "readme:19");
});
