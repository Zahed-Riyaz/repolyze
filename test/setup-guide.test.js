// Contribute tab → "Set up locally": a runbook from setup files, not an analysis
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const TREE = { tree: [
  "README.md", "docs/development.md", "package.json", ".nvmrc", ".env.example", "docker-compose.yml",
  ".devcontainer/devcontainer.json", ".github/workflows/ci.yml",
  "src/server.ts", "src/db/migrate.ts", "docs/architecture.md", "CHANGELOG.md",
].map(p => ({ path: p, type: "blob", size: 400 })) };
const RAW = {
  "README.md": "# Rocket\nSee docs/development.md to hack on it.",
  "docs/development.md": "Copy .env.example to .env, then `docker compose up -d` and `npm run dev`.",
  "package.json": '{"engines":{"node":">=20"},"scripts":{"dev":"vite","test":"vitest","lint":"eslint ."}}',
  ".nvmrc": "20.11.0",
  ".env.example": "DATABASE_URL=postgres://localhost/rocket",
  "docker-compose.yml": "services:\n  db:\n    image: postgres:16",
  ".devcontainer/devcontainer.json": '{"image":"node:20"}',
  ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npm ci\n      - run: npm test\n",
  "src/server.ts": "SECRET_SOURCE_CODE",
  "docs/architecture.md": "ARCHITECTURE_OVERVIEW",
};

function setupPanel({ onAI } = {}) {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE }, {
    raw: RAW,
    repoPrefix: "/repos/acme/rocket",
    ai: async (url, init) => { onAI?.(JSON.parse(init.body).messages[0].content); return sseReply("## 1. Prerequisites\n- Node 20.11.0 (from .nvmrc)\n\n```bash\nnpm ci\n```\n(from .github/workflows/ci.yml)"); },
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo("acme", "rocket");
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_test"`);
  return { gh, panel };
}

test("setup context reads docs, manifests, version pins, env templates, containers and CI — nothing else", async () => {
  const { panel } = setupPanel();
  const { context, files } = await panel.fn.buildSetupContext({ owner: "acme", repo: "rocket" });
  for (const f of ["README.md", "docs/development.md", "package.json", ".nvmrc", ".env.example", "docker-compose.yml", ".devcontainer/devcontainer.json", ".github/workflows/ci.yml"]) {
    assert.ok(files.includes(f), `missing ${f}`);
    assert.ok(context.includes(`=== ${f} ===`), `not in context: ${f}`);
  }
  assert.ok(!context.includes("SECRET_SOURCE_CODE"), "no source code");
  assert.ok(!context.includes("ARCHITECTURE_OVERVIEW"), "no general docs");
  assert.ok(!/File tree/.test(context), "no file tree");
});

test("the prompt asks for a sourced runbook, not a description of the project", () => {
  const p = loadPanel().fn.setupGuidePrompt({ owner: "acme", repo: "rocket" }, "=== .nvmrc ===\n20", [{ cmd: "npm test", from: ".github/workflows/ci.yml" }]);
  for (const s of [
    "setting up the GitHub repository \"acme/rocket\" locally",
    "Do not describe, summarise or evaluate the project",
    "name the file it comes from",
    "write \"not specified\" rather than guessing",
    "## 1. Prerequisites", "## 3. Install dependencies", "## 4. Configure", "## 5. Run it", "## 6. Run the checks",
    "git remote add upstream https://github.com/acme/rocket.git",
    "- `npm test` (from .github/workflows/ci.yml)",
    "=== .nvmrc ===",
  ]) assert.ok(p.includes(s), s);
});

test("Generate setup steps uses the setup prompt, renders copyable commands, and caches the result", async () => {
  const prompts = [];
  const { panel } = setupPanel({ onAI: (p) => prompts.push(p) });
  await panel.fn.generateQuickstart();

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Do not describe, summarise or evaluate the project/);
  assert.match(prompts[0], /`npm ci` \(from \.github\/workflows\/ci\.yml\)/, "CI commands are passed in");
  assert.doesNotMatch(prompts[0], /SECRET_SOURCE_CODE|File tree/);

  const html = panel.el("quickstart-content").innerHTML;
  assert.match(html, /<h3>1\. Prerequisites<\/h3>/);
  assert.match(html, /<div class="code-wrap"><pre><code>npm ci<\/code><\/pre><button class="copy-btn code-copy"/);
  assert.equal(panel.el("gen-quickstart-btn").style.display, "none");

  await panel.fn.generateQuickstart();
  assert.equal(prompts.length, 1, "second time comes from cache");
});

test("the Contribute tab offers setup steps, not a generic AI guide", async () => {
  const { panel } = setupPanel();
  await panel.fn.fetchContributeTab().catch(() => {});
  assert.match(panel.el("gen-quickstart-btn").innerHTML, /Generate setup steps/);
});

test("withCodeCopy adds a copy button to every code block and leaves other HTML alone", () => {
  const { withCodeCopy } = loadPanel().fn;
  const out = withCodeCopy("<p>x</p><pre><code>a\nb</code></pre><pre><code>c</code></pre>");
  assert.equal((out.match(/class="copy-btn code-copy"/g) || []).length, 2);
  assert.match(out, /^<p>x<\/p><div class="code-wrap"><pre><code>a\nb<\/code><\/pre>/);
});
