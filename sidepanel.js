// ── State ────────────────────────────────────────────────────────────────────
let currentRepo = null;
let githubToken = "";
let aiProvider = "groq";   // "groq" | "gemini" | "ollama" | "openai" | "anthropic"
let aiApiKey = "";          // API key for cloud providers
let ollamaModel = "llama3.2";
let chatMessages = []; // [{role:"user"|"bot", text:"...", error?:true}]
let panelWindowId = null; // the browser window this side panel belongs to

// Model used for each provider — the one place to bump when a model is retired
const MODELS = {
  groq:      "llama-3.3-70b-versatile",
  gemini:    "gemini-2.5-flash",
  openai:    "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

// Session cache keyed by "owner/repo"
// Stores: { repoData, issues, languages, contributors, health, prs, … }
const repoCache = {};

function repoKey(repo = currentRepo) { return `${repo.owner}/${repo.repo}`; }
function cacheFor(key) { return (repoCache[key] ??= {}); }
// Async work captures the repo it started for and checks this before touching
// the UI, so a slow response never renders into a different repo's view.
function isCurrentRepo(key) { return !!currentRepo && repoKey() === key; }

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Tab switching — the settings gear in the header is a .tab-btn too, and
  // toggles back to the last content tab when clicked again.
  document.querySelectorAll(".tab-btn").forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      if (target === "settings" && tab.classList.contains("active")) {
        switchTab(lastContentTab);
      } else {
        switchTab(target);
      }
    });
  });
  new ResizeObserver(moveTabIndicator).observe(document.getElementById("tabs"));
  moveTabIndicator();

  // Issue filter buttons
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => setIssueFilter(btn.dataset.label));
  });
  document.getElementById("issue-sort").addEventListener("change", (e) => { issueView.sort = e.target.value; fetchIssues(); });
  document.getElementById("issue-unclaimed").addEventListener("change", (e) => setUnclaimed(e.target.checked));
  document.getElementById("issues-more").addEventListener("click", () => fetchIssues({ append: true }));

  // "Start this issue" brief
  document.getElementById("issues-list").addEventListener("click", (e) => {
    const btn = e.target.closest?.(".start-issue-btn");
    if (btn) openIssueBriefFromList(btn.dataset.issue);
  });
  document.getElementById("brief-back").addEventListener("click", closeIssueBrief);
  document.getElementById("brief-copy").addEventListener("click", copyBrief);
  document.getElementById("brief-ask").addEventListener("click", askAboutIssue);
  document.getElementById("brief-body").addEventListener("click", handleBriefClick);

  // Chat controls
  document.getElementById("send-btn").addEventListener("click", () => { handleChat(); });
  const chatInput = document.getElementById("chat-input");
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleChat(); }
  });
  chatInput.addEventListener("input", autosizeChatInput);
  document.getElementById("clear-chat-btn").addEventListener("click", clearChat);

  // Load saved settings — also migrate legacy geminiApiKey → aiApiKey
  const stored = await chrome.storage.local.get(["githubToken", "aiProvider", "aiApiKey", "ollamaModel", "geminiApiKey"]);
  githubToken  = stored.githubToken  || "";
  aiProvider   = stored.aiProvider   || "groq";
  aiApiKey     = stored.aiApiKey     || "";
  ollamaModel  = stored.ollamaModel  || "llama3.2";

  // One-time migration: if old Gemini key exists but new key doesn't, adopt it
  if (!aiApiKey && stored.geminiApiKey) {
    aiApiKey   = stored.geminiApiKey;
    aiProvider = "gemini";
    await chrome.storage.local.set({ aiApiKey, aiProvider });
    await chrome.storage.local.remove(["geminiApiKey"]);
  }

  initSettingsTab();

  document.getElementById("rate-banner-btn").addEventListener("click", getGitHubToken);
  document.getElementById("sp-get-token-link").addEventListener("click", (e) => {
    e.preventDefault(); // open via getGitHubToken so the paste hint shows too
    getGitHubToken();
  });
  const rateBadge = document.getElementById("rate-limit-badge");
  rateBadge.addEventListener("click", openTokenSettings);
  rateBadge.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTokenSettings(); }
  });
  refreshRateLimit();

  if (aiProvider !== "ollama" && !aiApiKey) {
    document.querySelector('.tab-btn[data-tab="settings"]')?.click();
  }

  // Follow the active tab of this panel's window only — navigation in
  // background tabs or other windows must not hijack the panel.
  panelWindowId = (await chrome.windows.getCurrent()).id;

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.active && tab.windowId === panelWindowId) {
      handleRepoRefresh(changeInfo.url);
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (windowId !== panelWindowId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) handleRepoRefresh(tab.url);
  });

  // Load current tab
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
  if (activeTab?.url) handleRepoRefresh(activeTab.url);
});

// ── View & tab state ──────────────────────────────────────────────────────────
let onRepoPage = false;
let lastContentTab = "issues";

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (t.getAttribute("role") === "tab") t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `${name}-tab`));
  if (name !== "settings") lastContentTab = name;
  applyView();
  loadTabData(name);
  moveTabIndicator();
  if (name === "chat") autosizeChatInput();
}

// Settings must stay reachable off-repo, so it overrides the welcome screen
function applyView() {
  const settingsOpen = document.getElementById("settings-tab").classList.contains("active");
  const showMain = onRepoPage || settingsOpen;
  document.body.classList.toggle("no-repo", !onRepoPage);
  document.getElementById("not-repo-msg").style.display = showMain ? "none" : "";
  document.getElementById("main-content").style.display = showMain ? "" : "none";
}

function moveTabIndicator() {
  const nav = document.getElementById("tabs");
  const active = nav.querySelector(".tab-btn.active");
  nav.classList.toggle("no-indicator", !active);
  if (!active) return;
  nav.style.setProperty("--ind-x", `${active.offsetLeft}px`);
  nav.style.setProperty("--ind-w", `${active.offsetWidth}px`);
}

function autosizeChatInput() {
  const el = document.getElementById("chat-input");
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

// ── Render helpers ────────────────────────────────────────────────────────────
function icon(name, cls = "") {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// Placeholder rows shaped like the content they stand in for, so nothing
// jumps when real data arrives.
function skeletonList(count, kind = "row") {
  const row = {
    row:    `<span class="sk-lines"><span class="sk sk-line"></span><span class="sk sk-line short"></span></span>`,
    person: `<span class="sk sk-circle"></span><span class="sk-lines"><span class="sk sk-line short"></span><span class="sk sk-line"></span></span>`,
    bar:    `<span class="sk-lines"><span class="sk sk-line short"></span></span>`,
  }[kind];
  return Array.from({ length: count }, () => `<li class="skeleton-item" aria-hidden="true">${row}</li>`).join("");
}

// Error row for a failed load. Rate limits get a calm "paused" message (the
// banner explains the fix); anything else shows the error itself.
function errorState(err, tag = "li") {
  if (err?.rateLimited) {
    return stateItem(`Paused until <strong>${formatTime(err.resetAt)}</strong> — GitHub's hourly limit is used up.`, { iconName: "clock", tag });
  }
  return stateItem(escapeHtml(err?.message || "Something went wrong."), { error: true, tag });
}

// Ask GitHub for an appropriately sized avatar instead of the full-size image
function avatarUrl(url, size) {
  try { const u = new URL(url); u.searchParams.set("s", String(size)); return u.href; }
  catch { return url; }
}

// Empty / error row. `html` must already be escaped.
function stateItem(html, { error = false, iconName = error ? "alert" : "inbox", tag = "li" } = {}) {
  return `<${tag} class="state-item${error ? " is-error" : ""}">${icon(iconName)}<span>${html}</span></${tag}>`;
}

// ── Repo detection ────────────────────────────────────────────────────────────
function handleRepoRefresh(url) {
  let urlObj;
  try { urlObj = new URL(url); } catch { return; }

  if (urlObj.hostname !== "github.com" && urlObj.hostname !== "www.github.com") {
    showNotRepoMessage();
    return;
  }

  const pathParts = urlObj.pathname.split("/").filter(p => p);

  // Ignore special GitHub paths that aren't repos
  const nonRepoPaths = [
    "explore", "trending", "marketplace", "login", "logout", "signup", "session", "sessions",
    "settings", "notifications", "pulls", "issues", "orgs", "organizations", "users",
    "sponsors", "topics", "collections", "features", "enterprise", "pricing", "about",
    "search", "new", "codespaces", "dashboard", "account", "apps", "stars", "watching",
    "security", "readme", "site", "customer-stories", "github-copilot",
  ];
  if (pathParts.length < 2 || nonRepoPaths.includes(pathParts[0].toLowerCase())) {
    showNotRepoMessage();
    return;
  }

  hideNotRepoMessage();

  const newRepo = { owner: pathParts[0], repo: pathParts[1] };
  if (!currentRepo || currentRepo.owner !== newRepo.owner || currentRepo.repo !== newRepo.repo) {
    currentRepo = newRepo;
    updateRepoInfo();
  }
}

function showNotRepoMessage() {
  onRepoPage = false;
  applyView();
}

function hideNotRepoMessage() {
  onRepoPage = true;
  applyView();
  moveTabIndicator(); // tabs were display:none, so their geometry was unknown
  if (reloadPending) reloadCurrentRepo();
}

// ── Core update ───────────────────────────────────────────────────────────────
async function updateRepoInfo() {
  if (!currentRepo) return;
  const { owner, repo } = currentRepo;
  document.getElementById("repo-name").innerHTML =
    `<span class="repo-owner">${escapeHtml(owner)} / </span>${escapeHtml(repo)}`;
  document.getElementById("repo-description").textContent = "";
  document.getElementById("repo-stars").textContent = "—";
  document.getElementById("repo-forks").textContent = "—";
  document.getElementById("repo-license-wrap").hidden = true;
  document.getElementById("repo-fork-badge").style.display = "none";

  // A brief belongs to the repo it was opened on
  closeIssueBrief();
  issueIndex.clear();

  // New repo starts on "All" (sort and unclaimed preferences carry over)
  issueView.filter = "";
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.label === ""));

  // Header + the visible tab now; other tabs load the first time they're opened,
  // which keeps a repo visit to 2 requests instead of ~13.
  loadedTabs = new Set();
  fetchRepoData();
  loadChatHistory();
  loadTabData(lastContentTab);
}

// ── Lazy tab loading ──────────────────────────────────────────────────────────
const TAB_LOADERS = {
  issues: () => fetchIssues(),
  tech: () => fetchTechStack(),
  maintainers: () => fetchMaintainers(),
  contribute: () => fetchContributeTab(),
};
let loadedTabs = new Set();

function loadTabData(name) {
  if (!currentRepo || !onRepoPage || !TAB_LOADERS[name] || loadedTabs.has(name)) return;
  const key = repoKey();
  loadedTabs.add(name);
  Promise.resolve(TAB_LOADERS[name]()).then(ok => {
    // A failed load (rate limit, network) isn't "loaded": retry the next time
    // the tab is shown rather than leaving its error on screen for good.
    if (!ok && isCurrentRepo(key)) loadedTabs.delete(name);
  });
}

// After a rate-limit reset or a token change: re-run what's visible. Anything
// that loaded fine is served from cache; only failed requests hit GitHub.
let reloadPending = false;

