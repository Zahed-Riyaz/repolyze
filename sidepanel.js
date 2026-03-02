// ── State ────────────────────────────────────────────────────────────────────
let currentRepo = null;
let githubToken = "";
let aiProvider = "groq";   // "groq" | "gemini" | "ollama" | "openai" | "anthropic"
let aiApiKey = "";          // API key for cloud providers
let ollamaModel = "llama3.2";
let chatMessages = []; // [{role:"user"|"bot", text:"..."}]

// Session cache keyed by "owner/repo"
// Stores: { repoData, issues, languages, contributors, health, prs, quickstart, context }
const repoCache = {};

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Tab switching
  document.querySelectorAll(".tab-btn").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`${tab.dataset.tab}-tab`).classList.add("active");
    });
  });

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
  document.getElementById("chat-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(); }
  });
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

  // Listen for tab URL changes
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && changeInfo.url.includes("github.com")) {
      handleRepoRefresh(changeInfo.url);
    }
  });

  // Load current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (activeTab && activeTab.url) handleRepoRefresh(activeTab.url);
  });
});

// ── Repo detection ────────────────────────────────────────────────────────────
function handleRepoRefresh(url) {
  let urlObj;
  try { urlObj = new URL(url); } catch { return; }

  if (!urlObj.hostname.includes("github.com")) return;

  const pathParts = urlObj.pathname.split("/").filter(p => p);

  // Ignore special GitHub paths that aren't repos
  const nonRepoPaths = ["explore", "trending", "marketplace", "login", "settings", "notifications", "pulls", "issues"];
  if (pathParts.length < 2 || nonRepoPaths.includes(pathParts[0])) {
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
  document.getElementById("not-repo-msg").style.display = "block";
  document.getElementById("main-content").style.display = "none";
}

function hideNotRepoMessage() {
  document.getElementById("not-repo-msg").style.display = "none";
  document.getElementById("main-content").style.display = "block";
}

// ── Core update ───────────────────────────────────────────────────────────────
async function updateRepoInfo() {
  if (!currentRepo) return;
  const { owner, repo } = currentRepo;
  document.getElementById("repo-name").textContent = `${owner}/${repo}`;
  document.getElementById("repo-description").textContent = "";
  document.getElementById("repo-stars").textContent = "⭐ —";
  document.getElementById("repo-forks").textContent = "⑂ —";
  document.getElementById("repo-license").textContent = "";

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
async function fetchGitHub(endpoint, rawResponse = false) {
  const headers = { "Accept": "application/vnd.github+json" };
  if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;

  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com/repos/${currentRepo.owner}/${currentRepo.repo}${endpoint}`;

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
  badge.textContent = `API: ${remaining}/${limit}`;
  badge.classList.toggle("rate-limit-low", parseInt(remaining) < 100);
}

// ── Repo metadata ─────────────────────────────────────────────────────────────
async function fetchRepoData() {
  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  if (repoCache[cacheKey]?.repoData) {
    applyRepoData(repoCache[cacheKey].repoData);
    return;
  }
  try {
    const data = await fetchGitHub("");
    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].repoData = data;
    applyRepoData(data);
  } catch (err) {
    console.warn("fetchRepoData:", err.message);
  }
}

function applyRepoData(data) {
  document.getElementById("repo-description").textContent = data.description || "";
  document.getElementById("repo-stars").textContent = `⭐ ${formatNumber(data.stargazers_count)}`;
  document.getElementById("repo-forks").textContent = `⑂ ${formatNumber(data.forks_count)}`;
  const license = data.license?.spdx_id;
  if (license && license !== "NOASSERTION") {
    document.getElementById("repo-license").textContent = license;
  }
  // Fork detection — show upstream repo link if this is a fork
  const forkBadge = document.getElementById("repo-fork-badge");
  if (data.fork && data.parent) {
    forkBadge.innerHTML = `⑂ fork of <a href="${data.parent.html_url}" target="_blank">${escapeHtml(data.parent.full_name)}</a>`;
    forkBadge.style.display = "inline";
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
  list.innerHTML = "<li class='loading-item'>Loading issues…</li>";

  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;

  if (repoCache[cacheKey]?.issues) {
    renderIssues("");
    return;
  }

  try {
    const issues = await fetchGitHub("/issues?state=open&assignee=none&sort=comments&direction=desc&per_page=100");
    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].issues = issues.filter(i => !i.pull_request);
    renderIssues("");
  } catch (err) {
    list.innerHTML = `<li class="error-item">Error: ${err.message}</li>`;
  }
}

function renderIssues(activeLabel) {
  const list = document.getElementById("issues-list");
  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  const allIssues = repoCache[cacheKey]?.issues || [];

  const filtered = activeLabel
    ? allIssues.filter(i => i.labels.some(l => l.name === activeLabel))
    : allIssues;

  if (filtered.length === 0) {
    const msgs = {
      "good-first-issue": `No "good first issue" labels found — but don't stop here. Many maintainers don't use this label consistently. Browse <strong>All</strong> issues and look for small scope, clear description, or "bug" labels.`,
      "help-wanted":      `No "help wanted" issues right now. Try <strong>All</strong> issues — any unassigned issue is fair game if you comment first.`,
      "":                 `No open unassigned issues. The repo may be in a quiet period — check the <strong>Contribute</strong> tab for other ways to help.`,
    };
    list.innerHTML = `<li class="empty-item">${msgs[activeLabel] ?? msgs[""]}</li>`;
    return;
  }

  list.innerHTML = "";
  filtered.forEach(issue => {
    const li = document.createElement("li");
    const labelsHtml = issue.labels
      .map(l => `<span class="label-chip" style="background:#${l.color}20;color:#${l.color};border:1px solid #${l.color}40">${escapeHtml(l.name)}</span>`)
      .join("");

    li.innerHTML = `
      <a href="${issue.html_url}" target="_blank" class="issue-link">#${issue.number} ${escapeHtml(issue.title)}</a>
      <div class="issue-meta">
        <span>💬 ${issue.comments}</span>
        <span>👍 ${issue.reactions?.total_count || 0}</span>
        <span class="issue-age">${daysAgo(issue.created_at)}</span>
      </div>
      ${labelsHtml ? `<div class="issue-labels">${labelsHtml}</div>` : ""}
    `;
    list.appendChild(li);
  });
}

// ── Tech Stack ────────────────────────────────────────────────────────────────
async function fetchTechStack() {
  const list = document.getElementById("tech-list");
  list.innerHTML = "<li class='loading-item'>Loading stack…</li>";

  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  if (repoCache[cacheKey]?.languages) {
    renderTechStack(repoCache[cacheKey].languages);
    return;
  }

  try {
    const languages = await fetchGitHub("/languages");
    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].languages = languages;
    renderTechStack(languages);
  } catch (err) {
    list.innerHTML = `<li class="error-item">Error: ${err.message}</li>`;
  }
}

function renderTechStack(languages) {
  const list = document.getElementById("tech-list");
  list.innerHTML = "";
  const total = Object.values(languages).reduce((a, b) => a + b, 0);
  Object.entries(languages).sort((a, b) => b[1] - a[1]).forEach(([lang, size]) => {
    const pct = ((size / total) * 100).toFixed(1);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="tech-row">
        <span class="tech-name">${escapeHtml(lang)}</span>
        <span class="tech-pct">${pct}%</span>
      </div>
      <div class="tech-bar-bg"><div class="tech-bar-fill" style="width:${pct}%"></div></div>
    `;
    list.appendChild(li);
  });
}

