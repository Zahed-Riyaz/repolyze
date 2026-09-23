// End-to-end panel behaviour against a mocked repo: request budgets, tab
// loading, issue search, stale-response guards, rendering, chat and settings.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, tick, plain } = require("./helpers/panel");
const { githubMock, json, sseReply } = require("./helpers/github-mock");

const DAY = 86_400_000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const user = (login, id = 1) => ({ login, type: "User", avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`, html_url: `https://github.com/${login}` });
const issue = (number, labels = [], extra = {}) => ({
  number, title: `Issue ${number}`, html_url: `https://github.com/o/r/issues/${number}`, comments: 2,
  reactions: { total_count: 0 }, created_at: iso(3), labels: labels.map(name => ({ name, color: "7057ff" })), ...extra,
});

// A small but complete fake repo
function repoRoutes(overrides = {}) {
  return {
    "": { default_branch: "main", description: "Rockets", stargazers_count: 1200, forks_count: 30, pushed_at: iso(1), open_issues_count: 40, license: { spdx_id: "MIT" } },
    "/issues": [issue(1, ["bug"]), issue(2, ["good first issue"]), { ...issue(3), pull_request: {} }],
    "/languages": { TypeScript: 900, CSS: 100 },
    "/git/trees/HEAD?recursive=1": { tree: ["README.md", "package.json", ".github/CODEOWNERS", "src/index.ts"].map(p => ({ path: p, type: "blob", size: 100 })) },
    "/contributors?per_page=10": [{ ...user("ada"), contributions: 500 }, { ...user("bob", 2), contributions: 50 }],
    "/community/profile": { files: { contributing: { url: "x" }, issue_template: { url: "x" }, pull_request_template: null, code_of_conduct: null } },
    "/labels?per_page=100": [{ name: "bug" }, { name: "good first issue" }, { name: "help wanted" }],
    "/pulls": [],
    "/issues/comments": [
      { user: user("ada"), author_association: "OWNER", issue_url: "https://api.github.com/repos/o/r/issues/1", created_at: iso(2) },
      { user: user("bob", 2), author_association: "NONE", issue_url: "https://api.github.com/repos/o/r/issues/1", created_at: iso(2) },
    ],
    "/search/issues": (url) => {
      const q = new URL(url).searchParams.get("q");
      return json({ total_count: 1, items: [issue(2, ["good first issue"])] , q }, { headers: { "X-RateLimit-Resource": "search", "X-RateLimit-Remaining": "9" } });
    },
    ...overrides,
  };
}

function openRepo({ routes, raw = { "README.md": "# Rockets", ".github/CODEOWNERS": "* @ada\n/docs/ @org/docs" }, chrome, ai } = {}) {
  const gh = githubMock(repoRoutes(routes), { raw, ai });
  const panel = loadPanel({ fetch: gh.fetch, chrome });
  panel.setRepo();
  return { gh, panel };
}

async function visitAllTabs(panel) {
  await panel.fn.updateRepoInfo(); await tick(5);
  for (const tab of ["tech", "maintainers", "contribute"]) { panel.fn.switchTab(tab); await tick(5); }
  await panel.fn.getRepoContextParts();
}

// ── Request budget ───────────────────────────────────────────────────────────
test("opening a repo costs 2 API requests; other tabs load only when opened", async () => {
  const { gh, panel } = openRepo();
  await panel.fn.updateRepoInfo(); await tick(5);
  assert.deepEqual(gh.apiCalls, ["", "/issues?state=open&assignee=none&sort=comments&direction=desc&per_page=30&page=1"]);
});

test("a full visit stays within budget, chat costs no API requests, and reopening the panel costs none", async () => {
  const first = openRepo();
  await visitAllTabs(first.panel);
  const coreCalls = first.gh.apiCalls.filter(u => !u.startsWith("/search/"));
  assert.ok(coreCalls.length <= 13, `too many API requests on a first visit (${coreCalls.length}):\n${coreCalls.join("\n")}`);
  const beforeChat = first.gh.apiCalls.length;
  await first.panel.fn.getRepoContextParts();
  assert.equal(first.gh.apiCalls.length, beforeChat, "chat context re-uses the tree and raw files");

  const session = structuredClone(first.panel.chrome.storage.session.data);
  const reopened = openRepo({ chrome: { session } });
  await visitAllTabs(reopened.panel);
  assert.deepEqual(reopened.gh.apiCalls, [], "everything is served from the session cache");
});

// ── Tab loading & recovery ───────────────────────────────────────────────────
test("rate-limited → token added off-repo → back on the repo, tabs reload instead of staying Paused", async () => {
  let limited = true;
  const reset = String(Math.floor(Date.now() / 1000) + 1800);
  const gate = (data) => () => (limited
    ? json({ message: "API rate limit exceeded" }, { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "60", "X-RateLimit-Reset": reset } })
    : json(data));
  const base = repoRoutes();
  const { panel } = openRepo({ routes: {
    "": gate(base[""]), "/issues": gate(base["/issues"]),
    "/rate_limit": () => json({ resources: { core: { remaining: limited ? 0 : 4999, limit: limited ? 60 : 5000, reset: +reset } } }),
  } });
  await panel.fn.updateRepoInfo(); await tick(5);
  assert.match(panel.el("issues-list").innerHTML, /Paused until/);

  panel.fn.switchTab("settings");
  panel.fn.showNotRepoMessage();          // the GitHub token page isn't a repo
  limited = false;
  panel.setToken("ghp_good");
  await panel.fn.onGitHubTokenChanged(); await tick(5);
  panel.fn.hideNotRepoMessage();          // back to the repo tab
  panel.fn.switchTab("issues"); await tick(5);
  assert.doesNotMatch(panel.el("issues-list").innerHTML, /Paused/);
  assert.match(panel.el("issues-list").innerHTML, /Issue 1/);
});

test("a tab that failed to load retries the next time it's opened", async () => {
  let down = true;
  const { gh, panel } = openRepo({ routes: {
    "/languages": () => (down ? json({ message: "Server Error" }, { status: 502 }) : json({ Go: 1 })),
  } });
  panel.fn.switchTab("tech"); await tick(5);
  assert.match(panel.el("tech-list").innerHTML, /502/);

  down = false;
  panel.fn.switchTab("issues"); await tick(5);
  panel.fn.switchTab("tech"); await tick(5);
  assert.equal(gh.apiCalls.filter(u => u === "/languages").length, 2, "the failed load was retried");
  assert.match(panel.el("tech-list").innerHTML, /Go/);
});

test("a stale response never renders into a different repo", async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  const { panel } = openRepo({ routes: { "/issues": async () => { await slow; return json([issue(111)]); } } });
  const pending = panel.fn.fetchIssues();
  panel.setRepo("other", "repo");
  panel.el("issues-list").innerHTML = "OTHER REPO CONTENT";
  release();
  await pending;
  assert.equal(panel.el("issues-list").innerHTML, "OTHER REPO CONTENT");
});

