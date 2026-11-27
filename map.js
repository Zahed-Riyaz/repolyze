// map.js — the repo map in its own tab (map.html?repo=owner/name[&file=path]).
// Opens on the overview (how it runs, the main parts); the file map is one click away — boxes are files,
// arrows are "loads". The crawl, the overview and the layout (mapOverview, flowFiles, flowLayout) are in
// territory.js; this file draws and handles the page. 0 API requests on public repos.

let currentRepo = null;
const params = new URLSearchParams(location.search);
const [repoOwner, repoName] = (params.get("repo") || "").split("/");
if (repoOwner && repoName) currentRepo = { owner: repoOwner, repo: repoName };
const isCurrentRepo = (key) => !!currentRepo && repoKey() === key;
if (typeof escapeHtml !== "function") {
  // eslint-disable-next-line no-var
  var escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const $ = (id) => document.getElementById(id);
const fm = { graph: null, branch: "HEAD", view: "overview", helpers: false, expanded: new Set(), extra: new Set(), sel: null, hover: null, folder: null, drawn: false, dirty: true, scale: 1, x: 0, y: 0, layout: null, colour: new Map() };

// ── Drawing ──────────────────────────────────────────────────────────────────
// Each folder (a top folder, or two levels under src/, apps/, packages/…) gets a colour, biggest first
const FM_PALETTE = ["#4493f8", "#a371f7", "#2da44e", "#e5534b", "#d29922", "#1b9aaa", "#db61a2", "#768390"];
const FM_USED_TOP = 6; // "Used by N files" only on the most-used few
const fmArea = (path) => mapAreaOf(path);
// One colour per part, the same in both views: the overview's parts first, then the file map's other folders
function fmColours(paths) {
  const count = new Map();
  for (const p of paths) count.set(fmArea(p), (count.get(fmArea(p)) || 0) + 1);
  for (const a of [...count.keys()].sort((a, b) => count.get(b) - count.get(a) || a.localeCompare(b)))
    if (!fm.colour.has(a)) fm.colour.set(a, FM_PALETTE[fm.colour.size % FM_PALETTE.length]);
  return fm.colour;
}
// A long folder keeps its end, which is the part that tells folders apart: libs/core/langchain_core/messages/ → …/langchain_core/messages/
function fmShortDir(dir) {
  const segs = dir.replace(/\/$/, "").split("/").filter(Boolean);
  return segs.length > 2 ? `…/${segs.slice(-2).join("/")}/` : dir;
}
// A package's front file (__init__.py, index.ts) is named after its folder: `prompts/`
function fmName(path) {
  const parts = path.split("/");
  const name = mapShortName(path, fm.graph);
  parts.splice(name.endsWith("/") ? -2 : -1);
  return { name, dir: parts.length ? parts.join("/") + "/" : "" };
}
const fmOrdinal = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");

function fileBoxHtml(graph, path, steps, look) {
  const n = graph.nodes[path];
  const entry = graph.entries.find(e => e.path === path);
  const step = steps.find(s => s.path === path);
  const { name, dir } = fmName(path);
  const used = look.used.has(path);
  const tags = [];
  if (entry) tags.push(`<span class="fm-tag start" title="${escapeHtml(entry.reason || "")}">▶ Starts here</span>`);
  if (used) tags.push(`<span class="fm-tag core">Used by ${n.inDegree} files</span>`);
  const role = graph.roles?.[path];
  const desc = n.desc
    ? `<div class="fm-desc">${escapeHtml(n.desc)}</div>`
    : role ? `<div class="fm-desc"><span class="fm-ai" title="Written by your AI">AI</span>${escapeHtml(role)}</div>`
    : n.read === false ? `<div class="fm-desc none">Not read (repo too large)</div>` : "";
  const url = `https://github.com/${encodeURIComponent(currentRepo.owner)}/${encodeURIComponent(currentRepo.repo)}/blob/${encodeURIComponent(fm.branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const label = [path, entry && "starts here", step && `read ${fmOrdinal(step.step)}`, n.inDegree && `used by ${n.inDegree} files`, n.desc || role].filter(Boolean).join(" · ");
  return `<div class="fm-box${entry ? " entry" : ""}" data-path="${escapeHtml(path)}" data-area="${escapeHtml(fmArea(path))}" style="--c:${look.colour.get(fmArea(path))};--r:${look.r};--i:${look.i}" tabindex="0" role="button" aria-label="${escapeHtml(label)}" title="${escapeHtml(path)}${n.inDegree ? ` · used by ${n.inDegree} files` : ""}">
    <div class="fm-top"><span class="fm-name">${escapeHtml(name)}</span>${step ? `<span class="fm-step" title="Read ${fmOrdinal(step.step)}">${step.step}</span>` : ""}</div>
    ${dir ? `<div class="fm-folder" title="${escapeHtml(dir)}"><i></i><span>${escapeHtml(fmShortDir(dir))}</span></div>` : ""}
    ${tags.length ? `<div class="fm-tags">${tags.join("")}</div>` : ""}
    ${desc}
    <div class="fm-actions"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">GitHub ↗</a><button type="button" data-ask="${escapeHtml(path)}">Ask about this file</button></div>
  </div>`;
}

function groupBoxHtml(g, look) {
  const n = g.files.size;
  const segs = g.dir === "(root)" ? [] : g.dir.split("/");
  const name = segs.length ? segs[segs.length - 1] + "/" : "the root";
  const parent = segs.length > 1 ? fmShortDir(segs.slice(0, -1).join("/") + "/") : "";
  return `<div class="fm-box fm-group" data-group="${escapeHtml(g.dir)}" style="--r:${look.r};--i:${look.i}" tabindex="0" role="button" title="${escapeHtml(g.dir === "(root)" ? "the root" : g.dir + "/")}" aria-label="${n} more files in ${escapeHtml(g.dir)}, click to show">
    <span class="fm-group-n">+${n} more in</span><b>${escapeHtml(name)}</b>${parent ? `<span class="fm-group-dir">${escapeHtml(parent)}</span>` : ""}<div class="fm-desc">click to show</div></div>`;
}

const fmRowName = (d) => d === 0 ? "Starts here" : d === 1 ? "1 step away" : `${d} steps away`;

function draw() {
  if (fm.view !== "files") { fm.dirty = true; return; } // boxes are measured, so drawn only when shown
  fm.dirty = false;
  const graph = mapView(fm.graph);
  const files = flowFiles(graph, { expanded: fm.expanded, extra: fm.extra, helpers: fm.helpers });
  const lay = flowLayout(graph, files);
  fm.files = files; fm.layout = lay;
  const colour = fmColours([...files.shown]);
  const used = new Set([...files.shown].filter(p => graph.nodes[p].inDegree >= 3)
    .sort((a, b) => graph.nodes[b].inDegree - graph.nodes[a].inDegree).slice(0, FM_USED_TOP));
  // Within a row, files sit with their folder; folded groups go last
  const rows = lay.rows.map(r => [...r].sort((a, b) => (a.kind === "group") - (b.kind === "group")
    || (a.kind === "file" && b.kind === "file" ? fmArea(a.id).localeCompare(fmArea(b.id)) || graph.nodes[b.id].inDegree - graph.nodes[a.id].inDegree : 0)));

  const boxes = $("fm-boxes");
  boxes.innerHTML = rows.flatMap((r, ri) => r.map((it, i) => {
    const look = { colour, used, r: ri, i };
    return it.kind === "group" ? groupBoxHtml(it.group, look) : fileBoxHtml(graph, it.id, files.steps, look);
  })).join("");
  if (fm.drawn) boxes.classList.add("settled");
  fm.drawn = true;
  const el = new Map([...boxes.children].map(b => [b.dataset.path || `group:${b.dataset.group}`, b]));

  // Place: rows centred, heights measured after render; room on the left for the row labels
  const LABEL = 130, ROW_WRAP_GAP = 22;
  const rowW = (r) => r.length * FLOW.BOX_W + (r.length - 1) * FLOW.GAP_X;
  const inner = Math.max(...rows.map(rowW));
  const width = LABEL + inner + FLOW.PAD * 2;
  const rect = new Map(), bands = [];
  let y = FLOW.PAD + 16;
  rows.forEach((r, ri) => {
    const depth = Math.min(...r.map(it => it.depth ?? 0));
    const sameBand = bands.length && bands[bands.length - 1].depth === depth;
    if (ri && sameBand) y += ROW_WRAP_GAP - FLOW.GAP_Y;
    if (!sameBand) bands.push({ depth, top: y });
    let x = FLOW.PAD + LABEL + (inner - rowW(r)) / 2;
    const h = Math.max(...r.map(it => el.get(it.id).offsetHeight));
    for (const it of r) {
      const b = el.get(it.id);
      b.style.left = x + "px"; b.style.top = y + "px";
      rect.set(it.id, { x, y, w: FLOW.BOX_W, h: b.offsetHeight });
      x += FLOW.BOX_W + FLOW.GAP_X;
    }
    y += h;
    bands[bands.length - 1].bottom = y;
    y += FLOW.GAP_Y;
  });
  const height = y - FLOW.GAP_Y + FLOW.PAD + 16;
  fm.rect = rect; fm.size = { width, height };
  boxes.insertAdjacentHTML("afterbegin", bands.map(b =>
    `<div class="fm-band" style="left:${FLOW.PAD - 10}px;top:${b.top - 16}px;width:${width - FLOW.PAD * 2 + 20}px;height:${b.bottom - b.top + 32}px"><div class="fm-band-label"><b>${b.depth === 0 ? "▶" : b.depth}</b>${fmRowName(b.depth)}</div></div>`).join(""));

  // Every arrow is drawn, hidden; pointing at or picking a file shows its own
  const svg = $("fm-edges");
  svg.setAttribute("width", width); svg.setAttribute("height", height);
  const paths = lay.allEdges.map(e => {
    const a = rect.get(e.from), b = rect.get(e.to);
    if (!a || !b) return "";
    let x1 = a.x + a.w / 2, x2 = b.x + b.w / 2, y1, y2, c1, c2;
    if (b.y > a.y + a.h) { y1 = a.y + a.h; y2 = b.y - 3; const k = Math.max(34, (y2 - y1) / 2); c1 = y1 + k; c2 = y2 - k; }
    else if (b.y + b.h < a.y) { y1 = a.y; y2 = b.y + b.h + 3; const k = Math.max(34, (y1 - y2) / 2); c1 = y1 - k; c2 = y2 + k; }
    else { // same row: a loop underneath
      const dir = x2 > x1 ? 1 : -1;
      x1 += dir * 30; x2 -= dir * 30; y1 = a.y + a.h; y2 = b.y + b.h + 3; c1 = y1 + 46; c2 = y2 + 46;
    }
    return `<path class="fm-e" d="M${x1},${y1} C${x1},${c1} ${x2},${c2} ${x2},${y2}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}"/>`;
  }).join("");
  const marker = (k) => `<marker id="fm-m-${k}" class="${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,1 L9,5 L0,9 z"/></marker>`;
  svg.innerHTML = `<defs>${marker("out")}${marker("in")}</defs>${paths}`;

  $("fm-legend").innerHTML = [...colour].map(([a, c]) =>
    `<button type="button" class="fm-chip${fm.folder === a ? " on" : ""}" data-area="${escapeHtml(a)}" style="--c:${c}" aria-pressed="${fm.folder === a}"><i></i>${escapeHtml(a)}</button>`).join("");
  $("fm-hint").hidden = false;
  $("fm-helpers").textContent = fm.helpers ? "Hide helpers" : `Show helpers (${files.helpers})`;
  $("fm-helpers").hidden = !files.helpers;
  summary(files);
  applySelection();
}

function summary(files) {
  const g = fm.graph;
  const start = g.entries[0]?.path;
  const chain = files.steps.slice(0, 3).map(s => `<code>${escapeHtml(s.path.split("/").pop())}</code>`).join(" → ");
  $("fm-summary").innerHTML = start
    ? `Starts in <code>${escapeHtml(start)}</code> · ${chain}${files.steps.length > 3 ? " → …" : ""} · ${files.shown.size} of ${g.read} files shown`
    : "No starting file found.";
  const notes = [];
  if (globalScripts(g)) notes.push("These scripts share one global scope — they don't import each other, so arrows show the order the page loads them.");
  if (g.topup) notes.push(`<code>${escapeHtml(start || "The start")}</code> doesn't import most of the code (frameworks often load files by name), so ${g.topup} files were also read from the main folders. Arrows are their imports.`);
  if (g.truncated) notes.push(`Large repo: read the first ${g.read} files from the start.`);
  if (g.untraced?.length) notes.push(`Not followed: ${escapeHtml(g.untraced.join(", "))} (only JavaScript, TypeScript and Python imports are traced).`);
  $("fm-note").hidden = !notes.length;
  $("fm-note").innerHTML = notes.join(" ");
}

// ── The overview: how it runs, the main parts ──────────────────────────────
function renderOverview() {
  const o = mapOverview(fm.graph);
  fm.overview = o;
  o.parts.forEach(p => { if (!fm.colour.has(p.name)) fm.colour.set(p.name, FM_PALETTE[fm.colour.size % FM_PALETTE.length]); });
  const colourOf = (path) => fm.colour.get(fmArea(path)) || "var(--fg-subtle)";
  const steps = o.steps.map((s, i) => {
    const { name, dir } = fmName(s.path);
    const where = s.pkg ? `${dir || ""}${dir ? " · " : ""}package` : dir;
    return `<li class="fm-ov-step${i ? "" : " start"}" style="--i:${i};--c:${colourOf(s.path)}">
      <div class="fm-ov-rail"><span class="fm-ov-num">${i ? i : "▶"}</span><span class="fm-ov-line"></span></div>
      <button type="button" class="fm-ov-card" data-path="${escapeHtml(s.path)}" title="${escapeHtml(s.reason)}">
        <span class="fm-ov-top"><span class="fm-ov-name">${escapeHtml(name)}</span>${i ? "" : `<span class="fm-tag start">▶ Starts here</span>`}</span>
        ${where ? `<span class="fm-folder" title="${escapeHtml(dir)}"><i></i><span>${escapeHtml(s.pkg ? `${dir ? fmShortDir(dir) + " · " : ""}package` : fmShortDir(dir))}</span></span>` : ""}
        ${s.desc ? `<span class="fm-ov-desc">${escapeHtml(s.desc)}</span>` : ""}
        ${s.defs.length ? `<span class="fm-ov-defs"><span>defines</span>${s.defs.slice(0, 3).map(d => `<code>${escapeHtml(d)}</code>`).join("")}</span>` : ""}
      </button></li>`;
  }).join("");
  const parts = o.parts.map((p, i) => `<button type="button" class="fm-ov-part" data-part="${escapeHtml(p.name)}" style="--i:${i};--c:${fm.colour.get(p.name)}">
      <span class="fm-ov-top"><span class="fm-ov-pname">${escapeHtml(p.name)}</span><span class="fm-ov-n">${p.files} files</span></span>
      ${p.desc ? `<span class="fm-ov-desc">${escapeHtml(p.desc)}</span>` : ""}
      ${p.main.length ? `<span class="fm-ov-main">mainly ${p.main.map(m => `<code>${escapeHtml(m)}</code>`).join(" · ")}</span>` : ""}
      <span class="fm-ov-open">Its files on the map →</span></button>`).join("");
  const left = [o.hidden.helpers && `${o.hidden.helpers} helpers (utils, constants, types…)`, o.hidden.pass && `${o.hidden.pass} files that only pass imports along`].filter(Boolean);
  $("fm-overview").innerHTML = `<div class="fm-ov">
    <section><h2>How it runs</h2><p class="fm-ov-lede">Read these in order — each is loaded by one before it. Click one to see it on the file map.</p>
      <ol class="fm-ov-chain">${steps || `<li class="fm-ov-empty">Couldn't trace how it runs.</li>`}</ol></section>
    <aside><h2>Main parts</h2><p class="fm-ov-lede">The repo's shape, biggest first.</p>
      <div class="fm-ov-parts">${parts || `<p class="fm-ov-empty">One part.</p>`}</div>
      <div class="fm-ov-left">${left.length ? `Left out here: ${left.join(" and ")}. They're on the file map.` : "Everything read is on the file map."}
        <button type="button" class="fm-btn" id="fm-ov-files">Open the file map</button></div></aside>
  </div>`;
}

// Overview ⇄ file map
function setView(view) {
  fm.view = view;
  $("fm-v-overview").setAttribute("aria-selected", view === "overview");
  $("fm-v-files").setAttribute("aria-selected", view === "files");
  $("fm-overview").hidden = view !== "overview";
  $("fm-stage").hidden = view !== "files";
  $("fm-legend").hidden = view !== "files";
  for (const b of document.querySelectorAll(".fm-files-only")) b.hidden = view !== "files";
  if (view === "files") {
    if (fm.dirty) { draw(); fit(); }
    else summary(fm.files);
    $("fm-helpers").hidden = !fm.files?.helpers;
  } else {
    $("fm-summary").innerHTML = fm.overview?.steps.length ? `Starts in <code>${escapeHtml(fm.overview.steps[0].path)}</code> · ${fm.graph.read} files read` : "";
    $("fm-note").hidden = true;
  }
}

// ── How does X work? ─────────────────────────────────────────────────────────
// Step 1 here, without AI (feature.js); past the threshold the side panel asks the AI to pick from the index.
const FM_CIRCLED = (i) => String.fromCharCode(0x2460 + i);
function fmBlobUrl(path, line) {
  return `https://github.com/${encodeURIComponent(currentRepo.owner)}/${encodeURIComponent(currentRepo.repo)}/blob/${encodeURIComponent(fm.branch)}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
}
// Stems back to the asker's own words: "scor" → "scored"
function fmWordsFor(terms, question) {
  const words = question.split(/[^A-Za-z0-9_]+/).filter(Boolean);
  return terms.map(t => words.find(w => queryTerms(w).includes(t)) || t);
}

async function traceQuestion(text) {
  const question = `How does ${text.trim().replace(/\?+$/, "")} work?`;
  fm.trace = { question, loading: "Reading the likely files…" };
  renderTrace();
  try {
    const t = await traceFeature(question, currentRepo, fm.graph, { isPrivate: !!fm.graph.private });
    if (fm.trace?.question !== question) return; // a newer question
    fm.trace = { question, ...t, found: t.verdict.kind === "none" ? null : "name" };
    renderTrace();
    if (t.verdict.kind === "none" && t.terms.length) await traceWithAI(); // nothing to show without the AI
  } catch (err) {
    fm.trace = { question, error: err.message || "Couldn't read the files" };
    renderTrace();
  }
}

async function traceWithAI() {
  const t = fm.trace;
  if (!t?.index?.length) return;
  t.loading = `Asking your AI to pick from ${t.index.length} functions…`;
  renderTrace();
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: "map-feature-ai", repo: repoKey(), question: t.question, found: t.steps || [], index: t.index });
  } catch { r = { error: "no-panel" }; }
  if (fm.trace !== t) return;
  t.loading = null;
  if (!r || r.error) t.aiError = r?.error || "no-panel";
  else {
    const steps = featureStepsFromPicks(r.picks, t.index);
    if (steps.length) { t.steps = steps; t.found = t.found === "name" ? "name+ai" : "ai"; }
    else t.aiError = "nothing";
  }
  renderTrace();
  if (fm.traceOn) { fm.dirty = true; showTraceOnMap(); }
}