// ── Maintainers ───────────────────────────────────────────────────────────────
async function fetchMaintainers() {
  const list = document.getElementById("maintainers-list");
  list.innerHTML = "<li class='loading-item'>Loading contributors…</li>";

  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  if (repoCache[cacheKey]?.contributors) {
    renderMaintainers(repoCache[cacheKey].contributors);
    return;
  }

  try {
    const contributors = await fetchGitHub("/contributors?per_page=10");
    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].contributors = contributors;
    renderMaintainers(contributors);
  } catch (err) {
    list.innerHTML = `<li class="error-item">Error: ${err.message}</li>`;
  }
}

function renderMaintainers(contributors) {
  const list = document.getElementById("maintainers-list");
  list.innerHTML = "";
  contributors.forEach(user => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="contributor-row">
        <img src="${user.avatar_url}" class="contributor-avatar" alt="${escapeHtml(user.login)}">
        <div class="contributor-info">
          <a href="${user.html_url}" target="_blank" class="contributor-name">${escapeHtml(user.login)}</a>
          <span class="contributor-commits">${formatNumber(user.contributions)} commits</span>
        </div>
      </div>
    `;
    list.appendChild(li);
  });
}

// ── Contribute Tab ────────────────────────────────────────────────────────────
async function fetchContributeTab() {
  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
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
  document.getElementById("health-card").innerHTML = "<p class='loading-item'>Loading repo health…</p>";

  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;

  try {
    const [contribResult, templateResult, openPRsResult, closedPRsResult] = await Promise.allSettled([
      fetchGitHub("/contents/CONTRIBUTING.md", true).then(r => r.status === 200),
      fetchGitHub("/contents/.github/ISSUE_TEMPLATE", true).then(r => r.status === 200)
        .catch(() => fetchGitHub("/contents/.github/ISSUE_TEMPLATE.md", true).then(r => r.status === 200)),
      fetchGitHub("/pulls?state=open&per_page=1", true).then(async r => {
        const linkHeader = r.headers.get("Link") || "";
        const match = linkHeader.match(/page=(\d+)>; rel="last"/);
        if (match) return parseInt(match[1]);
        const data = await r.json().catch(() => []);
        return data.length;
      }),
      fetchGitHub("/pulls?state=closed&sort=updated&per_page=10").then(prs => {
        const merged = prs.filter(p => p.merged_at);
        if (merged.length === 0) return null;
        const avgMs = merged.reduce((sum, p) => {
          return sum + (new Date(p.merged_at) - new Date(p.created_at));
        }, 0) / merged.length;
        return Math.round(avgMs / (1000 * 60 * 60 * 24));
      })
    ]);

    const repoData = repoCache[cacheKey]?.repoData;
    const health = {
      hasContributing: contribResult.status === "fulfilled" ? contribResult.value : false,
      hasIssueTemplates: templateResult.status === "fulfilled" ? templateResult.value : false,
      openPRs: openPRsResult.status === "fulfilled" ? openPRsResult.value : "?",
      avgMergeDays: closedPRsResult.status === "fulfilled" ? closedPRsResult.value : null,
      lastPush: repoData?.pushed_at || null,
      openIssues: repoData?.open_issues_count || 0,
    };

    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].health = health;
    renderHealthCard(health);
  } catch (err) {
    document.getElementById("health-card").innerHTML = `<p class="error-item">Error loading health: ${err.message}</p>`;
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

  let grade, color, emoji;
  if (score >= 80)      { grade = "Excellent";       color = "#3fb950"; emoji = "🟢"; }
  else if (score >= 60) { grade = "Good";             color = "#58a6ff"; emoji = "🔵"; }
  else if (score >= 40) { grade = "Fair";             color = "#e3b341"; emoji = "🟡"; }
  else                  { grade = "Needs attention";  color = "#f85149"; emoji = "🔴"; }

  return { score, grade, color, emoji };
}

function renderHealthCard(h) {
  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  const repoData = repoCache[cacheKey]?.repoData;
  const { score, grade, color, emoji } = calculateHealthScore(h, repoData);

  const lastPushText = h.lastPush ? daysAgo(h.lastPush) : "unknown";
  const avgMergeText = h.avgMergeDays !== null ? `${h.avgMergeDays}d avg` : "N/A";

  document.getElementById("health-card").innerHTML = `
    <div class="health-score-row">
      <div class="health-score-circle" style="border-color:${color}">
        <span class="health-score-num" style="color:${color}">${score}</span>
        <span class="health-score-denom">/100</span>
      </div>
      <div class="health-score-info">
        <div class="health-score-grade" style="color:${color}">${emoji} ${grade}</div>
        <div class="health-score-sub">Contributor Friendliness</div>
      </div>
    </div>
    <div class="health-section-title">Details</div>
    <div class="health-grid">
      <div class="health-item ${h.hasContributing ? "good" : "bad"}">
        ${h.hasContributing ? "✓" : "✗"} CONTRIBUTING.md
      </div>
      <div class="health-item ${h.hasIssueTemplates ? "good" : "bad"}">
        ${h.hasIssueTemplates ? "✓" : "✗"} Issue Templates
      </div>
      <div class="health-item neutral">🕐 Last Push: ${lastPushText}</div>
      <div class="health-item neutral">🔀 Open PRs: ${h.openPRs}</div>
      <div class="health-item neutral">⏱ Merge Time: ${avgMergeText}</div>
      <div class="health-item neutral">🐛 Open Issues: ${formatNumber(h.openIssues)}</div>
    </div>
  `;
}

async function fetchOpenPRs() {
  const list = document.getElementById("prs-list");
  list.innerHTML = "<li class='loading-item'>Loading PRs…</li>";

  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;

  try {
    const prs = await fetchGitHub("/pulls?state=open&per_page=8&sort=updated");
    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].prs = prs;
    renderOpenPRs(prs);
  } catch (err) {
    list.innerHTML = `<li class="error-item">Error: ${err.message}</li>`;
  }
}

function renderOpenPRs(prs) {
  const list = document.getElementById("prs-list");
  if (prs.length === 0) {
    list.innerHTML = "<li class='empty-item'>No open PRs.</li>";
    return;
  }
  list.innerHTML = "";
  prs.forEach(pr => {
    const li = document.createElement("li");
    li.innerHTML = `
      <a href="${pr.html_url}" target="_blank" class="issue-link">#${pr.number} ${escapeHtml(pr.title)}</a>
      <div class="issue-meta">
        <img src="${pr.user.avatar_url}" class="contributor-avatar-sm" alt="${escapeHtml(pr.user.login)}">
        <span>${escapeHtml(pr.user.login)}</span>
        <span class="issue-age">opened ${daysAgo(pr.created_at)}</span>
      </div>
    `;
    list.appendChild(li);
  });
}

// ── Getting Started Quickstart ────────────────────────────────────────────────
async function generateQuickstart() {
  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  const btn = document.getElementById("gen-quickstart-btn");
  const content = document.getElementById("quickstart-content");

  if (repoCache[cacheKey]?.quickstart) {
    content.innerHTML = renderMarkdown(repoCache[cacheKey].quickstart);
    btn.style.display = "none";
    return;
  }

  if (aiProvider !== "ollama" && !aiApiKey) {
    content.innerHTML = `<p class="error-item">AI not configured. <a href="#" id="open-opts">Open Settings</a></p>`;
    document.getElementById("open-opts")?.addEventListener("click", (e) => {
      e.preventDefault();
      document.querySelector('.tab-btn[data-tab="settings"]')?.click();
    });
    return;
  }

  btn.disabled = true;
  btn.textContent = "Generating…";
  content.innerHTML = "";

  try {
    const context = await getDeepRepoContext();
    const { owner, repo } = currentRepo;
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
      content.innerHTML = renderMarkdown(partial) + '<span class="streaming-cursor"></span>';
    });

    content.innerHTML = renderMarkdown(result);
    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].quickstart = result;
    btn.style.display = "none";
  } catch (err) {
    let msg = err.message;
    if (msg === "OLLAMA_NOT_RUNNING") msg = "Ollama is not running. Start it with: OLLAMA_ORIGINS='*' ollama serve";
    if (msg === "OLLAMA_CORS")        msg = "Ollama is blocking the extension. Restart with: OLLAMA_ORIGINS='*' ollama serve";
    content.innerHTML = `<p class="error-item">Error: ${escapeHtml(msg)}</p>`;
    btn.disabled = false;
    btn.textContent = "Retry ✨";
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

  document.getElementById("chat-starters")?.remove();
  chatMessages.push({ role: "user", text: query });
  appendChatMessage("user", query, false);
  input.value = "";

  const typingEl  = document.getElementById("typing-indicator");
  const chatHistEl = document.getElementById("chat-history");
  typingEl.style.display = "flex";
  document.getElementById("send-btn").disabled = true;

  // Pre-create bot bubble; it will be appended on the first streaming token
  const botBubble = document.createElement("div");
  botBubble.className = "chat-msg chat-msg-bot";
  let streamStarted = false;
  let fullReply = "";

  try {
    const context = await getDeepRepoContext();
    const systemText = `You are an expert on the GitHub repository "${currentRepo.owner}/${currentRepo.repo}". Answer questions based on this context:\n\n${context}\n\nUser question: `;

    const history = chatMessages.slice(-7, -1).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));
    history.push({ role: "user", parts: [{ text: systemText + query }] });

    // Stream tokens directly into the bot bubble
    fullReply = await callAIStreaming(history, (partial) => {
      if (!streamStarted) {
        streamStarted = true;
        typingEl.style.display = "none";
        chatHistEl.appendChild(botBubble);
      }
      botBubble.innerHTML = renderMarkdown(partial) + '<span class="streaming-cursor"></span>';
      chatHistEl.scrollTop = chatHistEl.scrollHeight;
    });

    // Final render without the blinking cursor
    botBubble.innerHTML = renderMarkdown(fullReply);
    chatHistEl.scrollTop = chatHistEl.scrollHeight;
    chatMessages.push({ role: "bot", text: fullReply });
    saveChatHistory();
  } catch (err) {
    const ollamaErr = err.message === "OLLAMA_NOT_RUNNING" || err.message === "OLLAMA_CORS";
    if (ollamaErr) {
      // Errors happen before streaming starts — clean up and show guide
      chatMessages.pop();
      chatHistEl.lastElementChild?.remove(); // remove user bubble
      showOllamaGuide(err.message, query);
    } else if (!streamStarted) {
      // Error before first token — show error bubble
      const errText = `Error: ${err.message}`;
      chatMessages.push({ role: "bot", text: errText });
      appendChatMessage("bot", errText, false);
    }
    // Mid-stream error: partial content already visible, leave it as-is
  } finally {
    typingEl.style.display = "none";
    document.getElementById("send-btn").disabled = false;
  }
}

function appendChatMessage(role, text, save = true) {
  const history = document.getElementById("chat-history");
  const msg = document.createElement("div");
  msg.className = `chat-msg chat-msg-${role}`;
  if (role === "bot") {
    msg.innerHTML = renderMarkdown(text);
  } else {
    msg.textContent = text;
  }
  history.appendChild(msg);
  history.scrollTop = history.scrollHeight;
  if (save) saveChatHistory();
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
  el.innerHTML = `
    <p class="chat-starters-label">Try asking:</p>
    <div class="chat-starters-grid">
      <button class="starter-chip" data-q="What does this repo do and who is it for?">💡 What does this repo do?</button>
      <button class="starter-chip" data-q="How do I set up this project locally from scratch?">🛠️ How do I set up this project?</button>
      <button class="starter-chip" data-q="What are the easiest issues I could work on as a new contributor?">🐛 Good first issues for me?</button>
      <button class="starter-chip" data-q="Walk me through the project structure and the most important files">🗂️ Walk me through the structure</button>
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
  card.className = "chat-msg chat-msg-bot ollama-guide";
  card.innerHTML = `
    <div class="ollama-guide-header">🦙 ${isCors ? "Ollama is blocked (CORS)" : "Ollama is not running"}</div>
    <p class="ollama-guide-desc">${
      isCors
        ? "Ollama is running but blocking browser extension requests. Restart it with the <code>OLLAMA_ORIGINS</code> flag:"
        : "Start Ollama in your terminal, then press Send again."
    }</p>

    <div class="cmd-block">
      <span class="cmd-os">macOS / Linux</span>
      <div class="cmd-row">
        <code class="cmd-code">OLLAMA_ORIGINS='*' ollama serve</code>
        <button class="copy-btn" data-cmd="OLLAMA_ORIGINS='*' ollama serve">Copy</button>
      </div>
    </div>

    <div class="cmd-block">
      <span class="cmd-os">Windows (PowerShell)</span>
      <div class="cmd-row">
        <code class="cmd-code">$env:OLLAMA_ORIGINS='*'; ollama serve</code>
        <button class="copy-btn" data-cmd="$env:OLLAMA_ORIGINS='*'; ollama serve">Copy</button>
      </div>
    </div>

    ${!isCors ? `<p class="ollama-guide-link">Not installed? → <a href="https://ollama.com" target="_blank">ollama.com</a></p>` : ""}
    <p class="ollama-guide-ready">✓ Your message has been restored below — just press Send once Ollama is running.</p>
  `;

  history.appendChild(card);
  history.scrollTop = history.scrollHeight;

  // Wire up copy buttons
  card.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.cmd).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
      });
    });
  });

  // Restore the user's message to the input so they can just press Send
  if (retryQuery) {
    const input = document.getElementById("chat-input");
    input.value = retryQuery;
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
  chatMessages.forEach(m => appendChatMessage(m.role, m.text, false));
  renderChatStarters(); // shows only if chatMessages is empty
}

