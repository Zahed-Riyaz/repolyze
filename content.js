// ── Contributor guide on GitHub issue pages ──────────────────────────────────
// Adds a small card to github.com/{owner}/{repo}/issues/{n}: whether the issue
// looks free and the files it needs, each with where that came from. Data comes
// from the background worker (guide.js), so this file only renders.
//   • Lives in a Shadow DOM: GitHub's styles and ours never mix.
//   • Goes in the issue's sidebar when it can find it, else floats bottom-right;
//     GitHub's markup changes often, so nothing depends on one selector.
//   • Follows GitHub's in-page navigation (it doesn't reload between pages).
//   • Signed out, it waits for a click before spending the 60/hour limit.
//   • Can be switched off in the panel's Settings ("pageGuide").
// Never posts, edits or clicks anything on GitHub.

const GUIDE_HOST_ID = "gra-contributor-guide";

// github.com/o/r/issues/12 → { owner, repo, number } (null for anything else)
function parseIssuePage(url) {
  const m = String(url).match(/^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/issues\/(\d+)(?:[/?#]|$)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TONE = { free: "good", maybe: "warn", taken: "bad" };

// The card's inner HTML for a state: { phase: "idle"|"loading"|"ready"|"error", data?, error?, open }.
// Reading order: verdict → why → next step; where to start (guesses folded); who owns it.
function guideCardHtml(page, state) {
  const d = state.data;
  const head = `<button class="head" data-act="toggle" aria-expanded="${state.open}">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/></svg><span class="title">Contributor guide</span>
      ${state.phase === "ready" && d?.availability ? `<span class="verdict tone-${TONE[d.availability.status] || "good"}">${esc(d.availability.verdict)}</span>` : ""}
      <span class="chev">${state.open ? "▾" : "▸"}</span>
    </button>`;
  if (!state.open) return head;
  let body = "";
  if (state.phase === "idle") {
    body = `<p class="note">Whether it's free, where to start and who owns the code. Uses a few GitHub requests.</p>
      <button class="btn" data-act="load">Show</button>`;
  } else if (state.phase === "loading") {
    body = `<p class="note">Reading the issue and the repo…</p>`;
  } else if (state.phase === "error") {
    body = `<p class="note">${esc(state.error)}</p><button class="btn" data-act="load">Try again</button>`;
  } else {
    const base = `https://github.com/${encodeURIComponent(page.owner)}/${encodeURIComponent(page.repo)}/blob/${encodeURIComponent(d.ref)}/`;
    const row = (f) => `
      <li class="file conf-${f.confidence}">
        <a href="${base}${f.path.split("/").map(encodeURIComponent).join("/")}" title="${esc(f.path)}">${esc(f.name)}</a>
        <span class="why">${esc(f.why)}</span>
        ${f.dir ? `<span class="dir" title="${esc(f.path)}">${esc(f.dir)}</span>` : ""}
      </li>`;
    const guesses = d.guesses.length
      ? `<details${d.start.length ? "" : " open"}><summary>${d.guesses.length} ${d.guesses.length === 1 ? "guess" : "guesses"} by file name</summary><ul class="files">${d.guesses.map(row).join("")}</ul></details>`
      : "";
    body = `
      ${d.availability.reasons.length ? `<p class="why-line">${d.availability.reasons.map(esc).join(" · ")}</p>` : ""}
      <p class="next">→ ${esc(d.availability.advice)}</p>
      <div class="section-head"><h3>Where to start</h3>${d.stack.length ? `<span class="stack">${d.stack.map(esc).join(" · ")}</span>` : ""}</div>
      ${d.start.length ? `<ul class="files">${d.start.map(row).join("")}</ul>` : `<p class="note">Nothing in the issue or its PRs points at a file yet.</p>`}
      ${guesses}
      ${d.owners.length ? `<h3>Who owns it</h3><ul class="owners">${d.owners.map(o => `<li><span class="owner" title="${esc(o.handle)}">${esc(o.display)}</span><span class="why">${o.files.length === 1 ? "1 file" : `${o.files.length} files`}</span></li>`).join("")}</ul>` : ""}
      <button class="btn" data-act="panel">Open the full brief in the panel</button>`;
  }
  return head + `<div class="body">${body}</div>`;
}

const GUIDE_CSS = `
  :host { all: initial; display: block; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif; }
  .card { --bg:#fff; --fg:#1f2328; --muted:#59636e; --subtle:#818b98; --line:#d8dee4; --hover:#f6f8fa; --accent:#0969da; --good:#1a7f37; --warn:#9a6700; --bad:#cf222e;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .card.dark { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --subtle:#6e7681; --line:#30363d; --hover:#151b23; --accent:#4493f8; --good:#3fb950; --warn:#d29922; --bad:#f85149; }
  .card.floating { position: fixed; right: 16px; bottom: 16px; width: 320px; max-height: 70vh; overflow: auto; z-index: 99; box-shadow: 0 8px 24px rgba(0,0,0,.18); }
  .card.inline { margin: 0 0 16px; }
  button { font: inherit; color: inherit; cursor: pointer; }
  .head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px 10px; border: 0; background: none; text-align: left; }
  .head:hover { background: var(--hover); }
  .mark { width: 14px; height: 14px; flex-shrink: 0; fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .title { font-weight: 600; font-size: 12.5px; }
  .verdict { margin-left: auto; font-size: 11.5px; font-weight: 500; }
  .chev { color: var(--subtle); font-size: 10px; width: 10px; text-align: center; }
  .verdict + .chev { margin-left: 4px; }
  .title + .chev { margin-left: auto; }
  .tone-good { color: var(--good); } .tone-warn { color: var(--warn); } .tone-bad { color: var(--bad); }
  .body { padding: 2px 10px 10px; border-top: 1px solid var(--line); }
  h3 { margin: 10px 0 4px; font-size: 11.5px; font-weight: 600; color: var(--muted); }
  .note { margin: 8px 0; font-size: 12px; color: var(--muted); }
  .why-line { margin: 8px 0 0; font-size: 11.5px; color: var(--subtle); }
  .next { margin: 6px 0 2px; font-size: 12px; color: var(--fg); }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-top: 12px; }
  .section-head h3 { margin: 0 0 6px; }
  .stack { font: 10.5px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--subtle); }
  ul { list-style: none; margin: 0; padding: 0; }
  .files { display: flex; flex-direction: column; gap: 6px; }
  .file { display: grid; grid-template-columns: minmax(0, auto) 1fr; column-gap: 8px; align-items: baseline; }
  .file a { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); text-decoration: none; font: 500 12px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .file a:hover { text-decoration: underline; }
  .why { font-size: 11px; color: var(--subtle); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dir { grid-column: 1 / -1; font: 10.5px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: var(--subtle); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conf-low a { color: var(--muted); font-weight: 400; }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 11.5px; color: var(--muted); margin-bottom: 6px; }
  .owners li { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; }
  .owner { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .btn { margin-top: 10px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); font-size: 12px; }
  .btn:hover { background: var(--hover); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
`;

// Where the card goes: the issue's sidebar if we can find it, else floating
function guideAnchor() {
  const sidebar = document.querySelector([
    '[data-testid="issue-viewer-metadata-pane"]',
    '[data-testid="issue-metadata-sidebar"]',
    "#partial-discussion-sidebar",
  ].join(","));
  return sidebar ? { el: sidebar, where: "inline" } : { el: document.body, where: "floating" };
}

function isDarkPage() {
  const mode = document.documentElement.getAttribute("data-color-mode");
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

// ── Running on the page ──────────────────────────────────────────────────────
function startGuide() {
  let shownFor = null; // "owner/repo#n" the card is showing
  let state = null;
  const states = new Map(); // key → last state, so a re-mount (GitHub re-rendered) keeps it
  let root = null;
  let enabled = true;

  const page = () => parseIssuePage(location.href);

  function draw() {
    const p = page();
    if (shownFor) states.set(shownFor, state);
    if (!root || !p) return;
    const card = root.querySelector(".card");
    card.innerHTML = guideCardHtml(p, state);
  }

  function load() {
    const p = page();
    if (!p) return;
    const key = `${p.owner}/${p.repo}#${p.number}`;
    state = { ...state, phase: "loading", open: true };
    draw();
    chrome.runtime.sendMessage({ type: "issue-guide", ...p }).then((res) => {
      if (shownFor !== key) return; // the user moved on
      if (!res || res.kind === "pr") { remove(); return; }
      state = res.error
        ? { ...state, phase: "error", error: res.rateLimited ? "GitHub's hourly limit is used up — sign in from the panel to raise it." : res.status === 404 ? "This issue isn't visible to the extension." : res.error }
        : { ...state, phase: "ready", data: res };
      draw();
    }).catch(() => { state = { ...state, phase: "error", error: "The extension was updated — reload the page." }; draw(); });
  }

  function remove() {
    document.getElementById(GUIDE_HOST_ID)?.remove();
    root = null;
    shownFor = null;
  }

  async function sync() {
    const p = page();
    const key = p ? `${p.owner}/${p.repo}#${p.number}` : null;
    if (!enabled || !key) { remove(); return; }
    if (key === shownFor && document.getElementById(GUIDE_HOST_ID)) return;
    remove();
    const { el, where } = guideAnchor();
    const host = document.createElement("div");
    host.id = GUIDE_HOST_ID;
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${GUIDE_CSS}</style><div class="card ${where}${isDarkPage() ? " dark" : ""}" role="complementary" aria-label="Contributor guide"></div>`;
    if (where === "inline") el.prepend(host); else el.appendChild(host);
    shownFor = key;
    root.addEventListener("click", (e) => {
      const act = e.target.closest?.("[data-act]")?.dataset.act;
      if (act === "toggle") { state = { ...state, open: !state.open }; if (state.open && state.phase === "idle" && state.auto) load(); else draw(); }
      if (act === "load") load();
      if (act === "panel") chrome.runtime.sendMessage({ type: "open-panel" }).catch(() => {});
    });
    const saved = states.get(key);
    if (saved && saved.phase !== "loading") { state = saved; draw(); return; }
    // Signed in (5,000/hour) → load right away; signed out (60/hour) → on request
    const { githubToken } = await chrome.storage.local.get(["githubToken"]);
    state = { phase: "idle", open: !!githubToken, auto: !!githubToken };
    if (githubToken) load(); else draw();
  }

  chrome.storage.local.get(["pageGuide"]).then(({ pageGuide }) => {
    enabled = pageGuide !== false;
    sync();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pageGuide) { enabled = changes.pageGuide.newValue !== false; sync(); }
  });
  // GitHub navigates without reloading: re-check when the URL or page changes
  let lastUrl = location.href;
  const check = () => { if (location.href !== lastUrl || !document.getElementById(GUIDE_HOST_ID)) { lastUrl = location.href; sync(); } };
  document.addEventListener("turbo:load", check);
  window.addEventListener("popstate", check);
  setInterval(check, 1000);
}

if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof location !== "undefined" && location.host === "github.com") {
  startGuide();
}