function renderTrace() {
  const box = $("fm-trace");
  const t = fm.trace;
  box.hidden = !t;
  if (!t) return;
  const head = `<div class="fm-trace-head"><strong>${escapeHtml(t.question)}</strong><button type="button" class="fm-trace-close" aria-label="Close">✕</button></div>`;
  if (t.error) { box.innerHTML = head + `<p class="fm-trace-note">${escapeHtml(t.error)}</p>`; return; }
  if (!t.verdict) { box.innerHTML = head + `<p class="fm-trace-note">${escapeHtml(t.loading)}</p>`; return; }
  const v = t.verdict;
  const words = (ts) => fmWordsFor(ts, t.question).map(w => `<b>${escapeHtml(w)}</b>`).join(", ");
  const why = `${v.nameMatches} functions with a question word in their name · ${Math.round(v.coverage * 100)}% of the question's words matched · ${v.linked} linked by calls`;
  let label = "";
  if (t.found === "name") label = v.kind === "confident" ? `Found by name — no AI` : `Partial — only ${words(v.matched)} matched${v.missing.length ? `, not ${words(v.missing)}` : ""}`;
  if (t.found === "name+ai") label = "Found by name, completed by your AI";
  if (t.found === "ai") label = "Picked by your AI — no function mentions those words";
  const aiNote = t.aiError === "no-ai" ? "Set up an AI provider in the Repolyze side panel's Settings to search past the names."
    : t.aiError === "no-panel" ? "Open the Repolyze side panel (toolbar icon) — it holds your AI key — then try again."
    : t.aiError === "nothing" ? "Your AI found nothing on the list that fits." : t.aiError ? escapeHtml(t.aiError) : "";
  const steps = (t.steps || []).map((s, i) => `<li>
      <button type="button" class="fm-trace-step" data-path="${escapeHtml(s.path)}"><span class="fm-trace-n">${FM_CIRCLED(i)}</span>
        <span class="fm-trace-fn"><code>${escapeHtml(s.name)}()</code><span class="fm-trace-file">${escapeHtml(mapBase(s.path))}</span></span></button>
      <a class="fm-trace-line" href="${escapeHtml(fmBlobUrl(s.path, s.line))}" target="_blank" rel="noopener" title="${escapeHtml(s.path)}">L${s.line || "?"} ↗</a>
      ${s.why || s.doc ? `<span class="fm-trace-doc">${escapeHtml(s.why || s.doc)}</span>` : ""}</li>`).join("");
  const none = !steps && !t.loading ? `<p class="fm-trace-note">No function mentions ${words(t.terms)}. Try a word from the code${t.aiError ? "" : ", or ask your AI"}.</p>` : "";
  const canFill = t.found === "name" && v.kind === "partial" && !t.loading;
  box.innerHTML = head
    + (label ? `<p class="fm-trace-label ${t.found === "name" ? v.kind : "ai"}" title="${escapeHtml(why)}">${label}</p>` : "")
    + (steps ? `<ol class="fm-trace-steps">${steps}</ol>` : none)
    + (t.loading ? `<p class="fm-trace-note">${escapeHtml(t.loading)}</p>` : "")
    + (aiNote ? `<p class="fm-trace-note">${aiNote}</p>` : "")
    + `<div class="fm-trace-actions">
        ${canFill ? `<button type="button" class="fm-btn fm-primary" data-trace="fill">Fill the gaps with AI</button>` : ""}
        ${steps ? `<button type="button" class="fm-btn" data-trace="map">Show on the file map</button><button type="button" class="fm-btn" data-trace="explain">Explain the code</button>` : ""}
      </div>`;
}

