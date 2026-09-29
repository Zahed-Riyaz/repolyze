// ── Retrieval eval ───────────────────────────────────────────────────────────
// Runs made-up issues about this repo (eval/issues.js) through the two paths a
// real user hits, and scores them against the code a correct answer needs:
//   brief — the issue brief's "Where to start" (resolveIssueFiles): is a needed
//           file in its first 5?
//   ask   — Ask's retrieval for "Summary & plan": are the needed files read, and
//           is each needed function's definition line in what's sent?
// This repo is served from disk as if it were on GitHub (eval/ itself excluded),
// so it's offline and repeatable. Without a model, the file picker's fallback
// (path ranking) stands in for it; set EVAL_AI_PROVIDER and EVAL_AI_KEY to use a
// real one (e.g. groq / gsk_…). Not part of `npm test`: it measures, it doesn't pass or fail.
// By default it runs signed in, with GitHub code search answered from the files
// on disk; --anonymous runs signed out (no code search), the harder case.
//
//   npm run eval                  table per issue + a summary per level
//   npm run eval -- --anonymous   signed out
//   npm run eval -- --json        the same as JSON

const fs = require("fs");
const path = require("path");
const { loadPanel } = require("../test/helpers/panel");
const ISSUES = require("./issues");

const ROOT = path.join(__dirname, "..");
const SKIP = new Set([".git", "node_modules", "eval"]);
const REPO = { owner: "local", repo: "this-repo" };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel, out);
    else out.push({ path: rel, type: "blob", size: fs.statSync(path.join(ROOT, rel)).size });
  }
  return out;
}
const TREE = walk("");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// GitHub, served from disk; AI hosts pass through only when a real model is configured
const useAI = !!(process.env.EVAL_AI_PROVIDER && process.env.EVAL_AI_KEY);
const anonymous = process.argv.includes("--anonymous");

// GitHub code search, approximated from disk: code files containing every word,
// most mentions first (GitHub ranks differently, but finds the same files)
function localCodeSearch(q) {
  const words = q.split(/\s+/).filter(w => w && !w.startsWith("repo:")).map(w => w.toLowerCase());
  return TREE.filter(e => /\.(m?js|ts|py|go|rs|json|html|css)$/.test(e.path))
    .map(e => {
      const text = fs.readFileSync(path.join(ROOT, e.path), "utf8").toLowerCase();
      const counts = words.map(w => text.split(w).length - 1);
      return { path: e.path, hits: counts.every(c => c > 0) ? counts.reduce((a, b) => a + b, 0) : 0 };
    })
    .filter(r => r.hits).sort((a, b) => b.hits - a.hits).map(r => ({ path: r.path }));
}
const realFetch = globalThis.fetch;
async function fetchLocal(url, init) {
  const u = new URL(url);
  if (u.host === "raw.githubusercontent.com") {
    const p = decodeURIComponent(u.pathname.split("/").slice(4).join("/"));
    return TREE.some(e => e.path === p) ? new Response(fs.readFileSync(path.join(ROOT, p), "utf8")) : new Response("404", { status: 404 });
  }
  if (u.host === "api.github.com") {
    const p = u.pathname.replace(`/repos/${REPO.owner}/${REPO.repo}`, "");
    if (p === "") return json({ default_branch: "main" });
    if (p === "/git/trees/HEAD") return json({ tree: TREE });
    if (u.pathname === "/search/code") return json({ items: localCodeSearch(u.searchParams.get("q") || "").slice(0, Number(u.searchParams.get("per_page")) || 5) });
    return json({ message: "Not Found" }, 404);
  }
  if (useAI) return realFetch(url, init);
  throw new Error("no model in this eval run"); // → the picker falls back to path ranking
}

const SUMMARY = (n) => `Summarise issue #${n} in two sentences: what's broken or missing, and what "done" looks like. Then give numbered steps to fix it, each naming the file and function to change and what to change, including how to reproduce it first and which test to add.`;

