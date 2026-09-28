// brief.js: "Start this issue" — availability, code owners, verify commands, flow
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, tick, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const user = (login) => ({ login, type: "User", avatar_url: `https://avatars.githubusercontent.com/u/1?v=4`, html_url: `https://github.com/${login}` });
const comment = (login, assoc, body, daysAgo) => ({ user: user(login), author_association: assoc, body, created_at: iso(daysAgo), html_url: `https://github.com/o/r/issues/7#c-${login}` });
const prRef = (number, state, merged, login = "someone") => ({
  event: "cross-referenced",
  source: { issue: { number, state, user: user(login), html_url: `https://github.com/o/r/pull/${number}`, pull_request: { merged_at: merged ? iso(1) : null } } },
});
const baseIssue = { number: 7, title: "Countdown drifts on Windows", labels: [], assignees: [], user: user("reporter"), created_at: iso(10), comments: 0, html_url: "https://github.com/o/r/issues/7" };

// ── CODEOWNERS matching ──────────────────────────────────────────────────────
test("codeOwnerRegex follows GitHub's pattern rules", () => {
  const m = (pattern, path) => pure.codeOwnerRegex(pattern).test(path);
  assert.ok(m("*", "anything/at/all.ts"));
  assert.ok(m("*.js", "deep/dir/file.js") && !m("*.js", "file.ts"));
  assert.ok(m("/docs/", "docs/guide.md") && !m("/docs/", "src/docs/guide.md"), "leading slash anchors to root");
  assert.ok(m("docs/", "src/docs/guide.md"), "no slash except trailing: matches at any depth");
  assert.ok(m("src/launch/", "src/launch/sequence.ts") && !m("src/launch/", "lib/src/launch/x.ts"), "inner slash anchors");
  assert.ok(m("src/**/timer.ts", "src/a/b/timer.ts"));
  assert.ok(m("apps/*", "apps/web") && !m("apps/*", "apps"));
});

test("codeOwnersFor: the last matching rule wins", () => {
  const rules = pure.parseCodeOwners("*  @everyone\n/src/  @core\n/src/launch/  @launch-team @ada\n");
  assert.deepEqual(plain(pure.codeOwnersFor("README.md", rules)), ["@everyone"]);
  assert.deepEqual(plain(pure.codeOwnersFor("src/index.ts", rules)), ["@core"]);
  assert.deepEqual(plain(pure.codeOwnersFor("src/launch/timer.ts", rules)), ["@launch-team", "@ada"]);
});

// ── Availability ─────────────────────────────────────────────────────────────
test("looksLikeClaim spots the usual ways of calling dibs", () => {
  for (const t of ["I'd like to work on this!", "Can I take this one?", "I'll give it a try", "Please assign this to me", "I'm working on it", "Let me pick this up"]) assert.ok(pure.looksLikeClaim(t), t);
  for (const t of ["I can reproduce this on Windows too", "This works for me", "Any update?", "+1"]) assert.ok(!pure.looksLikeClaim(t), t);
});

test("an untouched issue looks free, and notes that no maintainer has replied", () => {
  const a = pure.issueAvailability(baseIssue, [], [], NOW);
  assert.equal(a.status, "free");
  assert.equal(a.verdict, "Looks free");
  assert.deepEqual(plain(a.reasons.map(r => r.tone)), ["good", "info"]);
  assert.match(a.reasons[1].text, /no maintainer/i);
});

