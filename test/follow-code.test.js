// Ask accuracy: following imports / code search, citation checks, editing the files read, @file
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply, json } = require("./helpers/github-mock");

const pure = loadPanel().fn;

// ── Imports ──────────────────────────────────────────────────────────────────
test("parseImports reads JS/TS import, export-from, require and dynamic imports", () => {
  const imps = plain(pure.parseImports(`
import Client, { retryDelay, type Options as Opts } from "./retry";
import * as log from '../log';
import "./polyfill";
export { thing } from "./thing.js";
const { parse } = require("./parser");
const lazy = () => import("./lazy");
import React from "react";`, "src/net/client.ts"));
  assert.deepEqual(imps.find(i => i.spec === "./retry").names.sort(), ["Client", "Options", "retryDelay"].sort());
  assert.deepEqual(imps.find(i => i.spec === "./parser").names, ["parse"]);
  for (const spec of ["../log", "./polyfill", "./thing.js", "./lazy", "react"]) assert.ok(imps.some(i => i.spec === spec), spec);
});

test("parseImports reads Python from-imports (relative too) and plain imports", () => {
  const imps = plain(pure.parseImports("from .retry import backoff, jitter as j\nfrom app.models import (User,\nimport app.db\n", "app/net/client.py"));
  assert.deepEqual(imps[0], { spec: ".retry", names: ["backoff", "jitter"], py: true });
  assert.equal(imps[1].spec, "app.models");
  assert.ok(imps.some(i => i.spec === "app.db"));
});

test("resolveImport finds the file behind an import: extensions, index files, ESM .js → .ts, @/ aliases, Python modules", () => {
  const known = new Set(["src/net/retry.ts", "src/log/index.ts", "src/thing.ts", "src/lib/fmt.tsx", "app/net/retry.py", "app/models/__init__.py", "app/net/util.py"]);
  const r = (spec, from, extra = {}) => plain(pure.resolveImport({ spec, names: [], ...extra }, from, known));
  assert.deepEqual(r("./retry", "src/net/client.ts"), ["src/net/retry.ts"]);
  assert.deepEqual(r("../log", "src/net/client.ts"), ["src/log/index.ts"]);
  assert.deepEqual(r("../thing.js", "src/net/client.ts"), ["src/thing.ts"]);
  assert.deepEqual(r("@/lib/fmt", "src/net/client.ts"), ["src/lib/fmt.tsx"]);
  assert.deepEqual(r("react", "src/net/client.ts"), []);
  assert.deepEqual(r(".retry", "app/net/client.py", { py: true }), ["app/net/retry.py"]);
  assert.deepEqual(r("app.models", "app/net/client.py", { py: true }), ["app/models/__init__.py"]);
  assert.deepEqual(r(".", "app/net/client.py", { py: true, names: ["util"] }), ["app/net/util.py"]);
});

test("definesIdentifier spots definitions in several languages, not calls", () => {
  const d = (text, name) => pure.definesIdentifier(text, name);
  assert.ok(d("export function retryDelay(n) {", "retryDelay"));
  assert.ok(d("export const retryDelay = (n) => n * 2;", "retryDelay"));
  assert.ok(d("const retryDelay = async function () {}", "retryDelay"));
  assert.ok(d("class Api {\n  async retryDelay(n: number): Promise<number> {\n", "retryDelay"));
  assert.ok(d("def retry_delay(n):", "retry_delay"));
  assert.ok(d("func (c *Client) RetryDelay(n int) time.Duration {", "RetryDelay"));
  assert.ok(!d("const ms = retryDelay(3);\nif (retryDelay(n)) {", "retryDelay"));
});

test("questionIdentifiers keeps code names from the question, not words or file paths", () => {
  assert.deepEqual(plain(pure.questionIdentifiers("Why does `backoff` call retryDelay twice in src/net/client.ts and what is MAX_RETRIES?")),
    ["backoff", "retryDelay", "MAX_RETRIES"]);
  assert.deepEqual(plain(pure.questionIdentifiers("How do I set it up?")), []);
});

test("relatedFiles ranks the import that brings in a name the question asks about first", () => {
  const known = new Set(["src/client.ts", "src/retry.ts", "src/log.ts", "src/format.ts"]);
  const related = plain(pure.relatedFiles(
    [{ path: "src/client.ts", text: 'import { retryDelay } from "./retry";\nimport { log } from "./log";\nimport { fmt } from "./format";' }],
    known, pure.queryTerms("how does retryDelay work"), ["retryDelay"]));
  assert.equal(related[0].path, "src/retry.ts");
  assert.ok(related[0].score >= 4);
  assert.ok(related.slice(1).every(r => r.score < 1), "unrelated imports stay below the reading threshold");
});

