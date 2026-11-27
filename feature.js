// feature.js — "How does X work?": the functions to read, in the order they run.
// Step 1 needs no AI: rank and read the likely files (raw, free on public repos), pull out their functions,
// score each against the question's words (name > docstring > body), link them by calls, order callers first.
// The AI is only asked past a fixed threshold (FEATURE_THRESHOLD), and only gets a numbered index of
// function signatures to pick from — never whole files. Loaded by the side panel and the map tab.

const FEATURE = {
  FILES_PUBLIC: 12,   // raw reads, free
  FILES_PRIVATE: 6,   // contents API, costs requests
  STEPS: 6,
  INDEX: 80,          // entries the AI may pick from
  NAME: 3, DOC: 1.5, BODY: 0.5, BODY_MAX: 3, HELPER: 0.6,
};
// Confident (no AI): ≥ 2 functions with a question word in their name, those functions' names and docstrings
// covering ≥ 2/3 of the question's words (both words of a two-word question — at 50%, EvalAI's "how does a
// submission get scored" passed on "submission" alone), and ≥ 2 steps linked by a call.
// Partial (AI on a click): ≥ 1 name match otherwise. Nothing (AI runs at once): no name or docstring hit at all.
const FEATURE_THRESHOLD = { NAME_MATCHES: 2, COVERAGE: 2 / 3, LINKED: 2 };

// Words that say what kind of thing is asked about, not which thing
const FEATURE_FILLER = new Set(queryTerms("feature features function functions method methods class classes logic flow " +
  "happen happens happening implementation part parts system thing things process processes step steps call calls called"));

function featureTerms(question) {
  return queryTerms(question).filter(t => !FEATURE_FILLER.has(t) && !GENERIC_WORDS.has(t));
}

// "score_submission" / "scoreSubmission" → ["score", "submission"], stemmed
function featureNameWords(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3).map(stemWord);
}
// A word matches a term when one starts with the other (stems differ: "scor" / "score")
const featureWordHit = (w, t) => w === t || (Math.min(w.length, t.length) >= 3 && (w.startsWith(t) || t.startsWith(w)));
const featureTextWords = (text) => (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3).map(stemWord);

const FEATURE_JS_SKIP = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "constructor"]);