async function saveChatHistory() {
  if (!currentRepo) return;
  const key = `chat_${currentRepo.owner}_${currentRepo.repo}`;
  // Keep last 50 messages to avoid storage bloat
  const trimmed = chatMessages.slice(-50);
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
    gemini:    'Free key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>. <strong>Gemini 2.0 Flash</strong> — 1,500 req/day.',
    ollama:    'Download at <a href="https://ollama.com" target="_blank">ollama.com</a>. Models pull automatically on first use.',
    openai:    'Key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>. Uses <strong>GPT-4o mini</strong>.',
    anthropic: 'Key at <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Uses <strong>Claude 3.5 Haiku</strong>.',
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
      groq: "Groq — Llama 3.3 70B", gemini: "Gemini 2.0 Flash",
      ollama: `Ollama — ${ollamaModel || "llama3.2"}`,
      openai: "OpenAI — GPT-4o mini", anthropic: "Anthropic — Claude 3.5 Haiku",
    };
    const configured = aiProvider === "ollama" || !!aiApiKey;
    badge.textContent = configured
      ? `Active: ${names[aiProvider] || aiProvider}`
      : "Not configured — choose a provider below";
    badge.style.color = configured ? "#3fb950" : "#f0883e";

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
}

function maskApiKey(key) {
  if (!key || key.length < 8) return "****";
  return key.substring(0, 6) + "****" + key.substring(key.length - 2);
}