// ── Retrieval flow ───────────────────────────────────────────────────────────
const TREE = { tree: ["README.md", "src/net/client.ts", "src/net/retry.ts", "src/net/log.ts", "src/util/timing.ts", "Makefile"].map(p => ({ path: p, type: "blob", size: 300 })) };
const RAW = {
  "README.md": "# Net",
  "src/net/client.ts": 'import { retryDelay } from "./retry";\nimport { log } from "./log";\nexport function send() {\n  return retryDelay(3);\n}',
  "src/net/retry.ts": "// backoff\nexport function retryDelay(n) {\n  return jitter(2 ** n * 100);\n}",
  "src/net/log.ts": "export const log = console.log;",
  "src/util/timing.ts": "export function jitter(ms) {\n  return ms * Math.random();\n}",
};

function setup({ token, search } = {}) {
  const ai = [];
  const gh = githubMock({
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": TREE,
    "/search/code": search || json({ items: [] }),
  }, {
    raw: RAW,
    ai: async (_url, init) => {
      const body = JSON.parse(init.body);
      ai.push(body);
      return /You choose which source files/.test(body.messages[0].content)
        ? sseReply('["src/net/client.ts"]')
        : sseReply("It waits `retryDelay` ms — see `src/net/retry.ts:2` and `src/net/retry.ts:40` and `src/other.ts:3`.");
    },
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  if (token) panel.setToken(token);
  panel.run(`aiProvider = "openai"; aiApiKey = "sk-test"; chatMessages = [];`);
  return { gh, panel, ai };
}

test("imports of the chosen file are followed: the definition the question asks about is read", async () => {
  const { panel } = setup();
  const seen = [];
  const { context, sources } = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "How is retryDelay computed?", null, () => {},
    { onFiles: (f) => seen.push(...f) });
  assert.match(context, /=== src\/net\/retry\.ts[\s\S]*export function retryDelay/);
  assert.deepEqual(plain(sources).map(s => [s.path, s.via]), [["src/net/client.ts", "picked"], ["src/net/retry.ts", "import"]]);
  assert.deepEqual(plain(seen).map(f => f.via), ["picked", "import"], "the files are announced before the answer");
  assert.ok(!sources.some(s => s.path === "src/net/log.ts"), "unrelated imports aren't read");
});

test("with a token, identifiers nothing read defines are found with code search; without one, no search", async () => {
  const withToken = setup({ token: "ghp_x", search: json({ items: [{ path: "src/util/timing.ts" }] }) });
  const { sources } = await withToken.panel.fn.buildChatContext({ owner: "o", repo: "r" }, "Where is `jitter` defined?", null);
  const search = withToken.gh.apiCalls.find(u => u.startsWith("/search/code"));
  assert.match(decodeURIComponent(search), /q=jitter repo:o\/r/);
  assert.ok(plain(sources).some(s => s.path === "src/util/timing.ts" && s.via === "search"));

  const anon = setup();
  await anon.panel.fn.buildChatContext({ owner: "o", repo: "r" }, "Where is `jitter` defined?", null);
  assert.ok(!anon.gh.apiCalls.some(u => u.startsWith("/search/code")), "anonymous code search isn't allowed");
});

test("an edited file list is read exactly: no picker, no following", async () => {
  const { panel, ai } = setup();
  const { sources } = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "How is retryDelay computed?", null, () => {},
    { files: ["src/util/timing.ts", "nope.ts"] });
  assert.equal(ai.length, 0, "no picker call");
  assert.deepEqual(plain(sources).map(s => [s.path, s.via]), [["src/util/timing.ts", "chosen"]]);
});

test("@ names a file directly, even one without an extension", () => {
  const entries = TREE.tree;
  assert.deepEqual(plain(pure.mentionedFiles("what does @Makefile run and @retry.ts do?", entries)), ["Makefile", "src/net/retry.ts"]);
});

