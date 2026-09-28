// ── Your stack: how well an issue fits you ───────────────────────────────────
// Once you're signed in, the panel learns what you work with from your own
// public GitHub repos (their languages, topics and descriptions) and your
// profile bio. Each issue is then scored on two things it can check without AI:
//   • the languages of the files it likely touches (path ranking on its title
//     and body, as in the brief's "Likely files"), or languages it names;
//   • technologies it mentions that appear in your repos or bio.
// Every issue row lists the stack it requires (issueStack): no AI, and shown
// whether or not you're signed in. Signed in, the parts you know are brighter
// and "Best fit for you" sorts by a score that's relative to the repo: what's
// true of almost every issue here (the repo's main language, a term most issues
// mention) doesn't lift one issue above another.
// Built from public data, kept in chrome.storage.local, refreshed daily, and
// editable in Settings (hide what's wrong, add what's missing).
// Cost: ≤8 API requests a day (profile, repo list, languages of 6 recent repos).

const STACK_TTL_MS = DAY_MS;
const STACK_LANG_REPOS = 6;

let stackProfile = null;   // effective profile (detected + your edits), or null
let stackLoading = null;   // in-flight load

// File extension → GitHub linguist language
const EXT_LANG = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", rb: "Ruby", php: "PHP",
  cs: "C#", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", c: "C", h: "C", swift: "Swift", m: "Objective-C",
  scala: "Scala", ex: "Elixir", exs: "Elixir", dart: "Dart", hs: "Haskell", lua: "Lua", jl: "Julia",
  vue: "Vue", svelte: "Svelte", css: "CSS", scss: "SCSS", html: "HTML", sh: "Shell", bash: "Shell",
  sql: "SQL", r: "R", zig: "Zig", clj: "Clojure", erl: "Erlang", ml: "OCaml", fs: "F#", tf: "HCL", dockerfile: "Dockerfile",
};
const LANGUAGES = [...new Set(Object.values(EXT_LANG))];

// Ways an issue might name a language ("golang", not "go"; "c++", "csharp"…)
const LANG_MENTIONS = [
  ["TypeScript", /\btypescript\b/i], ["JavaScript", /\bjavascript\b/i], ["Python", /\bpython\b/i],
  ["Go", /\bgolang\b/i], ["Rust", /\brust\b/i], ["Java", /\bjava\b(?!script)/i], ["Kotlin", /\bkotlin\b/i],
  ["Ruby", /\bruby\b/i], ["PHP", /\bphp\b/i], ["C#", /(?:\bc#|\bcsharp\b)/i], ["C++", /(?:\bc\+\+|\bcpp\b)/i],
  ["Swift", /\bswift\b/i], ["Scala", /\bscala\b/i], ["Elixir", /\belixir\b/i], ["Dart", /\bdart\b/i],
  ["Haskell", /\bhaskell\b/i], ["Lua", /\blua\b/i], ["Julia", /\bjulia\b/i], ["Shell", /\b(?:bash|shell script)\b/i],
];

// Technologies worth matching, with the spellings people use. Only these are
// read from descriptions and bios, so ordinary words never count.
const TECH_TERMS = {
  "react": ["react", "reactjs", "react native"], "vue": ["vue", "vuejs", "nuxt"], "angular": ["angular"],
  "svelte": ["svelte", "sveltekit"], "next.js": ["next.js", "nextjs"], "node.js": ["node.js", "nodejs", "node"],
  "deno": ["deno"], "bun": ["bun"], "express": ["express"], "nestjs": ["nestjs"], "django": ["django"],
  "flask": ["flask"], "fastapi": ["fastapi"], "rails": ["rails", "ruby on rails"], "spring": ["spring boot", "spring"],
  ".net": [".net", "dotnet", "asp.net"], "laravel": ["laravel"], "graphql": ["graphql"], "grpc": ["grpc", "protobuf"],
  "rest api": ["rest api", "restful"], "websocket": ["websocket", "websockets"], "tailwind": ["tailwind", "tailwindcss"],
  "css": ["css"], "docker": ["docker", "dockerfile", "container"], "kubernetes": ["kubernetes", "k8s", "helm"],
  "terraform": ["terraform"], "aws": ["aws", "lambda", "s3"], "gcp": ["gcp", "google cloud"], "azure": ["azure"],
  "postgres": ["postgres", "postgresql"], "mysql": ["mysql"], "sqlite": ["sqlite"], "mongodb": ["mongodb", "mongo"],
  "redis": ["redis"], "kafka": ["kafka"], "elasticsearch": ["elasticsearch"], "prisma": ["prisma"],
  "pytorch": ["pytorch", "torch"], "tensorflow": ["tensorflow", "keras"], "pandas": ["pandas"], "numpy": ["numpy"],
  "machine learning": ["machine learning", "deep learning"], "llm": ["llm", "llms", "large language model"],
  "langchain": ["langchain", "langgraph"], "openai": ["openai"], "rag": ["rag", "retrieval-augmented"],
  "cli": ["cli", "command-line", "command line"], "testing": ["jest", "vitest", "pytest", "playwright", "cypress", "unit test"],
  "ci/cd": ["github actions", "ci/cd", "ci pipeline"], "webpack": ["webpack", "vite", "rollup", "esbuild"],
  "electron": ["electron"], "chrome extension": ["chrome extension", "browser extension"], "android": ["android"],
  "ios": ["ios", "swiftui"], "flutter": ["flutter"], "wasm": ["wasm", "webassembly"], "embedded": ["embedded", "arduino", "firmware"],
  "security": ["oauth", "authentication", "jwt", "encryption"], "accessibility": ["accessibility", "a11y", "aria"],
  "i18n": ["i18n", "localization", "translation"], "documentation": ["documentation", "docs"],
};

const termRegexCache = new Map();
function termRegex(term) {
  if (!termRegexCache.has(term)) {
    const forms = TECH_TERMS[term] || [term];
    const alts = forms.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "[\\s-]+"));
    termRegexCache.set(term, new RegExp(`(?:^|[^\\w.])(?:${alts.join("|")})(?![\\w])`, "i"));
  }
  return termRegexCache.get(term);
}

