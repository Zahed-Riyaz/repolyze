// retrieval.js: ranking files, picking, snippets, context packing, chat context
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply, json } = require("./helpers/github-mock");

const pure = loadPanel().fn;

// ── Pure helpers ─────────────────────────────────────────────────────────────
test("queryTerms keeps identifiers whole and split; drops plain stopwords; stems plurals", () => {
  assert.deepEqual(plain(pure.queryTerms("How does handleRepoRefresh parse the URLs?")),
    ["handlereporefresh", "handle", "repo", "refresh", "parse", "url"]);
  assert.deepEqual(plain(pure.queryTerms("load_repo_data")), ["loadrepodata", "load", "repo", "data"]);
  assert.deepEqual(plain(pure.queryTerms("what does the repo do")), []);
});

test("rankCodeFiles: file-name hits first; tests demoted; vendor, lockfiles, huge files excluded", () => {
  const entries = [
    { path: "src/auth/session.ts", type: "blob", size: 900 },
    { path: "src/auth.ts", type: "blob", size: 900 },
    { path: "tests/auth.test.ts", type: "blob", size: 900 },
    { path: "node_modules/auth/index.js", type: "blob", size: 900 },
    { path: "package-lock.json", type: "blob", size: 900 },
    { path: "src/huge_auth.js", type: "blob", size: 5_000_000 },
    { path: "src/billing.ts", type: "blob", size: 900 },
    { path: "src", type: "tree", size: 0 },
  ];
  const ranked = pure.rankCodeFiles(entries, pure.queryTerms("how is the auth session handled"));
  const paths = ranked.map(r => r.path);
  assert.equal(paths[0], "src/auth/session.ts");
  assert.ok(paths.indexOf("src/auth.ts") < paths.indexOf("tests/auth.test.ts"));
  for (const p of ["node_modules/auth/index.js", "package-lock.json", "src/huge_auth.js", "src"]) assert.ok(!paths.includes(p), p);
});

