// Contribute tab: browsing / finding any PR, and following the PR page you're on
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, tick, plain } = require("./helpers/panel");
const { githubMock, json } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const DAY = 86_400_000;
const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
const user = (login) => ({ login, type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4", html_url: `https://github.com/${login}` });
const pr = (number, extra = {}) => ({
  number, title: `PR ${number}`, state: "open", draft: false, user: user("dev"), html_url: `https://github.com/o/r/pull/${number}`,
  created_at: iso(3), updated_at: iso(1), body: "", head: { sha: `sha${number}`, ref: "b", label: "dev:b", repo: { full_name: "dev/r" } },
  base: { ref: "main" }, additions: 1, deletions: 1, changed_files: 1, commits: 1, requested_reviewers: [], requested_teams: [], ...extra,
});
const detailRoutes = (n) => ({
  [`/pulls/${n}`]: pr(n),
  [`/issues/${n}/timeline?per_page=100`]: [],
  [`/pulls/${n}/comments?per_page=100`]: [],
  [`/pulls/${n}/files?per_page=100`]: [],
  [`/commits/sha${n}/check-runs?per_page=100`]: { check_runs: [] },
});

function panelWith(routes = {}, { repo = true } = {}) {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": { tree: [] }, ...detailRoutes(42), ...detailRoutes(43), ...routes });
  const panel = loadPanel({ fetch: gh.fetch });
  if (repo) panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = ""`);
  return { gh, panel };
}

// ── Parsing ──────────────────────────────────────────────────────────────────
test("parsePrQuery understands numbers, PR links and keywords", () => {
  const repo = { owner: "Acme", repo: "Rocket" };
  assert.deepEqual(plain(pure.parsePrQuery("123", repo)), { number: 123, sameRepo: true });
  assert.deepEqual(plain(pure.parsePrQuery(" #123 ", repo)), { number: 123, sameRepo: true });
  assert.deepEqual(plain(pure.parsePrQuery("https://github.com/acme/rocket/pull/77/files#diff-1", repo)), { number: 77, sameRepo: true, owner: "acme", repo: "rocket" });
  assert.equal(pure.parsePrQuery("github.com/other/thing/pull/5", repo).sameRepo, false);
  assert.deepEqual(plain(pure.parsePrQuery("flaky timer test", repo)), { terms: "flaky timer test" });
  assert.equal(pure.parsePrQuery("   ", repo), null);
});

test("prNumberFromPath only matches PR pages", () => {
  assert.equal(pure.prNumberFromPath(["o", "r", "pull", "42", "files"]), 42);
  assert.equal(pure.prNumberFromPath(["o", "r", "pull", "42"]), 42);
  for (const parts of [["o", "r"], ["o", "r", "pulls"], ["o", "r", "issues", "42"], ["o", "r", "pull", "new"]]) assert.equal(pure.prNumberFromPath(parts), null, parts.join("/"));
});

test("closed PRs get honest verdicts: merged vs closed without merging", () => {
  const merged = pure.prStatus(pr(1, { state: "closed", merged_at: iso(2), merged_by: user("ada") }), [], null, Date.now());
  assert.equal(merged.status, "merged");
  assert.equal(merged.verdict, "Merged");
  assert.ok(merged.reasons.some(r => r.text === "Merged by @ada 2 days ago"));
  assert.ok(!merged.reasons.some(r => /No reviews yet|No activity/.test(r.text)), "open-PR nags don't apply");
  const closed = pure.prStatus(pr(2, { state: "closed", closed_at: iso(40), updated_at: iso(40) }), [], null, Date.now());
  assert.equal(closed.verdict, "Closed without merging");
  assert.ok(!closed.reasons.some(r => /No activity/.test(r.text)));
});

// ── Browsing ─────────────────────────────────────────────────────────────────
test("open PRs are listed newest first and page with Load more", async () => {
  const { gh, panel } = panelWith({
    "/pulls": (url) => (new URL(url).searchParams.get("page") === "1"
      ? json([pr(50), pr(49)], { headers: { Link: '<https://api.github.com/repos/o/r/pulls?page=2>; rel="next"' } })
      : json([pr(48)])),
  });
  await panel.fn.fetchPrList();
  assert.ok(gh.apiCalls.includes("/pulls?state=open&sort=created&direction=desc&per_page=15&page=1"));
  assert.equal(panel.el("prs-summary").innerHTML, "Open pull requests, newest first");
  assert.equal(panel.el("prs-more").hidden, false);
  await panel.fn.fetchPrList({ append: true });
  assert.match(panel.el("prs-list").innerHTML, /#50[\s\S]*#49[\s\S]*#48/);
  assert.equal(panel.el("prs-more").hidden, true);
});

test("closed PRs are sorted by recent activity and marked merged or closed", async () => {
  const { gh, panel } = panelWith({ "/pulls": [pr(7, { state: "closed", merged_at: iso(1), closed_at: iso(1) }), pr(6, { state: "closed", closed_at: iso(2) })] });
  panel.fn.setPrState("closed");
  await tick(5);
  assert.ok(gh.apiCalls.includes("/pulls?state=closed&sort=updated&direction=desc&per_page=15&page=1"));
  const html = panel.el("prs-list").innerHTML;
  assert.match(html, /#7[\s\S]*chip-merged">Merged/);
  assert.match(html, /#6[\s\S]*chip-closed">Closed/);
});

test("keywords search every PR in the repo; Clear goes back to the list", async () => {
  const { gh, panel } = panelWith({ "/search/issues": json({ total_count: 1, items: [{ ...pr(31), state: "closed", pull_request: { merged_at: iso(9) } }] }) });
  panel.fn.findPr("flaky timer");
  await tick(5);
  const search = decodeURIComponent(gh.apiCalls.find(u => u.startsWith("/search/issues")));
  assert.match(search, /q=repo:o\/r is:pr flaky timer&sort=updated&order=desc/);
  assert.match(panel.el("prs-summary").innerHTML, /<strong>1<\/strong> PR matching “flaky timer”/);
  assert.match(panel.el("prs-list").innerHTML, /#31[\s\S]*Merged/);
  panel.fn.setPrState("open");
  assert.equal(panel.run("prView.query"), "");
});

test("typing a number or this repo's PR link opens the brief directly", async () => {
  const { gh, panel } = panelWith();
  panel.fn.findPr("#42");
  await tick(10);
  assert.equal(panel.el("pr-brief").hidden, false);
  assert.ok(gh.apiCalls.includes("/pulls/42"));
  assert.match(panel.el("pr-brief-body").innerHTML, /PR 42/);
});

test("a link to another repo's PR explains how to open it instead of guessing", () => {
  const { gh, panel } = panelWith();
  panel.fn.findPr("https://github.com/someone/else/pull/9");
  assert.match(panel.el("prs-summary").innerHTML, /someone\/else[\s\S]*open it on GitHub and the panel will follow/);
  assert.equal(gh.apiCalls.length, 0);
});

test("a number that isn't a PR gets a clear message", async () => {
  const { panel } = panelWith({ "/pulls/999": json({ message: "Not Found" }, { status: 404 }) });
  await panel.fn.showPrBrief(999);
  assert.match(panel.el("pr-brief-body").innerHTML, /There's no pull request #999 in o\/r — it may be an issue number/);
});

// ── Following the page ───────────────────────────────────────────────────────
test("opening a PR page opens its brief on the Contribute tab", async () => {
  const { gh, panel } = panelWith({}, { repo: false });
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42/files");
  await tick(10);
  assert.equal(panel.run("lastContentTab"), "contribute");
  assert.equal(panel.el("pr-brief").hidden, false);
  assert.equal(panel.run("activePrBrief.number"), 42);
  assert.equal(panel.run("activePrBrief.auto"), true);
  assert.equal(gh.apiCalls.filter(u => u === "/pulls/42").length, 1);
});

test("moving between the same PR's tabs doesn't reopen or reload it", async () => {
  const { gh, panel } = panelWith({}, { repo: false });
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42");
  await tick(10);
  panel.fn.closePrBrief();                       // the user closes it…
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42/commits");
  await tick(10);
  assert.equal(panel.el("pr-brief").hidden, true, "…and it stays closed");
  assert.equal(gh.apiCalls.filter(u => u === "/pulls/42").length, 1);
});

test("leaving the PR closes an auto-opened brief; another PR opens its own", async () => {
  const { panel } = panelWith({}, { repo: false });
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42");
  await tick(10);
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/43");
  await tick(10);
  assert.equal(panel.run("activePrBrief.number"), 43);
  panel.fn.handleRepoRefresh("https://github.com/o/r");
  assert.equal(panel.el("pr-brief").hidden, true);
  assert.equal(panel.run("activePrBrief"), null);
});

test("a brief you opened yourself stays when you navigate around the repo", async () => {
  const { panel } = panelWith({}, { repo: false });
  panel.fn.handleRepoRefresh("https://github.com/o/r");
  await panel.fn.showPrBrief(42);                // opened from the list
  panel.fn.handleRepoRefresh("https://github.com/o/r/issues");
  assert.equal(panel.el("pr-brief").hidden, false);
  assert.equal(panel.run("activePrBrief.number"), 42);
});

test("the same PR number in a different repo still opens", async () => {
  const gh = githubMock({ ...detailRoutes(42), "/git/trees/HEAD?recursive=1": { tree: [] } }, { repoPrefix: "/repos/x/y" });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.run(`aiProvider = "groq"; aiApiKey = ""`);
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42");
  await tick(10);
  panel.fn.handleRepoRefresh("https://github.com/x/y/pull/42");
  await tick(10);
  assert.equal(panel.run("activePrBrief.key"), "x/y");
  assert.equal(panel.el("pr-brief").hidden, false);
});
