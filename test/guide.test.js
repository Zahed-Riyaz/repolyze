// guide.js + content.js: the files an issue needs, and the card on GitHub's issue pages
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, json } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const blobs = (paths) => paths.map(p => ({ path: p, type: "blob", size: 300 }));

// ── Pure helpers ─────────────────────────────────────────────────────────────
test("namedPaths finds repo files in paths, stack traces and links, skipping ambiguous bare names", () => {
  const tree = blobs(["src/launch/timer.ts", "app/db/models.py", "src/index.ts", "web/index.ts", "docs/setup.md"]);
  const text = `Crash at src/launch/timer.ts:42.
Traceback:
  File "/home/me/proj/app/db/models.py", line 12, in save
See https://github.com/o/r/blob/main/docs/setup.md and index.ts, version 1.2.3, e.g. example.com`;
  assert.deepEqual(plain(pure.namedPaths(text, tree)), ["src/launch/timer.ts", "app/db/models.py", "docs/setup.md"]);
});

test("referencingPrs ranks merged, then open, then closed PRs", () => {
  const ref = (number, state, merged) => ({ event: "cross-referenced", source: { issue: { number, state, pull_request: { merged_at: merged ? "2026-01-01" : null } } } });
  const prs = plain(pure.referencingPrs([ref(5, "closed", false), ref(9, "open", false), ref(7, "closed", true), { event: "labeled" },
    { event: "cross-referenced", source: { issue: { number: 3, state: "open" } } }]));
  assert.deepEqual(prs.map(p => p.number), [7, 9, 5], "issues that reference it aren't PRs");
});

test("testFileFor follows the usual naming conventions", () => {
  const tree = blobs(["src/timer.ts", "test/timer.test.ts", "app/db.py", "tests/test_db.py", "src/other.ts", "e2e/timer.spec.ts"]);
  assert.equal(pure.testFileFor("src/timer.ts", tree), "test/timer.test.ts");
  assert.equal(pure.testFileFor("app/db.py", tree), "tests/test_db.py");
  assert.equal(pure.testFileFor("src/other.ts", tree), null);
});

// ── Resolving files ──────────────────────────────────────────────────────────
const TREE = { tree: blobs([
  "src/launch/timer.ts", "src/launch/sequence.ts", "src/net/retry.ts", "test/timer.test.ts", "test/retry.test.ts",
  "src/cli/status.ts", "README.md", "package-lock.json", ".github/CODEOWNERS",
]) };
const RAW = { "src/net/retry.ts": "export function retryDelay(n) { return n * 100; }" };
const ISSUE = { number: 7, title: "Countdown drifts; retryDelay is off too", body: "Seen in src/launch/timer.ts after a while.", labels: [], state: "open", comments: 0, assignees: [], created_at: "2026-01-01T00:00:00Z" };
const PR_REF = { event: "cross-referenced", source: { issue: { number: 42, state: "closed", pull_request: { merged_at: null } } } };

function guidePanel({ token, timeline = [PR_REF] } = {}) {
  const gh = githubMock({
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE,
    "/issues/7": ISSUE,
    "/issues/7/comments?per_page=100": [{ body: "Also look at src/launch/sequence.ts", user: { login: "ada" }, author_association: "MEMBER", created_at: "2026-01-02T00:00:00Z" }],
    "/issues/7/timeline?per_page=100": timeline,
    "/pulls/42/files?per_page=100": [{ filename: "src/launch/timer.ts", status: "modified" }, { filename: "src/cli/status.ts", status: "modified" }, { filename: "package-lock.json", status: "modified" }],
    "/search/code": json({ items: [{ path: "test/retry.test.ts" }, { path: "src/net/retry.ts" }] }),
  }, { raw: { ...RAW, ".github/CODEOWNERS": "/src/launch/ @ada\n" } });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  if (token) panel.setToken(token);
  return { gh, panel };
}