function reloadCurrentRepo() {
  if (!currentRepo) return;
  // Off the repo page (e.g. on GitHub's token page) — run it when we're back
  if (!onRepoPage) { reloadPending = true; return; }
  reloadPending = false;
  loadedTabs = new Set();
  fetchRepoData();
  loadTabData(lastContentTab);
}

// ── GitHub API layer ──────────────────────────────────────────────────────────
// Without a token GitHub allows 60 requests an hour per IP, so every request
// counts:
//  • responses (404s included — most probed files don't exist) are cached for
//    the browser session in chrome.storage.session, so reopening the panel is free
//  • while fresh they're served without touching the network; after that they're
//    revalidated with If-None-Match, and GitHub doesn't count 304 replies
//  • once the quota is spent, requests stop until the reset time instead of
//    each tab collecting its own 403
const GH_FRESH_MS = 10 * 60 * 1000;
const GH_MAX_CACHED_CHARS = 400_000; // skip persisting huge bodies (e.g. file trees)
const ghMemCache = new Map();        // cache key → { status, body, etag, link, time }
const ghInflight = new Map();        // cache key → Promise of the same
// Core quota drives the badge/banner; search has its own (10/min anonymously)
const ghState = { remaining: null, limit: null, resetAt: 0, badToken: false, search: { remaining: null, resetAt: 0 } };

class GitHubError extends Error {
  constructor(message, status, { rateLimited = false, resetAt = 0, resource = "core" } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
    this.resource = resource;
  }
}

const resourceFor = (url) => (/^\/search\//.test(new URL(url).pathname) ? "search" : "core");
const limitsFor = (resource) => (resource === "search" ? ghState.search : ghState);

function isRateLimited(resource = "core") {
  const l = limitsFor(resource);
  return l.remaining === 0 && Date.now() < l.resetAt;
}

function rateLimitError(resource = "core") {
  const { resetAt } = limitsFor(resource);
  const message = resource === "search"
    ? `GitHub's search limit is used up for a moment — it resets at ${formatTime(resetAt)}.`
    : `GitHub's hourly request limit is used up — it resets at ${formatTime(resetAt)}.`;
  return new GitHubError(message, 403, { rateLimited: true, resetAt, resource });
}

function repoApiUrl(endpoint, repo) {
  return endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com/repos/${repo.owner}/${repo.repo}${endpoint}`;
}

function githubHeaders(url, token = githubToken) {
  const headers = { "Accept": "application/vnd.github+json" };
  // Send the token only to GitHub's own API host — endpoint may be a full URL
  // that came from response data, and the token must not follow it elsewhere.
  let host = "";
  try { host = new URL(url).host; } catch { throw new GitHubError(`Invalid GitHub API URL: ${url}`, 0); }
  if (token && host === "api.github.com") headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// Cache keys include whether a token was used: a private repo that 404s
// anonymously must not stay "missing" once a token is added.
function ghCacheKey(url) { return `gh:${githubToken ? "auth" : "anon"}:${url}`; }

async function ghCacheGet(key) {
  if (ghMemCache.has(key)) return ghMemCache.get(key);
  try {
    const stored = (await chrome.storage.session?.get(key))?.[key];
    if (stored) ghMemCache.set(key, stored);
    return stored || null;
  } catch { return null; }
}

function ghCacheSet(key, entry) {
  ghMemCache.set(key, entry);
  if (JSON.stringify(entry).length > GH_MAX_CACHED_CHARS) return;
  chrome.storage.session?.set({ [key]: entry }).catch(() => {}); // quota full → memory only
}

function noteRateLimitHeaders(res, resource) {
  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (remaining === null) return;
  const l = limitsFor(res.headers.get("X-RateLimit-Resource") || resource);
  l.remaining = Number(remaining);
  l.limit = Number(res.headers.get("X-RateLimit-Limit"));
  l.resetAt = Number(res.headers.get("X-RateLimit-Reset")) * 1000;
  if (l === ghState) renderRateLimit();
}

function isRateLimitResponse(res, body, resource = "core") {
  if (res.status !== 403 && res.status !== 429) return false;
  const quotaGone = res.headers.get("X-RateLimit-Remaining") === "0";
  const retryAfter = Number(res.headers.get("Retry-After")) || 0;
  if (!quotaGone && !retryAfter && res.status !== 429 && !/rate limit/i.test(body?.message || "")) return false;
  // Secondary limits don't zero the quota — pause for Retry-After (or a minute).
  // Not until X-RateLimit-Reset: that's the primary window, often an hour away.
  if (!quotaGone) {
    const l = limitsFor(resource);
    l.remaining = 0;
    l.resetAt = Date.now() + (retryAfter || 60) * 1000;
    if (l === ghState) renderRateLimit();
  }
  return true;
}

// GET a GitHub API URL → { status, body, link }. Cached, de-duplicated and
// rate-limit aware; a stale cached copy is preferred over failing.
async function githubRequest(url) {
  const key = ghCacheKey(url);
  const cached = await ghCacheGet(key);
  if (cached && Date.now() - cached.time < GH_FRESH_MS) return cached;
  if (ghInflight.has(key)) return ghInflight.get(key);

  const resource = resourceFor(url);
  const request = (async () => {
    if (isRateLimited(resource)) {
      if (cached) return cached;
      throw rateLimitError(resource);
    }
    const headers = githubHeaders(url);
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    let res;
    try {
      // no-store: we do our own conditional requests, so skip the HTTP cache
      res = await fetch(url, { headers, cache: "no-store" });
    } catch {
      if (cached) return cached;
      throw new GitHubError("Couldn't reach GitHub — check your connection.", 0);
    }
    noteRateLimitHeaders(res, resource);

    if (res.status === 304 && cached) {
      const refreshed = { ...cached, time: Date.now() };
      ghCacheSet(key, refreshed);
      return refreshed;
    }

    const body = await res.json().catch(() => null);
    if (isRateLimitResponse(res, body, resource)) {
      if (cached) return cached;
      throw rateLimitError(resource);
    }
    if (res.status === 401 && githubToken) {
      ghState.badToken = true;
      renderRateLimit();
      throw new GitHubError("GitHub rejected your token — update or clear it in Settings.", 401);
    }

    const entry = { status: res.status, body, etag: res.headers.get("ETag"), link: res.headers.get("Link"), time: Date.now() };
    if (res.ok || res.status === 404) ghCacheSet(key, entry);
    return entry;
  })().finally(() => ghInflight.delete(key));

  ghInflight.set(key, request);
  return request;
}

// `repo` defaults to the current repo; callers that have already awaited
// something must pass the repo they captured, since currentRepo may have moved on.
async function fetchGitHub(endpoint, repo = currentRepo) {
  return (await fetchGitHubPage(endpoint, repo)).data;
}

// Like fetchGitHub, but also returns the Link header (for page counts)
async function fetchGitHubPage(endpoint, repo = currentRepo) {
  const { status, body, link } = await githubRequest(repoApiUrl(endpoint, repo));
  if (status < 200 || status >= 300) {
    throw new GitHubError(`GitHub API ${status}: ${body?.message || "request failed"}`, status);
  }
  return { data: body, link };
}

// Does this path exist? 404 → false; rate limits and other errors propagate.
function githubExists(endpoint, repo) {
  return fetchGitHub(endpoint, repo).then(() => true, err => {
    if (err.status === 404) return false;
    throw err;
  });
}

// GET /rate_limit doesn't count against the limit, so it's a free way to show
// the real quota on open and to validate a token before saving it.
async function checkRateLimit(token = githubToken) {
  const url = "https://api.github.com/rate_limit";
  const res = await fetch(url, { headers: githubHeaders(url, token), cache: "no-store" });
  if (res.status === 401) return { valid: false };
  const core = (await res.json().catch(() => null))?.resources?.core;
  return { valid: true, core };
}

async function refreshRateLimit() {
  try {
    const { valid, core } = await checkRateLimit();
    ghState.badToken = !valid && !!githubToken;
    if (core) {
      ghState.remaining = core.remaining;
      ghState.limit = core.limit;
      ghState.resetAt = core.reset * 1000;
    }
    renderRateLimit();
  } catch { /* offline — the next real request will report */ }
}

// ── Rate-limit UI: header badge + banner ──────────────────────────────────────
let rateTimer = null;
let wasRateLimited = false;

function renderRateLimit() {
  const { remaining, limit, badToken } = ghState;
  const badge = document.getElementById("rate-limit-badge");
  if (remaining !== null) {
    document.getElementById("rate-limit-text").textContent = `${remaining}/${limit}`;
  }
  const limited = isRateLimited();
  const low = !limited && remaining !== null && remaining <= Math.max(10, limit * 0.05);
  badge.classList.toggle("rate-limit-low", limited || low);
  badge.title = githubToken
    ? "GitHub API requests left this hour"
    : "GitHub API requests left this hour — click to add a token for 5,000/hour";

  const banner = document.getElementById("rate-banner");
  let title = "", sub = "", action = "";
  if (badToken) {
    title = "GitHub rejected your token";
    sub = "It may have expired or been revoked — generate a new one on GitHub.";
    action = "Get new token";
  } else if (limited) {
    const mins = Math.max(1, Math.ceil((ghState.resetAt - Date.now()) / 60000));
    title = "GitHub's hourly limit is used up";
    sub = `Resumes at ${formatTime(ghState.resetAt)} (in ${mins} min).` +
      (githubToken ? " Anything already loaded still works." : " A free token raises the limit to 5,000/hour.");
    action = githubToken ? "" : "Get token";
  } else if (low && !githubToken) {
    title = `${remaining} GitHub request${remaining === 1 ? "" : "s"} left this hour`;
    sub = "A free token raises the limit to 5,000/hour.";
    action = "Get token";
  }
  banner.hidden = !title;
  banner.classList.toggle("is-warn", !!title && !badToken && !limited);
  document.getElementById("rate-banner-title").textContent = title;
  document.getElementById("rate-banner-sub").textContent = sub;
  const btn = document.getElementById("rate-banner-btn");
  btn.hidden = !action;
  btn.textContent = action;

  // Tick the countdown while limited; when the window resets, reload what failed
  if (limited && !rateTimer) {
    rateTimer = setInterval(renderRateLimit, 15000);
  } else if (!limited && rateTimer) {
    clearInterval(rateTimer);
    rateTimer = null;
  }
  if (wasRateLimited && !limited && !badToken) reloadCurrentRepo();
  wasRateLimited = limited;
}

const GITHUB_TOKEN_URL = "https://github.com/settings/tokens";

function openTokenSettings() {
  switchTab("settings");
  const input = document.getElementById("sp-gh-token");
  input.scrollIntoView({ block: "center", behavior: "smooth" });
  input.focus();
  // Draw the eye to where the new token goes
  const card = document.getElementById("sp-gh-card");
  card.classList.remove("attention");
  void card.offsetWidth;
  card.classList.add("attention");
}

// Straight to GitHub's token page in a new tab, with the panel already waiting
// on the token field — the side panel stays open, so the user just pastes on return.
function getGitHubToken() {
  chrome.tabs.create({ url: GITHUB_TOKEN_URL });
  openTokenSettings();
  // Stays put while the user is off on GitHub generating the token
  showSpStatus("sp-gh-status", "Paste your new token here and press Save token.", false, 0);
}

// ── Repo metadata ─────────────────────────────────────────────────────────────
// Returns a shared promise for the repo metadata so the header and the health
// score (which needs pushed_at / open_issues_count) wait on the same request.
function loadRepoData(repo = currentRepo) {
  const cache = cacheFor(repoKey(repo));
  if (cache.repoData) return Promise.resolve(cache.repoData);
  cache.repoDataPromise ??= fetchGitHub("", repo)
    .then(data => (cache.repoData = data))
    .finally(() => { delete cache.repoDataPromise; });
  return cache.repoDataPromise;
}

async function fetchRepoData() {
  const cacheKey = repoKey();
  try {
    const data = await loadRepoData();
    if (isCurrentRepo(cacheKey)) applyRepoData(data);
  } catch (err) {
    console.warn("fetchRepoData:", err.message);
  }
}

function applyRepoData(data) {
  document.getElementById("repo-description").textContent = data.description || "";
  document.getElementById("repo-stars").textContent = formatNumber(data.stargazers_count);
  document.getElementById("repo-forks").textContent = formatNumber(data.forks_count);
  const license = data.license?.spdx_id;
  const hasLicense = !!license && license !== "NOASSERTION";
  document.getElementById("repo-license").textContent = hasLicense ? license : "";
  document.getElementById("repo-license-wrap").hidden = !hasLicense;
  // Fork detection — show upstream repo link if this is a fork
  const forkBadge = document.getElementById("repo-fork-badge");
  if (data.fork && data.parent) {
    forkBadge.innerHTML = `${icon("fork", "icon-sm")}fork of <a href="${data.parent.html_url}" target="_blank">${escapeHtml(data.parent.full_name)}</a>`;
    forkBadge.style.display = "";
  } else {
    forkBadge.style.display = "none";
  }
}

function formatNumber(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ── Issues ────────────────────────────────────────────────────────────────────
// "All" pages through the issues API. Label filters use the search API across
// every open issue (not just one page), matched against the repo's real label
// names; "Unclaimed only" there also drops issues with a linked PR.
const issueView = { filter: "", sort: "comments", unclaimed: true };
const ISSUE_PAGE = 30;
const SORT_WORDS = { comments: "most discussed first", created: "newest first", updated: "recently updated first" };

const issueViewKey = (v) => `${v.filter}|${v.sort}|${v.unclaimed}`;

async function fetchIssues({ append = false } = {}) {
  const repo = currentRepo;
  const cacheKey = repoKey(repo);
  const view = { ...issueView };
  const key = issueViewKey(view);
  const views = (cacheFor(cacheKey).issueViews ??= {});
  const list = document.getElementById("issues-list");
  const more = document.getElementById("issues-more");
  const current = () => isCurrentRepo(cacheKey) && issueViewKey(issueView) === key;

  if (!append && views[key]) { renderIssueList(views[key], view); return true; }
  if (append) { more.disabled = true; more.textContent = "Loading…"; }
  else { list.innerHTML = skeletonList(5); more.hidden = true; document.getElementById("issues-summary").textContent = ""; }

  try {
    const page = append ? views[key].page + 1 : 1;
    const result = view.filter ? await searchLabelIssues(repo, view, page) : await listOpenIssues(repo, view, page);
    views[key] = append ? { ...result, items: [...views[key].items, ...result.items] } : result;
    if (current()) renderIssueList(views[key], view);
    return true;
  } catch (err) {
    if (current()) {
      if (append) { more.disabled = false; more.textContent = "Couldn't load more — try again"; }
      else list.innerHTML = errorState(err);
    }
    // Search limits reset within a minute — retry by ourselves if still here
    if (err.rateLimited && err.resource === "search") {
      setTimeout(() => { if (current()) fetchIssues({ append }); }, Math.max(1000, err.resetAt - Date.now() + 500));
    }
    return false;
  }
}

async function listOpenIssues(repo, view, page) {
  const { data, link } = await fetchGitHubPage(
    `/issues?state=open${view.unclaimed ? "&assignee=none" : ""}&sort=${view.sort}&direction=desc&per_page=${ISSUE_PAGE}&page=${page}`, repo);
  return { items: data.filter(i => !i.pull_request), page, total: null, hasMore: /rel="next"/.test(link || "") };
}

async function searchLabelIssues(repo, view, page) {
  const labels = await labelsForFilter(view.filter, repo);
  if (!labels.length) return { items: [], page, total: 0, hasMore: false, labels, noLabel: true };
  const search = (unclaimed, perPage, p) => fetchGitHub(
    `https://api.github.com/search/issues?q=${encodeURIComponent(beginnerSearchQuery(repo, labels, { unclaimed }))}` +
    `&sort=${view.sort}&order=desc&per_page=${perPage}&page=${p}`, repo);
  const res = await search(view.unclaimed, ISSUE_PAGE, page);
  const total = res.total_count ?? 0;
  const result = { items: res.items || [], page, total, labels, hasMore: page * ISSUE_PAGE < Math.min(total, 1000) };
  // Nothing unclaimed? Say how many are taken rather than showing a bare empty list
  if (view.unclaimed && total === 0 && page === 1) {
    result.claimedTotal = (await search(false, 1, 1).catch(() => null))?.total_count ?? null;
  }
  return result;
}

