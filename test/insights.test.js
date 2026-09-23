// insights.js: maintainers, response times, PR stats, health scoring
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");

const { parseCodeOwners, activeMaintainers, responseStats, prStats, scoreHealth, beginnerSearchQuery, median, isBot } = loadPanel().fn;

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-23T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const user = (login, type = "User") => ({ login, type, avatar_url: `https://avatars/${login}`, html_url: `https://github.com/${login}` });
const comment = (login, assoc, issue, daysAgo, type) => ({
  user: user(login, type), author_association: assoc, created_at: iso(daysAgo),
  issue_url: `https://api.github.com/repos/o/r/issues/${issue}`,
});

test("median handles odd, even and empty inputs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test("isBot recognises bot accounts by type and common names", () => {
  for (const u of [user("x", "Bot"), user("dependabot[bot]"), user("renovate-bot"), user("github-actions")]) assert.ok(isBot(u), u.login);
  assert.ok(!isBot(user("robotics-fan")));
});

test("parseCodeOwners reads patterns, users and teams; skips comments and emails", () => {
  const rules = parseCodeOwners("# owners\n*       @alice\n/docs/  @bob @org/docs-team   # inline\nsrc/api/** dev@example.com @carol\n\n");
  assert.deepEqual(plain(rules), [
    { pattern: "*", owners: ["@alice"] },
    { pattern: "/docs/", owners: ["@bob", "@org/docs-team"] },
    { pattern: "src/api/**", owners: ["@carol"] },
  ]);
});

test("activeMaintainers counts only maintainer-role, non-bot replies and ranks by threads", () => {
  const comments = [
    comment("alice", "MEMBER", 1, 1), comment("alice", "MEMBER", 2, 3), comment("alice", "MEMBER", 2, 4),
    comment("bob", "COLLABORATOR", 3, 10),
    comment("owner", "OWNER", 4, 20),
    comment("random", "NONE", 1, 1), comment("contrib", "CONTRIBUTOR", 1, 1),
    comment("dependabot[bot]", "MEMBER", 5, 1, "Bot"),
  ];
  const { people } = activeMaintainers(comments);
  assert.deepEqual(people.map(p => p.login), ["alice", "bob", "owner"]);
  assert.equal(people[0].threads, 2);
  assert.equal(people[0].replies, 3);
  assert.equal(people[0].lastActive, iso(1));
  assert.equal(people[0].role, "MEMBER");
});

test("activeMaintainers merges CODEOWNERS users and lists teams separately", () => {
  const { people, teams } = activeMaintainers([comment("bob", "COLLABORATOR", 3, 10)], parseCodeOwners("/docs/ @bob @org/docs\nsrc/ @zed"));
  assert.deepEqual(people.map(p => p.login), ["bob", "zed"]);
  assert.ok(people[0].codeOwner);
  assert.deepEqual(plain(people[0].owns), ["/docs/"]);
  assert.equal(people[1].threads, 0);
  assert.match(people[1].avatar_url, /github\.com\/zed\.png/);
  assert.deepEqual(plain(teams), ["@org/docs"]);
});

test("responseStats: first maintainer reply or close; skips maintainer-authored, bots, too-new, out-of-sample", () => {
  const item = (number, daysAgo, extra = {}) => ({ number, created_at: iso(daysAgo), user: user("u" + number), author_association: "NONE", closed_at: null, ...extra });
  const recent = [
    item(1, 10), item(2, 10), item(3, 10), item(4, 10),
    item(5, 10, { closed_at: iso(9.5) }),                 // closed after 12h — counts as a response
    item(6, 10, { author_association: "MEMBER" }),        // maintainer-authored
    item(7, 1),                                           // under 2 days old
    item(8, 60),                                          // before the comment sample starts
    item(9, 10, { user: user("renovate[bot]", "Bot") }),  // bot
  ];
  const comments = [
    comment("alice", "MEMBER", 1, 10 - 2 / 24),  // 2h
    comment("alice", "MEMBER", 2, 9),            // 24h
    comment("rando", "NONE", 3, 9.9),            // not a maintainer
    comment("bob", "COLLABORATOR", 4, 8),        // 48h
  ];
  const r = responseStats(recent, comments, iso(30), NOW);
  assert.equal(r.sample, 5);
  assert.equal(r.answered, 4);
  assert.equal(r.rate, 0.8);
  assert.equal(Math.round(r.medianHours), 18); // median of 2, 12, 24, 48
});

test("responseStats reports 'not enough data' under 5 items", () => {
  const r = responseStats([{ number: 1, created_at: iso(10), user: user("a"), author_association: "NONE" }], [], iso(30), NOW);
  assert.equal(r.rate, null);
});