test("re-running an answer on edited files sends those files and saves them as chosen", async () => {
  const { panel, ai } = setup();
  panel.el("chat-input").value = "How is retryDelay computed?";
  await panel.fn.handleChat({ files: ["src/util/timing.ts"] });
  assert.equal(ai.length, 1);
  assert.match(ai[0].messages.at(-1).content, /=== src\/util\/timing\.ts/);
  const saved = plain(panel.chrome.storage.local.data["chat_o_r"]);
  assert.deepEqual(saved[1].sources.map(s => [s.path, s.via]), [["src/util/timing.ts", "chosen"]]);
});

// ── Citation checks ──────────────────────────────────────────────────────────
const SOURCES = [{ path: "src/net/retry.ts", start: 1, end: 20 }, { path: "src/net/client.ts", start: 1, end: 5 }];

test("checkCitations sorts citations into verified, outside what was read, and files not read", () => {
  const c = plain(pure.checkCitations("See `src/net/retry.ts:2`, `retry.ts:4-6`, `src/net/retry.ts:40`, `src/other.ts:3`, `x:1` and `https://a.b:8080`.", SOURCES));
  assert.equal(c.total, 4);
  assert.equal(c.verified, 2);
  assert.deepEqual(c.outOfRange, ["src/net/retry.ts:40"]);
  assert.deepEqual(c.unread, ["src/other.ts:3"]);
  assert.equal(pure.checkCitations("`src/a.ts:900`", [{ path: "src/a.ts" }]).verified, 1, "a PR's changed files cover every line");
});

test("citations are linked when verified, marked when not, and the answer gets a note", () => {
  const panel = setup().panel;
  const html = panel.fn.linkifyCitations(panel.fn.renderMarkdown("`src/net/retry.ts:2` `src/net/retry.ts:40` `src/other.ts:3`"), { owner: "o", repo: "r" }, "main", SOURCES);
  assert.match(html, /<a class="cite" href="[^"]+retry\.ts#L2"/);
  assert.match(html, /<a class="cite cite-unverified" href="[^"]+retry\.ts#L40"[^>]*title="Line 40 wasn't in the code read/);
  assert.match(html, /<span class="cite-unread"[^>]*><code>src\/other\.ts:3<\/code><\/span>/);
  const note = panel.fn.citationNoteHtml("`src/net/retry.ts:40` `src/other.ts:3` `src/net/retry.ts:2`", SOURCES);
  assert.match(note, /2 citations point to code that wasn't read for this answer/);
  assert.equal(panel.fn.citationNoteHtml("`src/net/retry.ts:2`", SOURCES), "");
});

// ── The files row & @ suggestions ────────────────────────────────────────────
test("an answer's file list shows how each file was found and can be edited", () => {
  const panel = setup().panel;
  const html = panel.fn.sourcesHtml([{ path: "src/net/client.ts", start: 1, end: 5, via: "picked" }, { path: "src/net/retry.ts", start: 1, end: 4, via: "import" }], "main", { editable: true });
  assert.match(html, /data-editable="1"[\s\S]*Read 2 files/);
  assert.match(html, /class="source-chip source-followed" data-path="src\/net\/retry\.ts"[\s\S]*imported by a file that was read/);
  assert.equal((html.match(/class="source-remove"/g) || []).length, 2);
  assert.match(html, /class="source-add"[\s\S]*class="btn btn-primary btn-xs source-rerun" hidden/);
  assert.doesNotMatch(panel.fn.sourcesHtml([{ path: "a.ts", start: 1, end: 2 }], "main"), /source-remove|source-add/);
});

test("typing @ suggests files by name; choosing one completes the path", async () => {
  const { panel } = setup();
  assert.deepEqual(plain(panel.fn.suggestFiles(TREE.tree, "re")), ["README.md", "src/net/retry.ts"], "name matches first, shorter paths first");
  assert.deepEqual(plain(panel.fn.suggestFiles(TREE.tree, "net/l")), ["src/net/log.ts"], "or a path fragment");
  const input = panel.el("chat-input");
  input.value = "what does @retr";
  await panel.fn.updateFileSuggest();
  assert.equal(panel.el("file-suggest").hidden, false);
  assert.match(panel.el("file-suggest").innerHTML, /data-path="src\/net\/retry\.ts"/);
  const handled = panel.fn.fileSuggestKeydown({ key: "Enter", preventDefault() {} });
  assert.equal(handled, true, "Enter picks the suggestion instead of sending");
  assert.equal(input.value, "what does @src/net/retry.ts ");
  assert.equal(panel.el("file-suggest").hidden, true);
});
