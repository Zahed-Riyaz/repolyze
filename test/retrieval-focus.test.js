// Retrieval for issue- and PR-focused questions: made-up repos that reproduce
// the patterns that make answers go wrong (the issue names a function the
// question doesn't; the function is deep in a big file; the helper is in
// another file and there's no token; a PR's change imports a helper).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock } = require("./helpers/github-mock");

const blobs = (paths) => paths.map(p => ({ path: p, type: "blob", size: 900 }));
// A 600-line file with `checkLimit` defined far down, and noise everywhere else
const BIG = Array.from({ length: 600 }, (_, i) =>
  i === 479 ? "export function checkLimit(url) {" : i === 480 ? "  return isLoopback(url);" : `const filler${i} = ${i}; // unrelated`).join("\n");

const TREE = { tree: blobs([
  "README.md", "src/providers/memory-provider.ts", "src/policy/foo-policy.ts", "src/net/url.ts", "src/web/panel.ts",
]) };
const RAW = {
  "README.md": "# App\n## Setup\ndocker compose up postgres -d",
  "src/providers/memory-provider.ts": BIG,
  "src/policy/foo-policy.ts": "export function fooRequiresOwner(actor) {\n  return actor.isOwner;\n}\n",
  "src/net/url.ts": "export function isLoopback(url) { return /localhost/.test(url); }",
  "src/web/panel.ts": "export const panel = 1;",
};
const repo = { owner: "o", repo: "r" };
const ISSUE_TEXT = "Issue #9: Local mode rejects private hosts\nThe check is checkLimit. Other endpoints already allow this via fooRequiresOwner.";
const SUMMARY = "Summarise issue #9 in two sentences, then give numbered steps to fix it.";