function renderIssueList(state, view) {
  const list = document.getElementById("issues-list");
  const more = document.getElementById("issues-more");
  const summary = document.getElementById("issues-summary");
  const filterName = { "good-first-issue": "good first", "help-wanted": "help wanted" }[view.filter];

  if (view.filter) {
    summary.innerHTML = state.noLabel ? "" :
      `<strong>${state.total.toLocaleString()}</strong> ${filterName} issue${state.total === 1 ? "" : "s"}` +
      `${view.unclaimed ? " · unassigned, no linked PR" : ""} · ${SORT_WORDS[view.sort]}` +
      `<span class="issues-labels" title="Matched labels">Labels: ${state.labels.map(l => escapeHtml(l)).join(", ")}</span>`;
  } else {
    summary.textContent = `${view.unclaimed ? "Unassigned open issues" : "All open issues"}, ${SORT_WORDS[view.sort]}`;
  }

  if (!state.items.length) {
    more.hidden = true;
    if (state.noLabel) {
      list.innerHTML = stateItem(`This repo doesn't use a <strong>${filterName}</strong> label. Browse <strong>All</strong> and look for small, clearly described issues.`);
    } else if (state.claimedTotal) {
      list.innerHTML = stateItem(`All <strong>${state.claimedTotal}</strong> ${filterName} issues are already assigned or have a linked PR.` +
        ` <button class="btn btn-xs show-claimed">Show them anyway</button>`);
      list.querySelector(".show-claimed").addEventListener("click", () => setUnclaimed(false));
    } else {
      list.innerHTML = stateItem(view.filter
        ? `No open <strong>${filterName}</strong> issues right now.`
        : `No open${view.unclaimed ? ", unassigned" : ""} issues. The <strong>Contribute</strong> tab has other ways to help.`);
    }
    return;
  }

  state.items.forEach(i => issueIndex.set(i.number, i));
  list.innerHTML = state.items.map(issueCard).join("");
  more.hidden = !state.hasMore;
  more.disabled = false;
  more.textContent = "Load more";
}

function issueCard(issue) {
  const labelsHtml = issue.labels
    .map(l => `<span class="label-chip" style="--lc:#${/^[0-9a-f]{6}$/i.test(l.color) ? l.color : "8b949e"}">${escapeHtml(l.name)}</span>`)
    .join("");
  const reactions = issue.reactions?.total_count || 0;
  const assignee = issue.assignees?.[0] || issue.assignee;
  return `
    <li class="list-card">
      <a href="${issue.html_url}" target="_blank" class="issue-link"><span class="issue-number">#${issue.number}</span> ${escapeHtml(issue.title)}</a>
      <div class="issue-meta">
        <span title="Comments">${icon("comment", "icon-sm")}${issue.comments}</span>
        ${reactions ? `<span title="Reactions">${icon("heart", "icon-sm")}${reactions}</span>` : ""}
        ${assignee ? `<span title="Assigned to ${escapeHtml(assignee.login)}"><img src="${avatarUrl(assignee.avatar_url, 32)}" class="avatar-sm" alt="">assigned</span>` : ""}
        <span class="issue-age">${daysAgo(issue.created_at)}</span>
      </div>
      ${labelsHtml ? `<div class="issue-labels">${labelsHtml}</div>` : ""}
      <button class="start-issue-btn" data-issue="${issue.number}">${icon("bolt", "icon-sm")}Start this issue${icon("arrow-right", "icon-sm")}</button>
    </li>`;
}

function setIssueFilter(filter) {
  issueView.filter = filter;
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.label === filter));
  fetchIssues();
}

function setUnclaimed(on) {
  issueView.unclaimed = on;
  document.getElementById("issue-unclaimed").checked = on;
  fetchIssues();
}

// Repos spell these labels many ways ("good first issue", "good-first-issue",
// "Good First Issue 👋", "first-timers-only"…), so compare normalised names.
const LABEL_ALIASES = {
  "good-first-issue": ["good first issue", "good first issues", "good first bug", "first timers only", "first timer", "beginner", "beginner friendly", "starter", "newcomer"],
  "help-wanted":      ["help wanted", "contributions welcome", "pr welcome", "prs welcome", "up for grabs"],
};

function normalizeLabel(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function labelMatchesFilter(name, filter) {
  const aliases = LABEL_ALIASES[filter] || [normalizeLabel(filter)];
  const n = normalizeLabel(name);
  return aliases.some(a => n === a || n.endsWith(" " + a) || n.startsWith(a + " "));
}

// ── Tech Stack ────────────────────────────────────────────────────────────────
async function fetchTechStack() {
  const list = document.getElementById("tech-list");
  list.classList.add("skeleton-mode");
  list.innerHTML = skeletonList(4, "bar");

  const cacheKey = repoKey();
  if (repoCache[cacheKey]?.languages && repoCache[cacheKey]?.tools !== undefined) {
    renderTechStack(repoCache[cacheKey].languages, repoCache[cacheKey].tools);
    return true;
  }

  try {
    const [languages, tools] = await Promise.all([
      repoCache[cacheKey]?.languages
        ? Promise.resolve(repoCache[cacheKey].languages)
        : fetchGitHub("/languages").then(l => (cacheFor(cacheKey).languages = l)),
      detectTools(),
    ]);
    if (isCurrentRepo(cacheKey)) renderTechStack(languages, tools);
    return true;
  } catch (err) {
    if (isCurrentRepo(cacheKey)) list.innerHTML = errorState(err);
    return false;
  }
}

// GitHub's linguist colours for the most common languages; others fall back to a
// neutral tone so the bar still reads.
const LANG_COLORS = {
  JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Java: "#b07219", Go: "#00ADD8",
  Rust: "#dea584", "C++": "#f34b7d", C: "#555555", "C#": "#178600", Ruby: "#701516", PHP: "#4F5D95",
  Swift: "#F05138", Kotlin: "#A97BFF", Dart: "#00B4AB", Shell: "#89e051", HTML: "#e34c26", CSS: "#563d7c",
  SCSS: "#c6538c", Vue: "#41b883", Svelte: "#ff3e00", Lua: "#000080", Scala: "#c22d40", Elixir: "#6e4a7e",
  Haskell: "#5e5086", "Objective-C": "#438eff", R: "#198CE7", Julia: "#a270ba", Dockerfile: "#384d54",
  Makefile: "#427819", TeX: "#3D6117", "Jupyter Notebook": "#DA5B0B", Nix: "#7e7eff", Zig: "#ec915c",
  MDX: "#fcb32c", Astro: "#ff5a03", Perl: "#0298c3", PowerShell: "#012456", CMake: "#DA3434",
};
const langColor = (lang) => LANG_COLORS[lang] || "#8b949e";

function renderTechStack(languages, tools = []) {
  const list = document.getElementById("tech-list");
  list.classList.remove("skeleton-mode");
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);

  if (!entries.length) {
    list.innerHTML = stateItem("GitHub hasn't detected any languages in this repo.");
  } else {
    const pct = (n) => (n / total) * 100;
    const bar = entries
      .map(([lang, n]) => `<span style="width:${pct(n)}%;background:${langColor(lang)}" title="${escapeHtml(lang)} ${pct(n).toFixed(1)}%"></span>`)
      .join("");
    list.innerHTML = `<li class="lang-bar-row"><div class="lang-bar">${bar}</div></li>` + entries.map(([lang, n]) => `
      <li class="lang-row">
        <span class="lang-dot" style="background:${langColor(lang)}"></span>
        <span class="tech-name">${escapeHtml(lang)}</span>
        <span class="tech-pct">${pct(n) < 0.1 ? "<0.1" : pct(n).toFixed(1)}%</span>
      </li>`).join("");
  }
  renderTools(tools);
}

