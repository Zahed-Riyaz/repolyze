// flow.js: "From clone to pull request" — setup, checks, PR conventions and template
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const set = (...paths) => new Set(paths);
const issue = { number: 7, title: "Countdown drifts on Windows", labels: [{ name: "bug" }], assignees: [], comments: 0,
  user: { login: "reporter" }, created_at: new Date().toISOString(), html_url: "https://github.com/o/r/issues/7" };

// ── Setup ────────────────────────────────────────────────────────────────────
test("shellCommandsIn reads shell blocks: prompts stripped, output and comments skipped, continuations joined", () => {
  const md = [
    "```bash", "# install everything", "pnpm install", "cp .env.example .env  # then edit it", "docker compose \\", "  up -d", "```",
    "```console", "$ make dev", "Starting server on :3000", "```",
    "```json", '{ "npm": "not a command" }', "```",
  ].join("\n");
  assert.deepEqual(plain(pure.shellCommandsIn(md)), ["pnpm install", "cp .env.example .env", "docker compose up -d", "make dev"]);
  assert.deepEqual(plain(pure.shellCommandsIn("Run `npm install`, then `npm run dev`. Use `foo` for bar.")), ["npm install", "npm run dev"],
    "no fenced blocks → inline code that looks like a command");
});

test("setup comes from the contributing docs' setup section (subsections included), minus clone and cd", () => {
  const docs = [{ path: "CONTRIBUTING.md", sections: pure.splitMarkdownSections([
    "# Contributing", "Thanks!",
    "## Development setup", "You need Node.",
    "### Install", "```sh\ngit clone https://github.com/o/r.git\ncd r\nyarn install\n```",
    "### Run", "```sh\nyarn dev\n```",
    "## Releasing", "```sh\nyarn release\n```",
  ].join("\n")) }];
  const setup = plain(pure.setupSteps({ paths: set("package.json", "yarn.lock"), files: {}, docs }));
  assert.deepEqual(setup.commands.map(c => c.cmd), ["yarn install", "yarn dev"]);
  assert.deepEqual(setup.source, { path: "CONTRIBUTING.md", heading: "Development setup" });
});

test("a README's user-facing Installation isn't setup; its Development section is", () => {
  const readme = (extra) => [{ path: "README.md", sections: pure.splitMarkdownSections(`# Lib\n## Installation\n\`\`\`sh\nnpm install lib\n\`\`\`\n${extra}`) }];
  const userOnly = plain(pure.setupSteps({ paths: set("package.json", "package-lock.json"), files: {}, docs: readme("") }));
  assert.deepEqual(userOnly.commands.map(c => c.cmd), ["npm ci"], "falls back to the lockfile");
  assert.equal(userOnly.source, null);
  const dev = plain(pure.setupSteps({ paths: set("package.json"), files: {}, docs: readme("## Development\n```sh\nnpm install\nnpm run build\n```") }));
  assert.deepEqual(dev.commands.map(c => c.cmd), ["npm install", "npm run build"]);
});

test("without docs, setup is worked out from lockfiles, manifests and config files, each saying where it came from", () => {
  const js = plain(pure.inferredSetup(set("package.json", "pnpm-lock.yaml", ".env.example", "compose.yaml", ".pre-commit-config.yaml"),
    { "package.json": '{"scripts":{"dev":"vite","test":"vitest"}}' }));
  assert.deepEqual(js, [
    { cmd: "pnpm install", from: "pnpm-lock.yaml" }, { cmd: "pre-commit install", from: ".pre-commit-config.yaml" },
    { cmd: "cp .env.example .env", from: ".env.example" }, { cmd: "docker compose up -d", from: "compose.yaml" },
    { cmd: "pnpm run dev", from: "package.json" },
  ]);
  const cmds = (paths, files = {}, ci) => plain(pure.inferredSetup(set(...paths), files, ci)).map(c => c.cmd);
  assert.deepEqual(cmds(["pyproject.toml", "uv.lock"]), ["uv sync"]);
  assert.deepEqual(cmds(["pyproject.toml", "poetry.lock"]), ["poetry install"]);
  assert.deepEqual(cmds(["pyproject.toml"], { "pyproject.toml": "[project]\n[project.optional-dependencies]\ndev = [\"pytest\"]" }), ['pip install -e ".[dev]"']);
  assert.deepEqual(cmds(["go.mod", "Makefile"], { Makefile: "build:\n\tgo build\nsetup:\n\tgo mod download\n" }), ["make setup"], "a Makefile setup target is what maintainers use");
  assert.deepEqual(cmds(["package.json", "package-lock.json"], {}, [{ cmd: "npm ci --legacy-peer-deps", from: "ci.yml" }]), ["npm ci --legacy-peer-deps"], "CI's install step beats a guess");
  assert.deepEqual(cmds(["Cargo.toml"]), ["cargo build"]);
});