test("responseStats uses the oldest fetched comment as coverage when the sample was capped", () => {
  const items = [1, 2, 3, 4, 5].map(n => ({ number: n, created_at: iso(20), user: user("u"), author_association: "NONE" }));
  const comments = [comment("alice", "MEMBER", 99, 5)]; // sample only reaches back 5 days
  const r = responseStats(items, comments, null, NOW);
  assert.equal(r.sample, 0, "issues older than the sample can't be judged");
});

test("prStats: medians, outside share and acceptance; bots excluded", () => {
  const pr = (assoc, created, merged, login = "u") => ({ user: user(login), author_association: assoc, created_at: iso(created), merged_at: merged === null ? null : iso(merged) });
  const p = prStats([
    pr("MEMBER", 10, 9), pr("MEMBER", 10, 8),
    pr("CONTRIBUTOR", 10, 7), pr("FIRST_TIME_CONTRIBUTOR", 10, null), pr("NONE", 10, null),
    { ...pr("NONE", 10, 9.9), user: user("dependabot[bot]", "Bot") },
  ]);
  assert.deepEqual(plain(p), {
    sample: 5, merged: 3, medianMergeDays: 2,
    outsideClosed: 3, outsideMerged: 1, outsideAcceptance: 1 / 3, outsideShare: 1 / 3,
  });
});

const healthyDocs = { contributing: true, issueTemplates: true, prTemplate: true, codeOfConduct: true };

test("scoreHealth: a healthy repo scores 100 with every signal measured", () => {
  const s = scoreHealth({
    now: NOW, repoData: { pushed_at: iso(2) }, docs: healthyDocs, beginnerIssues: 3,
    response: { sample: 20, answered: 18, rate: 0.9, medianHours: 10 },
    prs: { sample: 30, merged: 20, medianMergeDays: 1, outsideClosed: 12, outsideMerged: 9, outsideAcceptance: 0.75, outsideShare: 0.45 },
  });
  assert.equal(s.score, 100);
  assert.equal(s.measured, 5);
  assert.ok(s.factors.every(f => f.detail));
});

test("scoreHealth leaves unmeasured signals out instead of scoring them as zero", () => {
  const s = scoreHealth({ now: NOW, repoData: { pushed_at: iso(2) }, docs: healthyDocs, beginnerIssues: 3, response: { sample: 2, rate: null }, prs: null });
  assert.equal(s.measured, 2);
  assert.equal(s.score, 100);
  for (const key of ["response", "outside", "merge"]) assert.equal(s.factors.find(f => f.key === key).points, null, key);
});

test("scoreHealth: a slow, closed-off, stale repo scores 0; archived repos are capped at 20", () => {
  const bad = {
    now: NOW, repoData: { pushed_at: iso(400) }, beginnerIssues: 0,
    docs: { contributing: false, issueTemplates: false, prTemplate: false, codeOfConduct: false },
    response: { sample: 20, answered: 3, rate: 0.15, medianHours: 900 },
    prs: { sample: 20, merged: 10, medianMergeDays: 60, outsideClosed: 8, outsideMerged: 0, outsideAcceptance: 0, outsideShare: 0 },
  };
  assert.equal(scoreHealth(bad).score, 0);
  const archived = { ...bad, repoData: { pushed_at: iso(1), archived: true }, response: { sample: 20, rate: 1, medianHours: 1 } };
  assert.ok(scoreHealth(archived).score <= 20);
});

test("scoreHealth onboarding only weighs the items it could check", () => {
  const s = scoreHealth({ now: NOW, docs: { contributing: true, issueTemplates: null, prTemplate: false, codeOfConduct: false }, beginnerIssues: null });
  const onboarding = s.factors.find(f => f.key === "onboarding");
  assert.equal(onboarding.points, Math.round((5 / 8) * 15)); // CONTRIBUTING 5 of (5 + 2 + 1) checkable
  assert.match(onboarding.detail, /Missing: PR template, code of conduct/);
});

test("beginnerSearchQuery ORs the repo's real labels; unclaimed adds no:assignee -linked:pr", () => {
  const repo = { owner: "o", repo: "r" };
  assert.equal(beginnerSearchQuery(repo, ["good first issue", 'E-"easy"'], { unclaimed: true }),
    'repo:o/r is:issue is:open label:"good first issue","E-easy" no:assignee -linked:pr');
  assert.ok(!beginnerSearchQuery(repo, ["x"], { unclaimed: false }).includes("no:assignee"));
});