// The steps' files on the file map, numbered; everything else fades
function showTraceOnMap() {
  const steps = fm.trace?.steps || [];
  if (!steps.length) return;
  fm.traceOn = true;
  steps.forEach(s => fm.extra.add(s.path));
  fm.sel = null; fm.hover = null; fm.folder = null; fm.dirty = true;
  setView("files");
}

// ── Selection: a box, what loads it and what it loads ───────────────────────
// fm.sel is the picked file (click); fm.hover the one pointed at while nothing is picked; fm.folder a picked folder
function applySelection() {
  const focus = fm.sel || fm.hover;
  const outs = new Set(), ins = new Set();
  for (const p of $("fm-edges").querySelectorAll("path[data-from]")) {
    const out = !!focus && p.dataset.from === focus, inn = !!focus && p.dataset.to === focus;
    const within = !focus && fm.folder && p.dataset.to.startsWith("group:") === false
      && fmArea(p.dataset.from) === fm.folder && fmArea(p.dataset.to) === fm.folder;
    if (out) outs.add(p.dataset.to);
    if (inn) ins.add(p.dataset.from);
    p.setAttribute("class", "fm-e" + (out ? " out" : inn ? " in" : within ? " faint" : ""));
    if (out || inn) p.setAttribute("marker-end", `url(#fm-m-${out ? "out" : "in"})`); else p.removeAttribute("marker-end");
  }
  const trace = fm.traceOn ? (fm.trace?.steps || []).map(s => s.path) : [];
  for (const b of $("fm-boxes").querySelectorAll(".fm-box")) {
    const id = b.dataset.path || `group:${b.dataset.group}`;
    const n = trace.indexOf(id);
    if (n >= 0) b.dataset.trace = FM_CIRCLED(n); else delete b.dataset.trace;
    b.classList.toggle("sel", id === focus);
    b.classList.toggle("out", outs.has(id));
    b.classList.toggle("in", ins.has(id) && !outs.has(id));
    b.classList.toggle("dim", focus ? id !== focus && !outs.has(id) && !ins.has(id) : fm.folder ? b.dataset.area !== fm.folder : trace.length ? n < 0 : false);
  }
  for (const c of $("fm-legend").children) { const on = c.dataset.area === fm.folder; c.classList.toggle("on", on); c.setAttribute("aria-pressed", on); }
}

