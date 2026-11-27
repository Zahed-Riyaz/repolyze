// map.js — the flow map in its own tab (map.html?repo=owner/name[&file=path]).
// Boxes are files, arrows are "loads". The crawl and the layout (flowFiles, flowLayout) are in territory.js;
// this file draws and handles the page. 0 API requests on public repos.

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
const fm = { graph: null, branch: "HEAD", expanded: new Set(), extra: new Set(), sel: null, scale: 1, x: 0, y: 0, layout: null };

// ── Drawing ──────────────────────────────────────────────────────────────────
function fileBoxHtml(graph, path, steps) {
  const n = graph.nodes[path];
  const entry = graph.entries.find(e => e.path === path);
  const step = steps.find(s => s.path === path);
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? escapeHtml(path) : `<span class="fm-dir">${escapeHtml(path.slice(0, slash + 1))}</span>${escapeHtml(path.slice(slash + 1))}`;
  const tags = [];
  if (entry) tags.push(`<span class="fm-tag start" title="${escapeHtml(entry.reason || "")}">Starts here</span>`);
  if (n.inDegree >= 3) tags.push(`<span class="fm-tag core">Used by ${n.inDegree} files</span>`);
  if (step) tags.push(`<span class="fm-tag" title="Reading order">Read ${step.step}${step.step === 1 ? "st" : step.step === 2 ? "nd" : step.step === 3 ? "rd" : "th"}</span>`);
  const role = graph.roles?.[path];
  const desc = n.desc
    ? `<div class="fm-desc">${escapeHtml(n.desc)}</div>`
    : role ? `<div class="fm-desc"><span class="fm-ai" title="Written by your AI">AI</span>${escapeHtml(role)}</div>`
    : `<div class="fm-desc none">${n.read === false ? "Not read (repo too large)" : "No description yet"}</div>`;
  const url = `https://github.com/${encodeURIComponent(currentRepo.owner)}/${encodeURIComponent(currentRepo.repo)}/blob/${encodeURIComponent(fm.branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const label = [path, entry && "starts here", n.inDegree >= 3 && `used by ${n.inDegree} files`, n.desc || role].filter(Boolean).join(" · ");
  return `<div class="fm-box${entry ? " entry" : ""}" data-path="${escapeHtml(path)}" tabindex="0" role="button" aria-label="${escapeHtml(label)}">
    <div class="fm-path">${name}</div>
    ${tags.length ? `<div class="fm-tags">${tags.join("")}</div>` : ""}
    ${desc}
    <div class="fm-actions"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">GitHub ↗</a><button type="button" data-ask="${escapeHtml(path)}">Ask about this file</button></div>
  </div>`;
}

function groupBoxHtml(g) {
  const n = g.files.size;
  return `<div class="fm-box fm-group" data-group="${escapeHtml(g.dir)}" tabindex="0" role="button" aria-label="${n} more files in ${escapeHtml(g.dir)}, click to show">
    +${n} more in <b>${escapeHtml(g.dir === "(root)" ? "the root" : g.dir + "/")}</b><div class="fm-desc">click to show</div></div>`;
}

function draw() {
  const graph = fm.graph;
  const files = flowFiles(graph, { expanded: fm.expanded, extra: fm.extra });
  const lay = flowLayout(graph, files);
  fm.files = files; fm.layout = lay;

  const boxes = $("fm-boxes");
  boxes.innerHTML = lay.rows.flat().map(it => it.kind === "group" ? groupBoxHtml(it.group) : fileBoxHtml(graph, it.id, files.steps)).join("");
  const el = new Map([...boxes.children].map(b => [b.dataset.path || `group:${b.dataset.group}`, b]));

  // Place: rows centred, heights measured after render
  const rowW = (r) => r.length * FLOW.BOX_W + (r.length - 1) * FLOW.GAP_X;
  const width = Math.max(...lay.rows.map(rowW)) + FLOW.PAD * 2;
  const rect = new Map();
  let y = FLOW.PAD;
  for (const r of lay.rows) {
    let x = (width - rowW(r)) / 2;
    const h = Math.max(...r.map(it => el.get(it.id).offsetHeight));
    for (const it of r) {
      const b = el.get(it.id);
      b.style.left = x + "px"; b.style.top = y + "px";
      rect.set(it.id, { x, y, w: FLOW.BOX_W, h: b.offsetHeight });
      x += FLOW.BOX_W + FLOW.GAP_X;
    }
    y += h + FLOW.GAP_Y;
  }
  const height = y - FLOW.GAP_Y + FLOW.PAD;
  fm.rect = rect; fm.size = { width, height };

  const svg = $("fm-edges");
  svg.setAttribute("width", width); svg.setAttribute("height", height);
  const paths = lay.edges.map(e => {
    const a = rect.get(e.from), b = rect.get(e.to);
    if (!a || !b) return "";
    let d;
    if (e.back) {
      // Loads something above or beside it: a dashed loop out to the side
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x + b.w, y2 = b.y + b.h / 2, bend = Math.max(x1, x2) + 50;
      d = `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2 + 4},${y2}`;
    } else {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y - 4, mid = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`;
    }
    return `<path d="${d}" class="${e.back ? "dashed" : ""}" data-from="${escapeHtml(e.from)}" data-to="${escapeHtml(e.to)}" marker-end="url(#fm-arrow)"/>`;
  }).join("");
  svg.innerHTML = `<defs><marker id="fm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>${paths}`;

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

// ── Selection: a box, what loads it and what it loads ───────────────────────
function applySelection() {
  const sel = fm.sel;
  const near = new Set();
  if (sel) for (const e of fm.layout.allEdges) { if (e.from === sel) near.add(e.to); if (e.to === sel) near.add(e.from); }
  for (const b of $("fm-boxes").children) {
    const id = b.dataset.path || `group:${b.dataset.group}`;
    b.classList.toggle("sel", id === sel);
    b.classList.toggle("near", near.has(id));
    b.classList.toggle("dim", !!sel && id !== sel && !near.has(id));
  }
  for (const p of $("fm-edges").querySelectorAll("path[data-from]")) {
    const on = sel && (p.dataset.from === sel || p.dataset.to === sel);
    p.classList.toggle("hl", !!on);
    p.classList.toggle("dim", !!sel && !on);
  }
}

function select(path, { center = false } = {}) {
  fm.sel = path;
  applySelection();
  if (center && fm.rect.has(path)) {
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
  $("fm-boxes").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.click(); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") select(null); });
  $("fm-explain").onclick = () => askPanel({ type: "map-explain" });

  // Roles written by Explain land in storage: show them with an "AI" badge
  chrome.storage.onChanged.addListener((changes, area) => {
    const k = mapStoreKey(currentRepo.owner, currentRepo.repo);
    if (area === "local" && changes[k]?.newValue && fm.graph) { fm.graph = changes[k].newValue; draw(); }
    if (area === "local" && changes.githubToken) githubToken = changes.githubToken.newValue || "";
  });
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "map-highlight" && msg.repo === repoKey() && fm.graph) {
      if (!fm.rect.has(msg.file)) { fm.extra.add(msg.file); draw(); }
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
    draw();
    fit();
    if (file) select(file, { center: true });
  } catch (err) {
    status.innerHTML = `${escapeHtml(err.message || "Couldn't load the map")} <button class="fm-btn" id="fm-retry">Try again</button>`;
    $("fm-retry").onclick = () => { status.textContent = "Reading the repo's files…"; start(allowPrivate); };
  }
}

wire();
start();
