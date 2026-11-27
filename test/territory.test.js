// territory.js: the repo map's pure logic (entry points first)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain, tick } = require("./helpers/panel");

const pure = loadPanel().fn;

test("findEntryPoints reads package.json main, bin and start script, strongest first", () => {
  const e = plain(pure.findEntryPoints(["src/index.ts", "src/cli.ts", "src/server.js"], {
    "package.json": JSON.stringify({ main: "src/index.ts", bin: { tool: "src/cli.ts" }, scripts: { start: "node src/server.js" } }) }));
  assert.deepEqual(e.map(x => x.path), ["src/index.ts", "src/cli.ts", "src/server.js"]);
  assert.match(e[0].reason, /package\.json.*main/);
});
test("findEntryPoints reads pyproject scripts, __main__.py and manage.py", () => {
  const e = plain(pure.findEntryPoints(["pkg/cli.py", "pkg/__main__.py", "manage.py"], {
    "pyproject.toml": '[project.scripts]\ntool = "pkg.cli:main"\n' }));
  assert.deepEqual(e.map(x => x.path), ["pkg/cli.py", "pkg/__main__.py", "manage.py"]);
});
test("findEntryPoints reads an extension manifest's pages and workers", () => {
  const e = plain(pure.findEntryPoints(["background.js", "sidepanel.html", "content.js"], {
    "manifest.json": JSON.stringify({ manifest_version: 3, background: { service_worker: "background.js" }, side_panel: { default_path: "sidepanel.html" }, content_scripts: [{ js: ["content.js"] }] }) }));
  assert.deepEqual(e.map(x => x.path), ["background.js", "sidepanel.html", "content.js"]);
});
test("findEntryPoints falls back to the shallowest main/index file, and agrees with repoStarters", () => {
  const paths = ["lib/deep/index.js", "src/main.py", "README.md"];
  assert.equal(pure.findEntryPoints(paths, {})[0].path, "src/main.py");
  const starters = plain(pure.repoStarters({ repo: { repo: "r" }, paths }));
  assert.ok(starters.some(s => s.q?.includes("src/main.py")));
});
test("findEntryPoints starts a Python monorepo at its biggest packages, not a stray cli.py", () => {
  const paths = [
    "libs/tool/tool_pkg/__init__.py", "libs/tool/tool_pkg/cli.py",
    "libs/core/core_pkg/__init__.py", "libs/core/core_pkg/a.py", "libs/core/core_pkg/b.py", "libs/core/core_pkg/sub/__init__.py", "libs/core/core_pkg/sub/c.py",
    "libs/core/tests/__init__.py", "libs/core/tests/test_a.py",
  ];
  const e = plain(pure.findEntryPoints(paths, {}));
  assert.deepEqual(e.map(x => x.path), ["libs/core/core_pkg/__init__.py", "libs/tool/tool_pkg/__init__.py"]);
  assert.match(e[0].reason, /core_pkg/);
});
test("mapResolver follows a Python package's absolute imports wherever the package lives", () => {
  const known = new Set(["libs/core/core_pkg/__init__.py", "libs/core/core_pkg/a.py", "libs/core/core_pkg/sub/__init__.py", "libs/core/core_pkg/sub/c.py", "libs/app/app_pkg/__init__.py", "libs/app/app_pkg/main.py"]);
  const r = pure.mapResolver({ known, files: {} });
  const text = "from core_pkg.a import thing\nimport core_pkg.sub.c\nfrom core_pkg.sub import c\n    from app_pkg.main import run\nimport os\n";
  assert.deepEqual(plain(r("libs/app/app_pkg/__init__.py", text).edges).sort(), ["libs/app/app_pkg/main.py", "libs/core/core_pkg/a.py", "libs/core/core_pkg/sub/__init__.py", "libs/core/core_pkg/sub/c.py"]);
});
test("findEntryPoints finds one entry per workspace package, at most 6", () => {
  const paths = Array.from({ length: 8 }, (_, i) => `packages/p${i}/src/index.ts`);
  const files = Object.fromEntries(paths.map((p, i) => [`packages/p${i}/package.json`, JSON.stringify({ main: "src/index.ts" })]));
  const e = plain(pure.findEntryPoints(paths, files));
  assert.equal(e.length, 6);
  assert.equal(new Set(e.map(x => x.path.split("/")[1])).size, 6);
});
test("findEntryPoints ignores entries that aren't in the tree", () => {
  assert.deepEqual(plain(pure.findEntryPoints([], { "package.json": '{"main":"dist/index.js"}' })), []);
});
test("findEntryPoints resolves package-relative paths against the package folder", () => {
  const e = plain(pure.findEntryPoints(["apps/web/src/app.ts"], { "apps/web/package.json": '{"main":"./src/app.ts"}' }));
  assert.deepEqual(e.map(x => x.path), ["apps/web/src/app.ts"]);
});
test("findEntryPoints skips a start script with no path in the tree", () => {
  assert.deepEqual(plain(pure.findEntryPoints(["a.js"], { "package.json": '{"scripts":{"start":"node nope.js"}}' })), []);
});
test("findEntryPoints survives malformed manifests", () => {
  assert.deepEqual(plain(pure.findEntryPoints(["a.js"], { "package.json": "{oops", "manifest.json": "" })), []);
});
test("findEntryPoints reads module, exports[\".\"] and a dev script that names a file", () => {
  const e = plain(pure.findEntryPoints(["src/esm.js", "src/exp.js", "src/dev.js"], {
    "package.json": JSON.stringify({ module: "src/esm.js", exports: { ".": { import: "./src/exp.js" } }, scripts: { dev: "node --watch src/dev.js", start: "vite" } }) }));
  assert.deepEqual(e.map(x => x.path), ["src/esm.js", "src/exp.js", "src/dev.js"]);
  assert.match(e[0].reason, /module/); assert.match(e[1].reason, /exports\["\."\]/); assert.match(e[2].reason, /dev script/);
});
test("findEntryPoints: a workspace package built to dist/ still gets its src/index entry", () => {
  const e = plain(pure.findEntryPoints(["packages/ui/src/index.ts", "packages/ui/src/button.ts"], {
    "packages/ui/package.json": JSON.stringify({ name: "ui", main: "dist/index.js" }) }));
  assert.deepEqual(e.map(x => x.path), ["packages/ui/src/index.ts"]);
  assert.match(e[0].reason, /packages\/ui\/package\.json/);
});
test("findEntryPoints reads app.py and main.py at the root or in src/", () => {
  assert.deepEqual(plain(pure.findEntryPoints(["app.py", "lib/x.py"], {})).map(x => x.path), ["app.py"]);
  assert.deepEqual(plain(pure.findEntryPoints(["src/main.py", "src/deep/main.py"], {})).map(x => x.path), ["src/main.py"]);
  assert.match(pure.findEntryPoints(["src/app.py"], {})[0].reason, /app\.py/);
});
test("findEntryPoints skips __main__.py and manage.py under tests or vendored folders", () => {
  const e = plain(pure.findEntryPoints(["tests/__main__.py", "node_modules/x/manage.py", "pkg/__main__.py"], {}));
  assert.deepEqual(e.map(x => x.path), ["pkg/__main__.py"]);
  assert.deepEqual(plain(pure.findEntryPoints(["tests/__main__.py", "src/app.ts"], {})).map(x => x.path).includes("tests/__main__.py"), false);
});
test("MAP_MANIFESTS lists root manifests and workspace package.json files", () => {
  const paths = ["package.json", "manifest.json", "README.md", "packages/a/package.json", "apps/b/package.json", "packages/a/src/package.json", "docs/c/package.json"];
  assert.deepEqual(plain(pure.MAP_MANIFESTS(paths)), ["package.json", "manifest.json", "packages/a/package.json", "apps/b/package.json"]);
});
test("findEntryPoints reads setup.cfg console_scripts", () => {
  const cfg = "[metadata]\nname = x\n\n[options.entry_points]\nconsole_scripts =\n    tool = src/pkg.cli:main\n";
  const e = plain(pure.findEntryPoints(["src/pkg/cli.py"], { "setup.cfg": cfg.replace("src/pkg", "pkg") }));
  assert.deepEqual(e.map(x => x.path), ["src/pkg/cli.py"]);
  assert.match(e[0].reason, /setup\.cfg/);
});
test("findEntryPoints ignores setup.cfg lines outside console_scripts", () => {
  const cfg = "[metadata]\nname = pkg.cli:main\n[options.entry_points]\nconsole_scripts =\n    a = pkg.cli:main\n[flake8]\nignore = pkg.other:x\n";
  const e = plain(pure.findEntryPoints(["pkg/cli.py", "pkg/other.py"], { "setup.cfg": cfg }));
  assert.deepEqual(e.map(x => x.path), ["pkg/cli.py"]);
});
test("findEntryPoints reads [tool.poetry.scripts]", () => {
  const e = plain(pure.findEntryPoints(["app/run.py"], { "pyproject.toml": '[tool.poetry.scripts]\nrun = "app.run:main"\n' }));
  assert.deepEqual(e.map(x => x.path), ["app/run.py"]);
});
test("findEntryPoints accepts bin as a plain string", () => {
  const e = plain(pure.findEntryPoints(["bin/cli.js"], { "package.json": '{"bin":"bin/cli.js"}' }));
  assert.deepEqual(e.map(x => x.path), ["bin/cli.js"]);
  assert.match(e[0].reason, /bin/);
});
test("findEntryPoints reads manifest background scripts, popup, options page and options_ui", () => {
  const paths = ["bg1.js", "popup.html", "options.html", "opts2.html"];
  const m = (o) => plain(pure.findEntryPoints(paths, { "manifest.json": JSON.stringify(o) })).map(x => x.path);
  assert.deepEqual(m({ background: { scripts: ["bg1.js"] }, action: { default_popup: "popup.html" } }), ["bg1.js", "popup.html"]);
  assert.deepEqual(m({ options_page: "options.html" }), ["options.html"]);
  assert.deepEqual(m({ options_ui: { page: "opts2.html" } }), ["opts2.html"]);
});

