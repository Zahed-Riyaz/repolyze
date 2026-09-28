// stack.js: your stack from your repos, and how well each issue fits it
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, json } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (d) => new Date(NOW - d * DAY).toISOString();
const repo = (name, extra = {}) => ({ full_name: `ada/${name}`, name, fork: false, archived: false, size: 100, language: "TypeScript", topics: [], description: "", pushed_at: iso(10), languages_url: `https://api.github.com/repos/ada/${name}/languages`, ...extra });

const REPOS = [
  repo("dashboard", { description: "A React dashboard with Docker deploys", topics: ["react", "tailwind"], language: "TypeScript" }),
  repo("scraper", { description: "Python CLI that scrapes stuff", language: "Python", pushed_at: iso(30) }),
  repo("site", { language: "TypeScript", pushed_at: iso(5) }),
  repo("old-thing", { language: "Java", pushed_at: iso(2000) }),
  repo("someone-elses", { fork: true, language: "Rust" }),
];

// ── Profile ──────────────────────────────────────────────────────────────────
test("buildStackProfile weighs recent own repos, skips forks, and reads only known tech from descriptions and bio", () => {
  const p = plain(pure.buildStackProfile({
    login: "ada", bio: "I build things with PostgreSQL and a bit of Go (golang)", repos: REPOS,
    repoLanguages: { "ada/dashboard": { TypeScript: 800, CSS: 200 } }, now: NOW,
  }));
  const langs = Object.fromEntries(p.languages.map(l => [l.name, l.share]));
  assert.ok(langs.TypeScript > langs.Python, "two recent TypeScript repos outweigh one Python repo");
  assert.ok(langs.Python > (langs.Java || 0), "a 5-year-old repo counts least");
  assert.ok(!("Rust" in langs), "forks aren't yours");
  assert.ok("Go" in langs, "languages named in the bio count");
  const terms = p.terms.map(t => t.term);
  for (const t of ["react", "tailwind", "docker", "cli", "postgres"]) assert.ok(terms.includes(t), t);
  assert.ok(!terms.includes("stuff") && !terms.includes("things"), "ordinary words never count");
  assert.equal(p.repos, 4);
});

test("your edits hide what's wrong and add what's missing", () => {
  const p = pure.buildStackProfile({ login: "ada", repos: REPOS, now: NOW });
  const edited = plain(pure.applyStackEdits(p, { hidden: ["Python", "cli"], added: ["Rust", "graphql"] }));
  const langs = edited.languages.map(l => l.name);
  assert.ok(!langs.includes("Python") && langs.includes("Rust"));
  const terms = edited.terms.map(t => t.term);
  assert.ok(!terms.includes("cli") && terms.includes("graphql"));
});

// ── Fit ──────────────────────────────────────────────────────────────────────
const PROFILE = { login: "ada", languages: [{ name: "TypeScript", share: 0.6 }, { name: "Python", share: 0.3 }], terms: [{ term: "docker", weight: 1 }, { term: "llm", weight: 0.8 }], repos: 3 };
const issue = (title, body = "", labels = []) => ({ number: 1, title, body, labels: labels.map(name => ({ name })) });
// A mostly-Python repo with a small TypeScript part, where most issues mention LLMs
const PY_REPO = { repoLangs: new Map([["Python", 0.9], ["TypeScript", 0.1]]), termDf: new Map([["llm", 0.8], ["docker", 0.1]]) };

test("issueFit marks what sets an issue apart, not what's true of the whole repo", () => {
  const ts = plain(pure.issueFit(issue("Graph viewer crashes in Docker"), PROFILE, ["web/graph.ts"], PY_REPO));
  assert.equal(ts.tier, "great", "your main language, in the repo's minority part");
  assert.deepEqual(ts.reasons, ["TypeScript — web/graph.ts", "mentions docker"]);

  const py = plain(pure.issueFit(issue("LLM tool calls re-executed"), PROFILE, ["core/stream.py"], PY_REPO));
  assert.equal(py.tier, null, "Python in a 90%-Python repo, and 'llm' in most issues, set nothing apart");
  assert.deepEqual(py.reasons, []);

  const stretch = plain(pure.issueFit(issue("Panic in the allocator"), PROFILE, ["core/alloc.rs"], PY_REPO));
  assert.deepEqual(stretch.other, ["Rust"]);
  assert.equal(pure.issueFit(issue("x"), null, []), null);
  // Without repo context (e.g. no tree), a match still counts in full
  assert.equal(pure.issueFit(issue("Retry on 503"), PROFILE, ["client/retry.ts"]).tier, "great");
});

test("repoLanguageShare and termDocFreq measure what's common in the repo and on the page", () => {
  const share = pure.repoLanguageShare(["a.py", "b.py", "c.py", "d.ts", "README.md"].map(path => ({ path })));
  assert.equal(share.get("Python"), 0.75);
  assert.equal(share.get("TypeScript"), 0.25);
  const df = pure.termDocFreq([issue("LLM retries"), issue("llm cost"), issue("Docker image")], PROFILE);
  assert.equal(df.get("llm"), 2 / 3);
  assert.equal(df.get("docker"), 1 / 3);
});