function panelWith({ token } = {}) {
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE }, { raw: RAW });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "openai"; aiApiKey = "sk-test"`);
  if (token) panel.setToken(token);
  return { gh, panel };
}

test("the issue's text drives retrieval: a function only the issue names is found and sent", async () => {
  const { panel } = panelWith();
  const { context, sources } = await panel.fn.buildChatContext(repo, SUMMARY, null, () => {},
    { about: ISSUE_TEXT, seedFiles: ["src/providers/memory-provider.ts"], picker: false });
  assert.match(context, /480\| export function checkLimit\(url\)/, "the definition deep in the big file is in the excerpt");
  assert.ok(plain(sources).some(s => s.path === "src/providers/memory-provider.ts" && s.start <= 480 && s.end >= 480));
});

test("without a token, a helper the issue names is found by name and read", async () => {
  const { gh, panel } = panelWith();
  const { context, sources } = await panel.fn.buildChatContext(repo, SUMMARY, null, () => {},
    { about: ISSUE_TEXT, seedFiles: ["src/providers/memory-provider.ts"], picker: false });
  assert.match(context, /export function fooRequiresOwner/);
  assert.ok(plain(sources).some(s => s.path === "src/policy/foo-policy.ts" && s.via === "name"));
  assert.ok(!gh.apiCalls.some(u => u.startsWith("/search/code")), "no code search without a token");
});

test("the brief's files are read first, even when the question names none", async () => {
  const { panel } = panelWith();
  const seen = [];
  await panel.fn.buildChatContext(repo, "How do I test this?", null, () => {},
    { about: "Issue #9: something is off", seedFiles: ["src/web/panel.ts"], picker: false, onFiles: (f) => seen.push(...f) });
  assert.deepEqual(plain(seen)[0], { path: "src/web/panel.ts", via: "issue" });
});

test("a PR question reads the changed file at its head and a helper it imports from the default branch", async () => {
  const headFile = 'import { isLoopback } from "../net/url";\nexport function checkLimit(url) {\n  return isLoopback(url) || isPrivate(url);\n}\n';
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE }, { raw: RAW });
  const fetch = async (url, init) => (url.includes("raw.githubusercontent.com/dev/r/sha9/src/providers/memory-provider.ts") ? new Response(headFile) : gh.fetch(url, init));
  const panel = loadPanel({ fetch });
  panel.setRepo();
  panel.run(`aiProvider = "openai"; aiApiKey = "sk-test"`);
  const brief = {
    pr: { number: 12, title: "Allow private hosts", body: "", head: { sha: "sha9", repo: { full_name: "dev/r" } }, base: { ref: "main" }, user: { login: "dev" } },
    files: [{ filename: "src/providers/memory-provider.ts", status: "modified", changes: 3, patch: "@@ -2,2 +2,2 @@\n export function checkLimit(url) {\n-  return isLoopback(url);\n+  return isLoopback(url) || isPrivate(url);" }],
    timeline: [], reviewComments: [], status: { verdict: "Waiting for review", reasons: [] }, checks: null,
  };
  const item = { kind: "pr", number: 12, title: "Allow private hosts", brief };
  const { context, sources } = await panel.fn.buildFocusedContext(repo, item, "What does this change?", null, () => {}, []);
  assert.match(context, /<changed_files_at_head>[\s\S]*3\| {3}return isLoopback\(url\) \|\| isPrivate\(url\);/, "the new version, not the default branch's");
  assert.match(context, /<related_code>[\s\S]*export function isLoopback/, "the helper it imports");
  const src = plain(sources);
  assert.ok(src.some(s => s.path === "src/providers/memory-provider.ts" && s.via === "changed" && s.at.ref === "sha9" && s.at.owner === "dev"));
  assert.ok(src.some(s => s.path === "src/net/url.ts" && !s.at), "related code lives on the default branch");
  assert.ok(!src.some(s => s.path === "src/providers/memory-provider.ts" && !s.at), "the changed file isn't also read from the default branch");
});

test("issue-focused questions tell the model the issue is the source of truth", async () => {
  const { panel } = panelWith();
  const item = { kind: "issue", number: 9, title: "Local mode rejects private hosts",
    brief: { issue: { number: 9, title: "Local mode rejects private hosts", body: "The check is checkLimit.", labels: [], created_at: "2026-01-01" },
      comments: [], availability: { verdict: "Looks free", reasons: [] }, fileSources: [{ path: "src/providers/memory-provider.ts", confidence: "high" }] } };
  const { focus } = await panel.fn.buildFocusedContext(repo, item, SUMMARY, null, () => {}, []);
  assert.match(focus, /use the steps the issue gives, not generic setup commands from the README/);
  assert.match(focus, /If one isn't in the context, say so; never name a different function in its place/);
});

test("an answer that cites nothing, although code was read, is flagged", () => {
  const panel = loadPanel();
  const long = "Change the check so it accepts private hosts. ".repeat(12);
  assert.match(panel.fn.citationNoteHtml(long, [{ path: "a.ts", start: 1, end: 20 }]), /doesn't point to specific lines/);
  assert.equal(panel.fn.citationNoteHtml("Short answer.", [{ path: "a.ts", start: 1, end: 20 }]), "", "short answers aren't flagged");
  assert.equal(panel.fn.citationNoteHtml(long, []), "", "nothing read, nothing to cite");
});

test("names at the end of a sentence still count as code names", () => {
  const { fn } = loadPanel();
  assert.deepEqual(plain(fn.questionIdentifiers("The check is checkLimit. See fooRequiresOwner, and src/a/b.ts.")), ["checkLimit", "fooRequiresOwner"]);
});

// ── The Supermemory pattern: many code-style names, one that matters ─────────
const NOISY = `Local mode only accepts a loopback base URL, see isLoopbackBaseUrl in src/providers/memory-provider.ts.
Both the API (connect/verify) and the worker (save_memory/recall_memory) call the provider.
Serenity memory: endpointTrust: "private", gated by serenityEndpointRequiresOwner.
SANDBOX_PROVIDER docker  AGENT_RUNTIME pi`;

test("code names are ranked: functions first, then types, tool/field names, env vars last", () => {
  const { fn } = loadPanel();
  assert.deepEqual(plain(fn.questionIdentifiers(NOISY)),
    ["isLoopbackBaseUrl", "serenityEndpointRequiresOwner", "endpointTrust", "save_memory", "recall_memory", "SANDBOX_PROVIDER"]);
  assert.deepEqual(plain(fn.questionIdentifiers("Why does `backoff` call retryDelay twice and what is MAX_RETRIES?")), ["backoff", "retryDelay", "MAX_RETRIES"]);
});

test("the helper the issue points to is found even when tool names, fields and env vars come first; unrelated imports aren't followed", async () => {
  const tree = { tree: blobs(["src/providers/memory-provider.ts", "src/policy/serenity-policy.ts", "src/ui/computer.ts", "src/tools/memory-tools.ts", "README.md"]) };
  const raw = {
    "README.md": "# App",
    "src/providers/memory-provider.ts": 'import { renderComputer } from "../ui/computer";\nimport { toolSchema } from "../tools/memory-tools";\nexport function isLoopbackBaseUrl(url) {\n  return /localhost/.test(url);\n}\n',
    "src/policy/serenity-policy.ts": "export function serenityEndpointRequiresOwner(url, actor) {\n  return isPrivate(url) && actor.isOwner;\n}\n",
    "src/ui/computer.ts": "export function renderComputer() {}",
    "src/tools/memory-tools.ts": "export const toolSchema = {};",
  };
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": tree }, { raw });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "openai"; aiApiKey = "sk-test"`);
  const { context, sources } = await panel.fn.buildChatContext(repo, SUMMARY, null, () => {},
    { about: `Issue #1063: Local mode rejects private hosts\n${NOISY}`, seedFiles: ["src/providers/memory-provider.ts"], picker: false });
  const read = [...new Set(plain(sources).map(s => s.path))];
  assert.ok(read.includes("src/policy/serenity-policy.ts"), `the Serenity helper is read (read: ${read.join(", ")})`);
  assert.match(context, /export function serenityEndpointRequiresOwner/);
  assert.ok(!read.includes("src/ui/computer.ts"), "an import that brings in nothing the issue is about isn't followed");
});