// ── Tools & Services detection ────────────────────────────────────────────────
async function detectTools() {
  const repo = currentRepo;
  const cacheKey = repoKey(repo);
  if (repoCache[cacheKey]?.tools !== undefined) return repoCache[cacheKey].tools;

  const tools = new Map(); // name → { emoji, category }

  const TOOL_DEFS = {
    "Docker":          { emoji: "🐳", category: "Containers" },
    "Docker Compose":  { emoji: "🐳", category: "Containers" },
    "Kubernetes":      { emoji: "☸️",  category: "Containers" },
    "GitHub Actions":  { emoji: "⚙️",  category: "CI/CD" },
    "CircleCI":        { emoji: "◎",  category: "CI/CD" },
    "Travis CI":       { emoji: "🔧", category: "CI/CD" },
    "Jenkins":         { emoji: "🔧", category: "CI/CD" },
    "AppVeyor":        { emoji: "🔧", category: "CI/CD" },
    "Azure Pipelines": { emoji: "☁️",  category: "CI/CD" },
    "Terraform":       { emoji: "🏗️",  category: "Infrastructure" },
    "Ansible":         { emoji: "🔩", category: "Infrastructure" },
    "Nginx":           { emoji: "🌐", category: "Infrastructure" },
    "AWS":             { emoji: "☁️",  category: "Cloud" },
    "Azure":           { emoji: "☁️",  category: "Cloud" },
    "GCP":             { emoji: "☁️",  category: "Cloud" },
    "Firebase":        { emoji: "🔥", category: "Cloud" },
    "Netlify":         { emoji: "🚀", category: "Deployment" },
    "Vercel":          { emoji: "▲",  category: "Deployment" },
    "Heroku":          { emoji: "💜", category: "Deployment" },
    "Serverless":      { emoji: "⚡", category: "Deployment" },
    "PostgreSQL":      { emoji: "🐘", category: "Database" },
    "MySQL":           { emoji: "🗄️",  category: "Database" },
    "MongoDB":         { emoji: "🍃", category: "Database" },
    "Redis":           { emoji: "🔴", category: "Database" },
    "SQLite":          { emoji: "🗄️",  category: "Database" },
    "Prisma":          { emoji: "◆",  category: "Database" },
    "Sequelize":       { emoji: "◆",  category: "Database" },
    "TypeORM":         { emoji: "◆",  category: "Database" },
    "Kafka":           { emoji: "📨", category: "Messaging" },
    "RabbitMQ":        { emoji: "🐰", category: "Messaging" },
    "GraphQL":         { emoji: "◈",  category: "API" },
    "gRPC":            { emoji: "⚡", category: "API" },
    "Stripe":          { emoji: "💳", category: "Services" },
    "Twilio":          { emoji: "📱", category: "Services" },
    "SendGrid":        { emoji: "📧", category: "Services" },
    "Sentry":          { emoji: "🔍", category: "Monitoring" },
    "Datadog":         { emoji: "🐕", category: "Monitoring" },
    "Prometheus":      { emoji: "🔥", category: "Monitoring" },
    "Grafana":         { emoji: "📊", category: "Monitoring" },
    "Webpack":         { emoji: "📦", category: "Build" },
    "Vite":            { emoji: "⚡", category: "Build" },
    "Jest":            { emoji: "🃏", category: "Testing" },
    "Mocha":           { emoji: "☕", category: "Testing" },
    "Cypress":         { emoji: "🌲", category: "Testing" },
    "Playwright":      { emoji: "🎭", category: "Testing" },
    "Pytest":          { emoji: "🧪", category: "Testing" },
    "Celery":          { emoji: "🌿", category: "Background Jobs" },
    "TensorFlow":      { emoji: "🤖", category: "ML/AI" },
    "PyTorch":         { emoji: "🔥", category: "ML/AI" },
    "scikit-learn":    { emoji: "🔬", category: "ML/AI" },
    "Pandas":          { emoji: "🐼", category: "Data" },
    "NumPy":           { emoji: "🔢", category: "Data" },
  };

  function add(name) {
    if (TOOL_DEFS[name] && !tools.has(name)) tools.set(name, TOOL_DEFS[name]);
  }

  // The file tree (one API call, shared with chat) replaces per-directory
  // listings; package.json / requirements.txt come from raw files, which are free.
  const tree = await getRepoTree(repo); // rate limits propagate, so nothing wrong gets cached
  const [pkgResult, reqResult] = await Promise.allSettled([
    readRepoFile("package.json", repo),
    readRepoFile("requirements.txt", repo),
  ]);

  // ── Root directory file-based detection ─────────────────────────────────────
  {
    const items  = tree.entries
      .filter(e => !e.path.includes("/"))
      .map(e => ({ name: e.path, type: e.type === "tree" ? "dir" : "file" }));
    const names  = items.map(f => f.name.toLowerCase());
    const byName = Object.fromEntries(items.map(f => [f.name.toLowerCase(), f]));

    if (names.some(n => n === "dockerfile" || n.startsWith("dockerfile.")))       add("Docker");
    if (names.some(n => n.startsWith("docker-compose")))                           add("Docker Compose");
    if (names.includes(".travis.yml"))                                             add("Travis CI");
    if (names.includes("jenkinsfile"))                                             add("Jenkins");
    if (names.includes("appveyor.yml"))                                            add("AppVeyor");
    if (names.includes("azure-pipelines.yml"))                                     add("Azure Pipelines");
    if (names.some(n => n === "serverless.yml" || n === "serverless.yaml"))        add("Serverless");
    if (names.includes("netlify.toml"))                                            add("Netlify");
    if (names.includes("vercel.json") || names.includes(".vercelignore"))          add("Vercel");
    if (names.includes("firebase.json") || names.includes(".firebaserc"))          add("Firebase");
    if (names.includes("procfile"))                                                add("Heroku");
    if (names.some(n => n.endsWith(".tf")))                                        add("Terraform");
    if (names.some(n => n === "nginx.conf" || n === "nginx"))                      add("Nginx");
    if (names.some(n => n === "prometheus.yml" || n === "prometheus.yaml"))        add("Prometheus");
    if (names.some(n => n === "grafana.ini" || n === "grafana"))                   add("Grafana");
    if (byName[".circleci"]?.type === "dir")                                       add("CircleCI");
    if (names.some(n => ["k8s","kubernetes","helm","charts"].includes(n) && byName[n]?.type === "dir")) {
      add("Kubernetes");
    }
    if (names.some(n => ["ansible","playbooks"].includes(n) && byName[n]?.type === "dir")) {
      add("Ansible");
    }

    if (tree.entries.some(e => e.path.startsWith(".github/workflows/"))) add("GitHub Actions");
  }

  // ── package.json dependency scanning ────────────────────────────────────────
  if (pkgResult.status === "fulfilled" && pkgResult.value) {
    try {
      const pkg  = JSON.parse(pkgResult.value);
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });

      const PKG_MAP = [
        [["aws-sdk", "@aws-sdk/"],                    "AWS"],
        [["@azure/", "azure-"],                       "Azure"],
        [["@google-cloud/"],                          "GCP"],
        [["firebase", "firebase-admin", "@firebase/"],"Firebase"],
        [["redis", "ioredis"],                        "Redis"],
        [["mongoose", "mongodb"],                     "MongoDB"],
        [["pg", "postgres"],                          "PostgreSQL"],
        [["mysql", "mysql2"],                         "MySQL"],
        [["sqlite3", "better-sqlite3"],               "SQLite"],
        [["prisma", "@prisma/"],                      "Prisma"],
        [["sequelize"],                               "Sequelize"],
        [["typeorm"],                                 "TypeORM"],
        [["kafkajs", "kafka-node"],                   "Kafka"],
        [["amqplib"],                                 "RabbitMQ"],
        [["graphql"],                                 "GraphQL"],
        [["@grpc/"],                                  "gRPC"],
        [["stripe"],                                  "Stripe"],
        [["twilio"],                                  "Twilio"],
        [["@sendgrid/", "sendgrid"],                  "SendGrid"],
        [["@sentry/"],                                "Sentry"],
        [["@datadog/"],                               "Datadog"],
        [["jest", "@jest/"],                          "Jest"],
        [["mocha"],                                   "Mocha"],
        [["cypress"],                                 "Cypress"],
        [["@playwright/"],                            "Playwright"],
        [["webpack"],                                 "Webpack"],
        [["vite"],                                    "Vite"],
        [["@tensorflow/"],                            "TensorFlow"],
      ];

      for (const [prefixes, name] of PKG_MAP) {
        if (deps.some(d => prefixes.some(p => d === p || d.startsWith(p)))) add(name);
      }
    } catch {}
  }

  // ── requirements.txt keyword scanning ───────────────────────────────────────
  if (reqResult.status === "fulfilled" && reqResult.value) {
    try {
      const req = reqResult.value.toLowerCase();

      const REQ_MAP = [
        [["boto3", "botocore", "awscli"],              "AWS"],
        [["google-cloud", "google.cloud"],             "GCP"],
        [["azure-"],                                   "Azure"],
        [["firebase-admin", "firebase"],               "Firebase"],
        [["redis", "aioredis"],                        "Redis"],
        [["pymongo"],                                  "MongoDB"],
        [["psycopg2", "asyncpg", "psycopg"],           "PostgreSQL"],
        [["mysql-connector", "pymysql", "aiomysql"],   "MySQL"],
        [["kafka-python", "confluent-kafka"],          "Kafka"],
        [["celery"],                                   "Celery"],
        [["pytest"],                                   "Pytest"],
        [["tensorflow", "tf-nightly"],                 "TensorFlow"],
        [["torch"],                                    "PyTorch"],
        [["scikit-learn", "sklearn"],                  "scikit-learn"],
        [["pandas"],                                   "Pandas"],
        [["numpy"],                                    "NumPy"],
        [["sentry-sdk"],                               "Sentry"],
        [["stripe"],                                   "Stripe"],
        [["graphene", "strawberry-graphql"],           "GraphQL"],
      ];

      for (const [keywords, name] of REQ_MAP) {
        if (keywords.some(k => req.includes(k))) add(name);
      }
    } catch {}
  }

  const result = Array.from(tools.entries()).map(([name, meta]) => ({ name, ...meta }));
  cacheFor(cacheKey).tools = result;
  return result;
}