test("runtimeRequirements reads the versions a repo pins", () => {
  assert.deepEqual(plain(pure.runtimeRequirements({ ".nvmrc": "v20.11.0\n", "package.json": '{"engines":{"node":">=18"}}' })), ["Node 20.11.0"], "the pinned file beats engines");
  assert.deepEqual(plain(pure.runtimeRequirements({ "pyproject.toml": 'requires-python = ">= 3.10"', "go.mod": "module x\n\ngo 1.22\n" })), ["Python >=3.10", "Go 1.22"]);
  assert.deepEqual(plain(pure.runtimeRequirements({ ".tool-versions": "nodejs 20.1.0\npython 3.12.2\n" })), ["Node 20.1.0", "Python 3.12.2"]);
});

test("branch names say what kind of change it is and which issue", () => {
  assert.equal(pure.branchNameFor(issue), "fix/7-countdown-drifts-windows");
  assert.equal(pure.branchNameFor({ number: 12, title: "Document the --watch flag", labels: ["documentation"] }), "docs/12-document-watch-flag");
  assert.equal(pure.branchNameFor({ number: 3, title: "???", labels: [] }), "issue/3");
});

// ── PR conventions ───────────────────────────────────────────────────────────
test("title conventions come from merged PRs: Conventional Commits, [area] prefixes, Go-style package prefixes", () => {
  const conv = ["feat(ui): dark mode", "fix: crash on start", "docs: typo", "chore(deps): bump x", "Update README", "fix(api): 500 on empty body"];
  assert.deepEqual(plain(pure.titleConvention(conv)), { kind: "conventional", count: 5, total: 6, example: "feat(ui): dark mode" });
  assert.equal(pure.titleConvention(["[docs] a", "[cli] b", "[core] c", "d", "[ui] e", "[cli] f"]).kind, "bracket");
  assert.equal(pure.titleConvention(["net/http: a", "cmd/go: b", "runtime: c", "os: d", "all: e", "f g"]).kind, "area");
  assert.equal(pure.titleConvention(["Add x", "Fix y", "Update z", "Remove w", "Bump v", "Tidy u"]), null);
  assert.equal(pure.titleConvention(["fix: a", "fix: b"]), null, "too few to tell");
  assert.equal(pure.titleConvention(["chore(release): bump version to 1.2.0", "chore(deps): bump x", "docs: fix typo", "feat(cli): add --json", "fix: y", "z"]).example,
    "feat(cli): add --json", "a person's feature or fix, not a release bot's title");
});

test("prConventions lists each rule with its evidence", () => {
  const titles = ["feat: a", "fix: b", "fix(x): c", "docs: d", "chore: e", "Merge f"];
  const doc = "## Pull requests\nAll commits must be signed off (DCO). Please add tests for new behaviour and update the docs.";
  const c = plain(pure.prConventions({ paths: set("package.json", ".changeset/config.json"), contributing: doc, mergedTitles: titles, packageManager: "pnpm" }));
  assert.equal(c.titleStyle, "conventional");
  assert.deepEqual(c.checklist.map(x => [x.text, x.cmd || null, x.from]), [
    ["Write the title as type(scope): summary", null, "5 of 6 recent merged PRs"],
    ["Sign off every commit", "git commit -s", "CONTRIBUTING"],
    ["Add a changeset describing the change", "pnpm changeset", ".changeset/"],
    ["Include tests for the change", null, "CONTRIBUTING"],
    ["Update the docs if behaviour changes", null, "CONTRIBUTING"],
  ]);
  assert.equal(pure.prConventions({ paths: set("commitlint.config.js"), mergedTitles: [] }).checklist[0].from, "commitlint.config.js");
  assert.deepEqual(plain(pure.prConventions({ paths: set("README.md"), mergedTitles: [] })), { checklist: [], titleStyle: null }, "nothing known → nothing claimed");
});

test("the PR template is found where GitHub looks for it", () => {
  assert.equal(pure.findPrTemplate(set("src/a.ts", ".github/PULL_REQUEST_TEMPLATE.md")), ".github/PULL_REQUEST_TEMPLATE.md");
  assert.equal(pure.findPrTemplate(set("docs/pull_request_template.md")), "docs/pull_request_template.md");
  assert.equal(pure.findPrTemplate(set(".github/PULL_REQUEST_TEMPLATE/release.md", ".github/PULL_REQUEST_TEMPLATE/bug_fix.md")), ".github/PULL_REQUEST_TEMPLATE/bug_fix.md");
  assert.equal(pure.findPrTemplate(set("README.md")), null);
});

