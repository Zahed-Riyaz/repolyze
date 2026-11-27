// ask-focus.js: every AI task runs in Ask; briefs hand off with the item in focus
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain, tick } = require("./helpers/panel");
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

// ── Explain this map ─────────────────────────────────────────────────────────
const MAP_RAW = {
  "package.json": '{"main":"src/index.ts"}',
  "src/index.ts": 'import "./app";\nimport "./db";\nexport const start = 1;',
  "src/app.ts": 'import "./db";\nexport const app = "APP_BODY";',
  "src/db.ts": 'export const db = "DB_BODY";',
  "README.md": "# Rocket",
};
function mapSetup(reply, { configured = true } = {}) {
  const requests = [];
  const gh = githubMock({
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": { sha: "t1", tree: Object.keys(MAP_RAW).map(p => ({ path: p, type: "blob", size: MAP_RAW[p].length })) },
  }, { raw: MAP_RAW, ai: async (_u, init) => { requests.push(JSON.parse(init.body)); return sseReply(reply); } });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = ${configured ? '"gsk_test"' : '""'}; chatMessages = [];`);
  // The fake DOM drops appended nodes, so record the elements the chat creates
  const made = [];
  const doc = panel.run("document"), create = doc.createElement;
  doc.createElement = (...a) => { const e = create(...a); made.push(e); return e; };
  panel.bubbles = () => made.map(e => e.innerHTML || e.textContent || "").join("\n");
  const click = (sel, dataset = {}) => panel.fn.handleMapClick({ target: { closest: (s) => (s === sel ? { dataset } : null) }, preventDefault() {} });
  return { panel, requests, gh, click, saved: () => plain(panel.chrome.storage.local.data["chat_o_r"] || []) };
}
const mapText = (panel) => panel.bubbles().replace(/<[^>]*>/g, "");

test("Explain this map sends one visible question grounded in the map", async () => {
  const { panel, requests, click, saved } = mapSetup("It starts in `src/index.ts:3`.");
  await panel.fn.fetchRepoTab();
  assert.equal(requests.length, 0, "no AI call before the click");
  await click("#map-explain");
  assert.equal(requests.length, 1);
  const user = requests[0].messages.at(-1).content;
  assert.match(user, /<repo_map>[\s\S]*src\/index\.ts/);
  assert.match(user, /APP_BODY/);
  assert.match(user, /DB_BODY/);
  assert.match(requests[0].messages[0].content, /fenced block tagged roles/);
  assert.equal(panel.run("lastContentTab"), "chat");
  assert.match(panel.el("chat-focus").innerHTML.replace(/<[^>]*>/g, ""), /About the repo map/);
  assert.match(panel.el("chat-focus").innerHTML, /#i-layers/);
  const [q, a] = saved();
  assert.equal(q.text, "Explain how this repo is organised and how it runs.");
  assert.match(user, /Question: Explain how this repo is organised and how it runs\.$/);
  assert.deepEqual(q.focus, { kind: "map" });
  assert.deepEqual(a.focus, { kind: "map" });
  assert.ok(a.sources.some(s => s.path === "src/index.ts"));
});

test("roles from the answer are saved with the map (the map tab redraws from storage) and the roles block is hidden", async () => {
  const { panel, click } = mapSetup("```roles\nsrc — the app code\n```\nIt starts in `src/index.ts:1`.");
  await panel.fn.fetchRepoTab();
  await click("#map-explain");
  assert.doesNotMatch(panel.bubbles(), /roles/);
  assert.match(mapText(panel), /It starts in/);
  assert.equal(panel.run('cacheFor("o/r").map.roles.src'), "the app code");
  assert.equal(panel.chrome.storage.local.data["map_o_r"].roles.src, "the app code");
});

test("an answer without roles, or with a malformed block, leaves the map as it was", async () => {
  for (const reply of ["It starts in `src/index.ts:1`.", "```roles\nnonsense\n```\nStarts in `src/index.ts:1`.", "```roles\nsrc — never closed"]) {
    const { panel, click } = mapSetup(reply);
    await panel.fn.fetchRepoTab();
    const before = panel.el("repo-map").innerHTML;
    await click("#map-explain");
    assert.equal(panel.el("repo-map").innerHTML, before);
    assert.equal(panel.run('cacheFor("o/r").map.roles'), undefined);
    assert.doesNotMatch(panel.bubbles(), /chat-msg-error|Error:/);
    assert.ok(mapText(panel).length > 0);
  }
});