function showSpStatus(elementId, msg, isError = false) {
  const el = document.getElementById(elementId);
  el.textContent  = msg;
  el.style.color  = isError ? "#f85149" : "#3fb950";
  setTimeout(() => { el.textContent = ""; }, 3000);
}

// ── AI routing ────────────────────────────────────────────────────────────────
// `contents` is always in Gemini format: [{role:"user"|"model", parts:[{text}]}]
async function callAI(contents) {
  if (aiProvider === "groq")      return callGroq(contents);
  if (aiProvider === "ollama")    return callOllama(contents);
  if (aiProvider === "openai")    return callOpenAI(contents);
  if (aiProvider === "anthropic") return callAnthropic(contents);
  return callGemini(contents);
}

async function callGemini(contents) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${aiApiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents }) }
    );
  } catch {
    throw new Error("Could not reach Gemini. Check your internet connection.");
  }
  const data = await response.json();
  if (data.error) {
    if (response.status === 400) throw new Error(`Gemini: Invalid API key. Go to Settings to update it.`);
    if (response.status === 429) throw new Error(`Gemini: Rate limit hit. Try again in a moment.`);
    throw new Error(`Gemini ${data.error.code}: ${data.error.message}`);
  }
  if (!data.candidates?.[0]) throw new Error("Gemini returned no response.");
  return data.candidates[0].content.parts[0].text;
}

