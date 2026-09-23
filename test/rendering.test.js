// Markdown rendering, citations and small helpers used across the panel
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel } = require("./helpers/panel");

const panel = loadPanel();
const { renderMarkdown, linkifyCitations, escapeHtml, decodeGitHubContent, labelMatchesFilter,
  formatNumber, formatFileTree, avatarUrl } = panel.fn;

test("renderMarkdown escapes HTML before formatting", () => {
  const out = renderMarkdown('<img src=x onerror="alert(1)"> **bold**');
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;img"));
  assert.ok(out.includes("<strong>bold</strong>"));
});

test("renderMarkdown only turns http(s) URLs into links", () => {
  assert.match(renderMarkdown("[ok](https://a.com/b?c=1&d=2)"), /href="https:\/\/a\.com\/b\?c=1&amp;d=2"/);
  assert.ok(!renderMarkdown("[x](javascript:alert(1))").includes("<a"));
  assert.ok(!renderMarkdown('[x](https://a.com" onmouseover="y)').includes("<a"), "no attribute breakout");
});

test("renderMarkdown keeps code blocks intact, blank lines included", () => {
  const out = renderMarkdown("Intro\n\n```js\nconst a = 1;\n\nconst b = **2**;\n```\n\nAfter");
  assert.match(out, /<pre><code>const a = 1;\n\nconst b = \*\*2\*\*;<\/code><\/pre>/);
  assert.ok(!/<pre>[\s\S]*<br>[\s\S]*<\/pre>/.test(out), "no <br> inside code");
});

test("renderMarkdown shows an unclosed fence (mid-stream) as code", () => {
  assert.match(renderMarkdown("Here:\n\n```bash\nnpm install"), /<pre><code>npm install<\/code><\/pre>$/);
});

test("renderMarkdown builds ul and ol lists without stray breaks around blocks", () => {
  const out = renderMarkdown("Steps\n\n1. one\n2. two\n\n* star\n- dash *em*\n\n## Next\ntext");
  assert.match(out, /<ol><li>one<\/li>\n<li>two<\/li>\n<\/ol>/);
  assert.match(out, /<ul><li>star<\/li>\n<li>dash <em>em<\/em><\/li>\n<\/ul>/);
  assert.ok(!/<br>\s*<(ol|ul|h3)/.test(out) && !/<\/(ol|ul|h3)>\s*<br>/.test(out));
});

test("linkifyCitations links only files that were read, with line anchors", () => {
  const repo = { owner: "o", repo: "r" };
  const html = renderMarkdown("See `src/launch/sequence.ts:42`, `sequence.ts:10-20`, `other.ts:3` and `npm test`.");
  const out = linkifyCitations(html, repo, "main", [{ path: "src/launch/sequence.ts", start: 1, end: 80 }]);
  assert.ok(out.includes('href="https://github.com/o/r/blob/main/src/launch/sequence.ts#L42"'));
  assert.ok(out.includes("sequence.ts#L10-L20"));
  assert.ok(!out.includes("other.ts#"));
  assert.ok(!/<a[^>]*><code>npm test/.test(out));
});

test("escapeHtml covers attribute context", () => {
  assert.equal(escapeHtml(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("decodeGitHubContent decodes base64 as UTF-8", () => {
  for (const text of ["héllo wörld 🚀 日本語 — “quotes”", "plain ascii"]) {
    const b64 = Buffer.from(text, "utf8").toString("base64").replace(/(.{60})/g, "$1\n");
    assert.equal(decodeGitHubContent({ content: b64 }), text);
  }
});

test("labelMatchesFilter matches the many spellings of beginner labels", () => {
  for (const name of ["good first issue", "good-first-issue", "Good First Issue 👋", "first-timers-only", "difficulty: beginner", "status: good first issue"]) {
    assert.ok(labelMatchesFilter(name, "good-first-issue"), name);
  }
  for (const name of ["help wanted", "Help-Wanted", "PRs welcome"]) assert.ok(labelMatchesFilter(name, "help-wanted"), name);
  for (const name of ["bug", "enhancement", "not a good first issue candidate"]) assert.ok(!labelMatchesFilter(name, "good-first-issue"), name);
});

test("formatNumber abbreviates thousands", () => {
  assert.equal(formatNumber(999), "999");
  assert.equal(formatNumber(48213), "48.2k");
});

test("formatFileTree skips noise directories and deep paths", () => {
  const tree = { entries: [
    { path: "src", type: "tree" }, { path: "src/app.js", type: "blob" },
    { path: "node_modules", type: "tree" }, { path: "node_modules/x/i.js", type: "blob" },
    { path: "a/b/c/d/e.js", type: "blob" },
  ], truncated: false };
  assert.equal(formatFileTree(tree), "src/\nsrc/app.js");
});

test("avatarUrl requests a sized image and tolerates bad input", () => {
  assert.equal(avatarUrl("https://avatars.githubusercontent.com/u/1?v=4", 64), "https://avatars.githubusercontent.com/u/1?v=4&s=64");
  assert.equal(avatarUrl("not a url", 64), "not a url");
});