function renderTools(tools) {
  const section = document.getElementById("tools-section");
  const grid    = document.getElementById("tools-grid");

  if (!tools || tools.length === 0) {
    section.style.display = "none";
    return;
  }

  // Group by category, preserving insertion order
  const grouped = {};
  tools.forEach(t => {
    if (!grouped[t.category]) grouped[t.category] = [];
    grouped[t.category].push(t);
  });

  grid.innerHTML = "";
  for (const [category, items] of Object.entries(grouped)) {
    const div = document.createElement("div");
    div.className = "tools-category";
    div.innerHTML = `
      <span class="tools-cat-label">${escapeHtml(category)}</span>
      <div class="tools-cat-pills">
        ${items.map(t => `<span class="tool-pill">${escapeHtml(t.name)}</span>`).join("")}
      </div>
    `;
    grid.appendChild(div);
  }
  section.style.display = "block";
}

// ── Maintainers ───────────────────────────────────────────────────────────────
// Active maintainers come from who actually replies (see insights.js); the
// all-time commit ranking is kept below as context.
const ROLE_NAMES = { OWNER: "Owner", MEMBER: "Org member", COLLABORATOR: "Collaborator" };

async function fetchMaintainers() {
  const repo = currentRepo;
  const cacheKey = repoKey(repo);
  const mList = document.getElementById("maintainers-list");
  const cList = document.getElementById("contributors-list");
  if (repoCache[cacheKey]?.people) { renderPeople(repoCache[cacheKey].people); return true; }

  mList.innerHTML = skeletonList(3, "person");
  cList.innerHTML = skeletonList(4, "person");
  document.getElementById("maintainer-teams").hidden = true;

  const [activity, owners, contributors] = await Promise.allSettled([
    loadRepoActivity(repo),
    loadCodeOwners(repo),
    fetchGitHub("/contributors?per_page=10", repo),
  ]);
  const limited = [activity, contributors].find(r => r.status === "rejected" && r.reason?.rateLimited);
  if (limited) {
    if (isCurrentRepo(cacheKey)) mList.innerHTML = cList.innerHTML = errorState(limited.reason);
    return false;
  }

  const people = {
    maintainers: activity.status === "fulfilled"
      ? activeMaintainers(activity.value.comments, owners.status === "fulfilled" ? owners.value.rules : [])
      : { error: activity.reason },
    partialSample: activity.status === "fulfilled" && !activity.value.commentsComplete,
    contributors: contributors.status === "fulfilled" ? contributors.value : { error: contributors.reason },
  };
  const ok = activity.status === "fulfilled" && contributors.status === "fulfilled";
  if (ok) cacheFor(cacheKey).people = people;
  if (isCurrentRepo(cacheKey)) renderPeople(people);
  return ok;
}

function renderPeople({ maintainers, partialSample, contributors }) {
  const mList = document.getElementById("maintainers-list");
  const teamsEl = document.getElementById("maintainer-teams");

  if (maintainers.error) {
    mList.innerHTML = errorState(maintainers.error);
  } else if (!maintainers.people.length) {
    mList.innerHTML = stateItem(`Nobody with maintainer access replied to issues or PRs in the last 90 days${partialSample ? " (in the latest comments)" : ""}. Expect slow responses.`);
  } else {
    mList.innerHTML = maintainers.people.slice(0, 8).map((p, i) => {
      const chips = [
        p.role ? `<span class="role-chip">${ROLE_NAMES[p.role] || p.role}</span>` : "",
        p.codeOwner ? `<span class="role-chip role-owner" title="CODEOWNERS: ${escapeHtml(p.owns.join(", "))}">Code owner</span>` : "",
      ].join("");
      const sub = p.threads
        ? `Replied in ${p.threads} thread${p.threads === 1 ? "" : "s"} · active ${daysAgo(p.lastActive)}`
        : `Owns ${p.owns.map(o => `<code>${escapeHtml(o)}</code>`).join(", ")}`;
      return `
        <li class="person" style="animation-delay:${i * 25}ms">
          <img src="${avatarUrl(p.avatar_url, 64)}" class="contributor-avatar" alt="" loading="lazy">
          <div class="contributor-info">
            <div class="contributor-top">
              <a href="${p.html_url}" target="_blank" class="contributor-name">${escapeHtml(p.login)}</a>
              <span class="role-chips">${chips}</span>
            </div>
            <div class="person-sub">${sub}</div>
          </div>
        </li>`;
    }).join("");
  }
  teamsEl.hidden = !maintainers.teams?.length;
  if (maintainers.teams?.length) {
    teamsEl.innerHTML = `${icon("users", "icon-sm")}Code-owner teams: ${maintainers.teams.map(t => `<code>${escapeHtml(t)}</code>`).join(" ")}`;
  }

  const cList = document.getElementById("contributors-list");
  if (contributors.error) { cList.innerHTML = errorState(contributors.error); return; }
  if (!contributors.length) { cList.innerHTML = stateItem("No contributor data available for this repo."); return; }
  const top = contributors[0].contributions || 1;
  cList.innerHTML = contributors.slice(0, 8).map((user, i) => `
    <li class="person" style="animation-delay:${i * 25}ms">
      <span class="person-rank">${i + 1}</span>
      <img src="${avatarUrl(user.avatar_url, 64)}" class="contributor-avatar" alt="" loading="lazy">
      <div class="contributor-info">
        <div class="contributor-top">
          <a href="${user.html_url}" target="_blank" class="contributor-name">${escapeHtml(user.login)}</a>
          <span class="contributor-commits">${formatNumber(user.contributions)} commits</span>
        </div>
        <div class="share-bar"><span style="width:${Math.max(3, (user.contributions / top) * 100)}%"></span></div>
      </div>
    </li>`).join("");
}

// ── Contribute Tab ────────────────────────────────────────────────────────────
async function fetchContributeTab() {
  const cacheKey = repoKey();

  let health = Promise.resolve(true);
  if (repoCache[cacheKey]?.health) {
    renderHealthCard(repoCache[cacheKey].health);
  } else {
    health = fetchRepoHealth();
  }
  let prs = Promise.resolve(true);
  if (repoCache[cacheKey]?.prs) {
    renderOpenPRs(repoCache[cacheKey].prs);
  } else {
    prs = fetchOpenPRs();
  }
  return (await Promise.all([health, prs])).every(Boolean);
}

async function fetchRepoHealth() {
  const card = document.getElementById("health-card");
  card.className = "card";
  card.innerHTML =
    `<div class="health-score-row"><span class="sk sk-circle" style="width:64px;height:64px"></span><span class="sk-lines" style="flex:1;display:flex;flex-direction:column;gap:8px"><span class="sk sk-line short"></span><span class="sk sk-line"></span></span></div><div class="sk sk-block"></div>`;

  const repo = currentRepo;
  const cacheKey = repoKey(repo);
  try {
    const signals = await loadHealthSignals(repo);
    const health = { ...scoreHealth(signals), signals };
    cacheFor(cacheKey).health = health;
    if (isCurrentRepo(cacheKey)) renderHealthCard(health);
    return true;
  } catch (err) {
    if (isCurrentRepo(cacheKey)) card.innerHTML = errorState(err, "div");
    return false;
  }
}

function gradeFor(score) {
  if (score === null) return { grade: "Not enough data", tone: "none" };
  if (score >= 80) return { grade: "Excellent", tone: "excellent" };
  if (score >= 60) return { grade: "Good", tone: "good" };
  if (score >= 40) return { grade: "Fair", tone: "fair" };
  return { grade: "Needs attention", tone: "poor" };
}