test("files come from the issue, its comments and its PRs first, each saying why", async () => {
  const { panel } = guidePanel();
  const thread = { comments: [{ body: "Also look at src/launch/sequence.ts" }], timeline: [PR_REF] };
  const files = plain(await panel.fn.resolveIssueFiles({ owner: "o", repo: "r" }, ISSUE, thread));
  assert.deepEqual(files.slice(0, 3), [
    { path: "src/launch/timer.ts", why: "named in the issue", confidence: "high" },
    { path: "src/launch/sequence.ts", why: "named in the issue", confidence: "high" },
    { path: "src/cli/status.ts", why: "changed by #42 (closed PR)", confidence: "high" },
  ]);
  assert.ok(files.some(f => f.path === "test/timer.test.ts" && f.why === "tests timer.ts" && f.confidence === "medium"));
  assert.ok(!files.some(f => f.path === "package-lock.json"), "lockfiles aren't files you'd work on");
  assert.ok(!files.some(f => f.confidence === "low"), "no name-matching guesses when there are real signals");
});

test("with a token, identifiers the issue names are traced to the file that defines them", async () => {
  const { gh, panel } = guidePanel({ token: "gho_x", timeline: [] });
  const files = plain(await panel.fn.resolveIssueFiles({ owner: "o", repo: "r" }, ISSUE, { comments: [], timeline: [] }));
  assert.ok(files.some(f => f.path === "src/net/retry.ts" && f.why === "defines retryDelay"), "the test file mentions it, but retry.ts defines it");
  assert.ok(gh.apiCalls.some(u => u.startsWith("/search/code")));
  const anon = guidePanel({ timeline: [] });
  await anon.panel.fn.resolveIssueFiles({ owner: "o", repo: "r" }, ISSUE, { comments: [], timeline: [] });
  assert.ok(!anon.gh.apiCalls.some(u => u.startsWith("/search/code")), "no code search without a token");
});

test("with nothing better, name matching is the fallback, marked as a guess", async () => {
  const { panel } = guidePanel({ timeline: [] });
  const files = plain(await panel.fn.resolveIssueFiles({ owner: "o", repo: "r" }, { ...ISSUE, title: "Status command is slow", body: "" }, { comments: [], timeline: [] }));
  assert.deepEqual(files[0], { path: "src/cli/status.ts", why: "name matches the issue", confidence: "low" });
});

test("issueGuide gathers the verdict and the files with their owners for the page card", async () => {
  const { panel } = guidePanel();
  const g = plain(await panel.fn.issueGuide({ owner: "o", repo: "r", number: 7 }));
  assert.equal(g.kind, "issue");
  assert.equal(g.ref, "main");
  assert.equal(g.availability.verdict, "Free to work on");
  assert.deepEqual(g.start.map(f => f.path).slice(0, 2), ["src/launch/timer.ts", "src/launch/sequence.ts"]);
  assert.deepEqual(g.guesses, [], "real signals, so no guesses");
  assert.deepEqual(g.owners.map(o => [o.display, o.files.length]), [["ada", 2]], "owners once, with how many of the files");
  assert.deepEqual(g.stack, ["TypeScript"]);
});

test("presentation helpers: owners without the org, short folders, guesses kept apart", () => {
  assert.equal(pure.ownerDisplay("@google-gemini/gemini-cli-maintainers", "google-gemini"), "gemini-cli-maintainers");
  assert.equal(pure.ownerDisplay("@other-org/team", "google-gemini"), "other-org/team");
  assert.equal(pure.ownerDisplay("@ada", "x"), "ada");
  assert.equal(pure.shortDir("packages/core/src/tools/definitions/model-family-sets"), "packages/…/definitions/model-family-sets");
  assert.equal(pure.shortDir("src/launch"), "src/launch");
  assert.deepEqual(plain(pure.splitPath("a/b/c.ts")), { name: "c.ts", dir: "a/b" });
  const g = plain(pure.groupIssueFiles([{ path: "a", confidence: "high" }, { path: "b", confidence: "low" }, { path: "c", confidence: "medium" }]));
  assert.deepEqual([g.start.map(f => f.path), g.guesses.map(f => f.path)], [["a", "c"], ["b"]]);
});