test("tech terms match whole words and their spellings, not fragments", () => {
  assert.deepEqual(plain(pure.techTermsIn("Deploys on k8s with PostgreSQL; uses Next.js")).sort(), ["kubernetes", "next.js", "postgres"].sort());
  assert.deepEqual(plain(pure.techTermsIn("reactive streams and a nodes graph")), [], "no 'react' in 'reactive', no 'node' in 'nodes'");
  assert.equal(pure.languageOfPath("src/App.TSX"), "TypeScript");
  assert.equal(pure.languageOfPath("Dockerfile"), "Dockerfile");
  assert.equal(pure.languageOfPath("README.md"), null);
});

test("topCodePaths keeps the best few paths without sorting the whole tree", () => {
  const cands = ["src/cli/status.ts", "src/cli/index.ts", "docs/status.md", "src/net/retry.ts"].map(path => ({ path }));
  assert.deepEqual(plain(pure.topCodePaths(cands, pure.queryTerms("status command"), 2)), ["src/cli/status.ts", "docs/status.md"]);
});

// ── Panel ────────────────────────────────────────────────────────────────────
// 9 Python files, 1 TypeScript file: the repo is mostly Python
const TREE = { tree: [...Array.from({ length: 9 }, (_, i) => `core/mod${i}.py`), "web/graph.ts", "core/stream.py"].map(p => ({ path: p, type: "blob", size: 300 })) };
const ISSUES = [
  { number: 10, title: "LLM stream drops tokens in core stream", comments: 30 },
  { number: 11, title: "LLM tool calls retried twice in stream", comments: 20 },
  { number: 12, title: "Graph viewer crashes in Docker", comments: 10 },
].map(i => ({ ...i, body: "", labels: [], state: "open", user: { login: "u" }, html_url: `https://github.com/o/r/issues/${i.number}`, created_at: iso(3), assignees: [] }));

function fitPanel() {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE, "/issues": ISSUES });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`stackProfile = ${JSON.stringify(PROFILE)}`);
  return { gh, panel };
}

test("every issue lists the stack it requires, known parts brighter, in GitHub's order", async () => {
  const { panel } = fitPanel();
  await panel.fn.fetchIssues();
  const html = panel.el("issues-list").innerHTML;
  assert.ok(html.indexOf("#10") < html.indexOf("#12"), "GitHub's order is kept");
  const row12 = html.slice(html.indexOf("#12"));
  assert.match(row12, /<span class="row-stack"><span class="stack-tag is-known" title="TypeScript — web\/graph\.ts · in your stack">TypeScript<\/span><span class="stack-tag is-known"[^>]*>Docker<\/span><\/span>/);
  assert.match(html.slice(html.indexOf("#10"), html.indexOf("#11")), /stack-tag is-known[^>]*>Python<\/span>[\s\S]*>LLMs<\/span>/);
  assert.doesNotMatch(html, /Uses your|is-fit|row-fit/, "no telling, just the requirements");
});

test("Best fit for you puts first the issues needing the most of your stack, relative to the repo", async () => {
  const { gh, panel } = fitPanel();
  panel.run(`issueView.sort = "fit"`);
  await panel.fn.fetchIssues();
  assert.ok(gh.apiCalls.some(u => u.includes("sort=comments")), "GitHub is asked for most discussed; fit is scored here");
  const html = panel.el("issues-list").innerHTML;
  assert.ok(html.indexOf("#12") < html.indexOf("#10"), "TypeScript + Docker in a Python repo beats Python + LLMs, which every issue has");
  assert.match(panel.el("issues-summary").innerHTML, /Issues needing more of your stack first \(TypeScript, Python, Docker, LLMs\) · among the 3 loaded/);
});

test("signed out, requirements still show (nothing is brighter) and Best fit asks you to sign in", async () => {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE, "/issues": ISSUES });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`issueView.sort = "fit"; AUTH.clientId = "x"`);
  await panel.fn.fetchIssues();
  const html = panel.el("issues-list").innerHTML;
  assert.match(html, /class="stack-tag" title="TypeScript — web\/graph\.ts">TypeScript/);
  assert.doesNotMatch(html, /is-known/);
  assert.match(panel.el("issues-summary").innerHTML, /Sign in to sort by fit[\s\S]*fit-sign-in/);
});

test("the profile is built from ≤8 requests and reused from storage for a day", async () => {
  const gh = githubMock({
    "/users/ada": { login: "ada", bio: "Docker person" },
    "/users/ada/repos": REPOS,
    "/repos/ada/dashboard/languages": { TypeScript: 900, CSS: 100 },
    "/repos/ada/scraper/languages": { Python: 1000 },
    "/repos/ada/old-thing/languages": { Java: 1000 },
  }, { repoPrefix: "/nothing" });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.run(`githubToken = "gho_x"; githubUser = { login: "ada" }`);
  const p = await panel.fn.loadStackProfile();
  assert.equal(p.login, "ada");
  assert.ok(gh.apiCalls.length <= 8, gh.apiCalls.join("\n"));
  assert.ok(panel.chrome.storage.local.data.stackProfile, "kept in this browser");
  const calls = gh.apiCalls.length;
  panel.run(`stackProfile = null`);
  await panel.fn.loadStackProfile();
  assert.equal(gh.apiCalls.length, calls, "fresh profile comes from storage");
  panel.run(`githubToken = ""`);
  assert.equal(await panel.fn.loadStackProfile(), null, "signed out → no profile");
});

