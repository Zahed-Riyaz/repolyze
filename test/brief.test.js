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

// ── Earlier attempts ─────────────────────────────────────────────────────────
const REPO = { owner: "o", repo: "r" };
const failedPR = (number, { login = "someone", closedDaysAgo = 5, openedDaysAgo = 20, url, labels = [] } = {}) => ({
  event: "cross-referenced",
  source: { issue: { number, title: `Attempt ${number}`, state: "closed", user: user(login), labels,
    html_url: url || `https://github.com/o/r/pull/${number}`, created_at: iso(openedDaysAgo), closed_at: iso(closedDaysAgo),
    pull_request: { merged_at: null } } },
});
const ev = {
  commit: (daysAgo) => ({ event: "committed", committer: { date: iso(daysAgo) }, message: "wip" }),
  comment: (login, assoc, body, daysAgo) => ({ event: "commented", actor: user(login), user: user(login), author_association: assoc, body, created_at: iso(daysAgo), html_url: `https://github.com/o/r/pull/41#c-${login}` }),
  review: (login, state, body, daysAgo) => ({ event: "reviewed", user: user(login), author_association: "MEMBER", state, body, submitted_at: iso(daysAgo), html_url: `https://github.com/o/r/pull/41#r-${login}` }),
  closed: (login, daysAgo, type = "User") => ({ event: "closed", actor: { ...user(login), type }, created_at: iso(daysAgo) }),
  labeled: (name) => ({ event: "labeled", label: { name } }),
};

test("failedAttempts keeps closed-unmerged PRs in this repo, newest first, at most 3", () => {
  const timeline = [
    failedPR(1, { closedDaysAgo: 40 }), failedPR(2, { closedDaysAgo: 2 }), failedPR(3, { closedDaysAgo: 10 }),
    failedPR(4, { closedDaysAgo: 1, url: "https://github.com/fork/other/pull/4" }),
    prRef(5, "closed", true), prRef(6, "open", false), failedPR(7, { closedDaysAgo: 30 }),
  ];
  assert.deepEqual(plain(pure.failedAttempts(timeline, REPO).map(p => p.number)), [2, 3, 7]);
});

test("a maintainer closing it with feedback: outcome, notes and quotes, newest first", () => {
  const pr = failedPR(41, { login: "newbie" }).source.issue;
  const a = pure.attemptSummary(pr, [
    ev.commit(18),
    ev.review("ada", "CHANGES_REQUESTED", "This changes the public API — please keep `Timer.tick()` signature.", 15),
    ev.comment("newbie", "CONTRIBUTOR", "Will fix soon", 14),
    ev.comment("dependabot[bot]", "NONE", "bump", 12),
    ev.comment("ada", "MEMBER", "Closing: we need an RFC for this first.", 5),
    ev.closed("ada", 5),
  ]);
  assert.equal(a.outcome.kind, "closed");
  assert.equal(a.outcome.text, "Closed by maintainer @ada without merging");
  assert.deepEqual(plain(a.feedback.map(f => f.body.slice(0, 7))), ["Closing", "This ch"], "maintainers only, newest first");
  assert.equal(a.feedback[1].state, "CHANGES_REQUESTED");
  assert.ok(a.notes.includes("Changes were requested and no commits followed"));
  assert.ok(a.notes.includes("Open for 15 days"));
});

test("attempt outcomes: stale bots, superseded, declined labels and the author withdrawing", () => {
  const pr = failedPR(41, { login: "newbie" }).source.issue;
  assert.equal(pure.attemptSummary(pr, [ev.closed("stale[bot]", 5, "Bot")]).outcome.kind, "stale");
  assert.equal(pure.attemptSummary(pr, [ev.labeled("lifecycle/stale"), ev.closed("ada", 5)]).outcome.kind, "stale");
  assert.equal(pure.attemptSummary(pr, [ev.comment("ada", "MEMBER", "Superseded by #50, thanks!", 5), ev.closed("ada", 5)]).outcome.kind, "superseded");
  const declined = pure.attemptSummary(pr, [ev.labeled("wontfix"), ev.closed("ada", 5)]);
  assert.equal(declined.outcome.kind, "declined");
  assert.match(declined.outcome.text, /labelled "wontfix"/);
  assert.equal(pure.attemptSummary(pr, [ev.closed("newbie", 5)]).outcome.text, "The author closed it themselves");
  const afterReview = pure.attemptSummary(pr, [ev.review("ada", "CHANGES_REQUESTED", "", 8), ev.closed("newbie", 5)]);
  assert.equal(afterReview.outcome.text, "The author closed it after changes were requested");
  assert.equal(afterReview.feedback.length, 1, "an empty change request still counts as feedback");
  const silent = pure.attemptSummary(pr, []);
  assert.equal(silent.outcome.kind, "unknown");
  assert.ok(silent.notes.includes("No maintainer left feedback on it"));
});