test("the map tab's Explain button runs Explain in the panel for the panel's repo", async () => {
  const { panel, requests } = mapSetup("```roles\nsrc/db.ts — talks to the database\n```\nok");
  await panel.fn.fetchRepoTab();
  panel.fn.handleMapTabMessage({ type: "map-explain", repo: "x/y" });
  await tick(20);
  assert.equal(requests.length, 0, "another repo's map: nothing");
  panel.fn.handleMapTabMessage({ type: "map-explain", repo: "o/r" });
  await tick(50);
  assert.equal(requests.length, 1);
  assert.equal(panel.chrome.storage.local.data["map_o_r"].roles["src/db.ts"], "talks to the database");
});

test("Re-run with these files on a map answer reads exactly those files, with chips while reading", async () => {
  const { panel, requests, click } = mapSetup("It starts in `src/db.ts:1`.");
  await panel.fn.fetchRepoTab();
  await click("#map-explain");
  assert.match(requests[0].messages.at(-1).content, /APP_BODY/, "first answer: the reading path");
  const chips = [];
  const el = panel.el("typing-files");
  Object.defineProperty(el, "innerHTML", { get: () => chips.at(-1) || "", set: (v) => chips.push(v), configurable: true });
  panel.el("chat-input").value = "Explain how this repo is organised and how it runs.";
  await panel.fn.handleChat({ files: ["src/db.ts"] });
  assert.equal(requests.length, 2);
  const user = requests[1].messages.at(-1).content;
  assert.match(user, /DB_BODY/);
  assert.doesNotMatch(user, /APP_BODY/, "the reading path's other files are not read");
  assert.ok(chips.some(h => /source-chip[^>]*title="src\/db\.ts — chosen by you"/.test(h)), "chips while reading");
  const a = panel.run("chatMessages").at(-1);
  assert.deepEqual([...new Set(a.sources.map(s => s.path))], ["src/db.ts"]);
});

test("Copy on a map answer leaves out the hidden roles block", async () => {
  const { panel, click } = mapSetup("```roles\nsrc — the app code\n```\nIt starts in `src/index.ts:1`.");
  await panel.fn.fetchRepoTab();
  await click("#map-explain");
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
  const made = [];
  const doc = panel.run("document"), create = doc.createElement;
  doc.createElement = (...x) => { const e = create(...x); made.push(e); return e; };
  const a = panel.run("chatMessages").at(-1);
  panel.fn.appendBotFooter(panel.run("document").createElement("div"), Date.now(), "q", { ...a, text: a.text });
  const copy = made.find(e => /Copy/.test(e.innerHTML));
  copy.dispatch("click");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0], /roles|the app code/);
  assert.match(copied[0], /It starts in/);
});

test("parseAreaRoles reads path — role lines and ignores the rest", () => {
  const pure = loadPanel().fn;
  assert.deepEqual(plain(pure.parseAreaRoles("x\n```roles\nsrc/db — database access\nsrc/ui: the panel\n- `lib` - helpers\nnonsense\nmy-dir\n```")),
    { "src/db": "database access", "src/ui": "the panel", lib: "helpers" });
  assert.deepEqual(plain(pure.parseAreaRoles("no block")), {});
  assert.deepEqual(plain(pure.parseAreaRoles("```roles\nsrc — never closed")), {});
  assert.equal(pure.stripRolesBlock("a\n```roles\nsrc — x\n```\nb").replace(/\s+/g, " "), "a b");
  assert.equal(pure.stripRolesBlock("a\n```roles\nsrc — x").trim(), "a", "an open block is hidden while it streams");
});

test("no AI call without a provider: Explain this map shows the set-up prompt", async () => {
  const { panel, requests, click } = mapSetup("x", { configured: false });
  await panel.fn.fetchRepoTab();
  await click("#map-explain");
  assert.equal(requests.length, 0);
  assert.match(mapText(panel), /Set up an AI provider/);
});

test("Ask about this file clears the map chip and fills @path", async () => {
  const { panel, requests, click } = mapSetup("x");
  await panel.fn.fetchRepoTab();
  panel.fn.setChatFocus({ kind: "map", key: "o/r", title: "the repo map" });
  panel.fn.handleMapTabMessage({ type: "map-ask-file", repo: "o/r", file: "src/db.ts" }); // from the map tab
  assert.equal(panel.el("chat-focus").hidden, true);
  assert.equal(panel.el("chat-input").value, "@src/db.ts ");
  assert.equal(panel.run("lastContentTab"), "chat");
  assert.equal(requests.length, 0);
});