test("parseLoads reads script tags and importScripts, not remote URLs", () => {
  assert.deepEqual(plain(pure.parseLoads('<script src="a.js"></script><script type="module" src="./src/main.ts"></script><script src="https://cdn.x/y.js"></script>', "index.html")), ["a.js", "./src/main.ts"]);
  assert.deepEqual(plain(pure.parseLoads('importScripts("github.js", "retrieval.js");', "background.js")), ["github.js", "retrieval.js"]);
});
test("mapResolver follows HTML script tags in document order", () => {
  const r = pure.mapResolver({ known: new Set(["a.js", "b.js", "index.html"]), files: {} });
  assert.deepEqual(plain(r("index.html", '<script src="b.js"></script><script src="a.js"></script>')), { edges: ["b.js", "a.js"], order: ["b.js", "a.js"], named: [] });
});
test("mapResolver links workspace packages and tsconfig paths", () => {
  const known = new Set(["packages/core/src/index.ts", "apps/web/src/app.ts", "apps/web/src/lib/db.ts"]);
  const files = { "package.json": '{"workspaces":["packages/*","apps/*"]}', "packages/core/package.json": '{"name":"@acme/core"}',
    "apps/web/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"#lib/*":["src/lib/*"]}}}' };
  const r = pure.mapResolver({ known, files });
  assert.deepEqual(plain(r("apps/web/src/app.ts", 'import { x } from "@acme/core";\nimport db from "#lib/db";').edges).sort(), ["apps/web/src/lib/db.ts", "packages/core/src/index.ts"]);
});
test("mapResolver leaves npm packages out", () => {
  const r = pure.mapResolver({ known: new Set(["src/a.ts"]), files: {} });
  assert.deepEqual(plain(r("src/a.ts", 'import React from "react";').edges), []);
});
test("mapResolver reads commented tsconfig, package main and exports", () => {
  const known = new Set(["libs/ui/dist.js", "libs/b/lib/x.js", "libs/b/src/index.js", "app/src/a.ts", "app/src/u.ts"]);
  const files = { "libs/ui/package.json": '{"name":"ui","main":"./dist.js"}',
    "libs/b/package.json": '{"name":"b","exports":{".":"./lib/x.js"}}',
    "app/tsconfig.json": '{\n// c\n"compilerOptions":{"baseUrl":"src","paths":{"u":["u.ts"],},/* x */},}' };
  const r = pure.mapResolver({ known, files });
  assert.deepEqual(plain(r("app/src/a.ts", 'import a from "ui"; import b from "b"; import u from "u";').edges).sort(), ["app/src/u.ts", "libs/b/lib/x.js", "libs/ui/dist.js"]);
});

// ── The crawl ────────────────────────────────────────────────────────────────
const { githubMock } = require("./helpers/github-mock");

function mapPanel(raw, opts = {}) {
  const paths = [...Object.keys(raw), ...(opts.extraTree || [])];
  const contents = !opts.private ? {} : Object.fromEntries(Object.entries(raw).map(([p, t]) =>
    [`/contents/${p}?ref=main`, { content: Buffer.from(String(t)).toString("base64") }]));
  const gh = githubMock({
    ...contents,
    "": { default_branch: "main", private: !!opts.private },
    "/git/trees/HEAD?recursive=1": { sha: "t1", truncated: !!opts.treeTruncated,
      tree: paths.map(p => ({ path: p, type: "blob", size: opts.sizes?.[p] ?? String(raw[p] ?? "").length })) },
  }, { raw });
  const panel = loadPanel({ fetch: gh.fetch, chrome: { local: opts.stored || {} } });
  panel.setRepo();
  return { panel, gh };
}
async function mapFor(raw, opts = {}) {
  const { panel } = mapPanel(raw, opts);
  return plain(await panel.fn.buildImportGraph(panel.run("currentRepo"), { cap: opts.cap ?? 300 }));
}
const SMALL_REPO = { "package.json": '{"main":"src/index.ts"}', "src/index.ts": 'import "./a"', "src/a.ts": "export const a = 1" };

test("buildImportGraph crawls from the entry, counts importers and depth", async () => {
  const g = await mapFor({ "package.json": '{"main":"src/index.ts"}', "src/index.ts": 'import "./app"', "src/app.ts": 'import "./db"\nimport "./router"',
    "src/router.ts": 'import "./db"', "src/db.ts": "export const db = 1", "src/unused.ts": "" });
  assert.equal(g.sha, "t1");
  assert.equal(g.nodes["src/db.ts"].inDegree, 2);
  assert.equal(g.nodes["src/db.ts"].depth, 2);
  assert.equal(g.nodes["src/index.ts"].depth, 0);
  assert.ok(!("src/unused.ts" in g.nodes), "not reached");
  assert.equal(g.entries[0].path, "src/index.ts");
});
// Django-style: manage.py names its settings in a string and imports nothing from the repo
const DJANGO_REPO = {
  "manage.py": 'import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "settings")\nfrom django.core.management import execute_from_command_line\n',
  "apps/jobs/models.py": "from django.db import models\n",
  "apps/jobs/views.py": "from apps.jobs.models import Job\nfrom apps.base.utils import helper\n",
  "apps/jobs/urls.py": "from . import views\n",
  "apps/base/utils.py": "def helper(): pass\n",
  "apps/jobs/tests/test_views.py": "from apps.jobs.views import x\n",
  "apps/jobs/migrations/0001_initial.py": "from django.db import migrations\n",
  "static/js/vendor.js": "var x = 1;\n",
  "docs/conf.py": "project = 'x'\n",
};
test("when the imports from the start reach little of the code, the main code folders are read too", async () => {
  const g = await mapFor(DJANGO_REPO);
  assert.equal(g.entries[0].path, "manage.py");
  assert.equal(g.nodes["manage.py"].depth, 0);
  for (const p of ["apps/jobs/models.py", "apps/jobs/views.py", "apps/jobs/urls.py", "apps/base/utils.py"]) assert.ok(g.nodes[p]?.read, p);
  for (const p of ["apps/jobs/tests/test_views.py", "apps/jobs/migrations/0001_initial.py", "static/js/vendor.js", "docs/conf.py"]) assert.ok(!(p in g.nodes), p);
  assert.ok(g.edges.some(([a, b]) => a === "apps/jobs/views.py" && b === "apps/jobs/models.py"));
  assert.ok(g.edges.some(([a, b]) => a === "apps/jobs/urls.py" && b === "apps/jobs/views.py"));
  assert.equal(g.nodes["apps/jobs/models.py"].inDegree, 1);
  assert.ok(g.topup >= 3, "says how many files were added from folders");
  assert.ok(g.nodes["apps/jobs/views.py"].depth >= 1);
});
test("files added from folders stay within the cap", async () => {
  const raw = { "manage.py": "import os\n" };
  for (let i = 0; i < 40; i++) raw[`apps/a/m${i}.py`] = "x = 1\n";
  const g = await mapFor(raw, { cap: 10 });
  assert.equal(g.read, 10);
  assert.equal(g.truncated, true);
});
test("the flow map shows files added from folders below the start", async () => {
  const g = await mapFor(DJANGO_REPO);
  const f = pure.flowFiles(g, {});
  assert.ok(f.shown.has("manage.py") && f.shown.has("apps/jobs/views.py") && f.shown.has("apps/jobs/models.py"));
});
test("buildImportGraph stops at the cap and says so", async () => {
  const raw = { "package.json": '{"main":"a0.js"}' };
  for (let i = 0; i < 20; i++) raw[`a${i}.js`] = `require("./a${i + 1}")`;
  const g = await mapFor(raw, { cap: 5 });
  assert.equal(g.read, 5); assert.equal(g.truncated, true);
  assert.equal(g.nodes["a4.js"].read, true);
  assert.equal(g.nodes["a5.js"].read, false); assert.equal(g.nodes["a5.js"].inDegree, 1); assert.equal(g.nodes["a5.js"].depth, 5);
  assert.ok(!("a6.js" in g.nodes));
});
test("buildImportGraph survives cycles and failed reads", async () => {
  const g = await mapFor({ "package.json": '{"main":"a.js"}', "a.js": 'require("./b"); require("./gone")', "b.js": 'require("./a")' }, { extraTree: ["gone.js"] });
  assert.equal(g.read, 2); assert.ok(!("gone.js" in g.nodes)); assert.equal(g.truncated, false);
});
test("buildImportGraph notes a truncated tree and untraced languages", async () => {
  const g = await mapFor({ "main.go": "package main", "x.js": "" }, { treeTruncated: true, sizes: { "main.go": 9000, "x.js": 100 } });
  assert.equal(g.treeTruncated, true); assert.deepEqual(g.untraced, ["Go"]);
});
test("Vue and Svelte files are crawled, so they never count as untraced", async () => {
  const g = await mapFor({ "package.json": '{"main":"src/main.js"}', "src/main.js": 'import App from "./App.vue"', "src/App.vue": '<script>import "./w.svelte"</script>', "src/w.svelte": "" },
    { sizes: { "src/App.vue": 9000, "src/w.svelte": 9000, "src/main.js": 100 } });
  assert.deepEqual(g.untraced, []);
  assert.ok(g.nodes["src/App.vue"]);
});
test("buildImportGraph records size and barrel files", async () => {
  const g = await mapFor({ "package.json": '{"main":"index.ts"}', "index.ts": 'import "./all"; import "./real"',
    "all.ts": 'export * from "./real"\n\nexport { a } from "./real"\n', "real.ts": 'export const a = 1\nexport { b } from "./x"' }, { sizes: { "real.ts": 42 } });
  assert.equal(g.nodes["all.ts"].barrel, true);
  assert.ok(!g.nodes["real.ts"].barrel);
  assert.ok(!g.nodes["index.ts"].barrel);
  assert.equal(g.nodes["real.ts"].size, 42);
});
test("buildImportGraph records the load order of an html page", async () => {
  const g = await mapFor({ "manifest.json": '{"side_panel":{"default_path":"p.html"}}', "p.html": '<script src="a.js"></script><script src="b.js"></script>', "a.js": "", "b.js": "" });
  assert.deepEqual(g.order["p.html"], ["a.js", "b.js"]);
});
test("buildImportGraph reads the workspace package.json files the root globs select", async () => {
  const raw = { "package.json": '{"workspaces":["libs/*"]}', "libs/core/package.json": '{"name":"core","main":"index.js"}', "libs/core/index.js": "",
    "tools/x/package.json": '{"name":"x","main":"index.js"}', "tools/x/index.js": "" };
  const { panel, gh } = mapPanel(raw);
  const g = plain(await panel.fn.buildImportGraph(panel.run("currentRepo"), {}));
  assert.deepEqual(g.entries.map(e => e.path), ["libs/core/index.js"]);
  assert.ok(gh.rawCalls.some(u => u.endsWith("/libs/core/package.json")));
  assert.ok(!gh.rawCalls.some(u => u.endsWith("/tools/x/package.json")), "outside the globs");
});
test("buildImportGraph reads workspaces given as { packages } and exact dirs", async () => {
  const raw = { "package.json": '{"workspaces":{"packages":["tools/x"]}}', "libs/core/package.json": '{"main":"index.js"}', "libs/core/index.js": "",
    "tools/x/package.json": '{"main":"index.js"}', "tools/x/index.js": "" };
  const { panel, gh } = mapPanel(raw);
  const g = plain(await panel.fn.buildImportGraph(panel.run("currentRepo"), {}));
  assert.deepEqual(g.entries.map(e => e.path), ["tools/x/index.js"]);
  assert.ok(!gh.rawCalls.some(u => u.endsWith("/libs/core/package.json")));
});
test("buildImportGraph reads the package.json files pnpm-workspace.yaml selects", async () => {
  const raw = { "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - \"!apps/old\"\n", "package.json": "{}", "apps/web/package.json": '{"main":"index.js"}', "apps/web/index.js": "",
    "packages/ui/package.json": '{"main":"index.js"}', "packages/ui/index.js": "" };
  const { panel, gh } = mapPanel(raw);
  const g = plain(await panel.fn.buildImportGraph(panel.run("currentRepo"), {}));
  assert.deepEqual(g.entries.map(e => e.path), ["apps/web/index.js"]);
  assert.ok(!gh.rawCalls.some(u => u.endsWith("/packages/ui/package.json")), "not in pnpm-workspace.yaml");
});
test("buildImportGraph caps manifest reads at 20, root files first", async () => {
  const raw = { "package.json": '{"workspaces":["p/*"]}', "tsconfig.json": "{}" };
  for (let i = 0; i < 30; i++) raw[`p/k${i}/package.json`] = "{}";
  const { panel, gh } = mapPanel(raw);
  await panel.fn.buildImportGraph(panel.run("currentRepo"), {});
  const reads = gh.rawCalls.filter(u => /package\.json|tsconfig\.json$/.test(u));
  assert.equal(reads.length, 20);
  assert.ok(reads.some(u => u.endsWith("/o/r/main/package.json")) && reads.some(u => u.endsWith("/tsconfig.json")));
});
test("loadRepoMap costs no API requests on a public repo and nothing on a second open", async () => {
  const { panel, gh } = mapPanel(SMALL_REPO);
  await panel.fn.getRepoTree(panel.run("currentRepo")); await panel.fn.loadRepoData(panel.run("currentRepo"));
  const before = gh.apiCalls.length;
  const map = plain(await panel.fn.loadRepoMap(panel.run("currentRepo"), {}));
  assert.equal(map.sha, "t1");
  assert.equal(gh.apiCalls.length - before, 0, "tree already loaded; files from raw");
  assert.ok(panel.chrome.storage.local.data.map_o_r, "saved under map_{owner}_{repo}");
  const raws = gh.rawCalls.length;
  const again = loadPanel({ fetch: gh.fetch, chrome: { local: panel.chrome.storage.local.data } }); again.setRepo();
  await again.fn.loadRepoMap(again.run("currentRepo"), {});
  assert.equal(gh.rawCalls.length, raws, "stored by tree SHA");
});
test("saving a 21st map removes the oldest stored one", async () => {
  const stored = {};
  for (let i = 0; i < 20; i++) stored[`map_o_old${i}`] = { sha: "x", time: 1000 + i, nodes: {}, edges: [] };
  stored.githubToken = "keep-me";
  const { panel } = mapPanel(SMALL_REPO, { stored });
  await panel.fn.loadRepoMap(panel.run("currentRepo"), {});
  const data = panel.chrome.storage.local.data;
  const maps = Object.keys(data).filter(k => k.startsWith("map_"));
  assert.equal(maps.length, 20);
  assert.equal(data.map_o_old0, undefined, "the oldest went");
  assert.ok(data.map_o_old1 && data.map_o_r, "the rest and the new one stay");
  assert.ok(data.map_o_r.time > 0);
  assert.equal(data.githubToken, "keep-me");
});
test("a private repo's stored map is marked private; a public one isn't", async () => {
  const pub = mapPanel(SMALL_REPO);
  await pub.panel.fn.loadRepoMap(pub.panel.run("currentRepo"), {});
  assert.equal(pub.panel.chrome.storage.local.data.map_o_r.private, undefined);
  const priv = mapPanel(SMALL_REPO, { private: true });
  await priv.panel.fn.loadRepoMap(priv.panel.run("currentRepo"), { allowPrivate: true });
  assert.equal(priv.panel.chrome.storage.local.data.map_o_r.private, true);
});
test("loadRepoMap waits for a click on a private repo", async () => {
  const { panel } = mapPanel(SMALL_REPO, { private: true });
  assert.deepEqual(plain(await panel.fn.loadRepoMap(panel.run("currentRepo"), {})), { needsClick: true, cost: 60 });
});
test("loadRepoMap crawls a private repo after a click, through the contents API, at most 60 files", async () => {
  const raw = { "package.json": '{"main":"a0.js"}' };
  for (let i = 0; i < 80; i++) raw[`a${i}.js`] = `require("./a${i + 1}")`;
  const { panel, gh } = mapPanel(raw, { private: true });
  const g = plain(await panel.fn.loadRepoMap(panel.run("currentRepo"), { allowPrivate: true }));
  assert.equal(g.read, 60); assert.equal(g.truncated, true);
  assert.equal(gh.rawCalls.length, 0, "private files never come from raw");
  assert.ok(gh.apiCalls.some(c => c.startsWith("/contents/a0.js")));
});

test("Explain this map's context finds a large file's exported function far below its head, within budget", async () => {
  const filler = Array.from({ length: 600 }, (_, i) => `// filler line ${i} with some words to take space`).join("\n");
  const raw = { "package.json": '{"main":"src/index.ts"}',
    "src/index.ts": 'import { deepThing } from "./big";\nimport "./other";\ndeepThing();',
    "src/big.ts": `${filler}\nexport function deepThing() {\n  return "DEEP_BODY";\n}\n${filler}`,
    "src/other.ts": `${filler}\nexport function lonely() {\n  return "LONELY_BODY";\n}\n${filler}` };
  const { panel, gh } = mapPanel(raw);
  const repo = panel.run("currentRepo");
  const graph = await panel.fn.loadRepoMap(repo, {});
  const tree = await panel.fn.getRepoTree(repo);
  panel.setRepo("o", "elsewhere"); // the context reads through the repo it is given
  const before = gh.rawCalls.length;
  const { context, sources } = plain(await panel.fn.mapFocusContext(graph, tree, 9000, { repo }));
  assert.ok(gh.rawCalls.slice(before).every(u => u.includes("/o/r/")), "read from o/r, not the current repo");
  assert.match(context, /DEEP_BODY/, "the name index.ts imports from big.ts");
  assert.match(context, /LONELY_BODY/, "an exported name");
  assert.ok(context.length <= 9000, `within budget (${context.length})`);
  assert.ok(sources.every(s => s.via === "map"));
});
test("Explain this map's context stops adding files when the budget runs out", async () => {
  const { panel } = mapPanel(SMALL_REPO);
  const repo = panel.run("currentRepo");
  const graph = await panel.fn.loadRepoMap(repo, {});
  const tree = await panel.fn.getRepoTree(repo);
  const { context, sources } = plain(await panel.fn.mapFocusContext(graph, tree, 10, { repo }));
  assert.deepEqual(sources, []);
  assert.match(context, /<repo_map>/);
});

const node = (inDegree, depth, extra = {}) => ({ inDegree, depth, size: 100, read: true, ...extra });
const GRAPH = {
  entries: [{ path: "src/index.ts", reason: "package.json main" }], order: {},
  nodes: { "src/index.ts": node(0, 0), "src/app.ts": node(1, 1), "src/db.ts": node(2, 2), "src/router.ts": node(1, 2) },
  edges: [["src/index.ts", "src/app.ts"], ["src/app.ts", "src/db.ts"], ["src/app.ts", "src/router.ts"], ["src/router.ts", "src/db.ts"]],
};
test("rankCore counts importers through barrels and skips tests", () => {
  const g = { entries: [{ path: "a.ts", reason: "x" }], order: {}, nodes: {
    "a.ts": node(0, 0), "b.ts": node(0, 1), "c.ts": node(0, 1), "d.ts": node(0, 1), "lib/index.ts": node(4, 1, { barrel: true }), "lib/db.ts": node(5, 2),
    "lib/db.test.ts": node(0, 1), "types.d.ts": node(9, 1) },
  edges: [...["a.ts", "b.ts", "c.ts", "d.ts"].map(f => [f, "lib/index.ts"]), ["lib/index.ts", "lib/db.ts"],
    ...Array.from({ length: 5 }, (_, i) => [`t${i}.test.ts`, "lib/db.ts"]),
    ...["a.ts", "b.ts", "c.ts"].map(f => [f, "types.d.ts"]), ...["a.ts", "b.ts", "c.ts"].map(f => [f, "lib/db.test.ts"])] };
  assert.deepEqual(plain(pure.rankCore(g)).map(({ path, importers }) => ({ path, importers })), [{ path: "lib/db.ts", importers: 4 }]);
});
test("rankCore keeps at most 10, most imported first", () => {
  const nodes = {}, edges = [];
  for (let i = 0; i < 12; i++) {
    nodes[`m${i}.js`] = node(0, 1);
    for (let k = 0; k < 3 + i; k++) edges.push([`u${k}.js`, `m${i}.js`]);
  }
  const c = plain(pure.rankCore({ entries: [], order: {}, nodes, edges }));
  assert.equal(c.length, 10);
  assert.equal(c[0].path, "m11.js"); assert.equal(c[0].importers, 14);
});
test("readingPath starts at the entry and follows what it loads, a file before the files it uses", () => {
  const p = plain(pure.readingPath(GRAPH, pure.rankCore(GRAPH)));
  assert.deepEqual(p.map(s => s.path), ["src/index.ts", "src/app.ts", "src/router.ts", "src/db.ts"]);
  assert.deepEqual(p.map(s => s.step), [1, 2, 3, 4]);
  assert.equal(p[0].reason, "entry point · package.json main");
  assert.equal(p[1].reason, "loaded by ① index.ts");
  assert.equal(p[3].reason, "loaded by ② app.ts · used by 2 files");
});
test("readingPath fills from core when the chain is short", () => {
  const g = { entries: [{ path: "a.js", reason: "r" }], order: {}, nodes: { "a.js": node(0, 0), "core.js": node(3, 1) }, edges: [] };
  const p = plain(pure.readingPath(g, [{ path: "core.js", importers: 3 }]));
  assert.deepEqual(p.map(s => s.path), ["a.js", "core.js"]);
});
test("global-scope scripts are read in their page's load order", () => {
  const g = { entries: [{ path: "sidepanel.html", reason: "manifest.json side_panel" }], order: { "sidepanel.html": ["github.js", "retrieval.js", "sidepanel.js"] },
    nodes: { "sidepanel.html": node(0, 0), "github.js": node(1, 1, { size: 50 }), "retrieval.js": node(1, 1, { size: 90 }), "sidepanel.js": node(1, 1, { size: 70 }) },
    edges: [["sidepanel.html", "github.js"], ["sidepanel.html", "retrieval.js"], ["sidepanel.html", "sidepanel.js"]] };
  assert.deepEqual(plain(pure.globalScripts(g)), ["github.js", "retrieval.js", "sidepanel.js"]);
  const p = plain(pure.readingPath(g, pure.rankCore(g)));
  assert.deepEqual(p.map(s => s.path), ["sidepanel.html", "github.js", "retrieval.js", "sidepanel.js"]);
  assert.equal(p[2].reason, "script 2 of 3 on sidepanel.html");
  assert.deepEqual(plain(pure.rankCore(g)).map(c => [c.path, c.importers]), [["retrieval.js", 0], ["sidepanel.js", 0], ["github.js", 0]]);
});
test("globalScripts is null with fewer than 3 scripts, a non-html entry or edges between scripts", () => {
  const mk = (entry, order, edges) => ({ entries: [{ path: entry, reason: "r" }], order, nodes: {}, edges });
  assert.equal(pure.globalScripts(mk("p.html", { "p.html": ["a.js", "b.js"] }, [])), null);
  assert.equal(pure.globalScripts(mk("a.js", { "a.js": ["b.js", "c.js", "d.js"] }, [])), null);
  assert.equal(pure.globalScripts(mk("p.html", { "p.html": ["a.js", "b.js", "c.js"] }, [["a.js", "b.js"]])), null);
});

// ── The Repo tab card ────────────────────────────────────────────────────────
const text = (html) => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&");

test("the Repo tab card says where the app starts and offers the map, with no block map", async () => {
  const { panel, gh } = mapPanel(SMALL_REPO);
  const before = gh.apiCalls.length;
  await panel.fn.fetchRepoMap();
  const html = panel.el("repo-map").innerHTML;
  assert.match(text(html), /How it runs/);
  assert.match(text(html), /Starts in src\/index\.ts · index\.ts → a\.ts/);
  assert.match(text(html), /2 files read/);
  assert.match(html, /id="map-open"/);
  assert.match(html, /id="map-explain"/);
  assert.doesNotMatch(html, /map-block|data-lens|<svg/);
  assert.equal(gh.apiCalls.length - before, 2, "the repo header and the file tree (both shared with the panel); files come from raw");
});
// Every other Repo tab call answers an empty list, so a healthy tab resolves true
const quietTab = (gh, { failSource = false } = {}) => async (url, init) => {
  if (failSource && /raw\.githubusercontent\.com\/.*\/src\//.test(url)) return new Response("boom", { status: 500 });
  const res = await gh.fetch(url, init);
  return res.status === 404 && url.startsWith("https://api.github.com/") ? new Response("[]") : res;
};
test("a map failure leaves the rest of the Repo tab loaded", async () => {
  const { gh } = mapPanel(SMALL_REPO);
  const healthy = loadPanel({ fetch: quietTab(gh) });
  healthy.setRepo();
  assert.equal(await healthy.fn.fetchRepoTab(), true, "baseline: the tab resolves true");
  const p2 = loadPanel({ fetch: quietTab(gh, { failSource: true }) });
  p2.setRepo();
  assert.equal(await p2.fn.fetchRepoTab(), true, "a map failure doesn't mark the tab failed");
  assert.match(p2.el("repo-map").innerHTML, /Try again/);
  assert.ok(p2.el("tech-list").innerHTML !== "", "the rest of the tab still rendered");
});
test("the map card keeps its own class through a load", async () => {
  const { panel } = mapPanel(SMALL_REPO);
  panel.el("repo-map").className = "card repo-map";
  await panel.fn.fetchRepoTab();
  assert.equal(panel.el("repo-map").className, "card repo-map");
});
test("a crawl where every read failed is an error, not a map, and is never stored", async () => {
  const { gh } = mapPanel(SMALL_REPO);
  const down = async (url, init) => url.startsWith("https://raw.githubusercontent.com/") ? new Response("boom", { status: 500 }) : gh.fetch(url, init);
  const panel = loadPanel({ fetch: down });
  panel.setRepo();
  await panel.fn.fetchRepoTab();
  const html = panel.el("repo-map").innerHTML;
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /map-open/);
  assert.equal(panel.chrome.storage.local.data["map_o_r"], undefined);
  assert.equal(panel.run('cacheFor("o/r").map'), undefined);
});
test("a slow map for one repo never draws into the next", async () => {
  const { gh } = mapPanel(SMALL_REPO);
  let release; const gate = new Promise(r => { release = r; });
  const slow = async (url, init) => { if (url.startsWith("https://raw.githubusercontent.com/o/r/")) await gate; return gh.fetch(url, init); };
  const panel = loadPanel({ fetch: slow });
  panel.setRepo();
  const first = panel.fn.fetchRepoTab();
  await tick(20);
  panel.setRepo("o", "other");
  panel.el("repo-map").innerHTML = "";
  release();
  await first;
  await tick(20);
  assert.equal(panel.el("repo-map").innerHTML, "", "nothing drawn for o/r");
  assert.ok(!gh.rawCalls.some(u => /\/src\//.test(u)), "no crawl reads after leaving");
});
test("returning to a repo whose crawl was stopped gets a complete map", async () => {
  const { gh } = mapPanel(SMALL_REPO);
  let release; const gate = new Promise(r => { release = r; });
  const slow = async (url, init) => { if (url.endsWith("/package.json")) await gate; return gh.fetch(url, init); };
  const panel = loadPanel({ fetch: slow });
  panel.setRepo();
  const repo = panel.run("currentRepo");
  let stale = false;
  const first = panel.fn.loadRepoMap(repo, { isStale: () => stale });
  await tick(20);
  stale = true;                 // the user leaves…
  const back = panel.fn.loadRepoMap(repo, { isStale: () => false }); // …and comes back
  release();
  const g = plain(await back);
  await first;
  assert.ok(g.nodes["src/index.ts"] && g.nodes["src/a.ts"], "complete graph, not the stopped one");
});
test("folder names are escaped", async () => {
  const raw = { "package.json": '{"main":"<img src=x onerror=1>/index.js"}', "<img src=x onerror=1>/index.js": "import './b'", "<img src=x onerror=1>/b.js": "" };
  const { panel } = mapPanel(raw);
  await panel.fn.fetchRepoTab();
  const html = panel.el("repo-map").innerHTML;
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
});
test("a private repo waits for a click", async () => {
  const { panel, gh } = mapPanel(SMALL_REPO, { private: true });
  await panel.fn.fetchRepoTab();
  const html = panel.el("repo-map").innerHTML;
  assert.match(text(html), /about 60/);
  assert.match(html, /id="map-open"/, "the tab asks before it reads");
  assert.ok(!gh.apiCalls.some(u => u.startsWith("/contents/src/")), "no source files read yet");
  await panel.fn.fetchRepoMap({ allowPrivate: true });
  assert.ok(gh.apiCalls.some(u => u.startsWith("/contents/src/")));
  assert.match(text(panel.el("repo-map").innerHTML), /Starts in src\/index\.ts/);
});
test("Try again after a failed private load keeps waiting for the click", async () => {
  const { gh } = mapPanel(SMALL_REPO, { private: true });
  let failTree = true;
  const flaky = async (url, init) => {
    if (failTree && url.includes("/git/trees/")) { failTree = false; return new Response("boom", { status: 500 }); }
    return gh.fetch(url, init);
  };
  const panel = loadPanel({ fetch: flaky });
  panel.setRepo();
  await panel.fn.fetchRepoMap();
  const html = panel.el("repo-map").innerHTML;
  assert.match(html, /id="map-retry"/);
  assert.doesNotMatch(html, /data-private/, "this attempt had no consent");
  await panel.fn.handleMapClick({ target: { closest: (s) => (s === "#map-retry" ? { dataset: {} } : null) } });
  assert.match(text(panel.el("repo-map").innerHTML), /about 60/);
  assert.equal(gh.apiCalls.filter(u => u.startsWith("/contents/")).length, 0, "no contents reads");
});
test("Try again after a failed clicked private load keeps its consent", async () => {
  const { gh } = mapPanel(SMALL_REPO, { private: true });
  let failTree = true;
  const panel = loadPanel({ fetch: async (url, init) => {
    if (failTree && url.includes("/git/trees/")) { failTree = false; return new Response("boom", { status: 500 }); }
    return gh.fetch(url, init);
  } });
  panel.setRepo();
  await panel.fn.fetchRepoMap({ allowPrivate: true });
  assert.match(panel.el("repo-map").innerHTML, /id="map-retry"[^>]*data-private="1"/);
  await panel.fn.handleMapClick({ target: { closest: (s) => (s === "#map-retry" ? { dataset: { private: "1" } } : null) } });
  assert.match(text(panel.el("repo-map").innerHTML), /Starts in src\/index\.ts/);
});

// ── What a file says about itself ────────────────────────────────────────────
test("fileSummary takes a file's header comment, docstring or page title", () => {
  const f = pure.fileSummary;
  assert.equal(f("/**\n * Talks to the database.\n * @param x\n */\nexport const db = 1", "src/db.js"), "Talks to the database.");
  assert.equal(f("// Starts the web server on port 3000\nimport x from 'y'", "src/index.js"), "Starts the web server on port 3000");
  assert.equal(f('#!/usr/bin/env python\n"""Command line entry point for the tool.\n\nMore."""\nimport os', "cli.py"), "Command line entry point for the tool.");
  assert.equal(f("<html><head><title>Repolyze</title>", "sidepanel.html"), "Repolyze");
  assert.equal(f('"use strict";\n// Opens the side panel when the toolbar icon is clicked\n', "bg.js"), "Opens the side panel when the toolbar icon is clicked");
});
test("fileSummary skips licences, pragmas and the file's own name, and uses a comment's title line", () => {
  const f = pure.fileSummary;
  assert.equal(f("/* Copyright 2024 Foo. MIT License */\n// Talks to the database\n", "db.js"), "Talks to the database");
  assert.equal(f("// eslint-disable-next-line\nconst x = 1", "a.js"), null);
  assert.equal(f("// ask.js: every AI task runs in Ask\n", "ask.js"), "every AI task runs in Ask");
  assert.equal(f("// ── GitHub layer (shared) ──────────\n// Everything that talks to the API.\n", "github.js"), "GitHub layer (shared)");
  assert.equal(f("import x from 'y'", "a.js"), null);
  assert.ok(f(`// ${"word ".repeat(60)}`, "a.js").length <= 120);
});
test("the crawl stores each file's description on its node", async () => {
  const g = await mapFor({ "package.json": '{"main":"src/index.ts"}', "src/index.ts": '// Starts the app\nimport "./a"', "src/a.ts": "export const a = 1" });
  assert.equal(g.nodes["src/index.ts"].desc, "Starts the app");
  assert.equal(g.nodes["src/a.ts"].desc, undefined);
  assert.equal(g.v, 4);
});
test("a stored map built by an older crawl is read again", async () => {
  const stored = { map_o_r: { sha: "t1", entries: [], nodes: {}, edges: [], order: {}, read: 0, descs: true } };
  const { panel, gh } = mapPanel(SMALL_REPO, { stored });
  const g = plain(await panel.fn.loadRepoMap(panel.run("currentRepo")));
  assert.ok(g.v === 4 && g.nodes["src/index.ts"]);
  assert.ok(gh.rawCalls.some(u => u.endsWith("/src/index.ts")));
});

// ── The flow map: boxes and layout ───────────────────────────────────────────
// index → app → {todos, users} → db; db used by 5 files; a long tail under lib/
function flowGraph() {
  const nodes = {}, edges = [];
  const n = (p, depth, inDegree = 0, extra = {}) => { nodes[p] = { depth, inDegree, read: true, size: 100, ...extra }; };
  n("src/index.js", 0); n("src/app.js", 1, 1); n("routes/todos.js", 2, 1); n("routes/users.js", 2, 1);
  n("src/db.js", 3, 5, { desc: "Talks to the database" });
  for (let i = 0; i < 40; i++) { n(`lib/x${i}.js`, 3, 1); edges.push(["routes/todos.js", `lib/x${i}.js`]); }
  edges.push(["src/index.js", "src/app.js"], ["src/app.js", "routes/todos.js"], ["src/app.js", "routes/users.js"],
    ["routes/todos.js", "src/db.js"], ["routes/users.js", "src/db.js"], ["lib/x0.js", "src/db.js"], ["lib/x1.js", "src/db.js"], ["lib/x2.js", "src/db.js"]);
  return { entries: [{ path: "src/index.js", reason: "package.json main" }], nodes, edges, order: {}, read: 45 };
}
test("flowFiles shows the entry, reading path and core, caps at 12 and folds the rest by folder", () => {
  const f = pure.flowFiles(flowGraph(), {});
  const shown = [...f.shown];
  for (const p of ["src/index.js", "src/app.js", "routes/todos.js", "routes/users.js", "src/db.js"]) assert.ok(shown.includes(p), p);
  assert.equal(shown.length, 12);
  const lib = f.groups.find(g => g.dir === "lib");
  assert.equal(lib.files.size, 40 - (12 - 5), "the files not shown are folded under lib/");
});
test("expanding a folder shows its files, up to 60 boxes", () => {
  const f = pure.flowFiles(flowGraph(), { expanded: new Set(["lib"]) });
  assert.equal(f.shown.size, 45);
  assert.equal(f.groups.length, 0);
});
test("chainTo is the shortest import chain from the entry", () => {
  const g = flowGraph();
  assert.deepEqual(plain(pure.chainTo(g, "src/db.js")), ["src/index.js", "src/app.js", "routes/todos.js", "src/db.js"]);
  assert.deepEqual(plain(pure.chainTo(g, "nope.js")), []);
});
test("a file asked for by the brief joins the boxes with its chain", () => {
  const g = flowGraph();
  const f = pure.flowFiles(g, { extra: new Set(["lib/x39.js"]) });
  assert.ok(f.shown.has("lib/x39.js"));
});
test("flowLayout puts rows by depth, the entry on top, and keeps at most 4 arrows into a shared file", () => {
  const g = flowGraph();
  const lay = pure.flowLayout(g, pure.flowFiles(g, {}));
  assert.deepEqual(plain(lay.rows[0].map(i => i.id)), ["src/index.js"]);
  assert.deepEqual(plain(lay.rows[1].map(i => i.id)), ["src/app.js"]);
  assert.ok(lay.rows.every(r => r.length <= 6), "wide rows wrap");
  const intoDb = lay.edges.filter(e => e.to === "src/db.js");
  assert.ok(intoDb.length <= 4 && intoDb.length >= 2);
  assert.ok(lay.edges.every(e => !e.back || lay.rowIdx.get(e.from) >= lay.rowIdx.get(e.to)));
  assert.deepEqual(plain(pure.flowLayout(g, pure.flowFiles(g, {})).rows.map(r => r.map(i => i.id))), plain(lay.rows.map(r => r.map(i => i.id))), "deterministic");
});
test("flowLayout orders a row to follow what loads it", () => {
  // a loads a1, b loads b1: a1 sits under a's side, b1 under b's
  const nodes = { a: { depth: 0, inDegree: 0 }, b: { depth: 0, inDegree: 0 }, b1: { depth: 1, inDegree: 1 }, a1: { depth: 1, inDegree: 1 } };
  const g = { entries: [{ path: "a" }, { path: "b" }], nodes, edges: [["a", "a1"], ["b", "b1"]], order: {}, read: 4 };
  const lay = pure.flowLayout(g, { shown: new Set(["a", "b", "a1", "b1"]), groups: [], steps: [] });
  const top = plain(lay.rows[0].map(i => i.id)), below = plain(lay.rows[1].map(i => i.id));
  assert.equal(top.indexOf("a") < top.indexOf("b"), below.indexOf("a1") < below.indexOf("b1"));
});

// ── Opening the map tab; the brief's line ────────────────────────────────────
function tabsPanel(openTabs = []) {
  const { panel } = mapPanel(SMALL_REPO);
  const created = [], updated = [], sent = [];
  panel.chrome.runtime = { getURL: (p) => `chrome-extension://id/${p}`, sendMessage: async (m) => { sent.push(m); } };
  panel.chrome.tabs.query = async () => openTabs;
  panel.chrome.tabs.create = (o) => created.push(o.url);
  panel.chrome.tabs.update = (id, o) => updated.push([id, o]);
  return { panel, created, updated, sent };
}
test("Open the map opens the repo's map tab, or focuses the one already open and highlights the file", async () => {
  const a = tabsPanel();
  await a.panel.fn.openMapTab({ owner: "o", repo: "r" }, "src/a.ts");
  assert.deepEqual(a.created, ["chrome-extension://id/map.html?repo=o%2Fr&file=src%2Fa.ts"]);
  const b = tabsPanel([{ id: 7, url: "chrome-extension://id/map.html?repo=o%2Fr" }]);
  await b.panel.fn.openMapTab({ owner: "o", repo: "r" }, "src/a.ts");
  assert.deepEqual(b.created, []);
  assert.deepEqual(plain(b.updated), [[7, { active: true }]]);
  assert.deepEqual(plain(b.sent), [{ type: "map-highlight", repo: "o/r", file: "src/a.ts" }]);
});
test("the map tab's Ask about this file reaches Ask in the panel, only for the panel's repo", () => {
  const { panel } = mapPanel(SMALL_REPO);
  panel.fn.handleMapTabMessage({ type: "map-ask-file", repo: "x/y", file: "src/a.ts" });
  assert.notEqual(panel.el("chat-input").value, "@src/a.ts ");
  panel.fn.handleMapTabMessage({ type: "map-ask-file", repo: "o/r", file: "src/a.ts" });
  assert.equal(panel.el("chat-input").value, "@src/a.ts ");
});
test("briefChain is the chain from the entry, or null when the file isn't reached", () => {
  const g = flowGraph();
  assert.deepEqual(plain(pure.briefChain(g, "routes/users.js")), ["src/index.js", "src/app.js", "routes/users.js"]);
  assert.deepEqual(plain(pure.briefChain(g, "src/index.js")), ["src/index.js"]);
  assert.equal(pure.briefChain(g, "elsewhere.js"), null);
  assert.equal(pure.briefChain(null, "x.js"), null);
});


// ── What to read: pass-through files, helpers, what files define, the overview ─
test("a Python __init__.py that only re-exports is a pass-through file; one with code isn't", () => {
  const pass = (t) => pure.mapIsBarrel(t, "pkg/__init__.py");
  assert.equal(pass(""), true);
  assert.equal(pass('"""Prompts."""\nfrom .base import BasePrompt\nfrom .chat import (\n    Chat,\n    Human,\n)\n__all__ = ["BasePrompt", "Chat"]\n'), true);
  assert.equal(pass('"""Lazy."""\nfrom typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .base import A\n_dynamic_imports = {\n    "A": "base",\n}\ndef __getattr__(name):\n    return import_attr(name)\ndef __dir__():\n    return __all__\n'), true);
  assert.equal(pass("from .base import A\n\nclass B(A):\n    pass\n"), false);
  assert.equal(pass("from .base import A\n\ndef helper():\n    return 1\n"), false);
  assert.equal(pure.mapIsBarrel("from .base import A\n", "pkg/base.py"), false, "only __init__.py");
  assert.equal(pure.mapIsBarrel('export * from "./a";\nexport { b } from "./b";\n', "src/index.ts"), true);
  assert.equal(pure.mapIsBarrel('export * from "./a";\nexport const c = 1;\n', "src/index.ts"), false);
});
test("helpers are recognised by name", () => {
  for (const p of ["src/utils.ts", "pkg/helpers.py", "pkg/constants.py", "pkg/_types.py", "pkg/compat.py", "pkg/exceptions.py", "src/errors.ts", "pkg/logger.py", "pkg/__version__.py", "settings/common.py", "apps/a/admin.py", "pkg/utils/__init__.py"])
    assert.ok(pure.mapIsHelper(p), p);
  for (const p of ["pkg/sessions.py", "src/app.ts", "apps/a/models.py", "src/utilsx.ts"]) assert.ok(!pure.mapIsHelper(p), p);
});
test("mapDefines lists a file's top-level classes and functions", () => {
  assert.deepEqual(plain(pure.mapDefines("class Session(Base):\n    def get(self): pass\n\ndef request(m):\n    pass\ndef _private(): pass\n", "a.py")), ["Session", "request"]);
  assert.deepEqual(plain(pure.mapDefines("export class App {}\nexport async function start() {}\nexport const router = x;\nfunction local() {}\nexports.legacy = 1;\n", "a.ts")), ["App", "start", "router", "legacy"]);
});
test("the crawl records pass-through __init__ files, what each file defines (most imported first) and code files per part", async () => {
  const g = await mapFor({
    "pyproject.toml": '[project.scripts]\ntool = "pkg.cli:main"\n',
    "pkg/__init__.py": '"""The pkg."""\nfrom .sessions import Session\n__all__ = ["Session"]\n',
    "pkg/cli.py": "from pkg.sessions import Session, request\nfrom pkg.models import Response\n",
    "pkg/sessions.py": "from .models import Response\nclass Helper:\n    pass\nclass Session:\n    pass\ndef request():\n    pass\n",
    "pkg/models.py": "class Response:\n    pass\n",
    "tests/test_x.py": "", "docs/conf.py": "",
  });
  assert.equal(g.nodes["pkg/__init__.py"]?.barrel ?? true, true);
  assert.deepEqual(g.nodes["pkg/sessions.py"].defs, ["Session", "request", "Helper"]);
  assert.deepEqual(g.parts, { pkg: 4 });
  assert.equal(g.v, 4);
});

// A requests-like library: helpers everywhere, the work in sessions → adapters → models
function libGraph() {
  const nodes = {}, edges = [];
  const n = (p, extra = {}) => { nodes[p] = { depth: 1, inDegree: 0, read: true, size: 100, ...extra }; };
  ["pkg/__init__.py", "pkg/api.py", "pkg/sessions.py", "pkg/models.py", "pkg/adapters.py", "pkg/hooks.py", "pkg/utils.py", "pkg/compat.py"].forEach(p => n(p));
  nodes["pkg/__init__.py"].depth = 0;
  const e = (a, ...bs) => bs.forEach(b => edges.push([`pkg/${a}.py`, `pkg/${b}.py`]));
  e("__init__", "api", "sessions", "models", "utils", "compat");
  e("api", "sessions", "utils");
  e("sessions", "models", "adapters", "utils", "compat");
  e("models", "hooks", "utils", "compat");
  e("adapters", "models", "utils", "compat");
  for (const [, b] of edges) nodes[b].inDegree++;
  return { entries: [{ path: "pkg/__init__.py", reason: "package" }], nodes, edges, order: {}, read: 8 };
}
test("readingPath follows the files that do the work, a file before the files it uses, never helpers", () => {
  const g = libGraph();
  const p = plain(pure.readingPath(g, pure.rankCore(g)));
  assert.deepEqual(p.map(s => s.path.split("/")[1]), ["__init__.py", "api.py", "sessions.py", "adapters.py", "models.py", "hooks.py"]);
  assert.equal(p[0].reason, "entry point · package");
  assert.match(p[2].reason, /^loaded by ① __init__\.py/);
  assert.ok(!plain(pure.rankCore(g)).some(c => /utils|compat/.test(c.path)), "helpers are never core");
});
test("readingPath stops at 6 steps", () => {
  const nodes = {}, edges = [];
  for (let i = 0; i < 20; i++) { nodes[`f${i}.js`] = node(i ? 1 : 0, i); if (i) edges.push([`f${i - 1}.js`, `f${i}.js`]); }
  assert.equal(plain(pure.readingPath({ entries: [{ path: "f0.js", reason: "r" }], order: {}, nodes, edges }, [])).length, 6);
});
test("when the start loads no code (Django's manage.py), the reading path begins at the file that ties the most together", () => {
  const nodes = {}, edges = [];
  for (const p of ["manage.py", "apps/jobs/views.py", "apps/jobs/models.py", "apps/jobs/serializers.py", "apps/base/models.py", "apps/base/utils.py"]) nodes[p] = node(0, p === "manage.py" ? 0 : 1);
  edges.push(["apps/jobs/views.py", "apps/jobs/models.py"], ["apps/jobs/views.py", "apps/jobs/serializers.py"], ["apps/jobs/views.py", "apps/base/utils.py"],
    ["apps/jobs/serializers.py", "apps/jobs/models.py"], ["apps/jobs/models.py", "apps/base/models.py"]);
  const p = plain(pure.readingPath({ entries: [{ path: "manage.py", reason: "manage.py" }], nodes, edges, order: {}, read: 6 }, []));
  assert.deepEqual(p.map(s => s.path), ["manage.py", "apps/jobs/views.py", "apps/jobs/serializers.py", "apps/jobs/models.py", "apps/base/models.py"]);
});
test("of several packages, the reading path starts at the one the others depend on", () => {
  const nodes = {}, edges = [];
  for (const p of ["libs/app/app_pkg/__init__.py", "libs/app/app_pkg/run.py", "libs/core/core_pkg/__init__.py", "libs/core/core_pkg/base.py"]) nodes[p] = node(0, 0);
  edges.push(["libs/app/app_pkg/__init__.py", "libs/app/app_pkg/run.py"], ["libs/app/app_pkg/run.py", "libs/core/core_pkg/base.py"], ["libs/core/core_pkg/__init__.py", "libs/core/core_pkg/base.py"]);
  const g = { entries: [{ path: "libs/app/app_pkg/__init__.py", reason: "a" }, { path: "libs/core/core_pkg/__init__.py", reason: "b" }], nodes, edges, order: {}, read: 4 };
  assert.equal(plain(pure.readingPath(g, []))[0].path, "libs/core/core_pkg/__init__.py");
});
test("mapView follows imports through pass-through files and marks helpers", () => {
  const nodes = {
    "a.py": node(0, 0), "b.py": node(0, 1), "pkg/__init__.py": node(2, 1, { barrel: true }), "pkg/base.py": node(1, 2), "pkg/chat.py": node(1, 2), "pkg/utils.py": node(1, 2),
  };
  const g = { entries: [{ path: "a.py", reason: "r" }], nodes, order: {}, read: 6,
    edges: [["a.py", "pkg/__init__.py"], ["b.py", "pkg/__init__.py"], ["pkg/__init__.py", "pkg/base.py"], ["pkg/__init__.py", "pkg/chat.py"], ["pkg/chat.py", "pkg/utils.py"]] };
  const v = plain(pure.mapView(g));
  assert.ok(!("pkg/__init__.py" in v.nodes));
  assert.deepEqual(v.edges.filter(([a]) => a === "a.py").map(([, b]) => b).sort(), ["pkg/base.py", "pkg/chat.py"]);
  assert.equal(v.nodes["pkg/base.py"].inDegree, 2);
  assert.equal(v.nodes["pkg/utils.py"].helper, true);
  assert.ok(!v.nodes["pkg/chat.py"].helper);
});
test("the file map shows about 12 files, without pass-through files, and helpers only when asked", () => {
  const g = libGraph();
  const f = pure.flowFiles(g, {});
  assert.ok(!f.shown.has("pkg/utils.py") && !f.shown.has("pkg/compat.py"));
  assert.equal(f.helpers, 2);
  const h = pure.flowFiles(g, { helpers: true });
  assert.ok(h.shown.has("pkg/utils.py"));
  assert.equal(pure.FLOW?.DEFAULT_BOXES ?? 12, 12);
});
test("mapOverview: how it runs with what each file defines, the main parts, and what was left out", () => {
  const g = libGraph();
  g.nodes["pkg/sessions.py"].defs = ["Session", "request"];
  g.nodes["pkg/__init__.py"].desc = "The pkg library";
  g.parts = { pkg: 8, cli: 2 };
  g.nodes["cli/main.py"] = node(0, 1); g.nodes["cli/main.py"].desc = "Command line";
  const o = plain(pure.mapOverview(g));
  assert.deepEqual(o.steps.map(s => s.path.split("/")[1]), ["__init__.py", "api.py", "sessions.py", "adapters.py", "models.py", "hooks.py"]);
  assert.deepEqual(o.steps[2].defs, ["Session", "request"]);
  assert.deepEqual(o.parts.map(p => [p.name, p.files]), [["pkg", 8], ["cli", 2]]);
  assert.equal(o.parts[0].desc, "The pkg library");
  assert.deepEqual(o.parts[0].main.slice(0, 2), ["models", "sessions"]);
  assert.deepEqual(o.hidden, { helpers: 2, pass: 0 });
});
test("an import through a pass-through package links only to the files that define the names it asks for", () => {
  const nodes = {
    "app.py": node(0, 0), "pkg/__init__.py": node(1, 1, { barrel: true, exports: { Runnable: "pkg/base.py", History: "pkg/history.py" } }),
    "pkg/base.py": node(1, 2), "pkg/history.py": node(1, 2), "other.py": node(0, 1),
  };
  const g = { entries: [{ path: "app.py", reason: "r" }], nodes, order: {}, read: 5,
    edges: [["app.py", "pkg/__init__.py"], ["other.py", "pkg/__init__.py"], ["pkg/__init__.py", "pkg/base.py"], ["pkg/__init__.py", "pkg/history.py"]],
    via: { "app.py": { "pkg/__init__.py": ["Runnable"] } } };
  const v = plain(pure.mapView(g));
  assert.deepEqual(v.edges.filter(([a]) => a === "app.py").map(([, b]) => b), ["pkg/base.py"]);
  assert.deepEqual(v.edges.filter(([a]) => a === "other.py").map(([, b]) => b).sort(), ["pkg/base.py", "pkg/history.py"], "names unknown: every file it passes along");
  assert.equal(v.nodes["pkg/history.py"].inDegree, 1);
});
test("the crawl records which names pass through a package, including lazy-import tables", async () => {
  const g = await mapFor({
    "pyproject.toml": '[project.scripts]\ntool = "app.main:run"\n',
    "app/__init__.py": "", "app/main.py": "from pkg import Runnable\nfrom pkg import lazy_thing\n",
    "pkg/__init__.py": 'from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .base import Runnable\n_dynamic_imports = {\n    "Runnable": "base",\n    "lazy_thing": "lazy",\n}\ndef __getattr__(n):\n    pass\n',
    "pkg/base.py": "class Runnable:\n    pass\n", "pkg/lazy.py": "def lazy_thing():\n    pass\n",
  });
  assert.equal(g.nodes["pkg/__init__.py"].barrel, true);
  assert.deepEqual(g.nodes["pkg/__init__.py"].exports, { Runnable: "pkg/base.py", lazy_thing: "pkg/lazy.py" });
  assert.deepEqual(g.via["app/main.py"]["pkg/__init__.py"].sort(), ["Runnable", "lazy_thing"]);
  const v = plain(pure.mapView(g));
  assert.deepEqual(v.edges.filter(([a]) => a === "app/main.py").map(([, b]) => b).sort(), ["pkg/base.py", "pkg/lazy.py"]);
});
test("when no package uses another, the reading path starts in the biggest part, not a playground or a scaffolding tool", () => {
  const nodes = {}, edges = [];
  for (const p of ["packages/create-app/index.js", "playground/a/index.js", "packages/core/src/index.ts", "packages/core/src/server.ts"]) nodes[p] = node(0, 0);
  edges.push(["packages/core/src/index.ts", "packages/core/src/server.ts"]);
  const g = { entries: ["packages/create-app/index.js", "playground/a/index.js", "packages/core/src/index.ts"].map(path => ({ path, reason: "r" })),
    nodes, edges, order: {}, read: 4, parts: { playground: 900, core: 140, "create-app": 30 } };
  assert.equal(plain(pure.readingPath(g, []))[0].path, "packages/core/src/index.ts");
  assert.ok(pure.mapIsHelper("src/flask/debughelpers.py") && pure.mapIsHelper("apps/challenges/aws_utils.py"));
  assert.equal(pure.fileSummary("/**\n * Module dependencies.\n * @private\n */\nvar x = require('x');\n", "lib/app.js"), null);
});