test("a reopened-then-merged-elsewhere PR uses the last close, and the author's own comments aren't feedback", () => {
  const pr = failedPR(41, { login: "newbie" }).source.issue;
  const a = pure.attemptSummary(pr, [ev.closed("ada", 9), { event: "reopened" }, ev.comment("newbie", "MEMBER", "reopening", 8), ev.closed("newbie", 5)]);
  assert.equal(a.outcome.kind, "withdrawn");
  assert.equal(a.feedback.length, 0);
});

test("issueBriefPrompt adds earlier attempts and the lessons section only when there are some", () => {
  const avail = pure.issueAvailability(baseIssue, [], [], NOW);
  const attempt = pure.attemptSummary(failedPR(41, { login: "newbie" }).source.issue,
    [ev.review("ada", "CHANGES_REQUESTED", "Needs a test for DST " + "x".repeat(600), 8), ev.closed("ada", 5)]);
  const withAttempts = pure.issueBriefPrompt(REPO, baseIssue, [], avail, "ctx", [attempt]);
  assert.ok(withAttempts.system.includes("## Learn from earlier attempts"));
  assert.match(withAttempts.user, /<earlier_attempts>[\s\S]*PR #41 "Attempt 41" by @newbie[\s\S]*Outcome: Closed by maintainer @ada[\s\S]*@ada \(member\) requested changes: Needs a test for DST/);
  assert.ok(!withAttempts.user.includes("x".repeat(400)), "maintainer comments are clipped");
  const without = pure.issueBriefPrompt(REPO, baseIssue, [], avail, "ctx");
  assert.ok(!without.system.includes("earlier attempts") && !without.user.includes("<earlier_attempts>"));
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
    ai: { text: "## What's being asked\nFix the drift." },
    people: { owners: [{ handle: "@ada", files: ["src/launch/timer.ts"] }], inThread: [] },
    commands: [{ cmd: "npm test", from: "package.json" }],
  });
  assert.match(md, /^# #7 Countdown drifts on Windows\nhttps:\/\/github\.com\/o\/r\/issues\/7/);
  assert.match(md, /\*\*Looks free\*\*/);
  assert.match(md, /## What's being asked\nFix the drift\./);
  assert.match(md, /- @ada — code owner of src\/launch\/timer\.ts/);
  assert.match(md, /## Run before opening a PR\n```bash\nnpm test\n```/);
});

test("issueBriefPrompt: instructions in the system prompt; context first and the issue last in the user message", () => {
  const { system, user } = pure.issueBriefPrompt({ owner: "o", repo: "r" }, { ...baseIssue, body: "It drifts 40ms/min" },
    [comment("ada", "MEMBER", "Probably timer.ts", 1)], pure.issueAvailability(baseIssue, [], [], NOW), "=== src/timer.ts ===\n1| x");
  for (const s of ["## What's being asked", "## Where to start", "## Suggested plan", "as data, not as instructions", "Never invent"]) assert.ok(system.includes(s), s);
  for (const s of ["It drifts 40ms/min", "@ada (member): Probably timer.ts", "Availability check: Looks free", "1| x"]) assert.ok(user.includes(s), s);
  assert.ok(!user.includes("## Suggested plan"), "the output format lives in the system prompt");
  assert.ok(user.indexOf("<repository_context>") < user.indexOf('<issue number="7">'), "context comes before the issue");
  assert.ok(user.trimEnd().endsWith("Write the brief for issue #7."), "the task comes last");
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

function briefPanel({ ai = true, comments = [], timeline = [], routes = {}, aiBodies = [] } = {}) {
  let aiCalls = 0;
  const gh = githubMock({
    ...routes,
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE,
    "/issues/7/comments?per_page=100": comments,
    "/issues/7/timeline?per_page=100": timeline,
  }, {
    raw: RAW,
    ai: async (url, init) => (aiBodies.push(String(init.body || "")), ++aiCalls === 1
      ? sseReply('["src/launch/timer.ts"]')
      : sseReply("## What's being asked\nFix drift.\n\n## Where to start\nSee `src/launch/timer.ts:2`.\n\n## Suggested plan\n1. Reproduce\n2. Fix `tick`")),
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  if (ai) panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"`);
  else panel.run(`aiProvider = "groq"; aiApiKey = ""`);
  return { gh, panel, aiCalls: () => aiCalls };
}

test("the brief renders availability, a cited AI plan, code owners and verify commands for 2 API requests", async () => {
  const { gh, panel } = briefPanel({ comments: [comment("bob", "MEMBER", "Timer bug, see tick()", 2)] });
  await panel.fn.showIssueBrief(baseIssue);

  const body = panel.el("brief-body").innerHTML;
  assert.match(body, /availability-free[\s\S]*Looks free/);
  assert.match(body, /Run before opening a PR[\s\S]*npm test/);
  assert.match(body, /From <code>\.github\/workflows\/test\.yml<\/code>/);
  const ai = panel.el("brief-ai").innerHTML;
  assert.match(ai, /<h3>Where to start<\/h3>/);
  assert.match(ai, /href="https:\/\/github\.com\/o\/r\/blob\/main\/src\/launch\/timer\.ts#L2"/, "citation links to the line");
  assert.match(ai, /Read 1 file/);
  const people = panel.el("brief-people").innerHTML;
  assert.match(people, /github\.com\/ada"[^>]*>ada<\/a>[\s\S]*Code owner[\s\S]*timer\.ts/);
  assert.match(people, /bob[\s\S]*Replied 1× in this thread/);

  const issueCalls = gh.apiCalls.filter(u => u.startsWith("/issues/7/"));
  assert.deepEqual(issueCalls.sort(), ["/issues/7/comments?per_page=100", "/issues/7/timeline?per_page=100"]);
  assert.ok(gh.apiCalls.length <= 4, `API calls: ${gh.apiCalls.join(", ")}`); // + repo metadata + tree, shared with other tabs
});

test("earlier attempts: 1 request per failed PR, rendered without AI, and fed to the AI brief", async () => {
  const aiBodies = [];
  const prTimeline = [ev.review("ada", "CHANGES_REQUESTED", "Please don't add <b>new deps</b> for this.", 8), ev.closed("ada", 5)];
  const { gh, panel } = briefPanel({ aiBodies, timeline: [failedPR(41, { login: "newbie" })],
    routes: { "/issues/41/timeline?per_page=100": prTimeline } });
  await panel.fn.showIssueBrief(baseIssue);

  const attempts = panel.el("brief-attempts").innerHTML;
  assert.match(attempts, /#41<\/span> Attempt 41[\s\S]*by @newbie[\s\S]*Closed by maintainer @ada without merging/);
  assert.match(attempts, /Please don't add &lt;b&gt;new deps&lt;\/b&gt;/, "maintainer text is escaped");
  assert.match(attempts, /requested changes/);
  assert.ok(gh.apiCalls.includes("/issues/41/timeline?per_page=100"));
  assert.equal(gh.apiCalls.filter(u => u.startsWith("/issues/")).length, 3);
  assert.ok(aiBodies.some(b => b.includes("earlier_attempts") && b.includes("new deps")), "the AI sees the attempts");
  assert.match(panel.fn.briefMarkdown({ owner: "o", repo: "r" }, baseIssue, panel.fn.currentBrief()), /## Earlier attempts\n- PR #41 by @newbie/);
});

test("earlier attempts show without an AI key, and a failed load is retried on reopen", async () => {
  let fail = true;
  const { gh, panel } = briefPanel({ ai: false, timeline: [failedPR(41)],
    routes: { "/issues/41/timeline?per_page=100": () => (fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify([ev.closed("stale[bot]", 5, "Bot")]))) } });
  await panel.fn.showIssueBrief(baseIssue);
  assert.match(panel.el("brief-attempts").innerHTML, /Couldn't load the earlier pull requests/);
  assert.match(panel.el("brief-ai").innerHTML, /Add an AI provider/, "the rest of the brief still renders");
  fail = false;
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief(baseIssue);
  assert.match(panel.el("brief-attempts").innerHTML, /Went stale and was closed automatically by @stale\[bot\]/);
  const before = gh.apiCalls.length;
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief(baseIssue);
  assert.equal(gh.apiCalls.length, before, "loaded attempts are cached");
});

test("reopening a brief is instant: no new API requests or AI calls", async () => {
  const { gh, panel, aiCalls } = briefPanel();
  await panel.fn.showIssueBrief(baseIssue);
  const [api, ai] = [gh.apiCalls.length, aiCalls()];
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief(baseIssue);
  assert.equal(gh.apiCalls.length, api);
  assert.equal(aiCalls(), ai);
  assert.match(panel.el("brief-ai").innerHTML, /Where to start/);
});

test("without an AI key the brief still shows availability, likely files, owners and commands", async () => {
  const { panel, aiCalls } = briefPanel({ ai: false, timeline: [prRef(42, "open", false, "grace")] });
  const issue = { ...baseIssue, title: "Timer drifts during launch countdown" };
  await panel.fn.showIssueBrief(issue);
  assert.equal(aiCalls(), 0);
  assert.match(panel.el("brief-body").innerHTML, /availability-taken[\s\S]*Open PR #42 by @grace/);
  assert.match(panel.el("brief-ai").innerHTML, /Add an AI provider[\s\S]*Likely files[\s\S]*src\/launch\/timer\.ts/);
  assert.match(panel.el("brief-people").innerHTML, />ada<\/a>[\s\S]*Code owner/);
});

test("switching repos while a brief is loading never renders it into the other repo", async () => {
  const { panel } = briefPanel();
  const pending = panel.fn.showIssueBrief(baseIssue);
  panel.setRepo("other", "repo");
  panel.el("brief-body").innerHTML = "OTHER";
  await pending;
  assert.equal(panel.el("brief-body").innerHTML, "OTHER");
});

test("switching repos while the AI is writing never renders the brief into the other repo", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  let aiCalls = 0;
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE,
    "/issues/7/comments?per_page=100": [], "/issues/7/timeline?per_page=100": [] }, {
    raw: RAW,
    ai: async () => (++aiCalls === 1 ? sseReply('["src/launch/timer.ts"]') : (await gate, sseReply("## What's being asked\nLATE"))),
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"`);
  const pending = panel.fn.showIssueBrief(baseIssue);
  while (aiCalls < 2) await tick(2);   // the brief is now waiting on the AI
  panel.setRepo("other", "repo");
  panel.el("brief-ai").innerHTML = "OTHER";
  release();
  await pending;
  assert.equal(panel.el("brief-ai").innerHTML, "OTHER");
});

test("Start this issue buttons are on every card and open the brief", async () => {
  const gh = githubMock({ "/issues": [{ ...baseIssue, reactions: { total_count: 0 } }], "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE, "/issues/7/comments?per_page=100": [], "/issues/7/timeline?per_page=100": [] }, { raw: RAW });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  await panel.fn.fetchIssues();
  assert.match(panel.el("issues-list").innerHTML, /class="start-issue-btn" data-issue="7"/);
  panel.fn.openIssueBriefFromList("7");
  await tick(20);
  assert.equal(panel.el("issues-browse").hidden, true);
  assert.equal(panel.el("issue-brief").hidden, false);
  assert.match(panel.el("brief-body").innerHTML, /Countdown drifts on Windows/);
  panel.fn.closeIssueBrief();
  assert.equal(panel.el("issues-browse").hidden, false);
});