function select(path, { center = false } = {}) {
  fm.sel = path;
  applySelection();
  if (center && fm.rect?.has(path)) {
    const r = fm.rect.get(path), st = $("fm-stage");
    fm.x = st.clientWidth / 2 - (r.x + r.w / 2) * fm.scale;
    fm.y = st.clientHeight / 3 - (r.y + r.h / 2) * fm.scale;
    transform();
  }
}

// ── Pan and zoom ─────────────────────────────────────────────────────────────
function transform() { $("fm-world").style.transform = `translate(${fm.x}px, ${fm.y}px) scale(${fm.scale})`; }
function fit() {
  const st = $("fm-stage");
  fm.scale = Math.min(1, st.clientWidth / fm.size.width, st.clientHeight / fm.size.height);
  fm.x = (st.clientWidth - fm.size.width * fm.scale) / 2;
  fm.y = Math.max(0, (st.clientHeight - fm.size.height * fm.scale) / 2);
  transform();
}
function zoomAt(factor, cx, cy) {
  const s = Math.min(2, Math.max(0.2, fm.scale * factor));
  fm.x = cx - (cx - fm.x) * (s / fm.scale);
  fm.y = cy - (cy - fm.y) * (s / fm.scale);
  fm.scale = s;
  transform();
}

function wire() {
  const st = $("fm-stage");
  let drag = null;
  st.addEventListener("mousedown", (e) => { if (e.target.closest(".fm-box")) return; drag = { x: e.clientX - fm.x, y: e.clientY - fm.y, moved: false }; st.classList.add("dragging"); });
  window.addEventListener("mousemove", (e) => { if (!drag) return; drag.moved = true; fm.x = e.clientX - drag.x; fm.y = e.clientY - drag.y; transform(); });
  window.addEventListener("mouseup", () => { if (drag && !drag.moved) select(null); drag = null; st.classList.remove("dragging"); });
  st.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const r = st.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top); }
    else { fm.x -= e.deltaX; fm.y -= e.deltaY; transform(); }
  }, { passive: false });
  $("fm-fit").onclick = fit;
  $("fm-in").onclick = () => zoomAt(1.2, st.clientWidth / 2, st.clientHeight / 2);
  $("fm-out").onclick = () => zoomAt(1 / 1.2, st.clientWidth / 2, st.clientHeight / 2);

  $("fm-boxes").addEventListener("click", (e) => {
    const ask = e.target.closest("[data-ask]");
    if (ask) { e.stopPropagation(); return askPanel({ type: "map-ask-file", file: ask.dataset.ask }); }
    if (e.target.closest("a")) return;
    const group = e.target.closest("[data-group]");
    if (group) { fm.expanded.add(group.dataset.group); return draw(); }
    const box = e.target.closest("[data-path]");
    if (box) select(fm.sel === box.dataset.path ? null : box.dataset.path);
  });
  // Pointing at a file shows its arrows while nothing is picked
  $("fm-boxes").addEventListener("mouseover", (e) => {
    const box = e.target.closest("[data-path]");
    if (!fm.sel && box && fm.hover !== box.dataset.path) { fm.hover = box.dataset.path; applySelection(); }
  });
  $("fm-boxes").addEventListener("mouseout", (e) => {
    if (fm.hover && !e.relatedTarget?.closest?.("[data-path]")) { fm.hover = null; applySelection(); }
  });
  $("fm-boxes").addEventListener("focusin", (e) => {
    const box = e.target.closest("[data-path]");
    if (!fm.sel && box) { fm.hover = box.dataset.path; applySelection(); }
  });
  $("fm-legend").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-area]");
    if (!chip) return;
    fm.folder = fm.folder === chip.dataset.area ? null : chip.dataset.area;
    fm.sel = null; fm.hover = null;
    applySelection();
  });
  $("fm-boxes").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.target.closest?.("#fm-ask")) return;
    fm.folder = null; fm.hover = null; fm.traceOn = false; select(null);
  });
  $("fm-explain").onclick = () => askPanel({ type: "map-explain" });
  $("fm-ask").addEventListener("submit", (e) => { e.preventDefault(); const q = $("fm-q").value.trim(); if (q) traceQuestion(q); });
  $("fm-trace").addEventListener("click", (e) => {
    if (e.target.closest(".fm-trace-close")) { fm.trace = null; fm.traceOn = false; renderTrace(); return applySelection(); }
    const act = e.target.closest("[data-trace]")?.dataset.trace;
    if (act === "fill") return traceWithAI();
    if (act === "map") return showTraceOnMap();
    if (act === "explain") return askPanel({ type: "map-feature-explain", question: fm.trace.question, steps: fm.trace.steps.map(s => ({ path: s.path, name: s.name, line: s.line })) });
    const step = e.target.closest(".fm-trace-step");
    if (step) { showTraceOnMap(); select(step.dataset.path, { center: true }); }
  });
  $("fm-v-overview").onclick = () => setView("overview");
  $("fm-v-files").onclick = () => setView("files");
  $("fm-helpers").onclick = () => { fm.helpers = !fm.helpers; fm.dirty = true; draw(); };
  $("fm-overview").addEventListener("click", (e) => {
    if (e.target.closest("#fm-ov-files")) return setView("files");
    const step = e.target.closest("[data-path]");
    if (step) { // the file on the file map, picked
      fm.extra.add(step.dataset.path); fm.folder = null; fm.dirty = true;
      setView("files");
      return select(step.dataset.path, { center: true });
    }
    const part = e.target.closest("[data-part]");
    if (part) { // the file map with that part picked out, its most-used files shown
      const view = mapView(fm.graph);
      Object.keys(view.nodes).filter(p => fmArea(p) === part.dataset.part && !view.nodes[p].helper && !TEST_PATH.test(p))
        .sort((a, b) => view.nodes[b].inDegree - view.nodes[a].inDegree || a.localeCompare(b)).slice(0, 8).forEach(p => fm.extra.add(p));
      fm.sel = null; fm.hover = null; fm.folder = part.dataset.part; fm.dirty = true;
      setView("files");
    }
  });

  // Roles written by Explain land in storage: show them with an "AI" badge
  chrome.storage.onChanged.addListener((changes, area) => {
    const k = mapStoreKey(currentRepo.owner, currentRepo.repo);
    if (area === "local" && changes[k]?.newValue && fm.graph) { fm.graph = changes[k].newValue; renderOverview(); fm.dirty = true; draw(); }
    if (area === "local" && changes.githubToken) githubToken = changes.githubToken.newValue || "";
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "map-highlight" && msg.repo === repoKey() && fm.graph) {
      if (!fm.rect?.has(msg.file)) { fm.extra.add(msg.file); fm.dirty = true; }
      setView("files");
      select(msg.file, { center: true });
    }
  });
}