// The functions and classes in a file: { name, line (1-based), doc, body }. Python ends a function by
// indentation; JS/TS at the next function or class start (good enough to see what it calls).
function codeFunctions(text, path) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  if (/\.py$/.test(path)) {
    lines.forEach((l, i) => {
      const m = l.match(/^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
      if (!m) return;
      const indent = m[1].length;
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || lines[end].match(/^\s*/)[0].length > indent)) end++;
      const body = lines.slice(i + 1, end).join("\n");
      const doc = body.match(/^\s*[rRuU]?("""|''')\s*([\s\S]*?)\1/);
      out.push({ name: m[3], line: i + 1, doc: doc ? featureFirstLine(doc[2]) : null, body });
    });
    return out;
  }
  const starts = [];
  lines.forEach((l, i) => {
    let m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/)
      || l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/)
      || l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/)
      || l.match(/^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/);
    if (m && !FEATURE_JS_SKIP.has(m[1])) starts.push({ name: m[1], i });
  });
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    // A /** … */ or // comment right above it
    let doc = null;
    let j = s.i - 1;
    if (j >= 0 && /\*\/\s*$/.test(lines[j])) {
      let a = j;
      while (a > 0 && !/\/\*/.test(lines[a])) a--;
      doc = featureFirstLine(lines.slice(a, j + 1).join("\n").replace(/\/\*\*?|\*\//g, "").replace(/^\s*\*\s?/gm, ""));
    } else if (j >= 0 && /^\s*\/\//.test(lines[j])) doc = featureFirstLine(lines[j].replace(/^\s*\/\/+\s?/, ""));
    out.push({ name: s.name, line: s.i + 1, doc, body: lines.slice(s.i + 1, end).join("\n") });
  });
  return out;
}
function featureFirstLine(text) {
  const line = String(text).split("\n").map(l => l.trim()).find(l => l && !/^@/.test(l));
  if (!line) return null;
  return line.length > 120 ? line.slice(0, 117).trimEnd() + "…" : line;
}

// Score every function against the terms; link them by calls; pick and order the steps; judge the threshold.
// files: [{ path, text }]; depth: (path) → import depth on the map (smaller = nearer the start), optional.
function featureTrace(question, files, { depth = () => 99 } = {}) {
  const terms = featureTerms(question);
  const fns = [];
  for (const f of files) {
    if (f.text == null) continue;
    for (const fn of codeFunctions(f.text, f.path)) fns.push({ ...fn, path: f.path });
  }
  const scored = fns.map(fn => {
    const nameW = featureNameWords(fn.name), docW = featureTextWords(fn.doc);
    // Calls are read from the body with nested definitions taken out
    const callText = fn.body.replace(/^\s*(?:async\s+)?(?:def|class|function)\s+\w+.*$/gm, "");
    const bodyW = new Set(featureTextWords(callText));
    const nameHits = terms.filter(t => nameW.some(w => featureWordHit(w, t)));
    const docHits = terms.filter(t => docW.some(w => featureWordHit(w, t)));
    const bodyHits = terms.filter(t => [...bodyW].some(w => featureWordHit(w, t)));
    // Helper files (utils, debughelpers…) rank lower, not out: a feature sometimes lives in one
    const score = (FEATURE.NAME * nameHits.length + FEATURE.DOC * docHits.length + FEATURE.BODY * Math.min(FEATURE.BODY_MAX, bodyHits.length))
      * (mapIsHelper(fn.path) ? FEATURE.HELPER : 1);
    return { ...fn, callText, nameHits, docHits, score };
  });

  // Candidates: a word in the name or docstring; best first
  const cands = scored.filter(f => f.nameHits.length || f.docHits.length)
    .sort((a, b) => b.score - a.score || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, FEATURE.STEPS);
  const key = (f) => `${f.path}#${f.name}#${f.line}`;
  const calls = new Map(cands.map(f => [key(f), new Set()]));
  for (const f of cands) for (const g of cands) {
    if (f === g) continue;
    if (new RegExp(`(^|[^\\w$])${g.name.replace(/\$/g, "\\$")}\\s*\\(`).test(f.callText)) calls.get(key(f)).add(key(g));
  }
  const linked = new Set();
  for (const [f, gs] of calls) for (const g of gs) { linked.add(f); linked.add(g); }

  // Callers before what they call; otherwise nearer the start, then by score
  const rest = [...cands], steps = [];
  while (rest.length) {
    const i = rest.findIndex(f => !rest.some(g => g !== f && calls.get(key(g)).has(key(f))));
    steps.push(...rest.splice(i < 0 ? 0 : i, 1));
  }

  const nameMatches = cands.filter(f => f.nameHits.length).length;
  const covered = new Set(cands.flatMap(f => [...f.nameHits, ...f.docHits]));
  const coverage = terms.length ? covered.size / terms.length : 0;
  const kind = !cands.length ? "none"
    : nameMatches >= FEATURE_THRESHOLD.NAME_MATCHES && coverage >= FEATURE_THRESHOLD.COVERAGE - 1e-9 && linked.size >= FEATURE_THRESHOLD.LINKED ? "confident"
    : nameMatches >= 1 ? "partial" : "none";

  // The index the AI may pick from: every function in the files read, steps first
  const index = [...steps, ...scored.filter(f => !cands.includes(f))].slice(0, FEATURE.INDEX)
    .map((f, i) => ({ n: i + 1, path: f.path, name: f.name, line: f.line, doc: f.doc }));

  return {
    terms,
    steps: kind === "none" ? [] : steps.map(f => ({ path: f.path, name: f.name, line: f.line, doc: f.doc, by: f.nameHits.length ? "name" : "docstring", calls: [...calls.get(key(f))].map(k => k.split("#")[1]) })),
    verdict: { kind, nameMatches, coverage: Math.round(coverage * 100) / 100, linked: linked.size, matched: [...covered], missing: terms.filter(t => !covered.has(t)) },
    index,
  };
}

// ── The AI's part: pick from the index ───────────────────────────────────────
const FEATURE_PICK_SYSTEM = `You map a question about how a feature works to the functions that implement it.
Pick ONLY from the numbered list you are given — never name anything that is not on it.
Reply with ONLY a JSON array, in the order the functions run, at most 6 items, for example [{"n": 3, "why": "accepts the upload"}, {"n": 12, "why": "scores it"}].
"why" is at most 12 words: what that function does for this feature. Reply [] if nothing on the list fits.`;

function featurePickPrompt(question, found, index) {
  const list = index.map(e => `${e.n}. ${e.path}${e.line ? `:${e.line}` : ""} ${e.name}${e.doc ? ` — ${e.doc}` : ""}`).join("\n");
  const already = found.length ? `\nAlready found by name (keep the ones that belong, add what's missing, fix the order):\n${found.map(f => `- ${f.path}:${f.line} ${f.name}`).join("\n")}\n` : "";
  return `Question: ${question}\n${already}\nFunctions:\n${list}`;
}

// The AI's reply → [{ n, why }], only numbers on the list, each once, ≤ 6
function parseFeaturePicks(reply, size) {
  const m = String(reply || "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const seen = new Set(), out = [];
  for (const x of arr) {
    const n = Number(x?.n);
    if (!Number.isInteger(n) || n < 1 || n > size || seen.has(n)) continue;
    seen.add(n);
    out.push({ n, why: typeof x.why === "string" ? x.why.trim().slice(0, 100) : "" });
    if (out.length >= FEATURE.STEPS) break;
  }
  return out;
}

// ── Reading the likely files ─────────────────────────────────────────────────
// Path ranking, then files whose recorded names (map defs) contain a word, then — signed in — code search
// for the two strongest words. Public: ≤ 12 raw reads (free); private: ≤ 6 contents requests.
async function traceFeature(question, repo = currentRepo, graph = null, { isPrivate = false } = {}) {
  const terms = featureTerms(question);
  const tree = await getRepoTree(repo);
  const cap = isPrivate ? FEATURE.FILES_PRIVATE : FEATURE.FILES_PUBLIC;
  const code = (tree.entries || []).filter(e => isCodeCandidate(e) && !TEST_PATH.test(e.path) && !/\.(md|mdx|ya?ml|toml|json)$/i.test(e.path));
  const known = new Set(code.map(e => e.path));
  const picked = [];
  const add = (p) => { if (known.has(p) && !picked.includes(p) && picked.length < cap) picked.push(p); };
  if (terms.length) {
    rankCodeFiles(code, terms).filter(c => c.score >= 1).slice(0, Math.ceil(cap / 2)).forEach(c => add(c.path));
    const nodes = graph?.nodes || {};
    Object.keys(nodes).filter(p => (nodes[p].defs || []).some(d => featureNameWords(d).some(w => terms.some(t => featureWordHit(w, t)))))
      .sort((a, b) => (nodes[b].inDegree || 0) - (nodes[a].inDegree || 0) || a.localeCompare(b)).forEach(add);
    if (typeof githubToken !== "undefined" && githubToken) {
      for (const w of searchWords(question, 2)) {
        try { (await searchCodeFor(w, repo)).forEach(add); } catch { /* code search is a bonus */ }
      }
    }
    rankCodeFiles(code, terms).filter(c => c.score >= 1).forEach(c => add(c.path));
  }
  // Nothing matched by path or name: the map's most important files, so the AI's index isn't empty
  if (graph?.nodes && picked.length < cap) {
    try { readingPath(graph, rankCore(graph)).forEach(s => add(s.path)); rankCore(graph).forEach(c => add(c.path)); } catch { /* no map */ }
  }
  const files = await Promise.all(picked.map(async path => ({ path, text: await readRepoFile(path, repo).catch(() => null) })));
  const view = graph ? mapView(graph) : null;
  const depth = (p) => view?.nodes?.[p]?.depth ?? 99;
  const trace = featureTrace(question, files, { depth });
  return { ...trace, read: files.filter(f => f.text != null).length };
}

// The AI's picks → steps, in its order, with its reasons
function featureStepsFromPicks(picks, index) {
  return picks.map(p => ({ ...index[p.n - 1], why: p.why, by: "ai" })).filter(s => s.path);
}