// How technologies are written when shown ("postgres" → "Postgres")
const TECH_NAMES = {
  "node.js": "Node.js", "next.js": "Next.js", ".net": ".NET", "nestjs": "NestJS", "fastapi": "FastAPI", "graphql": "GraphQL",
  "grpc": "gRPC", "rest api": "REST API", "aws": "AWS", "gcp": "GCP", "postgres": "Postgres", "mysql": "MySQL", "sqlite": "SQLite",
  "mongodb": "MongoDB", "pytorch": "PyTorch", "tensorflow": "TensorFlow", "numpy": "NumPy", "llm": "LLMs", "langchain": "LangChain",
  "openai": "OpenAI", "rag": "RAG", "cli": "CLI", "ci/cd": "CI/CD", "css": "CSS", "ios": "iOS", "wasm": "Wasm", "i18n": "i18n",
  "webpack": "Bundlers", "chrome extension": "Browser extensions", "machine learning": "Machine learning", "rest": "REST",
};
const techName = (term) => TECH_NAMES[term] || term.charAt(0).toUpperCase() + term.slice(1);

// Known technologies named in free text → canonical terms
function techTermsIn(text) {
  const found = [];
  for (const term of Object.keys(TECH_TERMS)) if (termRegex(term).test(text || "")) found.push(term);
  return found;
}

function languageOfPath(path) {
  const name = path.toLowerCase().split("/").pop();
  if (name === "dockerfile") return "Dockerfile";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return EXT_LANG[ext] || null;
}

function languagesMentioned(text) {
  return LANG_MENTIONS.filter(([, re]) => re.test(text || "")).map(([lang]) => lang);
}

