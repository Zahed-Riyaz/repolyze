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
// Stores: { repoData, issues, languages, contributors, health, prs, quickstart, context }
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
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderIssues(btn.dataset.label);
    });
  });

  // Chat controls
  document.getElementById("send-btn").addEventListener("click", () => { handleChat(); });
  const chatInput = document.getElementById("chat-input");
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleChat(); }
  });
  chatInput.addEventListener("input", autosizeChatInput);
  document.getElementById("clear-chat-btn").addEventListener("click", clearChat);

  // Quickstart generator
  document.getElementById("gen-quickstart-btn").addEventListener("click", generateQuickstart);

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

  // Reset issue filter to "All"
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.filter-btn[data-label=""]').classList.add("active");

  // Fire all data fetches in parallel
  fetchRepoData();
  fetchIssues();
  fetchTechStack();
  fetchMaintainers();
  fetchContributeTab();
  loadChatHistory();
}

// ── GitHub API helper ─────────────────────────────────────────────────────────
// `repo` defaults to the current repo; callers that have already awaited
// something must pass the repo they captured, since currentRepo may have moved on.
async function fetchGitHub(endpoint, rawResponse = false, repo = currentRepo) {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com/repos/${repo.owner}/${repo.repo}${endpoint}`;

  const headers = { "Accept": "application/vnd.github+json" };
  // Send the token only to GitHub's own API host — endpoint may be a full URL
  // that came from response data, and the token must not follow it elsewhere.
  let apiHost = "";
  try { apiHost = new URL(url).host; } catch { throw new Error(`Invalid GitHub API URL: ${url}`); }
  if (githubToken && apiHost === "api.github.com") headers["Authorization"] = `Bearer ${githubToken}`;

  const response = await fetch(url, { headers });

  // Track rate limit from every response
  const remaining = response.headers.get("X-RateLimit-Remaining");
  const limit = response.headers.get("X-RateLimit-Limit");
  if (remaining !== null) updateRateLimitBadge(remaining, limit);

  if (rawResponse) return response;

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`GitHub API ${response.status}: ${err.message || response.statusText}`);
  }
  return response.json();
}

function updateRateLimitBadge(remaining, limit) {
  const badge = document.getElementById("rate-limit-badge");
  document.getElementById("rate-limit-text").textContent = `${remaining}/${limit}`;
  badge.classList.toggle("rate-limit-low", parseInt(remaining) < 100);
}

// ── Repo metadata ─────────────────────────────────────────────────────────────
// Returns a shared promise for the repo metadata so the header and the health
// score (which needs pushed_at / open_issues_count) wait on the same request.
function loadRepoData(repo = currentRepo) {
  const cache = cacheFor(repoKey(repo));
  if (cache.repoData) return Promise.resolve(cache.repoData);
  cache.repoDataPromise ??= fetchGitHub("", false, repo)
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

// ── Issues (fetch once, filter client-side) ───────────────────────────────────
async function fetchIssues() {
  const list = document.getElementById("issues-list");
  list.innerHTML = skeletonList(5);

  const cacheKey = repoKey();

  if (repoCache[cacheKey]?.issues) {
    renderIssues("");
    return;
  }

  try {
    const issues = await fetchGitHub("/issues?state=open&assignee=none&sort=comments&direction=desc&per_page=100");
    cacheFor(cacheKey).issues = issues.filter(i => !i.pull_request);
    if (isCurrentRepo(cacheKey)) renderIssues(activeIssueFilter());
  } catch (err) {
    if (isCurrentRepo(cacheKey)) list.innerHTML = stateItem(escapeHtml(err.message), { error: true });
  }
}

function activeIssueFilter() {
  return document.querySelector(".filter-btn.active")?.dataset.label || "";
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

function issueMatchesFilter(issue, filter) {
  const aliases = LABEL_ALIASES[filter] || [normalizeLabel(filter)];
  return issue.labels.some(l => {
    const n = normalizeLabel(l.name);
    return aliases.some(a => n === a || n.endsWith(" " + a) || n.startsWith(a + " "));
  });
}

function renderIssues(activeLabel) {
  const list = document.getElementById("issues-list");
  const allIssues = repoCache[repoKey()]?.issues || [];

  const filtered = activeLabel
    ? allIssues.filter(i => issueMatchesFilter(i, activeLabel))
    : allIssues;

  if (filtered.length === 0) {
    const msgs = {
      "good-first-issue": `No <strong>good first issue</strong> labels here — many maintainers don't use it consistently. Browse <strong>All</strong> and look for small, clearly described issues.`,
      "help-wanted":      `No <strong>help wanted</strong> issues right now. Any unassigned issue in <strong>All</strong> is fair game if you comment first.`,
      "":                 `No open, unassigned issues. The repo may be in a quiet period — the <strong>Contribute</strong> tab has other ways to help.`,
    };
    list.innerHTML = stateItem(msgs[activeLabel] ?? msgs[""]);
    return;
  }

  list.innerHTML = filtered.map(issue => {
    const labelsHtml = issue.labels
      .map(l => `<span class="label-chip" style="--lc:#${/^[0-9a-f]{6}$/i.test(l.color) ? l.color : "8b949e"}">${escapeHtml(l.name)}</span>`)
      .join("");
    const reactions = issue.reactions?.total_count || 0;
    return `
      <li class="list-card">
        <a href="${issue.html_url}" target="_blank" class="issue-link"><span class="issue-number">#${issue.number}</span> ${escapeHtml(issue.title)}</a>
        <div class="issue-meta">
          <span title="Comments">${icon("comment", "icon-sm")}${issue.comments}</span>
          ${reactions ? `<span title="Reactions">${icon("heart", "icon-sm")}${reactions}</span>` : ""}
          <span class="issue-age">${daysAgo(issue.created_at)}</span>
        </div>
        ${labelsHtml ? `<div class="issue-labels">${labelsHtml}</div>` : ""}
      </li>`;
  }).join("");
}