test("parsePickedPaths tolerates fences and chatter, drops unknown paths, caps at 5", () => {
  const valid = new Set(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
  assert.deepEqual(plain(pure.parsePickedPaths('Sure!\n```json\n["b.ts", "nope.ts", "a.ts"]\n```', valid)), ["b.ts", "a.ts"]);
  assert.equal(pure.parsePickedPaths(JSON.stringify([...valid]), valid).length, 5);
  assert.deepEqual(plain(pure.parsePickedPaths("[]", valid)), []);
  assert.equal(pure.parsePickedPaths("I'd read a.ts", valid), null);
});

test("extractSnippets keeps small files whole", () => {
  assert.deepEqual(plain(pure.extractSnippets("a\nb\nc", ["x"], 1000)), [{ start: 1, end: 3 }]);
});

test("extractSnippets keeps the head plus the matching definition, within budget", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} filler text here`);
  lines[250] = "export function refreshToken(session) {";
  lines[252] = "  return session.refresh();";
  const ranges = plain(pure.extractSnippets(lines.join("\n"), pure.queryTerms("refresh token"), 3000));
  assert.equal(ranges[0].start, 1);
  assert.ok(ranges.some(r => r.start <= 251 && r.end >= 253), JSON.stringify(ranges));
  const chars = ranges.reduce((n, r) => n + lines.slice(r.start - 1, r.end).join("\n").length, 0);
  assert.ok(chars <= 3000, `over budget: ${chars}`);
});

test("formatSnippet numbers lines from the range start", () => {
  assert.equal(pure.formatSnippet("src/x.ts", ["a", "b", "c", "d"], { start: 2, end: 3 }), "=== src/x.ts (lines 2-3) ===\n2| b\n3| c");
});

test("packContext orders by priority and trims the last part to fit the budget", () => {
  const out = pure.packContext([
    { label: "Tree", text: "t".repeat(3000), priority: 2 },
    { label: "code.ts (lines 1-9)", text: "c".repeat(2000), priority: 0 },
    { label: "README", text: "r".repeat(2000), priority: 1 },
  ], 5500);
  assert.ok(out.indexOf("code.ts") < out.indexOf("README") && out.indexOf("README") < out.indexOf("Tree"));
  assert.ok(out.length <= 5500, `too long: ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("sourceUrl builds blob links with line anchors", () => {
  const repo = { owner: "o", repo: "r" };
  assert.equal(pure.sourceUrl(repo, "main", "src/a b.ts", 3, 9), "https://github.com/o/r/blob/main/src/a%20b.ts#L3-L9");
  assert.equal(pure.sourceUrl(repo, "release/1.0", "x.ts"), "https://github.com/o/r/blob/release/1.0/x.ts");
});

// ── Against a mocked repo ────────────────────────────────────────────────────
const TREE = {
  tree: [
    "README.md", ".github/CONTRIBUTING.md", "package.json", ".github/workflows/lint.yml", ".github/workflows/test.yml",
    "src", "src/index.ts", "src/launch/sequence.ts", "src/launch/timer.ts", "tests/sequence.spec.ts",
  ].map(p => ({ path: p, type: p.includes(".") ? "blob" : "tree", size: 3000 })),
};
const SEQUENCE = Array.from({ length: 200 }, (_, i) => `// filler ${i + 1}`);
SEQUENCE[0] = "import { Timer } from './timer';";
SEQUENCE[120] = "export async function runLaunchSequence(config) {";
SEQUENCE[121] = "  const timer = new Timer(config.countdown);";
const RAW = {
  "README.md": "# Rocket\nLaunch toolkit.",
  ".github/CONTRIBUTING.md": "Run npm test before opening a PR.",
  "package.json": '{"scripts":{"test":"jest"}}',
  ".github/workflows/test.yml": "jobs:\n  test:\n    steps:\n      - run: npm test",
  "src/launch/sequence.ts": SEQUENCE.join("\n"),
  "src/launch/timer.ts": "export class Timer {}",
};

function repoPanel({ ai, raw = RAW, repoData = { default_branch: "main" }, routes = {} } = {}) {
  const gh = githubMock({ "": repoData, "/git/trees/HEAD?recursive=1": TREE, ...routes }, { raw, ai });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"`);
  return { gh, panel };
}

test("repo context is found through the tree: no 404 probing, CONTRIBUTING in .github, test workflow preferred", async () => {
  const { gh, panel } = repoPanel();
  const ctx = (await panel.fn.getRepoContextParts()).map(p => `=== ${p.label} ===\n${p.text}`).join("\n\n");
  assert.match(ctx, /=== README ===\n# Rocket/);
  assert.match(ctx, /=== CONTRIBUTING ===\nRun npm test/);
  assert.match(ctx, /=== package\.json ===/);
  assert.match(ctx, /=== CI workflow \(\.github\/workflows\/test\.yml\) ===/);
  assert.match(ctx, /=== File tree ===/);
  assert.deepEqual(gh.apiCalls.sort(), ["", "/git/trees/HEAD?recursive=1"], "only metadata + tree cost API quota");
  assert.ok(gh.rawCalls.every(u => u.includes("/o/r/main/")), "raw reads use the default branch");
});

test("chat context: model picks files, relevant lines are read and cited as sources", async () => {
  let pickerPrompt = "";
  const { gh, panel } = repoPanel({
    ai: async (url, init) => {
      pickerPrompt = JSON.parse(init.body).messages[0].content;
      return sseReply('["src/launch/sequence.ts", "src/launch/timer.ts", "made/up.ts"]');
    },
  });
  const statuses = [];
  const { context, sources, ref } = await panel.fn.buildChatContext(
    { owner: "o", repo: "r" }, "How does runLaunchSequence start the timer?", null, (s) => statuses.push(s));

  assert.equal(ref, "main");
  assert.ok(pickerPrompt.includes("src/launch/sequence.ts"), "shortlist is offered to the model");
  assert.ok(!pickerPrompt.includes("node_modules"));
  const files = [...new Set(plain(sources).map(s => s.path))];
  assert.deepEqual(files, ["src/launch/sequence.ts", "src/launch/timer.ts"], "made-up paths are ignored");
  assert.match(context, /121\| export async function runLaunchSequence/, "numbered lines around the match");
  assert.ok(context.indexOf("runLaunchSequence") < context.indexOf("=== README ==="), "code comes before README");
  assert.ok(statuses.some(s => s.startsWith("Reading sequence.ts")));
  assert.deepEqual(gh.apiCalls.sort(), ["", "/git/trees/HEAD?recursive=1"], "reading code costs no extra API quota");
});

test("chat context falls back to path matches when the picker fails", async () => {
  const { panel } = repoPanel({ ai: async () => new Response('{"error":{"message":"rate limited"}}', { status: 429 }) });
  const { sources } = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "how is the launch timer created?", null);
  const files = new Set(plain(sources).map(s => s.path));
  assert.ok(files.has("src/launch/timer.ts"), [...files].join(", "));
});

test("chat context reads no code when the model says the README is enough", async () => {
  const { panel } = repoPanel({ ai: async () => sseReply("[]") });
  const { context, sources } = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "What is this project?", null);
  assert.equal(sources.length, 0);
  assert.match(context, /=== README ===/);
});

test("chat context respects the provider's budget", async () => {
  const big = { ...RAW, "src/launch/sequence.ts": Array.from({ length: 5000 }, (_, i) => `const launch${i} = runLaunchSequence(${i});`).join("\n") };
  const { panel } = repoPanel({ raw: big, ai: async () => sseReply('["src/launch/sequence.ts"]') });
  const budget = panel.run("CONTEXT_BUDGET.groq");
  const { context } = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "runLaunchSequence", null);
  assert.ok(context.length <= budget, `${context.length} > ${budget}`);
});

test("private repos read files through the contents API instead of raw", async () => {
  const b64 = Buffer.from("export class Timer {}").toString("base64");
  const { gh, panel } = repoPanel({
    repoData: { default_branch: "main", private: true },
    routes: { "/contents/src/launch/timer.ts?ref=main": { content: b64 } },
  });
  assert.equal(await panel.fn.readRepoFile("src/launch/timer.ts"), "export class Timer {}");
  assert.equal(await panel.fn.readRepoFile("missing.ts"), null);
  assert.equal(gh.rawCalls.length, 0);
});

test("a rate-limited tree surfaces as a rate-limit error instead of an empty context", async () => {
  const { panel } = repoPanel({ routes: { "/git/trees/HEAD?recursive=1": json({ message: "API rate limit exceeded" }, {
    status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 600) } }) } });
  const err = await panel.fn.getRepoContextParts().catch(e => e);
  assert.equal(err.rateLimited, true);
});
