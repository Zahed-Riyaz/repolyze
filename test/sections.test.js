// Section-aware repo context: split docs by heading, keep what matches the question
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const pure = loadPanel().fn;

// ── Splitting ────────────────────────────────────────────────────────────────
test("splitMarkdownSections: intro, heading paths, underlined and HTML headings, fences ignored", () => {
  const md = [
    "Intro line",
    "# Rocket",
    "Overview",
    "## Install",
    "npm i",
    "```bash",
    "# not a heading, a shell comment",
    "```",
    "### From source",
    "git clone",
    "Development",
    "===========",
    "dev notes",
    "Testing",
    "-------",
    "npm test",
    '<h2 align="center">Credits</h2>',
    "thanks",
  ].join("\n");
  const secs = plain(pure.splitMarkdownSections(md));
  assert.deepEqual(secs.map(s => [s.level, s.heading]), [
    [0, ""], [1, "Rocket"], [2, "Install"], [3, "From source"], [1, "Development"], [2, "Testing"], [2, "Credits"],
  ]);
  assert.equal(secs[0].body, "Intro line");
  assert.deepEqual(secs[3].path, ["Rocket", "Install", "From source"]);
  assert.deepEqual(secs[5].path, ["Development", "Testing"]);
  assert.match(secs[2].body, /# not a heading, a shell comment/);
});

test("a list item followed by --- isn't mistaken for a heading", () => {
  const secs = plain(pure.splitMarkdownSections("- item\n---\ntext"));
  assert.equal(secs.length, 1);
});

// ── Selecting ────────────────────────────────────────────────────────────────
const filler = (n) => "Lorem ipsum dolor sit amet. ".repeat(n);
const README = [
  "# Rocket", "A launch orchestration toolkit.",
  "## Features", filler(60),
  "## Architecture", filler(60),
  "## Configuration", filler(40),
  "## Running tests", "Run `npm test`; integration tests need `docker compose up -d` first.",
  "## License", "MIT",
].join("\n");

test("selectSections keeps the intro and pulls in a late section that matches the question", () => {
  const secs = pure.splitMarkdownSections(README);
  assert.ok(README.indexOf("## Running tests") > 3000, "precondition: the section is past the old 3,000-char cut");
  const out = pure.selectSections(secs, pure.queryTerms("How do I run the tests?"), 3000);
  assert.match(out, /^# Rocket\nA launch orchestration toolkit\./);
  assert.match(out, /## Running tests\nRun `npm test`; integration tests need `docker compose up -d` first\./);
  assert.ok(out.length <= 3000, `over the limit: ${out.length}`);
  assert.match(out, /\(Other sections not shown: Architecture, Configuration\)$/, "sections that didn't fit are named");
});

test("selectSections never exceeds its limit", () => {
  for (let k = 0; k < 200; k++) {
    let md = "# T\n" + "intro ".repeat(k % 300);
    for (let i = 0; i < 1 + (k % 11); i++) md += `\n## Part ${i} ${["tests", "config", "install", "debug"][i % 4]}\n` + "word ".repeat((k * 37 + i * 91) % 700);
    const limit = [800, 1500, 2000, 3000][k % 4];
    const out = pure.selectSections(pure.splitMarkdownSections(md), pure.queryTerms(["tests", "install config", "debug", "what"][k % 4]), limit);
    assert.ok(out.length <= limit, `doc ${k}: ${out.length} > ${limit}`);
  }
});

test("selectSections keeps document order among the sections it chooses", () => {
  const secs = pure.splitMarkdownSections("# A\nintro\n## Tests\nrun tests\n## Config\nconfigure tests here");
  const out = pure.selectSections(secs, pure.queryTerms("tests config"), 3000);
  assert.ok(out.indexOf("## Tests") < out.indexOf("## Config"));
});

test("with no terms it falls back to the top of the document, as before", () => {
  const secs = pure.splitMarkdownSections(README);
  const out = pure.selectSections(secs, [], 1000);
  assert.ok(out.startsWith("# Rocket\nA launch orchestration toolkit.\n\n## Features"));
  assert.ok(!out.includes("## Running tests"));
});

// ── package.json ─────────────────────────────────────────────────────────────
test("summarizePackageJson keeps every script even behind a huge dependency list", () => {
  const deps = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`dep-${i}`, "^1.0.0"]));
  const pkg = JSON.stringify({ name: "rocket", description: "Launch kit", dependencies: deps,
    engines: { node: ">=20" }, packageManager: "pnpm@9.0.0", workspaces: ["packages/*"],
    scripts: { dev: "vite", test: "vitest run", lint: "eslint ." } }, null, 2);
  const s = pure.summarizePackageJson(pkg);
  assert.match(s, /^name: rocket — Launch kit/);
  assert.match(s, /packageManager: pnpm@9\.0\.0\nengines: node >=20\nworkspaces: packages\/\*/);
  assert.match(s, /scripts:\n {2}dev: vite\n {2}test: vitest run\n {2}lint: eslint \./);
  assert.match(s, /dependencies: dep-0, dep-1/);
  assert.ok(!s.includes("^1.0.0"), "versions are dropped");
  assert.equal(pure.summarizePackageJson("{not json"), null);
});

// ── End to end ───────────────────────────────────────────────────────────────
const TREE = { tree: ["README.md", "package.json", "docs/development.md", "packages/web/package.json", "packages/api/pyproject.toml", "node_modules/x/package.json", "src/index.ts"]
  .map(p => ({ path: p, type: "blob", size: 500 })) };

function repoPanel() {
  const deps = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`dep-${i}`, "^1"]));
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE }, {
    raw: {
      "README.md": README,
      "package.json": JSON.stringify({ name: "rocket", dependencies: deps, scripts: { test: "vitest run" } }, null, 2),
      "docs/development.md": "# Development\n## Debugging\nUse DEBUG=rocket:*\n## Releasing\nTag and push",
      "src/index.ts": "export {}",
    },
    ai: async () => sseReply("[]"),
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "openai"; aiApiKey = "k"`);
  return panel;
}

test("repo context parts carry sections, a package.json summary and nested packages", async () => {
  const parts = plain(await repoPanel().fn.getRepoContextParts());
  const readme = parts.find(p => p.label === "README");
  assert.ok(readme.sections.length >= 6);
  const pkg = parts.find(p => p.label === "package.json");
  assert.match(pkg.text, /scripts:\n {2}test: vitest run/);
  assert.ok(!pkg.text.includes('"dependencies"'), "summarised, not raw JSON");
  assert.ok(parts.some(p => p.label === "docs/development.md" && p.sections));
  const nested = parts.find(p => p.label === "Nested packages");
  assert.deepEqual(nested.text.split("\n"), ["packages/web/package.json", "packages/api/pyproject.toml"], "noise folders like node_modules are excluded");
});

test("chat context includes the README section and dev-doc section that match the question", async () => {
  const panel = repoPanel();
  const testing = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "How do I run the tests?", null);
  assert.match(testing.context, /## Running tests\nRun `npm test`/);
  const debugging = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "How do I turn on debugging logs?", null);
  assert.match(debugging.context, /## Debugging\nUse DEBUG=rocket:\*/);
  assert.doesNotMatch(debugging.context, /## Running tests\nRun/, "an unrelated section isn't pulled in");
  assert.match(debugging.context, /Other sections not shown:[^)]*Running tests/, "…but the model knows it exists");
});