test("assignees and open PRs mean it's taken", () => {
  const assigned = pure.issueAvailability({ ...baseIssue, assignees: [user("ada")] }, [], [], NOW);
  assert.equal(assigned.status, "taken");
  assert.match(assigned.reasons[0].text, /Assigned to @ada/);
  const withPR = pure.issueAvailability(baseIssue, [], [prRef(42, "open", false, "grace")], NOW);
  assert.equal(withPR.status, "taken");
  assert.match(withPR.reasons.find(r => r.tone === "bad").text, /Open PR #42 by @grace/);
});

test("a merged PR means it may already be fixed; a closed one is just context", () => {
  assert.equal(pure.issueAvailability(baseIssue, [], [prRef(40, "closed", true)], NOW).status, "maybe");
  const closed = pure.issueAvailability(baseIssue, [], [prRef(41, "closed", false)], NOW);
  assert.equal(closed.status, "free");
  assert.ok(closed.reasons.some(r => /closed without merging/.test(r.text)));
});

test("recent claims make it 'possibly taken'; old claims with no PR don't", () => {
  const recent = pure.issueAvailability(baseIssue, [comment("newbie", "NONE", "Can I work on this?", 3)], [], NOW);
  assert.equal(recent.status, "maybe");
  assert.match(recent.reasons.find(r => r.tone === "warn").text, /@newbie offered to work on it/);

  const stale = pure.issueAvailability(baseIssue, [comment("ghost", "NONE", "I'll take this", 90)], [], NOW);
  assert.equal(stale.status, "free");
  assert.match(stale.reasons.find(r => /ghost/.test(r.text)).text, /no PR followed/);
});

test("maintainer comments aren't claims, and count as a maintainer reply", () => {
  const a = pure.issueAvailability(baseIssue, [comment("ada", "MEMBER", "I'll take a look at the design later", 1)], [], NOW);
  assert.equal(a.status, "free");
  assert.ok(!a.reasons.some(r => /no maintainer/i.test(r.text)));
});

test("someone who already opened a PR isn't listed again as a claim", () => {
  const a = pure.issueAvailability(baseIssue, [comment("grace", "NONE", "I'd like to work on this", 5)], [prRef(42, "open", false, "grace")], NOW);
  assert.equal(a.reasons.filter(r => /grace/.test(r.text)).length, 1);
});

// ── Verify commands ──────────────────────────────────────────────────────────
const WORKFLOW = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Lint
        run: npm run lint
      - run: |
          echo "starting"
          npm test -- --coverage
          cd docs
      - run: echo \${{ secrets.TOKEN }}
      - run: "make build"
`;

test("ciRunCommands reads single-line and block run steps", () => {
  assert.deepEqual(plain(pure.ciRunCommands(WORKFLOW)),
    ["npm ci", "npm run lint", 'echo "starting"', "npm test -- --coverage", "cd docs", "echo ${{ secrets.TOKEN }}", "make build"]);
});

test("verifyCommands keeps real build/test commands from CI, then fills gaps from package.json", () => {
  const cmds = plain(pure.verifyCommands({
    workflowText: WORKFLOW, workflowPath: ".github/workflows/ci.yml",
    packageJson: JSON.stringify({ scripts: { test: "jest", lint: "eslint .", typecheck: "tsc" } }), packageManager: "pnpm",
  }));
  assert.deepEqual(cmds.map(c => c.cmd), ["npm ci", "npm run lint", "npm test -- --coverage", "make build", "pnpm run typecheck"]);
  assert.equal(cmds[0].from, ".github/workflows/ci.yml");
  assert.equal(cmds.at(-1).from, "package.json");
});

test("verifyCommands copes with no CI and invalid package.json", () => {
  assert.deepEqual(plain(pure.verifyCommands({ packageJson: "{not json" })), []);
  assert.deepEqual(plain(pure.verifyCommands({ packageJson: '{"scripts":{"test":"vitest"}}' })).map(c => c.cmd), ["npm test"]);
});

// ── People & export ──────────────────────────────────────────────────────────
test("briefPeople maps files to owners and lists maintainers in the thread", () => {
  const rules = pure.parseCodeOwners("/src/launch/ @ada @org/launch\n");
  const people = plain(pure.briefPeople(["src/launch/timer.ts", "README.md"], rules, [
    comment("bob", "COLLABORATOR", "Looks like a timer bug", 2), comment("bob", "COLLABORATOR", "Yes", 1), comment("x", "NONE", "+1", 1),
  ]));
  assert.deepEqual(people.owners, [{ handle: "@ada", files: ["src/launch/timer.ts"] }, { handle: "@org/launch", files: ["src/launch/timer.ts"] }]);
  assert.deepEqual(people.inThread.map(p => [p.login, p.replies]), [["bob", 2]]);
});

test("briefMarkdown produces a shareable summary", () => {
  const md = pure.briefMarkdown({ owner: "o", repo: "r" }, baseIssue, {
    availability: pure.issueAvailability(baseIssue, [], [], NOW),
    likelyFiles: ["src/launch/timer.ts"],
    people: { owners: [{ handle: "@ada", files: ["src/launch/timer.ts"] }], inThread: [] },
    commands: [{ cmd: "npm test", from: "package.json" }],
  });
  assert.match(md, /^# #7 Countdown drifts on Windows\nhttps:\/\/github\.com\/o\/r\/issues\/7/);
  assert.match(md, /\*\*Looks free\*\*/);
  assert.match(md, /## Likely files\n- src\/launch\/timer\.ts/);
  assert.match(md, /- @ada — code owner of src\/launch\/timer\.ts/);
  assert.match(md, /## Run before opening a PR\n```bash\nnpm test\n```/);
});

// ── Flow ─────────────────────────────────────────────────────────────────────
const TREE = { tree: ["README.md", "package.json", ".github/CODEOWNERS", ".github/workflows/test.yml", "src/launch/timer.ts", "src/index.ts"]
  .map(p => ({ path: p, type: "blob", size: 500 })) };
const RAW = {
  "README.md": "# Rocket",
  "package.json": '{"scripts":{"test":"jest","lint":"eslint ."}}',
  ".github/CODEOWNERS": "/src/launch/ @ada\n",
  ".github/workflows/test.yml": "jobs:\n  t:\n    steps:\n      - run: npm ci\n      - run: npm test\n",
  "src/launch/timer.ts": "export class Timer {\n  tick() { /* drift */ }\n}",
};

function briefPanel({ ai = true, comments = [], timeline = [] } = {}) {
  let aiCalls = 0;
  const gh = githubMock({
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE,
    "/issues/7/comments?per_page=100": comments,
    "/issues/7/timeline?per_page=100": timeline,
  }, { raw: RAW, ai: async () => { aiCalls++; return sseReply("unexpected"); } });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  if (ai) panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"`);
  else panel.run(`aiProvider = "groq"; aiApiKey = ""`);
  return { gh, panel, aiCalls: () => aiCalls };
}