// Your public repos (+ bio) → { login, languages: [{ name, share }], terms: [{ term, weight }], repos }
// Recent repos count most; forks aren't yours; archived ones count half.
function buildStackProfile({ login, bio = "", repos = [], repoLanguages = {}, now = Date.now() }) {
  const langs = new Map();
  const terms = new Map();
  const add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  const own = repos.filter(r => !r.fork);
  for (const r of own) {
    const age = (now - Date.parse(r.pushed_at || r.updated_at || 0)) / DAY_MS;
    const w = (age <= 365 ? 1 : age <= 3 * 365 ? 0.5 : 0.25) * (r.archived ? 0.5 : 1);
    const bytes = repoLanguages[r.full_name];
    const total = bytes ? Object.values(bytes).reduce((a, b) => a + b, 0) : 0;
    if (total) for (const [lang, b] of Object.entries(bytes)) add(langs, lang, w * b / total);
    else if (r.language) add(langs, r.language, w);
    for (const t of techTermsIn([r.description || "", ...(r.topics || [])].join(" "))) add(terms, t, w);
  }
  for (const t of techTermsIn(bio)) add(terms, t, 1.5);
  for (const lang of languagesMentioned(bio)) add(langs, lang, 0.5);

  const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
  const topTerm = Math.max(1e-9, ...terms.values());
  return {
    login,
    languages: [...langs].map(([name, w]) => ({ name, share: w / langTotal }))
      .filter(l => l.share >= 0.03).sort((a, b) => b.share - a.share).slice(0, 8),
    terms: [...terms].map(([term, w]) => ({ term, weight: w / topTerm }))
      .sort((a, b) => b.weight - a.weight).slice(0, 20),
    repos: own.length,
    updatedAt: now,
  };
}

// Detected profile + what the user hid or added in Settings
function applyStackEdits(profile, edits = {}) {
  if (!profile) return null;
  const hidden = new Set((edits.hidden || []).map(s => s.toLowerCase()));
  const languages = profile.languages.filter(l => !hidden.has(l.name.toLowerCase()));
  const terms = profile.terms.filter(t => !hidden.has(t.term.toLowerCase()));
  for (const raw of edits.added || []) {
    const lang = LANGUAGES.find(l => l.toLowerCase() === raw.toLowerCase());
    if (lang && !languages.some(l => l.name === lang)) languages.push({ name: lang, share: 0.2, added: true });
    else if (!lang && !terms.some(t => t.term === raw.toLowerCase())) terms.push({ term: raw.toLowerCase(), weight: 1, added: true });
  }
  return { ...profile, languages, terms };
}

// How well an issue fits the profile → { score 0–100, tier, reasons[], other[] }.
// `likelyPaths` are the files it probably touches. `ctx` makes it relative:
//   repoLangs — share of the repo's code files per language (a match in the
//               language 95% of the repo is written in barely counts)
//   termDf    — share of the loaded issues mentioning each of your terms
//               (a term most issues mention stops counting)
// `other` are languages it needs that aren't in your repos (a nudge, not a penalty).
function issueFit(issue, profile, likelyPaths = [], ctx = {}) {
  if (!profile) return null;
  const repoLangs = ctx.repoLangs || new Map();
  const termDf = ctx.termDf || new Map();
  const text = `${issue.title} ${(issue.body || "").slice(0, 2000)} ${(issue.labels || []).map(l => l.name).join(" ")}`;
  const share = new Map(profile.languages.map(l => [l.name, l.share]));
  const needed = new Map(); // language → a file that shows it (or null if only named)
  for (const p of likelyPaths) {
    const lang = languageOfPath(p);
    if (lang && !needed.has(lang)) needed.set(lang, p);
  }
  for (const lang of languagesMentioned(text)) if (!needed.has(lang)) needed.set(lang, null);

  const reasons = [];
  const other = [];
  let langPts = 0;
  for (const [lang, path] of needed) {
    const s = share.get(lang);
    if (!s) { other.push(lang); continue; }
    const pts = (30 + 30 * Math.min(1, s / 0.4)) * (1 - (repoLangs.get(lang) || 0)); // rarer in the repo → counts more
    if (pts < 12) continue; // true of most of the repo: said once, above the list
    langPts = Math.max(langPts, pts);
    reasons.push(path ? `${lang} — ${path}` : `${lang} (mentioned)`);
  }
  let termPts = 0;
  for (const t of profile.terms) {
    if (!termRegex(t.term).test(text)) continue;
    const rarity = 1 - Math.min(1, (termDf.get(t.term) || 0) / 0.4); // in 40%+ of issues → no longer special
    if (rarity <= 0) continue;
    termPts += (12 + 13 * t.weight) * rarity;
    if (reasons.filter(r => !r.includes(" — ") && !r.endsWith("(mentioned)")).length < 3) reasons.push(`mentions ${t.term}`);
  }
  const score = Math.round(Math.min(100, langPts + Math.min(40, termPts)));
  return { score, tier: score >= 55 ? "great" : score >= 30 ? "good" : null, reasons: score >= 30 ? reasons : [], other };
}