// Score ring + one row per signal, each showing what it measured
function renderHealthCard({ score, factors, measured, signals }) {
  const { grade, tone } = gradeFor(score);
  const circumference = 2 * Math.PI * 26;
  const card = document.getElementById("health-card");
  card.className = `card grade-${tone}`;

  const facts = [
    signals.openPRs !== null ? `${formatNumber(signals.openPRs)} open PRs` : "",
    signals.repoData ? `${formatNumber(signals.repoData.open_issues_count - (signals.openPRs || 0))} open issues` : "",
    signals.beginnerIssues ? `${signals.beginnerIssues} unclaimed beginner issue${signals.beginnerIssues === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");

  card.innerHTML = `
    <div class="health-score-row">
      <div class="health-ring" role="img" aria-label="${score === null ? "No score" : `Score ${score} out of 100`}">
        <svg viewBox="0 0 60 60">
          <circle class="ring-track" cx="30" cy="30" r="26" fill="none" stroke-width="6"/>
          <circle class="ring-value" cx="30" cy="30" r="26" fill="none" stroke-width="6"
            stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
        </svg>
        <span class="health-score-num">${score ?? "–"}</span>
      </div>
      <div>
        <div class="health-score-grade">${grade}</div>
        <div class="health-score-sub">Contributor friendliness · ${measured} of ${factors.length} signals measured</div>
      </div>
    </div>
    <ul class="factor-list">
      ${factors.map(f => `
        <li class="factor${f.points === null ? " is-na" : ""}">
          <div class="factor-top">
            <span class="factor-label">${f.label}</span>
            <span class="factor-pts">${f.points === null ? "n/a" : `${f.points}<span>/${f.max}</span>`}</span>
          </div>
          <div class="factor-bar"><span style="width:${f.points === null ? 0 : (f.points / f.max) * 100}%"></span></div>
          <div class="factor-detail">${escapeHtml(f.detail)}</div>
        </li>`).join("")}
    </ul>
    ${facts ? `<div class="health-facts">${facts}</div>` : ""}
  `;
  // Animate the ring from empty on the next frame
  requestAnimationFrame(() => {
    card.querySelector(".ring-value")?.setAttribute("stroke-dashoffset", String(circumference * (1 - (score || 0) / 100)));
  });
}

async function fetchOpenPRs() {
  const list = document.getElementById("prs-list");
  list.innerHTML = skeletonList(3);

  const cacheKey = repoKey();

  try {
    // GitHub sorts ascending unless told otherwise, so always pass direction=desc
    const prs = await fetchGitHub("/pulls?state=open&sort=created&direction=desc&per_page=8");
    cacheFor(cacheKey).prs = prs;
    if (isCurrentRepo(cacheKey)) renderOpenPRs(prs);
    return true;
  } catch (err) {
    if (isCurrentRepo(cacheKey)) list.innerHTML = errorState(err);
    return false;
  }
}

function renderOpenPRs(prs) {
  const list = document.getElementById("prs-list");
  if (prs.length === 0) {
    list.innerHTML = stateItem("No open pull requests.");
    return;
  }
  list.innerHTML = prs.map(pr => `
    <li class="list-card">
      <a href="${pr.html_url}" target="_blank" class="issue-link"><span class="issue-number">#${pr.number}</span> ${escapeHtml(pr.title)}</a>
      <div class="issue-meta">
        <span><img src="${avatarUrl(pr.user.avatar_url, 32)}" class="avatar-sm" alt="" loading="lazy">${escapeHtml(pr.user.login)}</span>
        ${pr.draft ? `<span class="chip">Draft</span>` : ""}
        <span class="issue-age">${daysAgo(pr.created_at)}</span>
      </div>
    </li>`).join("");
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function handleChat() {
  const input = document.getElementById("chat-input");
  const query = input.value.trim();
  if (!query) return;

  if (aiProvider !== "ollama" && !aiApiKey) {
    appendChatMessage("bot", "AI provider not configured. Open Settings to set it up.", false);
    return;
  }

  // Capture the repo and its message list: if the user navigates mid-reply,
  // loadChatHistory swaps chatMessages out and this reply must still be saved
  // to the repo it belongs to, without drawing into the new repo's chat.
  const repo = currentRepo;
  const messages = chatMessages;
  const isStale = () => currentRepo !== repo;

  document.getElementById("chat-starters")?.remove();
  const userTime = Date.now();
  messages.push({ role: "user", text: query, time: userTime });
  appendChatMessage("user", query, false, true, userTime);
  input.value = "";
  autosizeChatInput();

  const typingEl   = document.getElementById("typing-indicator");
  const chatHistEl = document.getElementById("chat-history");

  // Show typing indicator with entrance animation
  typingEl.classList.remove("typing-anim");
  void typingEl.offsetWidth; // force reflow so animation replays
  document.getElementById("typing-status").textContent = "Reading the repo…";
  typingEl.style.display = "flex";
  typingEl.classList.add("typing-anim");
  chatHistEl.classList.add("responding");
  document.getElementById("send-btn").disabled = true;

  // Pre-create wrapper + bubble; wrapper is appended on the first streaming token
  const botWrap = document.createElement("div");
  botWrap.className = "msg-wrap msg-wrap-bot";
  const botLabel = document.createElement("span");
  botLabel.className = "msg-sender";
  botLabel.innerHTML = BOT_LABEL_HTML;
  botWrap.appendChild(botLabel);
  const botBubble = document.createElement("div");
  botBubble.className = "chat-msg chat-msg-bot";
  botWrap.appendChild(botBubble);
  let streamStarted = false;
  let fullReply = "";

  try {
    const previousQuestion = messages.slice(0, -1).reverse().find(m => m.role === "user")?.text;
    const setStatus = (t) => { if (!isStale()) document.getElementById("typing-status").textContent = t; };
    // Files behind the previous answer stay in play for follow-up questions
    const previousFiles = [...new Set((messages.slice(0, -1).reverse().find(m => m.role === "bot" && m.sources)?.sources || []).map(s => s.path))];
    const { context, sources, ref } = await buildChatContext(repo, query, previousQuestion, setStatus, { previousFiles });
    const { system, contents } = buildChatPrompt({
      repo, context, question: query,
      history: messages.slice(0, -1),
      historyBudget: Math.floor((CONTEXT_BUDGET[aiProvider] || 20000) * 0.25),
    });

    // Stream tokens directly into the bot bubble
    fullReply = await callAIStreaming(contents, (partial) => {
      fullReply = partial;
      if (isStale()) return;
      if (!streamStarted) {
        streamStarted = true;
        typingEl.style.display = "none";
        // Animate in + show streaming glow on left border
        botBubble.classList.add("msg-entering", "streaming");
        chatHistEl.appendChild(botWrap);
      }
      botBubble.innerHTML = renderMarkdown(partial) + '<span class="streaming-cursor"></span>';
      if (isNearBottom(chatHistEl)) chatHistEl.scrollTop = chatHistEl.scrollHeight;
    }, { system });

    const botTime = Date.now();
    messages.push({ role: "bot", text: fullReply, time: botTime, sources, ref });
    saveChatHistory(repo, messages);
    if (isStale()) return;

    // Streaming done — remove glow, stamp time, render final content
    botBubble.classList.remove("streaming");
    botBubble.innerHTML = linkifyCitations(renderMarkdown(fullReply), repo, ref, sources);
    if (!streamStarted) chatHistEl.appendChild(botWrap); // empty reply: no chunk ever arrived
    appendBotFooter(botWrap, botTime, query, { sources, ref });
    if (isNearBottom(chatHistEl)) chatHistEl.scrollTop = chatHistEl.scrollHeight;
  } catch (err) {
    const ollamaErr = err.message === "OLLAMA_NOT_RUNNING" || err.message === "OLLAMA_CORS";
    if (ollamaErr) {
      // Errors happen before streaming starts — clean up and show guide
      messages.pop();
      if (!isStale()) {
        const userWraps = chatHistEl.querySelectorAll(".msg-wrap-user");
        userWraps[userWraps.length - 1]?.remove(); // remove user bubble
        showOllamaGuide(err.message, query);
      }
    } else if (fullReply) {
      // Mid-stream error: keep the partial answer so user/bot turns stay paired
      messages.push({ role: "bot", text: fullReply, time: Date.now() });
      saveChatHistory(repo, messages);
      if (!isStale()) botBubble.classList.remove("streaming");
    } else {
      // Error before first token — show error bubble
      const errText = err.rateLimited ? err.message : `Error: ${err.message}`;
      messages.push({ role: "bot", text: errText, error: true });
      saveChatHistory(repo, messages);
      if (!isStale()) appendChatMessage("bot", errText, false);
    }
  } finally {
    typingEl.style.display = "none";
    chatHistEl.classList.remove("responding");
    document.getElementById("send-btn").disabled = false;
  }
}

async function regenerateResponse(botWrap, query) {
  if (document.getElementById("send-btn").disabled) return; // a reply is already streaming

  const chatHistEl = document.getElementById("chat-history");
  const allMsgWraps = Array.from(chatHistEl.querySelectorAll(".msg-wrap"));
  const wrapIdx = allMsgWraps.indexOf(botWrap);
  if (wrapIdx === -1) return;

  // Also drop the user message that prompted this reply — handleChat re-adds
  // it, so keeping it would duplicate the question.
  const cutIdx = allMsgWraps[wrapIdx - 1]?.classList.contains("msg-wrap-user") ? wrapIdx - 1 : wrapIdx;
  allMsgWraps.slice(cutIdx).forEach(w => w.remove());

  // DOM wraps and chatMessages are 1:1, so trim at the same index
  chatMessages.splice(cutIdx);
  await saveChatHistory();

  // Re-send the original query
  const input = document.getElementById("chat-input");
  input.value = query;
  handleChat();
}

function isNearBottom(el, threshold = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function appendChatMessage(role, text, save = true, animate = true, time = null, query = null, meta = {}) {
  const history = document.getElementById("chat-history");

  const wrap = document.createElement("div");
  wrap.className = `msg-wrap msg-wrap-${role}`;

  // Sender label — bot only
  if (role === "bot") {
    const label = document.createElement("span");
    label.className = "msg-sender";
    label.innerHTML = BOT_LABEL_HTML;
    wrap.appendChild(label);
  }

  const msg = document.createElement("div");
  msg.className = `chat-msg chat-msg-${role}${animate ? " msg-entering" : ""}`;
  if (role === "bot") {
    msg.innerHTML = currentRepo && meta.sources?.length
      ? linkifyCitations(renderMarkdown(text), currentRepo, meta.ref, meta.sources)
      : renderMarkdown(text);
  } else {
    msg.textContent = text;
  }
  wrap.appendChild(msg);

  if (role === "bot") {
    appendBotFooter(wrap, time, query, meta);
  } else if (time) {
    const t = document.createElement("span");
    t.className = "msg-time";
    t.textContent = formatTime(time);
    wrap.appendChild(t);
  }

  history.appendChild(wrap);
  history.scrollTop = history.scrollHeight;
  if (save) saveChatHistory();
}

const BOT_LABEL_HTML = `${icon("sparkles", "icon-sm")}Assistant`;

// Files the answer was grounded in, linked to the exact lines on GitHub
function sourcesHtml(sources, ref) {
  if (!sources?.length || !currentRepo) return "";
  const byFile = new Map();
  for (const s of sources) {
    if (!byFile.has(s.path)) byFile.set(s.path, []);
    byFile.get(s.path).push(s);
  }
  const chips = [...byFile].map(([path, ranges]) => {
    const r = ranges[0];
    const lines = ranges.map(x => (x.start === 1 && ranges.length === 1 ? "" : `L${x.start}–${x.end}`)).filter(Boolean).join(", ");
    return `<a class="source-chip" href="${sourceUrl(currentRepo, ref, path, r.start, r.end)}" target="_blank" title="${escapeHtml(path)}${lines ? ` (${lines})` : ""}">` +
      `${icon("file", "icon-sm")}<span>${escapeHtml(path.split("/").pop())}</span>${lines ? `<em>${lines}</em>` : ""}</a>`;
  }).join("");
  return `<div class="msg-sources"><span class="msg-sources-label">Read ${byFile.size} file${byFile.size === 1 ? "" : "s"}</span>${chips}</div>`;
}

// Turn `path:line` citations that point at files we actually read into links
function linkifyCitations(html, repo, ref, sources) {
  const known = new Set((sources || []).map(s => s.path));
  if (!known.size) return html;
  const byName = new Map([...known].map(p => [p.split("/").pop(), p]));
  return html.replace(/<code>([^<\s]+?)(?::(\d+)(?:[-–](\d+))?)?<\/code>/g, (m, rawPath, start, end) => {
    const path = known.has(rawPath) ? rawPath : byName.get(rawPath);
    if (!path) return m;
    return `<a class="cite" href="${sourceUrl(repo, ref, path, start && +start, end && +end)}" target="_blank">${m}</a>`;
  });
}

// Timestamp + (hover-revealed) regenerate action under a bot reply
function appendBotFooter(wrap, time, query, meta = {}) {
  if (meta.sources?.length) wrap.insertAdjacentHTML("beforeend", sourcesHtml(meta.sources, meta.ref));
  if (!time && !query) return;
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  if (time) {
    const t = document.createElement("span");
    t.className = "msg-time";
    t.textContent = formatTime(time);
    actions.appendChild(t);
  }
  if (query) {
    const regenBtn = document.createElement("button");
    regenBtn.className = "regen-btn";
    regenBtn.innerHTML = `${icon("refresh", "icon-sm")}Regenerate`;
    regenBtn.addEventListener("click", () => regenerateResponse(wrap, query));
    actions.appendChild(regenBtn);
  }
  wrap.appendChild(actions);
}

async function clearChat() {
  chatMessages = [];
  document.getElementById("chat-history").innerHTML = "";
  const key = `chat_${currentRepo?.owner}_${currentRepo?.repo}`;
  await chrome.storage.local.remove([key]);
  renderChatStarters();
}

// ── Chat starter suggestions ──────────────────────────────────────────────────
// Shows clickable prompt chips when the chat history is empty.
// Clicking one fills the input and auto-sends, removing the starters.
function renderChatStarters() {
  if (chatMessages.length > 0) return;
  if (document.getElementById("chat-starters")) return; // already shown

  const el = document.createElement("div");
  el.id = "chat-starters";
  el.className = "chat-starters";
  const starters = [
    ["What does this repo do and who is it for?", "What does this repo do?"],
    ["How do I set up this project locally from scratch?", "How do I set it up locally?"],
    ["What are the easiest issues I could work on as a new contributor?", "Which issues suit a newcomer?"],
    ["Walk me through the project structure and the most important files", "Walk me through the structure"],
    ["Where is the main entry point, and what happens at startup?", "What happens at startup?"],
  ];
  el.innerHTML = `
    <svg class="icon chat-starters-icon" aria-hidden="true"><use href="#i-sparkles"/></svg>
    <p class="chat-starters-title">Ask about ${escapeHtml(currentRepo?.repo || "this repo")}</p>
    <p class="chat-starters-label">Answers come from its actual source files, with links to the lines they cite.</p>
    <div class="chat-starters-grid">
      ${starters.map(([q, label]) => `<button class="starter-chip" data-q="${escapeHtml(q)}">${label}${icon("arrow-right", "icon-sm")}</button>`).join("")}
    </div>
  `;

  document.getElementById("chat-history").appendChild(el);

  el.querySelectorAll(".starter-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      el.remove();
      document.getElementById("chat-input").value = btn.dataset.q;
      handleChat();
    });
  });
}

function showOllamaGuide(reason, retryQuery) {
  const isCors = reason === "OLLAMA_CORS";
  const history = document.getElementById("chat-history");

  const card = document.createElement("div");
  card.className = "ollama-guide msg-entering";
  card.innerHTML = `
    <div class="ollama-guide-header">${icon("alert")}${isCors ? "Ollama is blocking the extension" : "Ollama isn't running"}</div>
    <p class="ollama-guide-desc">${
      isCors
        ? "Ollama is running but blocking browser extension requests. Restart it with the <code>OLLAMA_ORIGINS</code> flag:"
        : "Start Ollama in your terminal, then press Send again:"
    }</p>

    <div class="cmd-block">
      <span class="cmd-os">macOS / Linux</span>
      <div class="cmd-row">
        <code class="cmd-code">OLLAMA_ORIGINS='*' ollama serve</code>
        <button class="copy-btn" data-cmd="OLLAMA_ORIGINS='*' ollama serve">${icon("copy", "icon-sm")}Copy</button>
      </div>
    </div>

    <div class="cmd-block">
      <span class="cmd-os">Windows (PowerShell)</span>
      <div class="cmd-row">
        <code class="cmd-code">$env:OLLAMA_ORIGINS='*'; ollama serve</code>
        <button class="copy-btn" data-cmd="$env:OLLAMA_ORIGINS='*'; ollama serve">${icon("copy", "icon-sm")}Copy</button>
      </div>
    </div>

    ${!isCors ? `<p class="ollama-guide-link">Not installed? Get it at <a href="https://ollama.com" target="_blank">ollama.com</a></p>` : ""}
    <p class="ollama-guide-ready">Your message is back in the box below — press Send once Ollama is up.</p>
  `;

  history.appendChild(card);
  history.scrollTop = history.scrollHeight;

  // Wire up copy buttons
  card.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.cmd).then(() => {
        btn.innerHTML = `${icon("check", "icon-sm")}Copied`;
        setTimeout(() => { btn.innerHTML = `${icon("copy", "icon-sm")}Copy`; }, 2000);
      });
    });
  });

  // Restore the user's message to the input so they can just press Send
  if (retryQuery) {
    const input = document.getElementById("chat-input");
    input.value = retryQuery;
    autosizeChatInput();
    input.focus();
  }
}

async function loadChatHistory() {
  if (!currentRepo) return;
  const key = `chat_${currentRepo.owner}_${currentRepo.repo}`;
  const result = await chrome.storage.local.get([key]);
  chatMessages = result[key] || [];
  const historyEl = document.getElementById("chat-history");
  historyEl.innerHTML = "";

  if (chatMessages.length > 0) {
    // Date separator — use first message's timestamp if available
    const sep = document.createElement("div");
    sep.className = "history-sep";
    const firstTime = chatMessages[0].time;
    const label = firstTime
      ? new Date(firstTime).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
      : "Previous conversation";
    sep.innerHTML = `<span>${label}</span>`;
    historyEl.appendChild(sep);
  }

  chatMessages.forEach((m, i) => {
    let query = null;
    if (m.role === "bot") {
      for (let j = i - 1; j >= 0; j--) {
        if (chatMessages[j].role === "user") { query = chatMessages[j].text; break; }
      }
    }
    appendChatMessage(m.role, m.text, false, false, m.time || null, query, { sources: m.sources, ref: m.ref });
  });
  renderChatStarters(); // shows only if chatMessages is empty
  historyEl.scrollTop = historyEl.scrollHeight;
}

async function saveChatHistory(repo = currentRepo, messages = chatMessages) {
  if (!repo) return;
  const key = `chat_${repo.owner}_${repo.repo}`;
  // Keep last 50 messages to avoid storage bloat
  const trimmed = messages.slice(-50);
  await chrome.storage.local.set({ [key]: trimmed });
}

// ── Settings tab ──────────────────────────────────────────────────────────────
function initSettingsTab() {
  const PROVIDER_LABELS = {
    groq: "Groq API Key", gemini: "Gemini API Key", ollama: null,
    openai: "OpenAI API Key", anthropic: "Anthropic API Key",
  };
  const PROVIDER_PLACEHOLDERS = {
    groq: "gsk_...", gemini: "AIzaSy...", ollama: "",
    openai: "sk-...", anthropic: "sk-ant-...",
  };
  const PROVIDER_HELP = {
    groq:      'Free key at <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>. Uses <strong>Llama 3.3 70B</strong> — 14,400 req/day.',
    gemini:    'Free key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>. Uses <strong>Gemini 2.5 Flash</strong> — generous free tier.',
    ollama:    'Download at <a href="https://ollama.com" target="_blank">ollama.com</a>. Models pull automatically on first use.',
    openai:    'Key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>. Uses <strong>GPT-4o mini</strong>.',
    anthropic: 'Key at <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Uses <strong>Claude Haiku 4.5</strong>.',
  };

  let settingsProvider = aiProvider;

  function updateSettingsUI(provider, clearKey = false) {
    document.querySelectorAll(".sp-pill").forEach(p =>
      p.classList.toggle("active", p.dataset.provider === provider)
    );
    const isOllama = provider === "ollama";
    document.getElementById("sp-key-section").style.display    = isOllama ? "none"  : "block";
    document.getElementById("sp-ollama-section").style.display = isOllama ? "block" : "none";
    if (!isOllama) {
      document.getElementById("sp-key-label").textContent = PROVIDER_LABELS[provider] || "API Key";
      const keyInput = document.getElementById("sp-api-key");
      if (clearKey) {
        keyInput.value = "";
        keyInput.placeholder = PROVIDER_PLACEHOLDERS[provider] || "";
      } else if (!keyInput.value) {
        keyInput.placeholder = PROVIDER_PLACEHOLDERS[provider] || "";
      }
    }
    document.getElementById("sp-help-links").innerHTML = PROVIDER_HELP[provider] || "";
  }

  // Expected key prefixes for each provider — used for instant format validation
  const KEY_PREFIXES = {
    groq:      "gsk_",
    gemini:    "AIza",
    openai:    "sk-",
    anthropic: "sk-ant-",
  };

  function refreshBadge() {
    const badge  = document.getElementById("sp-active-badge");
    const banner = document.getElementById("sp-quickstart-banner");
    const names  = {
      groq: "Groq — Llama 3.3 70B", gemini: "Gemini 2.5 Flash",
      ollama: `Ollama — ${ollamaModel || "llama3.2"}`,
      openai: "OpenAI — GPT-4o mini", anthropic: "Anthropic — Claude Haiku 4.5",
    };
    const configured = aiProvider === "ollama" || !!aiApiKey;
    badge.textContent = configured
      ? `Active: ${names[aiProvider] || aiProvider}`
      : "Not configured — choose a provider";
    badge.classList.toggle("is-ok", configured);
    badge.classList.toggle("is-warn", !configured);

    // Quick Start banner: show only when nothing is configured
    if (banner) banner.style.display = configured ? "none" : "flex";
  }

  // Initialise UI from current globals
  updateSettingsUI(settingsProvider);
  if (aiApiKey) document.getElementById("sp-api-key").placeholder = maskApiKey(aiApiKey);
  if (ollamaModel) document.getElementById("sp-ollama-model").value = ollamaModel;
  if (githubToken) document.getElementById("sp-gh-token").placeholder = maskApiKey(githubToken);
  refreshBadge();

  // Provider pill clicks
  document.querySelectorAll(".sp-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      settingsProvider = pill.dataset.provider;
      updateSettingsUI(settingsProvider, true);
    });
  });

  // Show/hide toggles
  [["sp-toggle-key", "sp-api-key"], ["sp-toggle-gh", "sp-gh-token"]].forEach(([btnId, inputId]) => {
    document.getElementById(btnId).addEventListener("click", () => {
      const input = document.getElementById(inputId);
      const btn   = document.getElementById(btnId);
      input.type      = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "Show" : "Hide";
    });
  });

  // Save AI settings
  document.getElementById("sp-save-btn").addEventListener("click", async () => {
    const toSave = { aiProvider: settingsProvider };
    if (settingsProvider === "ollama") {
      const model = document.getElementById("sp-ollama-model").value.trim() || "llama3.2";
      toSave.ollamaModel = model;
      toSave.aiApiKey    = "";
      ollamaModel = model;
      aiApiKey    = "";
    } else {
      const key = document.getElementById("sp-api-key").value.trim();
      if (!key) { showSpStatus("sp-status", "Enter an API key.", true); return; }

      // Validate key format before saving — catches the most common mistake
      // (wrong provider selected, partial copy, etc.)
      const expectedPrefix = KEY_PREFIXES[settingsProvider];
      if (expectedPrefix && !key.startsWith(expectedPrefix)) {
        showSpStatus("sp-status",
          `${settingsProvider} keys start with "${expectedPrefix}" — check you copied the full key`,
          true);
        return;
      }

      toSave.aiApiKey = key;
      aiApiKey = key;
      document.getElementById("sp-api-key").value       = "";
      document.getElementById("sp-api-key").placeholder = maskApiKey(key);
    }
    aiProvider = settingsProvider;
    await chrome.storage.local.set(toSave);
    refreshBadge();
    showSpStatus("sp-status", "✓ Saved! Head to any GitHub repo to start.");
  });

  // Save GitHub token
  document.getElementById("sp-save-gh-btn").addEventListener("click", async () => {
    const token = document.getElementById("sp-gh-token").value.trim();
    if (!token) { showSpStatus("sp-gh-status", "Enter a token.", true); return; }
    const saveBtn = document.getElementById("sp-save-gh-btn");
    saveBtn.disabled = true;
    try {
      // /rate_limit is free, so check the token before trusting it
      const { valid, core } = await checkRateLimit(token);
      if (!valid) { showSpStatus("sp-gh-status", "GitHub rejected this token — check you copied all of it, or generate a new one above.", true); return; }
      await chrome.storage.local.set({ githubToken: token });
      githubToken = token;
      document.getElementById("sp-gh-token").value       = "";
      document.getElementById("sp-gh-token").placeholder = maskApiKey(token);
      showSpStatus("sp-gh-status", `Token saved — ${(core?.limit ?? 5000).toLocaleString()} requests/hour.`);
      onGitHubTokenChanged();
    } catch {
      showSpStatus("sp-gh-status", "Couldn't reach GitHub to check the token. Try again.", true);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // Clear GitHub token
  document.getElementById("sp-clear-gh-btn").addEventListener("click", async () => {
    await chrome.storage.local.remove(["githubToken"]);
    githubToken = "";
    document.getElementById("sp-gh-token").value       = "";
    document.getElementById("sp-gh-token").placeholder = "ghp_...";
    showSpStatus("sp-gh-status", "Token cleared.");
    onGitHubTokenChanged();
  });

  // Settings saved from the standalone options page must reach an open panel
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.aiProvider)  aiProvider  = changes.aiProvider.newValue  || "groq";
    if (changes.aiApiKey)    aiApiKey    = changes.aiApiKey.newValue    || "";
    if (changes.ollamaModel) ollamaModel = changes.ollamaModel.newValue || "llama3.2";
    if (changes.githubToken && (changes.githubToken.newValue || "") !== githubToken) {
      githubToken = changes.githubToken.newValue || "";
      document.getElementById("sp-gh-token").placeholder = githubToken ? maskApiKey(githubToken) : "ghp_...";
      onGitHubTokenChanged();
    }
    if (changes.aiProvider || changes.aiApiKey || changes.ollamaModel) {
      settingsProvider = aiProvider;
      updateSettingsUI(aiProvider);
      document.getElementById("sp-api-key").placeholder =
        aiApiKey ? maskApiKey(aiApiKey) : PROVIDER_PLACEHOLDERS[aiProvider] || "";
      document.getElementById("sp-ollama-model").value = ollamaModel;
      refreshBadge();
    }
  });
}

// New quota, new cache namespace: re-read the limit and reload what's on screen
async function onGitHubTokenChanged() {
  ghState.badToken = false;
  ghState.remaining = null;
  ghState.resetAt = 0;
  await refreshRateLimit();
  reloadCurrentRepo();
}

function maskApiKey(key) {
  if (!key || key.length < 8) return "****";
  return key.substring(0, 6) + "****" + key.substring(key.length - 2);
}

// `ms` = 0 keeps the message until the next status replaces it
function showSpStatus(elementId, msg, isError = false, ms = 3000) {
  const el = document.getElementById(elementId);
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  clearTimeout(el._timer);
  if (ms) el._timer = setTimeout(() => { el.textContent = ""; }, ms);
}

// ── Ollama model pull ─────────────────────────────────────────────────────────
// Streams POST /api/pull and reports progress in the typing indicator.
async function pullOllamaModel(model) {
  const setStatus = (text) => {
    const el = document.getElementById("typing-status");
    if (el) el.textContent = text;
  };

  setStatus(`Downloading ${model}… (first time only)`);

  let pullResponse;
  try {
    pullResponse = await fetch("http://localhost:11434/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true })
    });
  } catch {
    throw new Error("Ollama is not running. Start it with: ollama serve");
  }
  if (!pullResponse.ok) throw new Error(`Ollama: could not pull model "${model}".`);

  const reader = pullResponse.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.status === "success") { setStatus("Generating response…"); return; }
        if (evt.total && evt.completed) {
          const pct = Math.round((evt.completed / evt.total) * 100);
          setStatus(`Downloading ${model}… ${pct}%`);
        } else if (evt.status) {
          setStatus(`${evt.status}…`);
        }
      } catch { /* malformed chunk */ }
    }
  }
}

// ── AI Streaming ──────────────────────────────────────────────────────────────
// callAIStreaming mirrors callAI but calls the streaming variant of each
// provider. `onChunk(cumulativeText)` is called after every received token so
// the caller can update the UI incrementally.

// `opts.system` carries the instructions (kept apart from repo data, where each
// provider supports it); `opts.temperature` defaults low for grounded answers.
async function callAIStreaming(contents, onChunk, opts = {}) {
  const o = { temperature: 0.2, ...opts };
  if (aiProvider === "groq")      return callGroqStreaming(contents, onChunk, o);
  if (aiProvider === "ollama")    return callOllamaStreaming(contents, onChunk, o);
  if (aiProvider === "openai")    return callOpenAIStreaming(contents, onChunk, o);
  if (aiProvider === "anthropic") return callAnthropicStreaming(contents, onChunk, o);
  return callGeminiStreaming(contents, onChunk, o);
}

// Request body for each provider: instructions go in its dedicated system slot
// and the context window is sized to what we're actually sending (Ollama's
// default is only 2–4k tokens and it silently cuts longer prompts).
function providerBody(provider, contents, { system, temperature = 0.2 } = {}) {
  const chat = geminiToOpenAI(contents);
  const withSystem = system ? [{ role: "system", content: system }, ...chat] : chat;
  switch (provider) {
    case "gemini":
      return { contents, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { temperature } };
    case "groq":
    case "openai":
      return { model: MODELS[provider], messages: withSystem, temperature, stream: true };
    case "anthropic":
      return { model: MODELS.anthropic, max_tokens: 2048, ...(system ? { system } : {}), temperature, messages: chat, stream: true };
    case "ollama": {
      const chars = (system || "").length + chat.reduce((n, m) => n + m.content.length, 0);
      const needed = Math.ceil(chars / 3.5) + 1536; // prompt tokens + room for the answer
      let numCtx = 8192;
      while (numCtx < needed && numCtx < 32768) numCtx *= 2;
      return { model: ollamaModel || "llama3.2", messages: withSystem, stream: true, options: { temperature, num_ctx: numCtx } };
    }
  }
  throw new Error(`Unknown provider ${provider}`);
}

// ── Streaming: Gemini (Server-Sent Events) ────────────────────────────────────
// Endpoint: streamGenerateContent?alt=sse
// Each SSE event carries the DELTA text for that chunk.
async function callGeminiStreaming(contents, onChunk, opts = {}) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": aiApiKey },
        body: JSON.stringify(providerBody("gemini", contents, opts))
      }
    );
  } catch {
    throw new Error("Could not reach Gemini. Check your internet connection.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 400) throw new Error("Gemini: Invalid API key. Go to Settings to update it.");
    if (response.status === 429) throw new Error("Gemini: Rate limit hit. Try again in a moment.");
    throw new Error(`Gemini ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  const reader   = response.body.getReader();
  const decoder  = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        const json  = JSON.parse(raw);
        const delta = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (delta) { full += delta; onChunk(full); }
      } catch { /* skip malformed */ }
    }
  }
  return full;
}