// The line a function is defined on in a local file (1-based), or null
function definitionLine(panel, file, name) {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  const i = lines.findIndex(l => panel.fn.definesIdentifier(l, name));
  return i < 0 ? null : i + 1;
}

async function runOne(panel, issue, n) {
  const gh = { number: n, title: issue.title, body: issue.body, labels: [], state: "open", comments: 0, assignees: [], created_at: "2026-01-01T00:00:00Z" };
  const briefFiles = await panel.fn.resolveIssueFiles(REPO, gh, { comments: [], timeline: [] });
  const briefTop = briefFiles.slice(0, 5).map(f => f.path);
  const { sources } = await panel.fn.buildChatContext(REPO, SUMMARY(n), issue.title, () => {}, {
    about: `Issue #${n}: ${issue.title}\n${issue.body}`,
    seedFiles: briefFiles.filter(f => f.confidence !== "low").map(f => f.path),
  });
  const read = [...new Set(sources.map(s => s.path))];

  const need = issue.expect.files;
  const hit = (list) => (issue.expect.any ? need.some(f => list.includes(f)) : need.every(f => list.includes(f)));
  const defs = (issue.expect.defs || []).map(name => {
    const file = need.find(f => definitionLine(panel, f, name));
    const line = file && definitionLine(panel, file, name);
    const sent = !!line && sources.some(s => s.path === file && s.start <= line && s.end >= line);
    return { name, file, line, sent };
  });
  return {
    level: issue.level, n, title: issue.title,
    brief: hit(briefTop), ask: hit(read), defs, pass: hit(read) && defs.every(d => d.sent),
    briefTop, read,
  };
}

async function main() {
  const panel = loadPanel({ fetch: fetchLocal });
  panel.run(`currentRepo = ${JSON.stringify(REPO)}; onRepoPage = true;`);
  if (!anonymous) panel.setToken("eval-token"); // signed in → code search (answered from disk)
  panel.run(useAI ? `aiProvider = ${JSON.stringify(process.env.EVAL_AI_PROVIDER)}; aiApiKey = ${JSON.stringify(process.env.EVAL_AI_KEY)}` : `aiProvider = "openai"; aiApiKey = "none"`);

  const results = [];
  for (const [i, issue] of ISSUES.entries()) results.push(await runOne(panel, issue, i + 1));

  if (process.argv.includes("--json")) { console.log(JSON.stringify(results, null, 2)); return; }
  const mark = (b) => (b ? "✓" : "✗");
  console.log(`Retrieval eval — ${ISSUES.length} made-up issues about this repo · ${anonymous ? "signed out" : "signed in (code search from disk)"} · picker: ${useAI ? process.env.EVAL_AI_PROVIDER : "path ranking (no model)"}\n`);
  console.log("lvl  #   brief  ask  defs   issue");
  for (const r of results) {
    const d = r.defs.length ? `${r.defs.filter(x => x.sent).length}/${r.defs.length}` : " – ";
    console.log(` ${r.level}  ${String(r.n).padStart(2)}    ${mark(r.brief)}     ${mark(r.ask)}   ${d.padEnd(4)}   ${r.title}`);
    if (!r.pass) {
      console.log(`         read: ${r.read.join(", ") || "(nothing)"}`);
      for (const d of r.defs.filter(x => !x.sent)) console.log(`         missing: ${d.name} (${d.file || "not found"}${d.line ? `:${d.line}` : ""})`);
    }
  }
  console.log("\nBy level (issues where Ask got everything it needed):");
  for (let lvl = 1; lvl <= 5; lvl++) {
    const rs = results.filter(r => r.level === lvl);
    if (!rs.length) continue;
    const ok = rs.filter(r => r.pass).length;
    console.log(`  level ${lvl}: ${ok}/${rs.length}   brief found a needed file: ${rs.filter(r => r.brief).length}/${rs.length}`);
  }
  const total = results.filter(r => r.pass).length;
  console.log(`  overall: ${total}/${results.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
