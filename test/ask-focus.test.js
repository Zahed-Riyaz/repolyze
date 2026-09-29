// ask-focus.js: every AI task runs in Ask; briefs hand off with the item in focus
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const DAY = 86_400_000;
const iso = (d) => new Date(Date.now() - d * DAY).toISOString();
const user = (login) => ({ login, type: "User", avatar_url: "https://avatars.githubusercontent.com/u/1?v=4", html_url: `https://github.com/${login}` });
const issue = { number: 7, title: "Countdown drifts on Windows", body: "The launch timer drifts.", labels: [], comments: 1, user: user("reporter"),
  html_url: "https://github.com/o/r/issues/7", created_at: iso(5), assignees: [] };
const pr = {
  number: 42, title: "Fix timer drift", state: "open", draft: false, user: user("dev"), html_url: "https://github.com/o/r/pull/42",
  created_at: iso(3), updated_at: iso(1), body: "Fixes #7. Uses timestamps.", head: { sha: "abc123", ref: "fix", label: "dev:fix", repo: { full_name: "dev/r" } },
  base: { ref: "main" }, additions: 3, deletions: 1, changed_files: 1, commits: 1, requested_reviewers: [], requested_teams: [],
};

const ROUTES = {
  "": { default_branch: "main" },
  "/git/trees/HEAD?recursive=1": { tree: ["README.md", "src/launch/timer.ts", "src/new-clock.ts"].map(p => ({ path: p, type: "blob", size: 200 })) },
  "/issues/7/comments?per_page=100": [{ user: user("ada"), author_association: "MEMBER", body: "Probably tick()", created_at: iso(2) }],
  "/issues/7/timeline?per_page=100": [],
  "/pulls/42": pr,
  "/issues/42/timeline?per_page=100": [{ event: "reviewed", user: user("ada"), state: "changes_requested", submitted_at: iso(2), body: "Use a monotonic clock" }],
  "/pulls/42/comments?per_page=100": [],
  "/pulls/42/files?per_page=100": [{ filename: "src/launch/timer.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1,2 +1,3 @@\n export class Timer {\n-  tick() {}\n+  tick() { return now(); }\n+  now() {}" }],
  "/commits/abc123/check-runs?per_page=100": { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] },
};
const RAW = { "README.md": "# Rocket", "src/launch/timer.ts": "export class Timer {\n  tick() { /* drift */ }\n}" };