// AI work happens in Ask, in the side panel
async function askPanel(msg) {
  try {
    await chrome.runtime.sendMessage({ ...msg, repo: repoKey() });
    flash("Sent to Ask in the Repolyze side panel.");
  } catch {
    flash("Open the Repolyze side panel (toolbar icon) to ask, then try again.");
  }
}
function flash(text) {
  const n = $("fm-note");
  n.hidden = false; n.textContent = text;
  clearTimeout(flash.t); flash.t = setTimeout(() => summary(fm.files), 4000);
}

// ── Start ────────────────────────────────────────────────────────────────────
async function start(allowPrivate = false) {
  const status = $("fm-status");
  if (!currentRepo) { status.textContent = "No repo given."; return; }
  $("fm-repo").textContent = repoKey();
  document.title = `${repoKey()} · How it runs`;
  try {
    const { githubToken: t } = await chrome.storage.local.get("githubToken");
    githubToken = t || "";
    const meta = await loadRepoData(currentRepo);
    fm.branch = meta.default_branch || "HEAD";
    const g = await loadRepoMap(currentRepo, { allowPrivate });
    if (g.needsClick) {
      status.innerHTML = `<div>This repo is private, so reading its files uses GitHub requests. <button class="fm-btn fm-primary" id="fm-go">Read its files · about ${g.cost} requests</button></div>`;
      $("fm-go").onclick = () => { status.textContent = "Reading the repo's files…"; start(true); };
      return;
    }
    if (!g.entries.length) { status.textContent = "Couldn't find where this app starts."; return; }
    fm.graph = g;
    status.hidden = true;
    const file = params.get("file");
    if (file) fm.extra.add(file);
    renderOverview();
    $("fm-ask").hidden = false;
    setView(file ? "files" : "overview"); // a file asked for opens the file map on it
    if (file) select(file, { center: true });
  } catch (err) {
    status.innerHTML = `${escapeHtml(err.message || "Couldn't load the map")} <button class="fm-btn" id="fm-retry">Try again</button>`;
    $("fm-retry").onclick = () => { status.textContent = "Reading the repo's files…"; start(allowPrivate); };
  }
}

wire();
start();
