// The Ask tab: starters shaped by the repo, the model in the header, Stop, errors that can be retried
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, tick, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const repo = { owner: "o", repo: "rocket" };
const PATHS = [
  "README.md", "package.json",
  "packages/core/src/engine.ts", "packages/core/src/fuel.ts", "packages/core/src/orbit.ts",
  "packages/cli/src/index.ts", "packages/cli/src/args.ts",
  "packages/core/test/engine.test.ts", "docs/guide.md",
];
const issue = (number, extra = {}) => ({ number, title: `Issue ${number}`, state: "open", labels: [], assignees: [], ...extra });

// ── Starters ─────────────────────────────────────────────────────────────────
test("starters are shaped by the repo: a free newcomer issue, its biggest area, its entry point", () => {
  const starters = plain(pure.repoStarters({ repo, paths: PATHS, issues: [
    issue(1, { assignees: [{ login: "ada" }] }), issue(2), issue(3, { labels: [{ name: "good first issue" }] }),
  ] }));
  assert.deepEqual(starters.map(s => s.label), [
    "What does rocket do?", "Where do I start on #3?", "How does packages/core work?", "What happens in index.ts?", "How do I set it up locally?",
  ]);
  assert.equal(starters[1].issue, 3, "a newcomer label beats the first unassigned issue; assigned ones never show");
  assert.match(starters[2].q, /packages\/core\/ is organised/);
  assert.match(starters[3].q, /Walk me through packages\/cli\/src\/index\.ts/, "the question names the file, so it's read directly");
});

test("with nothing loaded yet, starters still make sense", () => {
  const starters = plain(pure.repoStarters({ repo, paths: [], issues: [] }));
  assert.deepEqual(starters.map(s => s.label), ["What does rocket do?", "How do I set it up locally?"]);
  const withTests = plain(pure.repoStarters({ repo, paths: ["lib.py", "tests/test_lib.py"], issues: [] }));
  assert.ok(withTests.some(s => s.label === "How are tests written here?"));
});

// ── Panel ────────────────────────────────────────────────────────────────────
const TREE = { tree: PATHS.map(p => ({ path: p, type: "blob", size: 200 })) };
const RAW = Object.fromEntries(PATHS.map(p => [p, `// ${p}\nexport const x = 1;\n`]));

function askPanel({ ai, configured = true } = {}) {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE }, { raw: RAW, ai });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = ${configured ? '"gsk_test"' : '""'}; chatMessages = []`);
  return panel;
}

// An answer that streams `first`, then waits until it's stopped
function stalledReply(first) {
  return async (url, init) => new Response(new ReadableStream({
    start(ctrl) {
      if (first) ctrl.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`));
      init.signal.addEventListener("abort", () => ctrl.error(new DOMException("Aborted", "AbortError")));
    },
  }));
}
const ask = async (panel, q) => { panel.el("chat-input").value = q; return panel.fn.handleChat({ files: ["README.md"] }); };

test("the empty chat shows the repo's own starters, or a way to set up an AI provider", async () => {
  const panel = askPanel();
  panel.run(`issueIndex.set(9, ${JSON.stringify(issue(9, { labels: [{ name: "help wanted" }] }))})`);
  panel.fn.renderChatStarters();
  await tick(20);
  const html = panel.el("chat-starters").innerHTML;
  assert.match(html, /Ask about r</);
  assert.match(html, /class="starter-chip starter-issue" data-issue="9"[\s\S]*Where do I start on #9\?/);
  assert.match(html, /data-q="Explain how packages\/core\/ is organised/, "redrawn once the file tree arrives");

  const none = askPanel({ configured: false });
  none.fn.renderChatStarters();
  assert.match(none.el("chat-starters").innerHTML, /chat-setup-btn">Set up an AI provider/);
  assert.doesNotMatch(none.el("chat-starters").innerHTML, /starter-chip/);
});

test("the header names the model in use and offers Clear only when there's something to clear", () => {
  const panel = askPanel();
  panel.fn.renderChatHeader();
  assert.match(panel.el("chat-model").innerHTML, /chat-model-dot"><\/span>Groq · /);
  assert.equal(panel.el("clear-chat-btn").hidden, true);
  panel.run(`chatMessages = [{ role: "user", text: "hi" }]`);
  panel.fn.renderChatHeader();
  assert.equal(panel.el("clear-chat-btn").hidden, false);
  panel.run(`aiApiKey = ""`);
  panel.fn.renderChatHeader();
  assert.match(panel.el("chat-model").innerHTML, /No AI provider · set one up/);
});

test("Stop mid-answer keeps what arrived, marked as stopped; Send comes back", async () => {
  const panel = askPanel({ ai: stalledReply("The engine burns fuel") });
  const pending = ask(panel, "How does the engine work?");
  await tick(30);
  assert.equal(panel.el("stop-btn").hidden, false, "Stop replaces Send while answering");
  assert.equal(panel.el("send-btn").hidden, true);
  panel.fn.stopAnswer();
  await pending;
  const last = plain(panel.run("chatMessages")).at(-1);
  assert.equal(last.role, "bot");
  assert.equal(last.text, "The engine burns fuel");
  assert.equal(last.ending, "stopped");
  assert.equal(panel.el("stop-btn").hidden, true);
  assert.equal(panel.el("send-btn").hidden, false);
  assert.equal(panel.run("activeReply"), null);
});

test("Stop before a word arrives puts the question back in the box and drops it from the chat", async () => {
  const panel = askPanel({ ai: stalledReply("") });
  const pending = ask(panel, "Where is fuel measured?");
  await tick(30);
  panel.fn.stopAnswer();
  await pending;
  assert.equal(panel.el("chat-input").value, "Where is fuel measured?");
  assert.deepEqual(plain(panel.run("chatMessages")), []);
});

test("a failed answer is saved as an error that can be retried, and progress shows the step", async () => {
  const panel = askPanel({ ai: async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 }) });
  await ask(panel, "How does orbit work?");
  const last = plain(panel.run("chatMessages")).at(-1);
  assert.equal(last.error, true);
  assert.match(last.text, /Groq 500: boom/);
  assert.equal(panel.el("typing-stage").textContent, "Writing", "it got as far as writing");
  assert.equal(panel.el("send-btn").disabled, false);
});

test("only one answer at a time: a second send while one is on its way is ignored", async () => {
  let calls = 0;
  const panel = askPanel({ ai: async (url, init) => { calls++; return stalledReply("…")(url, init); } });
  const first = ask(panel, "one");
  await tick(30);
  await ask(panel, "two");
  assert.equal(calls, 1);
  panel.fn.stopAnswer();
  await first;
  assert.equal(plain(panel.run("chatMessages")).filter(m => m.role === "user").length, 1);
});