// The file picker gets JSON; real questions get an answer that cites code
function setup() {
  const requests = [];
  const gh = githubMock(ROUTES, {
    raw: RAW,
    ai: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return /expert on the GitHub repository/.test(body.messages[0].content)
        ? sseReply("It's `tick()` in `src/launch/timer.ts:2`.")
        : sseReply('["src/launch/timer.ts"]');
    },
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"; chatMessages = [];`);
  const answers = () => requests.filter(b => /expert on the GitHub repository/.test(b.messages[0].content));
  const saved = () => plain(panel.chrome.storage.local.data["chat_o_r"] || []);
  const chip = (kind, index) => ({ target: { closest: (sel) => (sel === ".ask-chip" ? { dataset: { kind, ...(index === undefined ? {} : { ask: String(index) }) } } : null) }, preventDefault() {} });
  return { panel, requests, answers, saved, chip };
}

test("an issue suggestion opens Ask focused on the issue and answers from the issue plus its code", async () => {
  const { panel, answers, saved } = setup();
  await panel.fn.showIssueBrief(issue);
  await panel.fn.askAboutBrief("issue", 0);

  assert.equal(panel.run("lastContentTab"), "chat");
  assert.equal(panel.el("chat-focus").hidden, false);
  assert.match(panel.el("chat-focus").innerHTML, /About <strong>#7<\/strong> Countdown drifts on Windows/);
  assert.equal(panel.el("chat-input").placeholder, "Ask about #7…");

  const [req] = answers();
  assert.match(req.messages[0].content, /asking about issue #7 \("Countdown drifts on Windows"\)/);
  const userMsg = req.messages.at(-1).content;
  assert.match(userMsg, /<issue number="7">[\s\S]*The launch timer drifts\.[\s\S]*@ada \(member\): Probably tick\(\)/);
  assert.match(userMsg, /=== src\/launch\/timer\.ts/, "the code the question points at is read");
  assert.match(userMsg, /Question: Summarise issue #7 in two sentences/);
  assert.match(req.messages[0].content, /Make it actionable\.[\s\S]*which file and function to open[\s\S]*Don't use buzzwords or filler/, "every Ask answer gets the plain-language rules");

  const [q, a] = saved();
  assert.deepEqual(q.focus, { kind: "issue", number: 7 });
  assert.match(q.text, /^Summarise issue #7/, "the suggestion is sent as a visible question");
  assert.deepEqual(a.focus, { kind: "issue", number: 7 });
  assert.deepEqual(a.sources.map(s => s.path), ["src/launch/timer.ts"]);
});

test("a PR question reads its discussion, diff and changed files at its head, citing each where it lives", async () => {
  const { panel, requests, saved } = setup();
  await panel.fn.showPrBrief(42);
  await panel.fn.askAboutBrief("pr", 1);
  assert.equal(requests.length, 1, "no file picking for PRs: the PR and what it touches are the context");
  const userMsg = requests[0].messages.at(-1).content;
  assert.match(userMsg, /<pull_request number="42">[\s\S]*Closes: #7[\s\S]*Checks: 0 passed, 1 failed \(test\)/);
  assert.match(userMsg, /<activity>[\s\S]*requested changes: Use a monotonic clock[\s\S]*<diff>[\s\S]*2\+\|   tick\(\) \{ return now\(\); \}/);
  assert.match(userMsg, /<changed_files_at_head>\n=== src\/launch\/timer\.ts \(lines 1-3\) ===/, "the changed file, read at the PR's head");
  assert.match(requests[0].messages[0].content, /asking about pull request #42[\s\S]*<changed_files_at_head>[\s\S]*<related_code>/);
  const a = saved()[1];
  assert.equal(a.cite, undefined, "each source says where it lives instead");
  assert.ok(a.sources.some(s => s.path === "src/launch/timer.ts" && s.via === "changed" && s.at.owner === "dev" && s.at.ref === "abc123"));
  assert.match(panel.fn.linkifyCitations(panel.fn.renderMarkdown(a.text), { owner: "o", repo: "r" }, a.ref, a.sources),
    /href="https:\/\/github\.com\/dev\/r\/blob\/abc123\/src\/launch\/timer\.ts#L2"/, "changed code links to the fork's head commit");
});

test("'Your own question' focuses Ask without sending anything", async () => {
  const { panel, requests, chip } = setup();
  await panel.fn.showIssueBrief(issue);
  panel.fn.handleBriefClick(chip("issue"));
  assert.equal(panel.run("lastContentTab"), "chat");
  assert.equal(panel.el("chat-input").value, "");
  assert.equal(panel.el("chat-focus").hidden, false);
  assert.equal(requests.length, 0);
});

test("a suggestion never interrupts a reply that's still streaming — it waits in the input", async () => {
  const { panel, requests } = setup();
  await panel.fn.showIssueBrief(issue);
  panel.el("send-btn").disabled = true;
  await panel.fn.askAboutBrief("issue", 1);
  assert.match(panel.el("chat-input").value, /^Where in the code should I start on issue #7\?/);
  assert.equal(requests.length, 0);
});

test("removing the chip goes back to repo-wide questions; a new repo drops the focus", async () => {
  const { panel, answers } = setup();
  await panel.fn.showIssueBrief(issue);
  await panel.fn.askAboutBrief("issue", 1);
  panel.fn.setChatFocus(null); // the chip's ✕
  assert.equal(panel.el("chat-focus").hidden, true);
  assert.equal(panel.el("chat-input").placeholder, "Ask about this repo…");

  panel.el("chat-input").value = "What does this repo do?";
  await panel.fn.handleChat();
  const last = answers().at(-1);
  assert.doesNotMatch(last.messages[0].content, /asking about issue/);
  assert.doesNotMatch(last.messages.at(-1).content, /<issue number=/);

  panel.fn.setChatFocus({ kind: "issue", number: 7, key: "o/r", title: "x" });
  panel.setRepo("other", "repo");
  panel.fn.renderChatFocus();
  assert.equal(panel.el("chat-focus").hidden, true, "the focus belongs to the repo it was set on");
});

test("follow-ups about the same issue keep its files; a PR's files don't leak into repo-wide questions", async () => {
  const { panel, answers, requests } = setup();
  await panel.fn.showIssueBrief(issue);
  await panel.fn.askAboutBrief("issue", 1);
  panel.el("chat-input").value = "And how is it called?";
  await panel.fn.handleChat();
  assert.match(answers().at(-1).messages.at(-1).content, /=== src\/launch\/timer\.ts/);

  await panel.fn.showPrBrief(42);
  await panel.fn.askAboutBrief("pr", 0);
  panel.fn.setChatFocus(null);
  const before = requests.length;
  panel.el("chat-input").value = "Tell me about the README";
  await panel.fn.handleChat();
  assert.ok(requests.length > before);
  assert.deepEqual(plain(panel.run("chatMessages")).at(-1).focus, undefined);
});