// Share of the repo's code files per language (from the tree — no request)
function repoLanguageShare(candidates) {
  const counts = new Map();
  let total = 0;
  for (const c of candidates) {
    const lang = languageOfPath(c.path);
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) || 0) + 1);
    total++;
  }
  return new Map([...counts].map(([l, n]) => [l, n / (total || 1)]));
}

// Share of the loaded issues that mention each of your terms
function termDocFreq(items, profile) {
  const df = new Map();
  for (const t of profile.terms) {
    const n = items.filter(i => termRegex(t.term).test(`${i.title} ${(i.body || "").slice(0, 2000)}`)).length;
    df.set(t.term, items.length ? n / items.length : 0);
  }
  return df;
}

// The best-matching code paths for some terms, without sorting the whole tree
// (called for every issue on a page, so it scans once and keeps the top few)
function topCodePaths(candidates, terms, n = 3) {
  const top = [];
  for (const c of candidates) {
    const score = scorePath(c.path, terms);
    if (score < 1) continue;
    if (top.length < n) { top.push({ path: c.path, score }); top.sort((a, b) => b.score - a.score); continue; }
    if (score > top[n - 1].score) { top[n - 1] = { path: c.path, score }; top.sort((a, b) => b.score - a.score); }
  }
  return top.map(t => t.path);
}

// ── Loading ──────────────────────────────────────────────────────────────────
async function fetchStackProfile(login) {
  const [user, repos] = await Promise.all([
    fetchGitHub(`https://api.github.com/users/${encodeURIComponent(login)}`, null).catch(() => ({})),
    fetchGitHub(`https://api.github.com/users/${encodeURIComponent(login)}/repos?type=owner&sort=pushed&direction=desc&per_page=100`, null),
  ]);
  const recent = (repos || []).filter(r => !r.fork && r.size > 0).slice(0, STACK_LANG_REPOS);
  const langs = await Promise.all(recent.map(r => fetchGitHub(r.languages_url, null).catch(() => null)));
  const repoLanguages = Object.fromEntries(recent.map((r, i) => [r.full_name, langs[i]]).filter(([, l]) => l));
  return buildStackProfile({ login, bio: user.bio || "", repos: repos || [], repoLanguages });
}

// Signed in → your effective profile (from storage if fresh, else rebuilt)
function loadStackProfile({ refresh = false } = {}) {
  if (!githubToken || !githubUser?.login) { stackProfile = null; return Promise.resolve(null); }
  if (stackLoading && !refresh) return stackLoading;
  const login = githubUser.login;
  stackLoading = (async () => {
    const stored = await chrome.storage.local.get(["stackProfile", "stackEdits"]);
    let profile = stored.stackProfile;
    if (refresh || !profile || profile.login !== login || Date.now() - profile.updatedAt > STACK_TTL_MS) {
      profile = await fetchStackProfile(login);
      await chrome.storage.local.set({ stackProfile: profile });
    }
    if (githubUser?.login !== login) return null; // signed out or switched meanwhile
    stackProfile = applyStackEdits(profile, stored.stackEdits);
    return stackProfile;
  })().catch(() => null).finally(() => { stackLoading = null; });
  return stackLoading;
}

// Fit for each issue on a page (cached per repo). Needs the tree for likely files.
// What an issue requires → [{ name, kind: "lang" | "tech", key, from }]: the
// languages of the files it likely touches (`from` = that file), languages it
// names, then technologies it mentions. Independent of who's looking.
function issueStack(issue, likelyPaths = []) {
  const text = `${issue.title} ${(issue.body || "").slice(0, 2000)} ${(issue.labels || []).map(l => l.name).join(" ")}`;
  const out = [];
  const seen = new Set();
  const add = (item) => { if (!seen.has(item.key)) { seen.add(item.key); out.push(item); } };
  for (const p of likelyPaths) {
    const lang = languageOfPath(p);
    if (lang) add({ name: lang, kind: "lang", key: lang.toLowerCase(), from: p });
  }
  for (const lang of languagesMentioned(text)) add({ name: lang, kind: "lang", key: lang.toLowerCase(), from: null });
  for (const term of techTermsIn(text).filter(t => t !== "documentation").slice(0, 4)) add({ name: techName(term), kind: "tech", key: term, from: null });
  return out.slice(0, 5);
}