async function callGroq(contents) {
  const messages = geminiToOpenAI(contents);
  let response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages })
    });
  } catch {
    throw new Error("Could not reach Groq. Check your internet connection.");
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) throw new Error("Groq: Invalid API key. Go to Settings to update it.");
    if (response.status === 429) throw new Error("Groq: Rate limit hit. Try again in a moment.");
    throw new Error(`Groq ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  if (!data.choices?.[0]) throw new Error("Groq returned no response.");
  return data.choices[0].message.content;
}

async function callOllama(contents) {
  const messages = geminiToOpenAI(contents);
  const model = ollamaModel || "llama3.2";

  const ollamaFetch = () => fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false })
  });

  let response;
  try {
    response = await ollamaFetch();
  } catch {
    throw new Error("OLLAMA_NOT_RUNNING");
  }

  if (response.status === 403) throw new Error("OLLAMA_CORS");

  if (response.status === 404) {
    await pullOllamaModel(model);
    response = await ollamaFetch();
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama ${response.status}: ${text || "Unexpected error"}`);
  }
  const data = await response.json();
  if (!data.message?.content) throw new Error("Ollama returned no response.");
  return data.message.content;
}

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

async function callOpenAI(contents) {
  const messages = geminiToOpenAI(contents);
  let response;
  try {
    response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${aiApiKey}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages })
    });
  } catch {
    throw new Error("Could not reach OpenAI. Check your internet connection.");
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) throw new Error("OpenAI: Invalid API key. Go to Settings to update it.");
    if (response.status === 429) throw new Error("OpenAI: Rate limit hit. Try again in a moment.");
    throw new Error(`OpenAI ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  if (!data.choices?.[0]) throw new Error("OpenAI returned no response.");
  return data.choices[0].message.content;
}

async function callAnthropic(contents) {
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
      body: JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: 1024, messages })
    });
  } catch {
    throw new Error("Could not reach Anthropic. Check your internet connection.");
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) throw new Error("Anthropic: Invalid API key. Go to Settings to update it.");
    if (response.status === 429) throw new Error("Anthropic: Rate limit hit. Try again in a moment.");
    throw new Error(`Anthropic ${response.status}: ${data.error?.message || "Unknown error"}`);
  }
  if (!data.content?.[0]) throw new Error("Anthropic returned no response.");
  return data.content[0].text;
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
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?key=${aiApiKey}&alt=sse`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents }) }
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
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, stream: true })
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
      body: JSON.stringify({ model: "gpt-4o-mini", messages, stream: true })
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
      body: JSON.stringify({ model: "claude-3-5-haiku-20241022", max_tokens: 2048, messages, stream: true })
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