// ── Citations written in prose ───────────────────────────────────────────────
test("\"line 58\" next to the one file read in that paragraph counts as a citation and links to it", () => {
  const panel = loadPanel();
  const sources = [{ path: "packages/adapters/src/supermemory-memory-provider.ts", start: 41, end: 80 }, { path: "src/other.ts", start: 1, end: 10 }];
  const text = "In `packages/adapters/src/supermemory-memory-provider.ts`, update parseSupermemoryConnection.\n\n- Change line 58 in `supermemory-memory-provider.ts` to accept private hosts.\n- Also see line 300 of `supermemory-memory-provider.ts`.\n- Compare `src/other.ts` with `supermemory-memory-provider.ts` at line 5.";
  assert.deepEqual(plain(panel.fn.proseCitations(text, sources)).map(c => [c.path.split("/").pop(), c.start]),
    [["supermemory-memory-provider.ts", 58], ["supermemory-memory-provider.ts", 300]], "a paragraph naming two files is ambiguous, so skipped");
  const check = plain(panel.fn.checkCitations(text, sources));
  assert.equal(check.total, 2);
  assert.equal(check.verified, 1);
  assert.deepEqual(check.outOfRange, ["supermemory-memory-provider.ts line 300"]);
  assert.equal(panel.fn.citationNoteHtml(text.repeat(3), sources).includes("doesn't point to specific lines"), false, "no 'uncited' warning");

  const html = panel.fn.linkifyCitations(panel.fn.renderMarkdown(text), { owner: "o", repo: "r" }, "main", sources);
  assert.match(html, /Change <a class="cite cite-prose" href="https:\/\/github\.com\/o\/r\/blob\/main\/packages\/adapters\/src\/supermemory-memory-provider\.ts#L58"[^>]*>line 58<\/a>/);
  assert.match(html, /<a class="cite cite-prose cite-unverified"[^>]*#L300"[^>]*>line 300<\/a>/);
  assert.doesNotMatch(html, /#L5"/, "ambiguous paragraph left alone");
});

test("product names that look like code (GitHub, TypeScript, OAuth) aren't treated as code names", () => {
  const { fn } = loadPanel();
  assert.deepEqual(plain(fn.questionIdentifiers("If GitHub keeps answering slow_down in TypeScript, pollDeviceToken retries; see `GitHub` too")),
    ["pollDeviceToken", "GitHub", "slow_down"], "backticked is kept on purpose; plain GitHub/TypeScript aren't");
});

test("a named function's definition always makes the excerpt, however many lines mention other terms", () => {
  const { fn } = loadPanel();
  const noisy = Array.from({ length: 400 }, (_, i) =>
    i === 300 ? "async function pollDeviceToken(code, interval) {" : `const url${i} = "https://github.com/login"; // github github`).join("\n");
  const ranges = plain(fn.extractSnippets(noisy, ["github", "login"], 6000, ["polldevicetoken", "github"]));
  assert.ok(ranges.some(r => r.start <= 301 && r.end >= 301), `definition line 301 kept (${JSON.stringify(ranges)})`);
});