// ── Issues ───────────────────────────────────────────────────────────────────
test("All lists unassigned issues without PRs, with a summary", async () => {
  const { panel } = openRepo();
  await panel.fn.fetchIssues();
  const html = panel.el("issues-list").innerHTML;
  assert.match(html, /Issue 1/);
  assert.doesNotMatch(html, /Issue 3/, "pull requests are filtered out");
  assert.equal(panel.el("issues-summary").textContent, "Unassigned open issues, most discussed first");
});

test("Good first searches all issues with the repo's real label names and shows the total", async () => {
  const { gh, panel } = openRepo();
  panel.run(`issueView.filter = "good-first-issue"`);
  await panel.fn.fetchIssues();
  const search = decodeURIComponent(gh.apiCalls.find(u => u.startsWith("/search/issues")));
  assert.match(search, /repo:o\/r is:issue is:open label:"good first issue" no:assignee -linked:pr/);
  assert.match(panel.el("issues-summary").innerHTML, /<strong>1<\/strong> good first issue · unassigned, no linked PR/);
  assert.match(panel.el("issues-list").innerHTML, /Issue 2/);
});

test("when every labelled issue is claimed, it says so and offers to show them", async () => {
  const { panel } = openRepo({ routes: {
    "/search/issues": (url) => json(new URL(url).searchParams.get("q").includes("no:assignee")
      ? { total_count: 0, items: [] } : { total_count: 18, items: [] }),
  } });
  panel.run(`issueView.filter = "good-first-issue"`);
  await panel.fn.fetchIssues();
  assert.match(panel.el("issues-list").innerHTML, /All <strong>18<\/strong> good first issues are already assigned or have a linked PR/);
  assert.match(panel.el("issues-list").innerHTML, /Show them anyway/);

  panel.el("issues-list").queried[".show-claimed"].dispatch("click");
  assert.equal(panel.run("issueView.unclaimed"), false, "the button turns the Unclaimed filter off");
});