// ── Streaming: Groq / OpenAI (OpenAI-compatible SSE) ─────────────────────────
// Both providers use the same SSE wire format:
//   data: {"choices":[{"delta":{"content":"..."}}]}
//   data: [DONE]
async function callGroqStreaming(contents, onChunk, opts = {}) {
  let response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify(providerBody("groq", contents, opts))
    });
  } catch { throw new Error("Could not reach Groq. Check your internet connection."); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("Groq: Invalid API key.");
    if (response.status === 429) throw new Error("Groq: Rate limit hit. Try again in a moment.");
    throw new Error(`Groq ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  return readOpenAISSEStream(response, onChunk);
}

async function callOpenAIStreaming(contents, onChunk, opts = {}) {
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify(providerBody("openai", contents, opts))
    });
  } catch { throw new Error("Could not reach OpenAI. Check your internet connection."); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("OpenAI: Invalid API key.");
    if (response.status === 429) throw new Error("OpenAI: Rate limit hit. Try again in a moment.");
    throw new Error(`OpenAI ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  return readOpenAISSEStream(response, onChunk);
}

// Shared SSE reader for Groq + OpenAI format
async function readOpenAISSEStream(response, onChunk) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return full;
      try {
        const json  = JSON.parse(raw);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onChunk(full); }
      } catch { /* skip */ }
    }
  }
  return full;
}