// Does your stack include this requirement?
function knowsStackItem(item, profile) {
  if (!profile) return false;
  return item.kind === "lang"
    ? profile.languages.some(l => l.name.toLowerCase() === item.key)
    : profile.terms.some(t => t.term === item.key);
}

// The text an issue or PR is matched on (a PR's branch name often names the area)
function itemText(item) {
  const branch = item.head?.ref ? ` ${item.head.ref.replace(/[-_/]+/g, " ")}` : "";
  return `${item.title} ${(item.body || "").slice(0, 600)}${branch}`;
}

// Each item's likely files, required stack and (signed in) fit, cached per repo
// and per list ("issue" / "pr"): fit is relative to what's common in that list.
// Likely files need the tree, which is shared with briefs and Ask.
async function annotateStacks(repo, items, kind = "issue") {
  if (!items?.length) return;
  const cache = cacheFor(repoKey(repo));
  const paths = (cache.fitPaths ??= new Map()); // number → likely files (the slow part, done once; issue and PR numbers never clash)
  const tree = await getRepoTree(repo).catch(() => null);
  if (!tree) return;
  const candidates = (tree.codeCandidates ??= tree.entries.filter(isCodeCandidate));
  for (const item of items) {
    if (!paths.has(item.number)) paths.set(item.number, topCodePaths(candidates, queryTerms(itemText(item))));
  }
  const set = { stacks: new Map(items.map(i => [i.number, issueStack(i, paths.get(i.number))])), fits: null, ctx: null };
  if (stackProfile) {
    // Fit depends on the whole loaded list (what's common), so it's redone each time
    set.ctx = { repoLangs: (cache.repoLangs ??= repoLanguageShare(candidates)), termDf: termDocFreq(items, stackProfile) };
    set.fits = new Map(items.map(i => [i.number, issueFit(i, stackProfile, paths.get(i.number), set.ctx)]));
  }
  (cache.stackSets ??= {})[kind] = set;
}

function fitFor(number, kind = "issue") {
  return currentRepo && stackProfile ? cacheFor(repoKey()).stackSets?.[kind]?.fits?.get(number) || null : null;
}

function stackFor(number, kind = "issue") {
  return currentRepo ? cacheFor(repoKey()).stackSets?.[kind]?.stacks?.get(number) || null : null;
}

// Loaded items, best fit first (ties keep GitHub's order)
function sortByFit(items, kind) {
  return items.map((it, i) => ({ it, i, s: fitFor(it.number, kind)?.score ?? 0 }))
    .sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.it);
}

// A PR's stack from the files it actually changes: languages by how much of the
// PR is in them (the most-changed file shown for each), then tech it names
function prStack(pr, files = []) {
  const byLang = new Map();
  for (const f of files) {
    const lang = languageOfPath(f.filename);
    if (!lang) continue;
    const e = byLang.get(lang) || { changes: 0, top: null };
    e.changes += f.changes || 0;
    if (!e.top || (f.changes || 0) > (e.top.changes || 0)) e.top = f;
    byLang.set(lang, e);
  }
  const langs = [...byLang].sort((a, b) => b[1].changes - a[1].changes).slice(0, 4)
    .map(([lang, e]) => ({ name: lang, kind: "lang", key: lang.toLowerCase(), from: e.top.filename }));
  const named = issueStack({ title: pr.title, body: pr.body, labels: pr.labels }, []).filter(i => !langs.some(l => l.key === i.key));
  return [...langs, ...named].slice(0, 6);
}

// A row's line of what the issue or PR requires; the parts you know are brighter
function stackLineHtml(stack, profile = stackProfile) {
  if (!stack?.length) return "";
  return `<span class="row-stack">${stack.map(item => {
    const known = knowsStackItem(item, profile);
    const title = item.from ? `${item.name} — ${item.from}` : `${item.name} — named in the text`;
    return `<span class="stack-tag${known ? " is-known" : ""}" title="${escapeHtml(title + (known ? " · in your stack" : ""))}">${escapeHtml(item.name)}</span>`;
  }).join("")}</span>`;
}