// ── The card on GitHub (content.js) ──────────────────────────────────────────
function loadContent() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), ctx); // no chrome/location → doesn't start
  return ctx;
}

test("the page card only runs on issue pages", () => {
  const c = loadContent();
  assert.deepEqual(plain(c.parseIssuePage("https://github.com/o/r/issues/12")), { owner: "o", repo: "r", number: 12 });
  assert.deepEqual(plain(c.parseIssuePage("https://github.com/o/r/issues/12#issuecomment-1")), { owner: "o", repo: "r", number: 12 });
  for (const url of ["https://github.com/o/r/issues", "https://github.com/o/r/pull/12", "https://github.com/o/r/issues/new", "https://gist.github.com/o/r/issues/1"]) {
    assert.equal(c.parseIssuePage(url), null, url);
  }
});

test("the page card waits to be asked when signed out, and reads verdict → where to start → owners when ready", () => {
  const c = loadContent();
  const page = { owner: "o", repo: "r", number: 7 };
  assert.match(c.guideCardHtml(page, { phase: "idle", open: true }), /Is it free, where to start, who owns it[\s\S]*data-act="load">Show/);
  assert.doesNotMatch(c.guideCardHtml(page, { phase: "idle", open: false }), /class="body"/, "collapsed: just the header");
  const data = {
    ref: "main", availability: { status: "free", verdict: "Free to work on", advice: "Leave a short comment first.", reasons: ["No assignee, linked PR or recent claim"] },
    start: [{ path: "src/x/a b.ts", name: "a b.ts", dir: "src/x", why: "named in the issue", confidence: "high" }],
    guesses: [{ path: "src/y.ts", name: "y.ts", dir: "src", why: "name matches the issue", confidence: "low" }],
    owners: [{ handle: "@o/maintainers", display: "maintainers", files: ["src/x/a b.ts", "src/y.ts"] }],
    stack: ["TypeScript", "CLI"],
  };
  const html = c.guideCardHtml(page, { phase: "ready", open: true, data });
  assert.match(html, /class="verdict tone-good">Free to work on/);
  assert.match(html, /class="why-line">No assignee, linked PR or recent claim<\/p>\s*<p class="next">→ Leave a short comment first\./);
  assert.match(html, /Where to start<\/h3><span class="stack">TypeScript · CLI<\/span>/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/blob\/main\/src\/x\/a%20b\.ts"[^>]*>a b\.ts<\/a>\s*<span class="why">named in the issue<\/span>\s*<\/li>/, "one line per file; the folder is in the link's title");
  assert.match(html, /<details><summary>1 guess by file name<\/summary>[\s\S]*conf-low/, "guesses folded when there's a real signal");
  assert.match(html, /Who owns it[\s\S]*title="@o\/maintainers">maintainers<\/span><span class="why">2 files/);
  assert.match(c.guideCardHtml(page, { phase: "ready", open: true, data: { ...data, start: [] } }), /Nothing in the issue or its PRs points at a file yet[\s\S]*<details open>/, "only guesses → shown open");
  assert.match(c.guideCardHtml(page, { phase: "error", open: true, error: "<b>x</b>" }), /&lt;b&gt;x&lt;\/b&gt;/, "errors are escaped");
});

test("the background worker loads the shared scripts in an order that works", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const order = bg.match(/importScripts\(([^)]*)\)/)[1].split(",").map(s => s.trim().replace(/"/g, ""));
  assert.deepEqual(order, ["github.js", "retrieval.js", "insights.js", "brief.js", "guide.js", "stack.js"]);
  for (const f of order) assert.ok(fs.existsSync(path.join(__dirname, "..", f)), f);
});