// ── Deep repo context for RAG ─────────────────────────────────────────────────
async function getDeepRepoContext() {
  const cacheKey = `${currentRepo.owner}/${currentRepo.repo}`;
  if (repoCache[cacheKey]?.context) return repoCache[cacheKey].context;

  const fileTargets = [
    { endpoint: "/readme", label: "README", transform: async (d) => atob(d.content.replace(/\n/g, "")) },
    { endpoint: "/contents/CONTRIBUTING.md", label: "CONTRIBUTING.md", transform: (d) => atob(d.content.replace(/\n/g, "")) },
    { endpoint: "/contents/package.json", label: "package.json", transform: (d) => atob(d.content.replace(/\n/g, "")) },
    { endpoint: "/contents/requirements.txt", label: "requirements.txt", transform: (d) => atob(d.content.replace(/\n/g, "")) },
    { endpoint: "/contents/pyproject.toml", label: "pyproject.toml", transform: (d) => atob(d.content.replace(/\n/g, "")) },
    { endpoint: "/contents/Cargo.toml", label: "Cargo.toml", transform: (d) => atob(d.content.replace(/\n/g, "")) },
    { endpoint: "/contents/Makefile", label: "Makefile", transform: (d) => atob(d.content.replace(/\n/g, "")) },
  ];

  const results = await Promise.allSettled(
    fileTargets.map(f =>
      fetchGitHub(f.endpoint)
        .then(d => f.transform(d))
        .then(text => ({ label: f.label, text }))
    )
  );

  // Also get root file listing
  const rootFiles = await fetchGitHub("/contents")
    .then(items => items.map(i => i.name).join(", "))
    .catch(() => "");

  const parts = [];
  results.forEach(r => {
    if (r.status === "fulfilled") {
      const { label, text } = r.value;
      const limit = label === "README" ? 3000 : 1500;
      parts.push(`=== ${label} ===\n${text.substring(0, limit)}`);
    }
  });
  if (rootFiles) parts.push(`=== Root Files ===\n${rootFiles}`);

  const context = parts.join("\n\n");
  if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
  repoCache[cacheKey].context = context;
  return context;
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function renderMarkdown(text) {
  // Escape HTML first, then apply markdown transformations
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  // Inline code
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Bold
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // Headings
  html = html.replace(/^#### (.+)$/gm, "<h5>$1</h5>");
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.+)$/gm, "<h2>$1</h2>");
  // Unordered list items
  html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // Numbered list items
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Paragraph breaks
  html = html.replace(/\n\n/g, "<br><br>");

  return html;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function daysAgo(dateStr) {
  const days = Math.floor((Date.now() - new Date(dateStr)) / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