test("the brief shows availability, likely files, code owners and verify commands for 2 API requests — and no AI", async () => {
  const { gh, panel, aiCalls } = briefPanel({ comments: [comment("bob", "MEMBER", "Timer bug, see tick()", 2)] });
  await panel.fn.showIssueBrief({ ...baseIssue, title: "Timer drifts during launch countdown" });

  const body = panel.el("brief-body").innerHTML;
  assert.match(body, /availability-free[\s\S]*Looks free/);
  assert.match(body, /Likely files[\s\S]*href="https:\/\/github\.com\/o\/r\/blob\/HEAD\/src\/launch\/timer\.ts"/);
  assert.match(body, /Run before opening a PR[\s\S]*npm test/);
  assert.match(body, /From <code>\.github\/workflows\/test\.yml<\/code>/);
  const people = panel.el("brief-people").innerHTML;
  assert.match(people, /github\.com\/ada"[^>]*>ada<\/a>[\s\S]*Code owner[\s\S]*timer\.ts/);
  assert.match(people, /bob[\s\S]*Replied 1× in this thread/);
  assert.equal(aiCalls(), 0, "briefs never call the AI");

  const issueCalls = gh.apiCalls.filter(u => u.startsWith("/issues/7/"));
  assert.deepEqual(issueCalls.sort(), ["/issues/7/comments?per_page=100", "/issues/7/timeline?per_page=100"]);
  assert.ok(gh.apiCalls.length <= 4, `API calls: ${gh.apiCalls.join(", ")}`); // + repo metadata + tree, shared with other tabs
});

test("the brief hands AI questions to Ask: suggestions and your own question", async () => {
  const { panel } = briefPanel();
  await panel.fn.showIssueBrief(baseIssue);
  const body = panel.el("brief-body").innerHTML;
  assert.match(body, /Ask about this issue[\s\S]*data-kind="issue" data-ask="0">Summary &amp; plan[\s\S]*Where do I start\?[\s\S]*How do I test this\?[\s\S]*ask-chip-own/);
  assert.doesNotMatch(body, /Generate|thread-input/);

  const noAI = briefPanel({ ai: false });
  await noAI.panel.fn.showIssueBrief(baseIssue);
  assert.match(noAI.panel.el("brief-body").innerHTML, /Ask about this issue[\s\S]*Add an AI provider[\s\S]*for summaries and questions about this issue/);
  assert.doesNotMatch(noAI.panel.el("brief-body").innerHTML, /ask-chip/);
});

test("reopening a brief is instant: no new API requests", async () => {
  const { gh, panel } = briefPanel();
  await panel.fn.showIssueBrief(baseIssue);
  const api = gh.apiCalls.length;
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief(baseIssue);
  assert.equal(gh.apiCalls.length, api);
});

test("a taken issue says so, with the PR that took it", async () => {
  const { panel } = briefPanel({ ai: false, timeline: [prRef(42, "open", false, "grace")] });
  await panel.fn.showIssueBrief(baseIssue);
  assert.match(panel.el("brief-body").innerHTML, /availability-taken[\s\S]*Open PR #42 by @grace/);
});

test("switching repos while a brief is loading never renders it into the other repo", async () => {
  const { panel } = briefPanel();
  const pending = panel.fn.showIssueBrief(baseIssue);
  panel.setRepo("other", "repo");
  panel.el("brief-body").innerHTML = "OTHER";
  await pending;
  assert.equal(panel.el("brief-body").innerHTML, "OTHER");
});

test("Start this issue buttons are on every card and open the brief", async () => {
  const gh = githubMock({ "/issues": [{ ...baseIssue, reactions: { total_count: 0 } }], "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE, "/issues/7/comments?per_page=100": [], "/issues/7/timeline?per_page=100": [] }, { raw: RAW });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  await panel.fn.fetchIssues();
  assert.match(panel.el("issues-list").innerHTML, /class="row-open start-issue-btn" data-issue="7"/);
  panel.fn.openIssueBriefFromList("7");
  await tick(20);
  assert.equal(panel.el("contribute-browse").hidden, true);
  assert.equal(panel.el("issue-brief").hidden, false);
  assert.match(panel.el("brief-body").innerHTML, /Countdown drifts on Windows/);
  panel.fn.closeIssueBrief();
  assert.equal(panel.el("contribute-browse").hidden, false);
});