test("fillPrTemplate completes the repo's own issue placeholder, else adds Fixes #N where it belongs", () => {
  assert.equal(pure.fillPrTemplate("## Summary\n\nFixes #\n", 7), "## Summary\n\nFixes #7\n");
  assert.equal(pure.fillPrTemplate("Closes #(issue)\n\n## Checklist", 7), "Closes #7\n\n## Checklist");
  assert.equal(pure.fillPrTemplate("Resolves: #<issue number>", 7), "Resolves: #7");
  assert.equal(pure.fillPrTemplate("Fixes #XXXX", 42), "Fixes #42");
  assert.equal(pure.fillPrTemplate("<!-- Write 'Fixes #' to link -->\n## Related issue\n\n## Tests", 7),
    "<!-- Write 'Fixes #' to link -->\n## Related issue\n\nFixes #7\n\n## Tests", "a placeholder inside a comment is left alone");
  assert.equal(pure.fillPrTemplate("## What\n\n## Why", 7), "Fixes #7\n\n## What\n\n## Why");
  assert.equal(pure.fillPrTemplate("  \n", 7), null);
});

test("the PR draft: a title in the repo's style, the filled template, and (signed in) GitHub's PR form filled in", () => {
  const flow = { defaultBranch: "main", pr: { template: "## Summary\nFixes #\n", titleStyle: "conventional" } };
  const d = plain(pure.prDraftFor({ owner: "o", repo: "r" }, issue, flow, "you", [{ cmd: "npm test" }]));
  assert.equal(d.title, "fix: countdown drifts on Windows");
  assert.equal(d.body, "## Summary\nFixes #7\n");
  assert.ok(d.fromTemplate);
  assert.equal(d.compareUrl, "https://github.com/o/r/compare/main...you:fix/7-countdown-drifts-windows?expand=1&title=fix%3A%20countdown%20drifts%20on%20Windows&body=%23%23%20Summary%0AFixes%20%237%0A");

  const plainDraft = plain(pure.prDraftFor({ owner: "o", repo: "r" }, issue, { pr: { template: null } }, null, [{ cmd: "npm test" }]));
  assert.equal(plainDraft.title, "Countdown drifts on Windows");
  assert.match(plainDraft.body, /^Fixes #7\n\n## What changed[\s\S]*## How I tested it\n\n- \[ \] `npm test`/);
  assert.equal(plainDraft.compareUrl, null, "no login → no link to a branch we can't name");

  const long = plain(pure.prDraftFor({ owner: "o", repo: "r" }, issue, { pr: { template: "x".repeat(9000) } }, "you"));
  assert.doesNotMatch(long.compareUrl, /&body=/, "an overlong template is left to GitHub to fill in");
});

// ── In the brief ─────────────────────────────────────────────────────────────
const TREE = { tree: ["README.md", "CONTRIBUTING.md", "package.json", "pnpm-lock.yaml", ".nvmrc", ".env.example", ".github/pull_request_template.md",
  ".github/workflows/ci.yml", "commitlint.config.js", "src/timer.ts"].map(p => ({ path: p, type: "blob", size: 100 })) };
const RAW = {
  "README.md": "# Rocket",
  "CONTRIBUTING.md": "# Contributing\n## Local development\n```bash\n$ pnpm install\n$ pnpm dev\n```\n## Submitting a pull request\nSign off your commits (DCO).",
  "package.json": '{"scripts":{"test":"vitest","dev":"vite"}}',
  ".nvmrc": "20\n",
  ".github/pull_request_template.md": "## Description\n\nCloses #\n\n<script>alert(1)</script>\n",
  ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm test\n",
};

function flowPanel({ login = "you" } = {}) {
  let aiCalls = 0;
  const gh = githubMock({
    "": { default_branch: "trunk" },
    "/git/trees/HEAD?recursive=1": TREE,
    "/issues/7/comments?per_page=100": [], "/issues/7/timeline?per_page=100": [],
    "/issues/8/comments?per_page=100": [], "/issues/8/timeline?per_page=100": [],
    "/pulls?state=closed&sort=updated&direction=desc&per_page=50": [],
  }, { raw: RAW, ai: async () => { aiCalls++; return sseReply("no"); } });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"; githubUser = ${login ? `{ login: "${login}" }` : "null"}`);
  return { gh, panel, aiCalls: () => aiCalls };
}

test("the brief walks from clone to PR with the repo's own steps, template and rules — no AI", async () => {
  const { panel, aiCalls } = flowPanel();
  await panel.fn.showIssueBrief(issue);
  const body = panel.el("brief-body").innerHTML;

  assert.match(body, /From clone to pull request[\s\S]*<span class="flow-num">1<\/span>Set up/);
  assert.match(body, /href="https:\/\/github\.com\/o\/r\/fork"/);
  assert.match(body, /Needs <strong>Node 20<\/strong>/);
  assert.match(body, /git clone https:\/\/github\.com\/you\/r\.git &amp;&amp; cd r[\s\S]*git checkout -b fix\/7-countdown-drifts-windows[\s\S]*pnpm install<\/code>[\s\S]*pnpm dev<\/code>/);
  assert.match(body, /From <a href="https:\/\/github\.com\/o\/r\/blob\/trunk\/CONTRIBUTING\.md#local-development"[^>]*>CONTRIBUTING\.md › Local development<\/a>/);
  assert.match(body, /Before you push[\s\S]*pnpm test[\s\S]*What CI runs/);
  assert.doesNotMatch(body.split('<span class="flow-num">2</span>')[1].split('<span class="flow-num">3</span>')[0], /pnpm install/, "installs belong to setup");

  const pr = body.split('<span class="flow-num">3</span>')[1];
  assert.match(pr, /Write the title as type\(scope\): summary[\s\S]*commitlint\.config\.js/);
  assert.match(pr, /Sign off every commit <code>git commit -s<\/code>/);
  assert.match(pr, /<span class="pr-draft-label">Title<\/span><span class="pr-draft-title">fix: countdown drifts on Windows<\/span>/);
  assert.match(pr, /data-cmd="## Description\n\nCloses #7\n\n&lt;script&gt;alert\(1\)&lt;\/script&gt;\n"/, "the template, filled in and escaped");
  assert.doesNotMatch(body, /<script>/);
  assert.match(pr, /class="btn btn-primary pr-draft-open" href="https:\/\/github\.com\/o\/r\/compare\/trunk\.\.\.you:fix\/7-countdown-drifts-windows\?expand=1&amp;title=/);
  assert.match(pr, /From <code>pull_request_template\.md<\/code> · links #7/);
  assert.match(pr, /Full guidelines: <a [^>]*#submitting-a-pull-request"[^>]*>CONTRIBUTING\.md › Submitting a pull request<\/a>/);
  assert.match(pr, /Sign off every commit <code>git commit -s<\/code><\/span>\s*<span class="flow-meta">from CONTRIBUTING\.md<\/span>/, "evidence names the file");
  assert.equal(aiCalls(), 0);
});

test("signed out: YOUR-USERNAME in the clone command and no link to a branch it can't name", async () => {
  const { panel } = flowPanel({ login: null });
  await panel.fn.showIssueBrief(issue);
  const body = panel.el("brief-body").innerHTML;
  assert.match(body, /git clone https:\/\/github\.com\/YOUR-USERNAME\/r\.git/);
  assert.match(body, /replace YOUR-USERNAME below/);
  assert.doesNotMatch(body, /\/compare\//);
  assert.match(body, /<a href="#" class="brief-open-settings">Sign in<\/a> to open GitHub's PR form already filled in/);
});

test("the repo's setup and conventions are read once: another issue's brief costs only its own 2 requests", async () => {
  const { gh, panel } = flowPanel();
  await panel.fn.showIssueBrief(issue);
  const api = gh.apiCalls.length;
  const raw = gh.rawCalls.length;
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief({ ...issue, number: 8, title: "Add a pause button", labels: [{ name: "enhancement" }] });
  assert.deepEqual(gh.apiCalls.slice(api).sort(), ["/issues/8/comments?per_page=100", "/issues/8/timeline?per_page=100"]);
  assert.equal(gh.rawCalls.length, raw, "no file is read again");
  assert.match(panel.el("brief-body").innerHTML, /git checkout -b feat\/8-add-pause-button/);
});

test("the Markdown copy of a brief includes the steps and the PR title", async () => {
  const { panel } = flowPanel();
  await panel.fn.showIssueBrief(issue);
  const md = panel.fn.briefMarkdown({ owner: "o", repo: "r" }, issue, panel.fn.currentBrief());
  assert.match(md, /## Set up\n```bash\ngit clone https:\/\/github\.com\/you\/r\.git && cd r\ngit checkout -b fix\/7-countdown-drifts-windows\npnpm install\npnpm dev\n```/);
  assert.match(md, /## Open the PR\n- \[ \] Write the title as type\(scope\): summary\n- \[ \] Sign off every commit \(`git commit -s`\)\n\n\*\*Title:\*\* fix: countdown drifts on Windows/);
});