// The brief's section: what it requires (or touches), with the file behind each language
function stackSectionHtml(stack, profile = stackProfile, title = "What it requires") {
  if (!stack?.length) return "";
  return `<section class="brief-section">
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <ul class="stack-needs">${stack.map(item => `
        <li class="${knowsStackItem(item, profile) ? "is-known" : ""}"><strong>${escapeHtml(item.name)}</strong>${item.from ? ` <code>${escapeHtml(item.from)}</code>` : item.kind === "lang" ? ` <span>named in the text</span>` : ""}</li>`).join("")}
      </ul>
    </section>`;
}

// ── Settings: Your stack ─────────────────────────────────────────────────────
async function renderStackCard() {
  const card = document.getElementById("sp-stack-card");
  if (!githubToken || !githubUser?.login) { card.hidden = true; return; }
  card.hidden = false;
  const body = document.getElementById("sp-stack-body");
  if (!stackProfile) {
    body.innerHTML = `<p class="sp-help-links">Reading your public repos…</p>`;
    await loadStackProfile();
    if (!stackProfile) { body.innerHTML = `<p class="sp-help-links">Couldn't read your repos just now. <a href="#" class="stack-refresh">Try again</a></p>`; return; }
  }
  const p = stackProfile;
  const chip = (label, key, extra = "") =>
    `<span class="stack-chip${extra}">${escapeHtml(label)}<button class="stack-hide" data-key="${escapeHtml(key)}" title="Not me — don't use this" aria-label="Hide ${escapeHtml(key)}">${icon("x", "icon-sm")}</button></span>`;
  body.innerHTML = `
    <div class="stack-chips">${p.languages.map(l => chip(`${l.name}${l.added ? "" : ` ${Math.round(l.share * 100)}%`}`, l.name, " is-lang")).join("")}</div>
    ${p.terms.length ? `<div class="stack-chips">${p.terms.map(t => chip(t.term, t.term)).join("")}</div>` : ""}
    <input id="sp-stack-add" class="input" placeholder="Add a language or technology, then Enter" aria-label="Add to your stack">
    <p class="sp-help-links">From your ${p.repos} public repo${p.repos === 1 ? "" : "s"} and profile · updated ${daysAgo(new Date(p.updatedAt).toISOString())} ·
      <a href="#" class="stack-refresh">Refresh</a> · <a href="#" class="stack-reset">Undo my edits</a></p>`;
}

async function editStack(change) {
  const { stackEdits = { hidden: [], added: [] } } = await chrome.storage.local.get(["stackEdits"]);
  const edits = { hidden: [...(stackEdits.hidden || [])], added: [...(stackEdits.added || [])] };
  change(edits);
  await chrome.storage.local.set({ stackEdits: edits });
  stackProfile = null;
  await loadStackProfile();
  await renderStackCard();
  onStackChanged();
}

function handleStackCardClick(e) {
  const t = e.target;
  const hide = t.closest?.(".stack-hide");
  if (hide) {
    const key = hide.dataset.key;
    editStack((ed) => { ed.hidden.push(key); ed.added = ed.added.filter(a => a.toLowerCase() !== key.toLowerCase()); });
    return;
  }
  if (t.closest?.(".stack-refresh")) {
    e.preventDefault();
    stackProfile = null;
    document.getElementById("sp-stack-body").innerHTML = `<p class="sp-help-links">Reading your public repos…</p>`;
    loadStackProfile({ refresh: true }).then(() => { renderStackCard(); onStackChanged(); });
    return;
  }
  if (t.closest?.(".stack-reset")) {
    e.preventDefault();
    editStack((ed) => { ed.hidden = []; ed.added = []; });
  }
}

function handleStackCardKeydown(e) {
  if (e.target.id !== "sp-stack-add" || e.key !== "Enter") return;
  e.preventDefault();
  const value = e.target.value.trim();
  if (!value) return;
  editStack((ed) => {
    ed.added.push(value);
    ed.hidden = ed.hidden.filter(h => h.toLowerCase() !== value.toLowerCase());
  });
}

// The profile changed (loaded, edited, signed out): rescore what's on screen
function onStackChanged() {
  if (currentRepo) delete cacheFor(repoKey()).stackSets;
  if (currentRepo && onRepoPage && loadedTabs.has("contribute")) { fetchIssues(); fetchPrList(); }
}