test("a repo without a matching label gets an honest message, not a search", async () => {
  const { gh, panel } = openRepo({ routes: { "/labels?per_page=100": [{ name: "bug" }] } });
  panel.run(`issueView.filter = "help-wanted"`);
  await panel.fn.fetchIssues();
  assert.match(panel.el("issues-list").innerHTML, /doesn't use a <strong>help wanted<\/strong> label/);
  assert.ok(!gh.apiCalls.some(u => u.startsWith("/search/")));
});

test("Load more appends the next page", async () => {
  const { panel } = openRepo({ routes: {
    "/issues": (url) => {
      const page = new URL(url).searchParams.get("page");
      return page === "1"
        ? json([issue(1)], { headers: { Link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"' } })
        : json([issue(2)]);
    },
  } });
  await panel.fn.fetchIssues();
  assert.equal(panel.el("issues-more").hidden, false);
  await panel.fn.fetchIssues({ append: true });
  assert.match(panel.el("issues-list").innerHTML, /Issue 1[\s\S]*Issue 2/);
  assert.equal(panel.el("issues-more").hidden, true);
});

// ── Maintainers & health ─────────────────────────────────────────────────────
test("Maintainers shows people who replied plus code owners, then all-time contributors", async () => {
  const { panel } = openRepo();
  await panel.fn.fetchMaintainers();
  const html = panel.el("maintainers-list").innerHTML;
  assert.match(html, /ada[\s\S]*Owner[\s\S]*Code owner[\s\S]*Replied in 1 thread/);
  assert.doesNotMatch(html, /bob/, "a non-maintainer comment doesn't make someone a maintainer");
  assert.match(panel.el("maintainer-teams").innerHTML, /@org\/docs/);
  assert.match(panel.el("contributors-list").innerHTML, /ada[\s\S]*500 commits[\s\S]*bob/);
});

test("a quiet repo is called out on the Maintainers tab", async () => {
  const { panel } = openRepo({ routes: { "/issues/comments": [] }, raw: {} });
  await panel.fn.fetchMaintainers();
  assert.match(panel.el("maintainers-list").innerHTML, /Nobody with maintainer access replied/);
});

test("the health card shows every signal with its evidence, and n/a where data is thin", async () => {
  const { panel } = openRepo();
  await panel.fn.fetchRepoHealth();
  const html = panel.el("health-card").innerHTML;
  for (const label of ["Maintainer response", "Merges outside PRs", "Merge speed", "Recent activity", "Onboarding"]) assert.match(html, new RegExp(label));
  assert.match(html, /n\/a/, "no recent PRs → merge signals unmeasured");
  assert.match(html, /of 5 signals measured/);
  assert.match(html, /Last push 1 day ago/);
});

// ── Chat ─────────────────────────────────────────────────────────────────────
test("a chat reply is saved with its sources to the repo that asked, even if the user navigates away", async () => {
  let aiCalls = 0;
  const { panel } = openRepo({
    raw: { "README.md": "# Rockets", "src/index.ts": "export function launch() {}" },
    ai: async () => (++aiCalls === 1 ? sseReply('["src/index.ts"]') : sseReply("It starts in `src/index.ts:1`.")),
  });
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"; chatMessages = [];`);
  panel.el("chat-input").value = "Where does it start?";
  const sending = panel.fn.handleChat();
  panel.setRepo("someone", "else"); // user switches repos mid-reply
  await sending;

  const saved = panel.chrome.storage.local.data["chat_o_r"];
  assert.equal(saved.length, 2);
  assert.equal(saved[1].text, "It starts in `src/index.ts:1`.");
  assert.deepEqual(plain(saved[1].sources.map(s => s.path)), ["src/index.ts"]);
  assert.equal(saved[1].ref, "main");
  assert.equal(panel.chrome.storage.local.data["chat_someone_else"], undefined);
});

// ── Settings ─────────────────────────────────────────────────────────────────
test("a GitHub token is checked with GitHub before it's saved", async () => {
  const { panel } = openRepo({ routes: {
    "/rate_limit": (_url, init) => (init.headers.Authorization === "Bearer ghp_good"
      ? json({ resources: { core: { remaining: 5000, limit: 5000, reset: 9999999999 } } })
      : json({ message: "Bad credentials" }, { status: 401 })),
  } });
  panel.fn.initSettingsTab();
  const save = () => panel.el("sp-save-gh-btn").listeners.click[0]();

  panel.el("sp-gh-token").value = "ghp_bad";
  await save();
  assert.equal(panel.chrome.storage.local.data.githubToken, undefined);
  assert.match(panel.el("sp-gh-status").textContent, /rejected/);

  panel.el("sp-gh-token").value = "ghp_good";
  await save();
  assert.equal(panel.chrome.storage.local.data.githubToken, "ghp_good");
  assert.match(panel.el("sp-gh-status").textContent, /5,000 requests\/hour/);
});

test("Get token opens GitHub's token page and waits on the token field", async () => {
  const { panel } = openRepo();
  panel.fn.getGitHubToken();
  assert.deepEqual(panel.chrome.openedTabs, ["https://github.com/settings/tokens"]);
  assert.equal(panel.run("lastContentTab"), "issues");
  assert.match(panel.el("sp-gh-status").textContent, /Paste your new token/);
});
