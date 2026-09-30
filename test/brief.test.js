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
const prRef = (number, state, merged, login = "someone", closedDaysAgo = null) => ({
  event: "cross-referenced",
  source: { issue: { number, state, user: user(login), html_url: `https://github.com/o/r/pull/${number}`, closed_at: closedDaysAgo === null ? null : iso(closedDaysAgo), pull_request: { merged_at: merged ? iso(1) : null } } },
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

// Each case: [what's on the issue] → the verdict, its tone and the next step
const avail = (issue, comments, timeline) => plain(pure.issueAvailability(issue, comments, timeline, NOW));
test("each situation gets its own verdict and next step, most blocking first", () => {
  const cases = [
    ["nothing", avail(baseIssue, [], []), "free", "free", "Free to work on", /Comment that you'd like to take it/],
    ["assigned", avail({ ...baseIssue, assignees: [user("ada")] }, [], []), "taken", "assigned", "Taken", /ask @ada if they'd like help/],
    ["assigned + open PR", avail({ ...baseIssue, assignees: [user("ada")] }, [], [prRef(42, "open", false, "ada")]), "taken", "assigned", "Taken", /review #42/],
    ["open PR, nobody assigned", avail(baseIssue, [], [prRef(42, "open", false, "grace")]), "maybe", "open-pr", "Has an open PR", /Review or help on #42 with @grace/],
    ["two open PRs", avail(baseIssue, [], [prRef(42, "open", false), prRef(43, "open", false)]), "maybe", "open-pr", "Has 2 open PRs", /#4[23]/],
    ["merged PR, issue still open", avail(baseIssue, [], [prRef(40, "closed", true)]), "maybe", "merged", "May already be fixed", /Check whether #40 fixed it/],
    ["linked in Development", avail(baseIssue, [], [{ event: "connected", created_at: iso(2) }]), "maybe", "linked", "Has a linked PR", /Development section/],
    ["recent claim", avail(baseIssue, [comment("newbie", "NONE", "Can I work on this?", 3)], []), "maybe", "claimed", "Claimed in the comments", /Ask @newbie if they're still on it/],
    ["PR closed last week", avail(baseIssue, [], [prRef(41, "closed", false, "grace", 5)]), "maybe", "closed-pr", "A PR was closed recently", /Read why #41 was closed/],
    ["recent commit", avail(baseIssue, [], [{ event: "referenced", commit_id: "abc123", created_at: iso(3) }]), "maybe", "commits", "Work may be under way", /ask in the thread/],
    ["closed issue", avail({ ...baseIssue, state: "closed", state_reason: "completed", closed_at: iso(1) }, [], [prRef(42, "open", false)]), "taken", "closed", "Closed", /Read why it was closed/],
  ];
  for (const [name, a, status, kind, verdict, advice] of cases) {
    assert.deepEqual([a.status, a.kind, a.verdict], [status, kind, verdict], name);
    assert.match(a.advice, advice, name);
  }
});

test("the reasons back the verdict: 'no PR' only when there's none, and every PR is listed", () => {
  const free = avail(baseIssue, [], []);
  assert.deepEqual(free.reasons.map(r => r.text), ["No assignee, PR or claim", "No maintainer reply yet"]);
  const oldClosed = avail(baseIssue, [], [prRef(41, "closed", false, "someone", 90)]);
  assert.equal(oldClosed.kind, "free", "a PR closed long ago doesn't block");
  assert.equal(oldClosed.reasons[0].text, "No assignee or open PR");
  assert.ok(oldClosed.reasons.some(r => /^PR #41 by @someone closed unmerged \S+ ago$/.test(r.text)));
  const open = avail(baseIssue, [], [prRef(42, "open", false, "grace")]);
  assert.equal(open.reasons[0].text, "Open PR #42 by @grace");
  assert.equal(open.reasons[0].url, "https://github.com/o/r/pull/42");
});

test("Development links count until unlinked; old commits and old claims are only context", () => {
  assert.equal(avail(baseIssue, [], [{ event: "connected", created_at: iso(5) }, { event: "disconnected", created_at: iso(2) }]).kind, "free");
  const withOpen = avail(baseIssue, [], [{ event: "connected" }, prRef(43, "open", false)]);
  assert.equal(withOpen.kind, "open-pr");
  assert.equal(withOpen.reasons.filter(r => /Development|#43/.test(r.text)).length, 1, "an open PR already explains the link");
  const commit = avail(baseIssue, [], [{ event: "referenced", commit_id: "abc123", created_at: iso(3) }]).reasons.find(x => /commit/.test(x.text));
  assert.equal(commit.text, "A commit mentions it (3 days ago)");
  assert.equal(commit.url, "https://github.com/o/r/commit/abc123");
  assert.equal(avail(baseIssue, [], [{ event: "referenced", commit_id: "a", created_at: iso(200) }]).kind, "free");
  const stale = avail(baseIssue, [comment("ghost", "NONE", "I'll take this", 90)], []);
  assert.equal(stale.kind, "free");
  assert.match(stale.reasons.find(r => /ghost/.test(r.text)).text, /no PR followed/);
});

test("the whole timeline is read: signed out adds the newest page, signed in reads up to 5", async () => {
  const page = (n) => [{ event: "commented", n }];
  const lastLink = '<https://api.github.com/repos/o/r/issues/7/timeline?per_page=100&page=2>; rel="next", <https://api.github.com/repos/o/r/issues/7/timeline?per_page=100&page=8>; rel="last"';
  const routes = {
    "": { default_branch: "main" },
    "/issues/7/timeline?per_page=100": new Response(JSON.stringify(page(1)), { headers: { Link: lastLink, "X-RateLimit-Remaining": "4999", "X-RateLimit-Limit": "5000", "X-RateLimit-Reset": "9999999999" } }),
  };
  for (let n = 2; n <= 8; n++) routes[`/issues/7/timeline?per_page=100&page=${n}`] = n === 8 ? [prRef(99, "open", false, "late")] : page(n);
  const out = githubMock(routes);
  const anon = loadPanel({ fetch: out.fetch });
  anon.setRepo();
  const t1 = plain(await anon.fn.loadIssueTimeline({ owner: "o", repo: "r" }, 7));
  assert.equal(pure.issueAvailability(baseIssue, [], t1, NOW).kind, "open-pr", "the PR on the last page is found");
  assert.deepEqual(out.apiCalls.filter(u => u.includes("timeline")), ["/issues/7/timeline?per_page=100", "/issues/7/timeline?per_page=100&page=8"], "signed out: 1 extra request");

  const inn = githubMock(routes);
  const signed = loadPanel({ fetch: inn.fetch });
  signed.setRepo();
  signed.setToken("ghp_x");
  await signed.fn.loadIssueTimeline({ owner: "o", repo: "r" }, 7);
  assert.equal(inn.apiCalls.filter(u => u.includes("timeline")).length, 6, "signed in: pages 1–5 and the last");
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

test("verifyCommands keeps real build/test commands from CI (installs are setup, not checks), then fills gaps from package.json", () => {
  const cmds = plain(pure.verifyCommands({
    workflowText: WORKFLOW, workflowPath: ".github/workflows/ci.yml",
    packageJson: JSON.stringify({ scripts: { test: "jest", lint: "eslint .", typecheck: "tsc" } }), packageManager: "pnpm",
  }));
  assert.deepEqual(cmds.map(c => c.cmd), ["npm run lint", "npm test -- --coverage", "make build", "pnpm run typecheck"]);
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
    fileSources: [{ path: "src/launch/timer.ts", why: "named in the issue", confidence: "high" }],
    people: { owners: [{ handle: "@ada", files: ["src/launch/timer.ts"] }], inThread: [] },
    commands: [{ cmd: "npm test", from: "package.json" }],
  });
  assert.match(md, /^# #7 Countdown drifts on Windows\nhttps:\/\/github\.com\/o\/r\/issues\/7/);
  assert.match(md, /\*\*Free to work on\*\*/);
  assert.match(md, /## Files it needs\n- src\/launch\/timer\.ts \(named in the issue\)/);
  assert.match(md, /- @ada — code owner of src\/launch\/timer\.ts/);
  assert.match(md, /## Set up\n```bash\ngit clone https:\/\/github\.com\/YOUR-USERNAME\/r\.git && cd r\ngit checkout -b issue\/7-countdown-drifts-windows\n```/);
  assert.match(md, /## Before you push\n```bash\nnpm test\n```/);
  assert.match(md, /## Open the PR[\s\S]*\*\*Title:\*\* Countdown drifts on Windows/);
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

test("the brief shows availability, likely files, code owners and the steps from clone to PR for 3 API requests — and no AI", async () => {
  const { gh, panel, aiCalls } = briefPanel({ comments: [comment("bob", "MEMBER", "Timer bug, see tick()", 2)] });
  await panel.fn.showIssueBrief({ ...baseIssue, title: "Timer drifts during launch countdown" });

  const body = panel.el("brief-body").innerHTML;
  assert.match(body, /class="verdict verdict-free"[\s\S]*<strong>Free to work on<\/strong>[\s\S]*class="verdict-next"[\s\S]*Comment that you'd like to take it/);
  assert.match(body, /Where to start[\s\S]*Nothing in the issue or its PRs points at a file yet[\s\S]*<details class="file-guesses" open>[\s\S]*href="https:\/\/github\.com\/o\/r\/blob\/HEAD\/src\/launch\/timer\.ts"[^>]*title="src\/launch\/timer\.ts"><code>timer\.ts<\/code>[\s\S]*name matches the issue/, "only guesses → shown open, labelled as guesses; one line, the path on hover");
  assert.match(body, /<details class="flow-step">\s*<summary class="flow-label"><span class="flow-num">1<\/span>Set up<span class="flow-sum">3 commands<\/span>/, "steps fold to a one-line summary");
  assert.match(body, /From clone to pull request[\s\S]*Set up[\s\S]*npm ci[\s\S]*Before you push[\s\S]*npm test[\s\S]*Open the PR/);
  assert.match(body, /What CI runs · from <code>\.github\/workflows\/test\.yml<\/code>/);
  const people = panel.el("brief-people").innerHTML;
  assert.match(people, /class="person-chip" href="https:\/\/github\.com\/ada"[^>]*title="@ada\nCode owner · timer\.ts[\s\S]*<span class="person-chip-name">ada<\/span><span class="person-chip-why">owner<\/span>/);
  assert.match(people, /<span class="person-chip-name">bob<\/span><span class="person-chip-why">replied 1×<\/span>/);
  assert.equal(aiCalls(), 0, "briefs never call the AI");

  const issueCalls = gh.apiCalls.filter(u => u.startsWith("/issues/7/"));
  assert.deepEqual(issueCalls.sort(), ["/issues/7/comments?per_page=100", "/issues/7/timeline?per_page=100"]);
  // + recent merged PRs (for title conventions; shared with the health score), repo metadata and tree (shared with other tabs)
  assert.ok(gh.apiCalls.includes("/pulls?state=closed&sort=updated&direction=desc&per_page=50"));
  assert.ok(gh.apiCalls.length <= 5, `API calls: ${gh.apiCalls.join(", ")}`);
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

test("an issue with an open PR says so, with the PR", async () => {
  const { panel } = briefPanel({ ai: false, timeline: [prRef(42, "open", false, "grace")] });
  await panel.fn.showIssueBrief(baseIssue);
  assert.match(panel.el("brief-body").innerHTML, /verdict-maybe[\s\S]*Has an open PR[\s\S]*class="verdict-why">[\s\S]*Open PR #42 by @grace[\s\S]*Review or help on #42/);
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

// ── Staying current ──────────────────────────────────────────────────────────
test("a brief built before a PR was linked catches up when the issue's page is opened, or on Refresh", async () => {
  let timeline = [];
  let conditional = 0;
  const etagFor = () => `W/"${timeline.length}"`;
  const gh = githubMock({
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE,
    "/issues/7": { ...baseIssue },
    "/issues/7/comments?per_page=100": [],
    "/issues/7/timeline?per_page=100": (url, init) => {
      if (init.headers?.["If-None-Match"]) conditional++;
      if (init.headers?.["If-None-Match"] === etagFor()) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(timeline), { headers: { ETag: etagFor(), "X-RateLimit-Remaining": "4999", "X-RateLimit-Limit": "5000", "X-RateLimit-Reset": "9999999999" } });
    },
  }, { raw: RAW });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();

  await panel.fn.showIssueBrief(baseIssue);
  assert.match(panel.el("brief-body").innerHTML, /Free to work on/);

  timeline = [prRef(29573, "open", false, "feiiiiii5")]; // linked a minute later
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief(baseIssue);
  assert.match(panel.el("brief-body").innerHTML, /Free to work on/, "reopened from the list within 10 minutes: the saved brief, no requests");

  await panel.fn.showIssueBrief(7, { auto: true }); // the user opens the issue on GitHub
  assert.match(panel.el("brief-body").innerHTML, /Has an open PR[\s\S]*Open PR #29573 by @feiiiiii5/);
  assert.ok(conditional >= 1, "re-checked with the saved ETag");

  timeline = [];
  panel.fn.refreshBrief();
  await tick(20);
  assert.match(panel.el("brief-body").innerHTML, /Free to work on/, "Refresh checks again");
});

test("a saved brief older than 10 minutes is rebuilt", async () => {
  const { gh, panel } = briefPanel();
  await panel.fn.showIssueBrief(baseIssue);
  const calls = gh.apiCalls.length;
  panel.run(`cacheFor(repoKey()).briefs[7].loadedAt -= 11 * 60 * 1000`);
  panel.fn.closeIssueBrief();
  await panel.fn.showIssueBrief(baseIssue);
  assert.ok(panel.run("cacheFor(repoKey()).briefs[7].loadedAt") > Date.now() - 5000, "rebuilt");
  assert.ok(gh.apiCalls.length >= calls, "served by the GitHub layer: re-checked only if its copy is stale too");
});
