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
test("parseFindQuery understands numbers, issue and PR links, and keywords", () => {
  const repo = { owner: "Acme", repo: "Rocket" };
  assert.deepEqual(plain(pure.parseFindQuery("123", repo)), { number: 123, sameRepo: true });
  assert.deepEqual(plain(pure.parseFindQuery(" #123 ", repo)), { number: 123, sameRepo: true });
  assert.deepEqual(plain(pure.parseFindQuery("https://github.com/acme/rocket/pull/77/files#diff-1", repo)), { number: 77, sameRepo: true, owner: "acme", repo: "rocket", kind: "pr" });
  assert.deepEqual(plain(pure.parseFindQuery("https://github.com/acme/rocket/issues/12#issuecomment-1", repo)), { number: 12, sameRepo: true, owner: "acme", repo: "rocket", kind: "issue" });
  assert.equal(pure.parseFindQuery("github.com/other/thing/pull/5", repo).sameRepo, false);
  assert.deepEqual(plain(pure.parseFindQuery("flaky timer test", repo)), { terms: "flaky timer test" });
  assert.equal(pure.parseFindQuery("   ", repo), null);
});

test("briefPageFromPath matches PR and issue pages only", () => {
  assert.deepEqual(plain(pure.briefPageFromPath(["o", "r", "pull", "42", "files"])), { kind: "pr", number: 42 });
  assert.deepEqual(plain(pure.briefPageFromPath(["o", "r", "pull", "42"])), { kind: "pr", number: 42 });
  assert.deepEqual(plain(pure.briefPageFromPath(["o", "r", "issues", "7"])), { kind: "issue", number: 7 });
  for (const parts of [["o", "r"], ["o", "r", "pulls"], ["o", "r", "issues"], ["o", "r", "issues", "new"], ["o", "r", "pull", "new"], ["o", "r", "discussions", "5"]]) {
    assert.equal(pure.briefPageFromPath(parts), null, parts.join("/"));
  }
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
  assert.equal(panel.el("prs-summary").innerHTML, "", "no summary line restating the controls");
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

const issue = (number, extra = {}) => ({
  number, title: `Issue ${number}`, state: "open", user: user("reporter"), html_url: `https://github.com/o/r/issues/${number}`,
  created_at: iso(5), updated_at: iso(1), body: "", labels: [], comments: 0, assignees: [], ...extra,
});
const issueRoutes = (n, extra) => ({
  [`/issues/${n}`]: issue(n, extra),
  [`/issues/${n}/comments?per_page=100`]: [],
  [`/issues/${n}/timeline?per_page=100`]: [],
});

test("opening an issue page opens its brief on Contribute, fetching the issue once", async () => {
  const { gh, panel } = panelWith(issueRoutes(7), { repo: false });
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42");
  await tick(10);
  panel.fn.handleRepoRefresh("https://github.com/o/r/issues/7");
  await tick(10);
  assert.equal(panel.run("lastContentTab"), "contribute");
  assert.equal(panel.el("issue-brief").hidden, false);
  assert.equal(panel.run("activeBrief.number"), 7);
  assert.equal(panel.run("activeBrief.auto"), true);
  assert.match(panel.el("brief-body").innerHTML, /Issue 7/);
  assert.equal(panel.el("pr-brief").hidden, true, "the PR brief it left behind closes");
  assert.equal(gh.apiCalls.filter(u => u === "/issues/7").length, 1);

  panel.fn.handleRepoRefresh("https://github.com/o/r");
  assert.equal(panel.el("issue-brief").hidden, true, "leaving the issue closes its auto-opened brief");
});

test("an issue page that turns out to be a PR, or a missing issue, gets a clear message", async () => {
  const { panel } = panelWith({ ...issueRoutes(8, { pull_request: { url: "x" } }), "/issues/999": json({ message: "Not Found" }, { status: 404 }),
    "/issues/999/comments?per_page=100": [], "/issues/999/timeline?per_page=100": [] });
  await panel.fn.showIssueBrief(8);
  assert.match(panel.el("brief-body").innerHTML, /#8 is a pull request/);
  await panel.fn.showIssueBrief(999);
  assert.match(panel.el("brief-body").innerHTML, /There's no issue #999 in o\/r/);
});

test("auto-opened briefs never call the AI — they offer to ask in Ask", async () => {
  let aiCalls = 0;
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": { tree: [] }, ...detailRoutes(42), ...issueRoutes(7) },
    { ai: async () => { aiCalls++; throw new Error("AI must not be called"); } });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"`);
  panel.fn.handleRepoRefresh("https://github.com/o/r/issues/7");
  await tick(20);
  assert.match(panel.el("brief-body").innerHTML, /class="ask-chip" data-kind="issue"/);
  panel.fn.handleRepoRefresh("https://github.com/o/r/pull/42");
  await tick(20);
  assert.match(panel.el("pr-brief-body").innerHTML, /class="ask-chip" data-kind="pr"/);
  assert.equal(aiCalls, 0);
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

// ── Finding issues ───────────────────────────────────────────────────────────
test("issue keywords search every issue (open and closed), best match first, and Clear goes back", async () => {
  const { gh, panel } = panelWith({ "/search/issues": json({ total_count: 2, items: [issue(31, { title: "Timer drifts" }), issue(12, { state: "closed", title: "Old timer bug" })] }) });
  panel.fn.findIssue("timer drift");
  await tick(5);
  const search = decodeURIComponent(gh.apiCalls.find(u => u.startsWith("/search/issues")));
  assert.match(search, /q=repo:o\/r is:issue timer drift&per_page=30&page=1$/);
  assert.match(panel.el("issues-summary").innerHTML, /<strong>2<\/strong> issues matching “timer drift” · open and closed, best match first/);
  const list = panel.el("issues-list").innerHTML;
  assert.match(list, /#31[\s\S]*#12[\s\S]*chip-closed">Closed/);
  assert.match(list, /data-issue="12"/, "closed issues can still be opened");

  panel.fn.clearIssueSearch();
  assert.equal(panel.run("issueView.query"), "");
  assert.equal(panel.el("issue-find-input").value, "");
});

test("a label filter or the Unclaimed toggle ends a search", async () => {
  const { panel } = panelWith({ "/search/issues": json({ total_count: 0, items: [] }) });
  panel.fn.findIssue("anything");
  await tick(5);
  assert.match(panel.el("issues-list").innerHTML, /No issues match that search/);
  panel.fn.setIssueFilter("good-first-issue");
  assert.equal(panel.run("issueView.query"), "");
  panel.fn.findIssue("anything");
  panel.fn.setUnclaimed(false);
  assert.equal(panel.run("issueView.query"), "");
});

test("an issue number or link opens its brief; a PR link opens the PR's; another repo's gets a note", async () => {
  const { gh, panel } = panelWith(issueRoutes(7));
  panel.fn.findIssue("#7");
  await tick(10);
  assert.equal(panel.el("issue-brief").hidden, false);
  assert.ok(gh.apiCalls.includes("/issues/7"));

  panel.fn.findIssue("https://github.com/o/r/pull/42");
  await tick(10);
  assert.equal(panel.el("pr-brief").hidden, false);
  assert.equal(panel.run("activePrBrief.number"), 42);

  panel.fn.findPr("https://github.com/o/r/issues/7");
  await tick(10);
  assert.equal(panel.run("activeBrief.number"), 7, "the PR box opens issue links too");

  panel.fn.findIssue("https://github.com/someone/else/issues/9");
  assert.match(panel.el("issues-summary").innerHTML, /That issue is in <strong>someone\/else<\/strong>/);
});

test("a closed issue's brief says it's closed, not free", () => {
  const a = pure.issueAvailability(issue(5, { state: "closed", state_reason: "not_planned", closed_at: iso(3) }), [], [], Date.now());
  assert.equal(a.verdict, "Closed");
  assert.equal(a.status, "taken");
  assert.equal(a.reasons[0].text, "Closed as not planned 3 days ago");
});