test("issueStack lists languages of the likely files, then languages and tech the issue names", () => {
  const stack = plain(pure.issueStack(issue("Deploy the Python SDK with Docker on k8s", "Also touches the docs."), ["web/graph.ts", "web/view.tsx", "core/io.py", "README.md"]));
  assert.deepEqual(stack.map(i => i.name), ["TypeScript", "Python", "Docker", "Kubernetes"]);
  assert.equal(stack[0].from, "web/graph.ts", "the file behind each language");
  assert.equal(stack[1].from, "core/io.py");
  assert.deepEqual(plain(pure.issueStack(issue("Typo"), [])), []);
});

test("the issue brief says what it requires, with the file behind each language", () => {
  const panel = loadPanel();
  panel.run(`stackProfile = ${JSON.stringify(PROFILE)}`);
  const html = panel.fn.stackSectionHtml(pure.issueStack(issue("Allocator panics in Docker"), ["core/alloc.rs"]));
  assert.match(html, /What it requires[\s\S]*<li class=""><strong>Rust<\/strong> <code>core\/alloc\.rs<\/code><\/li>[\s\S]*<li class="is-known"><strong>Docker<\/strong><\/li>/);
  assert.equal(panel.fn.stackSectionHtml([]), "");
});

// ── Pull requests ────────────────────────────────────────────────────────────
const pull = (number, title, extra = {}) => ({
  number, title, body: "", labels: [], state: "open", draft: false, user: { login: "dev", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4" },
  html_url: `https://github.com/o/r/pull/${number}`, created_at: iso(2), updated_at: iso(1), requested_reviewers: [], head: { ref: "patch" }, ...extra,
});
const PULLS = [
  pull(30, "Fix llm stream in core", { head: { ref: "fix/core-stream" } }),
  pull(31, "Graph viewer: Docker build", { head: { ref: "graph-viewer-docker" } }),
];

function prFitPanel({ profile = PROFILE } = {}) {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE, "/pulls": PULLS });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  if (profile) panel.run(`stackProfile = ${JSON.stringify(profile)}`);
  return { gh, panel };
}

test("PR rows list the stack they require too, from title, description and branch name", async () => {
  const { gh, panel } = prFitPanel();
  await panel.fn.fetchPrList();
  const html = panel.el("prs-list").innerHTML;
  assert.match(html.slice(html.indexOf("#31")), /<span class="row-stack"><span class="stack-tag is-known" title="TypeScript — web\/graph\.ts · in your stack">TypeScript<\/span>[\s\S]*>Docker<\/span>/);
  assert.ok(!gh.apiCalls.some(u => /\/pulls\/\d+\/files/.test(u)), "no per-PR file requests for the list");
});

test("Best fit for you sorts PRs too, and asks you to sign in without a profile", async () => {
  const { panel } = prFitPanel();
  panel.run(`prView.sort = "fit"`);
  await panel.fn.fetchPrList();
  const html = panel.el("prs-list").innerHTML;
  assert.ok(html.indexOf("#31") < html.indexOf("#30"), "TypeScript + Docker first in a Python repo");
  assert.match(panel.el("prs-summary").innerHTML, /Open pull requests needing more of your stack first · among the 2 loaded/);

  const anon = prFitPanel({ profile: null });
  anon.panel.run(`prView.sort = "fit"; AUTH.clientId = "x"`);
  await anon.panel.fn.fetchPrList();
  assert.match(anon.panel.el("prs-summary").innerHTML, /Sign in to sort by fit[\s\S]*fit-sign-in/);
  assert.ok(anon.panel.el("prs-list").innerHTML.indexOf("#30") < anon.panel.el("prs-list").innerHTML.indexOf("#31"), "newest order kept");
});

test("prStack reads the PR's real changed files: languages by size of change, then tech it names", () => {
  const stack = plain(pure.prStack({ title: "Speed up the Docker build", body: "", labels: [] }, [
    { filename: "core/io.py", changes: 12 }, { filename: "web/graph.ts", changes: 80 }, { filename: "web/view.tsx", changes: 5 },
    { filename: "README.md", changes: 40 },
  ]));
  assert.deepEqual(stack.map(i => i.name), ["TypeScript", "Python", "Docker"]);
  assert.equal(stack[0].from, "web/graph.ts", "the most-changed file for each language");
  const panel = loadPanel();
  panel.run(`stackProfile = ${JSON.stringify(PROFILE)}`);
  assert.match(panel.fn.stackSectionHtml(stack, undefined, "What it touches"), /What it touches[\s\S]*<li class="is-known"><strong>TypeScript<\/strong> <code>web\/graph\.ts<\/code>/);
});