// ── Tech Stack ────────────────────────────────────────────────────────────────
async function fetchTechStack() {
  const list = document.getElementById("tech-list");
  list.classList.add("skeleton-mode");
  list.innerHTML = skeletonList(4, "bar");

  const cacheKey = repoKey();
  if (repoCache[cacheKey]?.languages && repoCache[cacheKey]?.tools !== undefined) {
    renderTechStack(repoCache[cacheKey].languages, repoCache[cacheKey].tools);
    return;
  }

  try {
    const [languages, tools] = await Promise.all([
      repoCache[cacheKey]?.languages
        ? Promise.resolve(repoCache[cacheKey].languages)
        : fetchGitHub("/languages").then(l => (cacheFor(cacheKey).languages = l)),
      detectTools(),
    ]);
    if (isCurrentRepo(cacheKey)) renderTechStack(languages, tools);
  } catch (err) {
    if (isCurrentRepo(cacheKey)) list.innerHTML = stateItem(escapeHtml(err.message), { error: true });
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

  // Fetch root dir + package.json + requirements.txt in parallel
  const [rootResult, pkgResult, reqResult] = await Promise.allSettled([
    fetchGitHub("/contents/"),
    fetchGitHub("/contents/package.json"),
    fetchGitHub("/contents/requirements.txt"),
  ]);

  // ── Root directory file-based detection ─────────────────────────────────────
  if (rootResult.status === "fulfilled" && Array.isArray(rootResult.value)) {
    const items  = rootResult.value;
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

    // .github/workflows → GitHub Actions (one extra call)
    if (byName[".github"]?.type === "dir") {
      try {
        const ghContents = await fetchGitHub("/contents/.github", false, repo);
        if (Array.isArray(ghContents) && ghContents.some(f => f.name === "workflows")) {
          add("GitHub Actions");
        }
      } catch {}
    }
  }

  // ── package.json dependency scanning ────────────────────────────────────────
  if (pkgResult.status === "fulfilled") {
    try {
      const pkg  = JSON.parse(decodeGitHubContent(pkgResult.value));
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
  if (reqResult.status === "fulfilled") {
    try {
      const req = decodeGitHubContent(reqResult.value).toLowerCase();

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
async function fetchMaintainers() {
  const list = document.getElementById("maintainers-list");
  list.innerHTML = skeletonList(6, "person");

  const cacheKey = repoKey();
  if (repoCache[cacheKey]?.contributors) {
    renderMaintainers(repoCache[cacheKey].contributors);
    return;
  }

  try {
    const contributors = await fetchGitHub("/contributors?per_page=10");
    cacheFor(cacheKey).contributors = contributors;
    if (isCurrentRepo(cacheKey)) renderMaintainers(contributors);
  } catch (err) {
    if (isCurrentRepo(cacheKey)) list.innerHTML = stateItem(escapeHtml(err.message), { error: true });
  }
}

function renderMaintainers(contributors) {
  const list = document.getElementById("maintainers-list");
  if (!contributors.length) {
    list.innerHTML = stateItem("No contributor data available for this repo.");
    return;
  }
  const top = contributors[0].contributions || 1;
  list.innerHTML = contributors.map((user, i) => `
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

  // Reset the quickstart area so one repo's guide never lingers on another's tab
  const qsBtn = document.getElementById("gen-quickstart-btn");
  const qsContent = document.getElementById("quickstart-content");
  if (repoCache[cacheKey]?.quickstart) {
    qsContent.innerHTML = renderMarkdown(repoCache[cacheKey].quickstart);
    qsBtn.style.display = "none";
  } else {
    qsContent.innerHTML = "";
    qsBtn.style.display = "";
    qsBtn.disabled = false;
    qsBtn.innerHTML = `${icon("sparkles")}Generate with AI`;
  }

  if (repoCache[cacheKey]?.health) {
    renderHealthCard(repoCache[cacheKey].health);
  } else {
    fetchRepoHealth();
  }
  if (repoCache[cacheKey]?.prs) {
    renderOpenPRs(repoCache[cacheKey].prs);
  } else {
    fetchOpenPRs();
  }
}

async function fetchRepoHealth() {
  document.getElementById("health-card").innerHTML =
    `<div class="health-score-row"><span class="sk sk-circle" style="width:64px;height:64px"></span><span class="sk-lines" style="flex:1;display:flex;flex-direction:column;gap:8px"><span class="sk sk-line short"></span><span class="sk sk-line"></span></span></div><div class="sk sk-block"></div>`;

  const repo = currentRepo;
  const cacheKey = repoKey(repo);
  const exists = (path) => fetchGitHub(path, true, repo).then(r => r.ok);
  const anyExists = async (paths) => (await Promise.all(paths.map(exists))).some(Boolean);

  try {
    const [profileResult, openPRsResult, closedPRsResult, repoDataResult] = await Promise.allSettled([
      // The community profile finds CONTRIBUTING / issue templates wherever GitHub
      // recognises them (root, .github/, docs/) in a single request.
      fetchGitHub("/community/profile", false, repo),
      fetchGitHub("/pulls?state=open&per_page=1", true, repo).then(async r => {
        const linkHeader = r.headers.get("Link") || "";
        const match = linkHeader.match(/page=(\d+)>; rel="last"/);
        if (match) return parseInt(match[1]);
        const data = await r.json().catch(() => []);
        return data.length;
      }),
      fetchGitHub("/pulls?state=closed&sort=updated&per_page=10", false, repo).then(prs => {
        const merged = prs.filter(p => p.merged_at);
        if (merged.length === 0) return null;
        const avgMs = merged.reduce((sum, p) => {
          return sum + (new Date(p.merged_at) - new Date(p.created_at));
        }, 0) / merged.length;
        return Math.round(avgMs / (1000 * 60 * 60 * 24));
      }),
      // Wait for the metadata instead of reading whatever happens to be cached,
      // otherwise the activity score silently drops to 0 when this wins the race.
      loadRepoData(repo),
    ]);

    const files = profileResult.status === "fulfilled" ? profileResult.value.files || {} : null;
    const [hasContributing, hasIssueTemplates] = await Promise.all([
      files?.contributing
        ? true
        : files ? false : anyExists(["/contents/CONTRIBUTING.md", "/contents/.github/CONTRIBUTING.md", "/contents/docs/CONTRIBUTING.md"]),
      // The profile misses directory-style templates (.github/ISSUE_TEMPLATE/), so check that too
      files?.issue_template ? true : anyExists(["/contents/.github/ISSUE_TEMPLATE", "/contents/.github/ISSUE_TEMPLATE.md"]),
    ]);

    const repoData = repoDataResult.status === "fulfilled" ? repoDataResult.value : null;
    const health = {
      hasContributing,
      hasIssueTemplates,
      openPRs: openPRsResult.status === "fulfilled" ? openPRsResult.value : "?",
      avgMergeDays: closedPRsResult.status === "fulfilled" ? closedPRsResult.value : null,
      lastPush: repoData?.pushed_at || null,
      openIssues: repoData?.open_issues_count || 0,
    };

    cacheFor(cacheKey).health = health;
    if (isCurrentRepo(cacheKey)) renderHealthCard(health);
  } catch (err) {
    if (isCurrentRepo(cacheKey)) {
      document.getElementById("health-card").innerHTML = stateItem(`Couldn't load repo health — ${escapeHtml(err.message)}`, { error: true, tag: "div" });
    }
  }
}

// ── Repo Health Score ──────────────────────────────────────────────────────────
// Calculates a 0-100 contributor-friendliness score from the health object.
// Weights: activity (30) + CONTRIBUTING (20) + issue templates (15) +
//          PR responsiveness (25) + description (5) + has issues (5)
function calculateHealthScore(h, repoData) {
  let score = 0;

  // Activity: how recently was the repo pushed to (30 pts)
  if (h.lastPush) {
    const days = Math.floor((Date.now() - new Date(h.lastPush)) / 86_400_000);
    if (days < 7)        score += 30;
    else if (days < 30)  score += 25;
    else if (days < 90)  score += 15;
    else if (days < 180) score +=  5;
  }

  // Has a CONTRIBUTING.md (20 pts)
  if (h.hasContributing) score += 20;

  // Has issue templates (15 pts)
  if (h.hasIssueTemplates) score += 15;

  // PR merge responsiveness (25 pts)
  if (h.avgMergeDays !== null) {
    if (h.avgMergeDays < 3)       score += 25;
    else if (h.avgMergeDays < 7)  score += 20;
    else if (h.avgMergeDays < 14) score += 12;
    else if (h.avgMergeDays < 30) score +=  5;
  }

  // Has a description (5 pts)
  if (repoData?.description) score += 5;

  // Has open issues to work on (5 pts)
  if (h.openIssues > 0) score += 5;

  score = Math.min(100, score);

  // `tone` maps to a .grade-* class so colours follow the light/dark theme
  let grade, tone;
  if (score >= 80)      { grade = "Excellent";       tone = "excellent"; }
  else if (score >= 60) { grade = "Good";            tone = "good"; }
  else if (score >= 40) { grade = "Fair";            tone = "fair"; }
  else                  { grade = "Needs attention"; tone = "poor"; }

  return { score, grade, tone };
}

function renderHealthCard(h) {
  const repoData = repoCache[repoKey()]?.repoData;
  const { score, grade, tone } = calculateHealthScore(h, repoData);
  const circumference = 2 * Math.PI * 26;

  const lastPushText = h.lastPush ? daysAgo(h.lastPush) : "unknown";
  const avgMergeText = h.avgMergeDays !== null ? `${h.avgMergeDays}d avg` : "n/a";
  const check = (ok, label) => `
    <div class="health-item ${ok ? "good" : "bad"}">${icon(ok ? "check" : "x")}<span><b>${label}</b>${ok ? "Present" : "Missing"}</span></div>`;
  const stat = (iconName, label, value) => `
    <div class="health-item">${icon(iconName)}<span><b>${value}</b>${label}</span></div>`;

  const card = document.getElementById("health-card");
  card.className = `card grade-${tone}`;
  card.innerHTML = `
    <div class="health-score-row">
      <div class="health-ring" role="img" aria-label="Score ${score} out of 100">
        <svg viewBox="0 0 60 60">
          <circle class="ring-track" cx="30" cy="30" r="26" fill="none" stroke-width="6"/>
          <circle class="ring-value" cx="30" cy="30" r="26" fill="none" stroke-width="6"
            stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
        </svg>
        <span class="health-score-num">${score}</span>
      </div>
      <div>
        <div class="health-score-grade">${grade}</div>
        <div class="health-score-sub">Contributor friendliness</div>
      </div>
    </div>
    <div class="health-grid">
      ${check(h.hasContributing, "CONTRIBUTING")}
      ${check(h.hasIssueTemplates, "Issue templates")}
      ${stat("clock", "Last push", lastPushText)}
      ${stat("merge", "Merge time", avgMergeText)}
      ${stat("pr", "Open PRs", h.openPRs)}
      ${stat("issue", "Open issues", formatNumber(h.openIssues))}
    </div>
  `;
  // Animate the ring from empty on the next frame
  requestAnimationFrame(() => {
    card.querySelector(".ring-value")?.setAttribute("stroke-dashoffset", String(circumference * (1 - score / 100)));
  });
}

async function fetchOpenPRs() {
  const list = document.getElementById("prs-list");
  list.innerHTML = skeletonList(3);

  const cacheKey = repoKey();

  try {
    const prs = await fetchGitHub("/pulls?state=open&per_page=8&sort=updated");
    cacheFor(cacheKey).prs = prs;
    if (isCurrentRepo(cacheKey)) renderOpenPRs(prs);
  } catch (err) {
    if (isCurrentRepo(cacheKey)) list.innerHTML = stateItem(escapeHtml(err.message), { error: true });
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

// ── Getting Started Quickstart ────────────────────────────────────────────────
async function generateQuickstart() {
  const repoRef = currentRepo;
  const cacheKey = repoKey(repoRef);
  const btn = document.getElementById("gen-quickstart-btn");
  const content = document.getElementById("quickstart-content");

  if (repoCache[cacheKey]?.quickstart) {
    content.innerHTML = renderMarkdown(repoCache[cacheKey].quickstart);
    btn.style.display = "none";
    return;
  }

  if (aiProvider !== "ollama" && !aiApiKey) {
    content.innerHTML = stateItem(`AI isn't set up yet. <a href="#" id="open-opts">Open settings</a>`, { error: true, tag: "div" });
    document.getElementById("open-opts")?.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelector('.tab-btn[data-tab="settings"]')?.click();
    });
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `${icon("sparkles")}Generating…`;
  content.innerHTML = "";

  try {
    const context = await getDeepRepoContext();
    const { owner, repo } = repoRef;
    const prompt = `You are a helpful open-source contributor guide writer.

Generate a concise, practical "Getting Started as a Contributor" guide for the repository "${owner}/${repo}".

Include these sections (use markdown headers and bullet points):
1. **Prerequisites** – what to install/know
2. **Fork & Clone** – the exact git commands
3. **Set Up Dev Environment** – based on the config files provided
4. **Run Tests** – based on scripts or test commands found in context
5. **Submit a PR** – branching, commit, PR steps

Keep it to the point. Use markdown code blocks for commands. Base it on this repository context:

${context}`;

    // Stream tokens directly into the content area for a premium feel
    const result = await callAIStreaming([{ role: "user", parts: [{ text: prompt }] }], (partial) => {
      if (isCurrentRepo(cacheKey)) content.innerHTML = renderMarkdown(partial) + '<span class="streaming-cursor"></span>';
    });

    cacheFor(cacheKey).quickstart = result;
    if (!isCurrentRepo(cacheKey)) return;
    content.innerHTML = renderMarkdown(result);
    btn.style.display = "none";
  } catch (err) {
    if (!isCurrentRepo(cacheKey)) return;
    let msg = err.message;
    if (msg === "OLLAMA_NOT_RUNNING") msg = "Ollama is not running. Start it with: OLLAMA_ORIGINS='*' ollama serve";
    if (msg === "OLLAMA_CORS")        msg = "Ollama is blocking the extension. Restart with: OLLAMA_ORIGINS='*' ollama serve";
    content.innerHTML = stateItem(escapeHtml(msg), { error: true, tag: "div" });
    btn.disabled = false;
    btn.innerHTML = `${icon("refresh")}Try again`;
  }
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
    const context = await getDeepRepoContext();
    const systemText = `You are an expert on the GitHub repository "${repo.owner}/${repo.repo}". Answer questions based on this context:\n\n${context}\n\nUser question: `;

    // Error bubbles are UI only — never feed them back to the model as its own words
    const history = messages.slice(0, -1).filter(m => !m.error).slice(-6).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));
    // Providers such as Anthropic reject a conversation that opens with the assistant
    while (history.length && history[0].role !== "user") history.shift();
    history.push({ role: "user", parts: [{ text: systemText + query }] });

    // Stream tokens directly into the bot bubble
    fullReply = await callAIStreaming(history, (partial) => {
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
    });

    const botTime = Date.now();
    messages.push({ role: "bot", text: fullReply, time: botTime });
    saveChatHistory(repo, messages);
    if (isStale()) return;

    // Streaming done — remove glow, stamp time, render final content
    botBubble.classList.remove("streaming");
    botBubble.innerHTML = renderMarkdown(fullReply);
    if (!streamStarted) chatHistEl.appendChild(botWrap); // empty reply: no chunk ever arrived
    appendBotFooter(botWrap, botTime, query);
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
      const errText = `Error: ${err.message}`;
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

function appendChatMessage(role, text, save = true, animate = true, time = null, query = null) {
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
    msg.innerHTML = renderMarkdown(text);
  } else {
    msg.textContent = text;
  }
  wrap.appendChild(msg);

  if (role === "bot") {
    appendBotFooter(wrap, time, query);
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

// Timestamp + (hover-revealed) regenerate action under a bot reply
function appendBotFooter(wrap, time, query) {
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
  ];
  el.innerHTML = `
    <svg class="icon chat-starters-icon" aria-hidden="true"><use href="#i-sparkles"/></svg>
    <p class="chat-starters-title">Ask about ${escapeHtml(currentRepo?.repo || "this repo")}</p>
    <p class="chat-starters-label">Answers are grounded in its README, configs and file tree.</p>
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
    appendChatMessage(m.role, m.text, false, false, m.time || null, query);
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
    await chrome.storage.local.set({ githubToken: token });
    githubToken = token;
    document.getElementById("sp-gh-token").value       = "";
    document.getElementById("sp-gh-token").placeholder = maskApiKey(token);
    showSpStatus("sp-gh-status", "Token saved!");
  });

  // Clear GitHub token
  document.getElementById("sp-clear-gh-btn").addEventListener("click", async () => {
    await chrome.storage.local.remove(["githubToken"]);
    githubToken = "";
    document.getElementById("sp-gh-token").value       = "";
    document.getElementById("sp-gh-token").placeholder = "ghp_...";
    showSpStatus("sp-gh-status", "Token cleared.");
  });

  // Settings saved from the standalone options page must reach an open panel
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.aiProvider)  aiProvider  = changes.aiProvider.newValue  || "groq";
    if (changes.aiApiKey)    aiApiKey    = changes.aiApiKey.newValue    || "";
    if (changes.ollamaModel) ollamaModel = changes.ollamaModel.newValue || "llama3.2";
    if (changes.githubToken) {
      githubToken = changes.githubToken.newValue || "";
      document.getElementById("sp-gh-token").placeholder = githubToken ? maskApiKey(githubToken) : "ghp_...";
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

function maskApiKey(key) {
  if (!key || key.length < 8) return "****";
  return key.substring(0, 6) + "****" + key.substring(key.length - 2);
}

function showSpStatus(elementId, msg, isError = false) {
  const el = document.getElementById(elementId);
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.textContent = ""; }, 3000);
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

async function callAIStreaming(contents, onChunk) {
  if (aiProvider === "groq")      return callGroqStreaming(contents, onChunk);
  if (aiProvider === "ollama")    return callOllamaStreaming(contents, onChunk);
  if (aiProvider === "openai")    return callOpenAIStreaming(contents, onChunk);
  if (aiProvider === "anthropic") return callAnthropicStreaming(contents, onChunk);
  return callGeminiStreaming(contents, onChunk);
}

// ── Streaming: Gemini (Server-Sent Events) ────────────────────────────────────
// Endpoint: streamGenerateContent?alt=sse
// Each SSE event carries the DELTA text for that chunk.
async function callGeminiStreaming(contents, onChunk) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": aiApiKey },
        body: JSON.stringify({ contents })
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
async function callGroqStreaming(contents, onChunk) {
  const messages = geminiToOpenAI(contents);
  let response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify({ model: MODELS.groq, messages, stream: true })
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

async function callOpenAIStreaming(contents, onChunk) {
  const messages = geminiToOpenAI(contents);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify({ model: MODELS.openai, messages, stream: true })
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
async function callAnthropicStreaming(contents, onChunk) {
  const messages = geminiToOpenAI(contents);
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
      body: JSON.stringify({ model: MODELS.anthropic, max_tokens: 2048, messages, stream: true })
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
async function callOllamaStreaming(contents, onChunk) {
  const messages = geminiToOpenAI(contents);
  const model    = ollamaModel || "llama3.2";

  const ollamaFetch = () => fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true })
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

// ── Repo context for chat ────────────────────────────────────────────────────
// Not retrieval in the embeddings sense: a fixed bundle of key files plus the
// repo's file tree, fetched once per repo and sent with every question.
function getDeepRepoContext(repo = currentRepo) {
  const cache = cacheFor(repoKey(repo));
  if (cache.context) return Promise.resolve(cache.context);
  // Share one in-flight build between chat and the quickstart generator
  cache.contextPromise ??= buildRepoContext(repo)
    .then(context => (cache.context = context))
    .finally(() => { delete cache.contextPromise; });
  return cache.contextPromise;
}

async function buildRepoContext(repo) {
  const fileTargets = [
    { endpoint: "/readme",                    label: "README",           limit: 3000 },
    { endpoint: "/contents/CONTRIBUTING.md",  label: "CONTRIBUTING.md",  limit: 1500 },
    { endpoint: "/contents/package.json",     label: "package.json",     limit: 1500 },
    { endpoint: "/contents/requirements.txt", label: "requirements.txt", limit: 1500 },
    { endpoint: "/contents/pyproject.toml",   label: "pyproject.toml",   limit: 1500 },
    { endpoint: "/contents/Cargo.toml",       label: "Cargo.toml",       limit: 1500 },
    { endpoint: "/contents/Makefile",         label: "Makefile",         limit: 1500 },
  ];

  const [tree, ...results] = await Promise.allSettled([
    fetchGitHub("/git/trees/HEAD?recursive=1", false, repo).then(formatFileTree),
    ...fileTargets.map(f =>
      fetchGitHub(f.endpoint, false, repo).then(d => `=== ${f.label} ===\n${decodeGitHubContent(d).substring(0, f.limit)}`)
    ),
  ]);

  const parts = results.filter(r => r.status === "fulfilled").map(r => r.value);
  if (tree.status === "fulfilled" && tree.value) parts.push(`=== File Tree ===\n${tree.value}`);
  return parts.join("\n\n");
}

// Turns a recursive git tree into a compact path listing the model can use to
// answer "where is X / walk me through the structure" questions.
function formatFileTree(treeData, maxDepth = 4, maxChars = 5000) {
  const NOISE = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|__pycache__|\.git|\.next|\.venv|venv)(\/|$)/;
  const lines = [];
  let chars = 0;
  for (const item of treeData.tree || []) {
    if (NOISE.test(item.path) || item.path.split("/").length > maxDepth) continue;
    const line = item.type === "tree" ? `${item.path}/` : item.path;
    if (chars + line.length > maxChars) { lines.push("… (truncated)"); break; }
    lines.push(line);
    chars += line.length + 1;
  }
  if (treeData.truncated && lines[lines.length - 1] !== "… (truncated)") lines.push("… (truncated)");
  return lines.join("\n");
}

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