// ── Streaming: Anthropic (SSE with typed events) ──────────────────────────────
// Relevant event: content_block_delta → delta.type === "text_delta" → delta.text
async function callAnthropicStreaming(contents, onChunk, opts = {}) {
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": aiApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify(providerBody("anthropic", contents, opts))
    });
  } catch { throw new Error("Could not reach Anthropic. Check your internet connection."); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("Anthropic: Invalid API key.");
    if (response.status === 429) throw new Error("Anthropic: Rate limit hit. Try again in a moment.");
    throw new Error(`Anthropic ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      try {
        const json = JSON.parse(raw);
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
          full += json.delta.text; onChunk(full);
        }
      } catch { /* skip */ }
    }
  }
  return full;
}

// ── Streaming: Ollama (NDJSON, stream:true) ────────────────────────────────────
// Wire format: newline-delimited JSON, each line: {"message":{"content":"..."},"done":false}
// Final line has "done":true. Auto-pulls missing models via pullOllamaModel.
async function callOllamaStreaming(contents, onChunk, opts = {}) {
  const body = providerBody("ollama", contents, opts);
  const model    = ollamaModel || "llama3.2";

  const ollamaFetch = () => fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  let response;
  try { response = await ollamaFetch(); }
  catch { throw new Error("OLLAMA_NOT_RUNNING"); }

  if (response.status === 403) throw new Error("OLLAMA_CORS");

  if (response.status === 404) {
    // Model not downloaded — stream the pull, then retry
    await pullOllamaModel(model);
    try { response = await ollamaFetch(); }
    catch { throw new Error("OLLAMA_NOT_RUNNING"); }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama ${response.status}: ${text || "Unexpected error"}`);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.done) return full;
        const delta = evt.message?.content;
        if (delta) { full += delta; onChunk(full); }
      } catch { /* skip malformed */ }
    }
  }
  return full;
}

// Convert Gemini contents format → OpenAI messages format
function geminiToOpenAI(contents) {
  return contents.map(c => ({
    role: c.role === "model" ? "assistant" : c.role,
    content: c.parts.map(p => p.text).join("")
  }));
}

// ── File decoding ─────────────────────────────────────────────────────────────
// The contents API returns base64 of the raw bytes; atob() alone yields Latin-1,
// which garbles any UTF-8 (emoji, CJK, accents), so decode the bytes properly.
function decodeGitHubContent(data) {
  const binary = atob((data.content || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(text) {
  // Escape HTML first, then apply markdown transformations
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Pull code blocks out first so nothing below rewrites their contents. An
  // unclosed fence (mid-stream) is treated as code too, so it doesn't flash as prose.
  const blocks = [];
  const stash = (code) => `\u0000${blocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`) - 1}\u0000`;
  html = html.replace(/```[\w+-]*\n([\s\S]*?)```/g, (_, code) => stash(code));
  html = html.replace(/```[\w+-]*\n([\s\S]*)$/, (_, code) => stash(code));

  // Headings
  html = html.replace(/^#### (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");
  // Lists — before emphasis, so a "* item" bullet isn't read as italics
  html = html.replace(/^\s*[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/^\s*\d+[.)] (.+)$/gm, "<oli>$1</oli>");
  html = html.replace(/(<oli>[\s\S]*?<\/oli>\n?)+/g, (m) => `<ol>${m.replace(/<(\/?)oli>/g, "<$1li>")}</ol>`);
  // Inline code, bold, italic
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // Links
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Paragraph breaks — but block elements already carry their own spacing
  html = html.replace(/\n{2,}/g, "<br><br>");
  html = html.replace(/(?:<br>\s*)+(?=<(?:h[2-5]|ul|ol)|\u0000)/g, "");
  html = html.replace(/(<\/(?:h[2-5]|ul|ol)>|\u0000\d+\u0000)\s*(?:<br>\s*)+/g, "$1");

  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function daysAgo(dateStr) {
  const days = Math.floor((Date.now() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
