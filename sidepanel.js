// ── State ────────────────────────────────────────────────────────────────────
let currentRepo = null;
let githubToken = "";
let aiProvider = "groq";   // "groq" | "gemini" | "ollama"
let aiApiKey = "";          // groq or gemini key
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
  document.getElementById("send-btn").addEventListener("click", handleChat);
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

  if (aiProvider !== "ollama" && !aiApiKey) showSettingsPrompt();

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

// ── Settings prompt ───────────────────────────────────────────────────────────
function showSettingsPrompt() {
  if (document.getElementById("settings-prompt")) return;
  const container = document.getElementById("container");
  const prompt = document.createElement("div");
  prompt.id = "settings-prompt";
  prompt.innerHTML = `
    <div class="settings-inline">
      <h3>Choose AI Provider</h3>
      <div class="prompt-provider-pills">
        <button class="prompt-pill active" data-provider="groq">⚡ Groq <span class="pill-tag">Free</span></button>
        <button class="prompt-pill" data-provider="gemini">✦ Gemini <span class="pill-tag">Free tier</span></button>
        <button class="prompt-pill" data-provider="ollama">🦙 Ollama <span class="pill-tag">Local</span></button>
      </div>
      <div id="prompt-key-wrap">
        <input type="password" id="ai-key-input" placeholder="Groq API key — get free at console.groq.com">
      </div>
      <div id="prompt-ollama-wrap" style="display:none">
        <p class="prompt-ollama-note">No key needed. Make sure <code>ollama serve</code> is running locally.</p>
        <input type="text" id="ollama-model-input" placeholder="Model name (default: llama3.2)">
      </div>
      <div class="settings-inline-actions">
        <button id="save-keys-btn">Save &amp; Continue</button>
        <a href="#" id="open-options-link">Full Settings</a>
      </div>
    </div>
  `;
  container.prepend(prompt);

  // Provider pill switching
  let promptProvider = "groq";
  const pillPlaceholders = {
    groq:   "Groq API key — get free at console.groq.com",
    gemini: "Gemini API key — get free at aistudio.google.com",
    ollama: "",
  };

  prompt.querySelectorAll(".prompt-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      prompt.querySelectorAll(".prompt-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      promptProvider = pill.dataset.provider;
      const isOllama = promptProvider === "ollama";
      document.getElementById("prompt-key-wrap").style.display  = isOllama ? "none" : "block";
      document.getElementById("prompt-ollama-wrap").style.display = isOllama ? "block" : "none";
      if (!isOllama) {
        document.getElementById("ai-key-input").placeholder = pillPlaceholders[promptProvider];
      }
    });
  });

  document.getElementById("save-keys-btn").addEventListener("click", async () => {
    aiProvider = promptProvider;
    const toSave = { aiProvider };

    if (aiProvider === "ollama") {
      ollamaModel = (document.getElementById("ollama-model-input").value.trim()) || "llama3.2";
      toSave.ollamaModel = ollamaModel;
    } else {
      const key = document.getElementById("ai-key-input").value.trim();
      if (!key) { alert("Please enter an API key."); return; }
      aiApiKey = key;
      toSave.aiApiKey = aiApiKey;
    }

    await chrome.storage.local.set(toSave);
    prompt.remove();
    if (currentRepo) updateRepoInfo();
  });

  document.getElementById("open-options-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

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
    list.innerHTML = `<li class="empty-item">No ${activeLabel ? `"${activeLabel}" ` : ""}issues found.</li>`;
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

function renderHealthCard(h) {
  const lastPushText = h.lastPush ? daysAgo(h.lastPush) : "unknown";
  const avgMergeText = h.avgMergeDays !== null ? `${h.avgMergeDays}d avg` : "N/A";

  document.getElementById("health-card").innerHTML = `
    <div class="health-section-title">Repo Health</div>
    <div class="health-grid">
      <div class="health-item ${h.hasContributing ? "good" : "bad"}">
        ${h.hasContributing ? "✓" : "✗"} CONTRIBUTING.md
      </div>
      <div class="health-item ${h.hasIssueTemplates ? "good" : "bad"}">
        ${h.hasIssueTemplates ? "✓" : "✗"} Issue Templates
      </div>
      <div class="health-item neutral">
        🕐 Last Push: ${lastPushText}
      </div>
      <div class="health-item neutral">
        🔀 Open PRs: ${h.openPRs}
      </div>
      <div class="health-item neutral">
        ⏱ Merge Time: ${avgMergeText}
      </div>
      <div class="health-item neutral">
        🐛 Open Issues: ${formatNumber(h.openIssues)}
      </div>
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
      e.preventDefault(); chrome.runtime.openOptionsPage();
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

    const result = await callAI([{ role: "user", parts: [{ text: prompt }] }]);

    if (!repoCache[cacheKey]) repoCache[cacheKey] = {};
    repoCache[cacheKey].quickstart = result;
    content.innerHTML = renderMarkdown(result);
    btn.style.display = "none";
  } catch (err) {
    content.innerHTML = `<p class="error-item">Error: ${err.message}</p>`;
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

  chatMessages.push({ role: "user", text: query });
  appendChatMessage("user", query, false);
  input.value = "";

  const typingEl = document.getElementById("typing-indicator");
  typingEl.style.display = "flex";
  document.getElementById("send-btn").disabled = true;

  try {
    const context = await getDeepRepoContext();
    const systemText = `You are an expert on the GitHub repository "${currentRepo.owner}/${currentRepo.repo}". Answer questions based on this context:\n\n${context}\n\nUser question: `;

    // Build multi-turn history (last 6 messages)
    const history = chatMessages.slice(-7, -1).map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));
    history.push({ role: "user", parts: [{ text: systemText + query }] });

    const reply = await callAI(history);
    chatMessages.push({ role: "bot", text: reply });
    appendChatMessage("bot", reply, false);
    saveChatHistory();
  } catch (err) {
    const errText = `Error: ${err.message}`;
    chatMessages.push({ role: "bot", text: errText });
    appendChatMessage("bot", errText, false);
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
}

async function loadChatHistory() {
  if (!currentRepo) return;
  const key = `chat_${currentRepo.owner}_${currentRepo.repo}`;
  const result = await chrome.storage.local.get([key]);
  chatMessages = result[key] || [];
  const historyEl = document.getElementById("chat-history");
  historyEl.innerHTML = "";
  chatMessages.forEach(m => appendChatMessage(m.role, m.text, false));
}

async function saveChatHistory() {
  if (!currentRepo) return;
  const key = `chat_${currentRepo.owner}_${currentRepo.repo}`;
  // Keep last 50 messages to avoid storage bloat
  const trimmed = chatMessages.slice(-50);
  await chrome.storage.local.set({ [key]: trimmed });
}

// ── AI routing ────────────────────────────────────────────────────────────────
// `contents` is always in Gemini format: [{role:"user"|"model", parts:[{text}]}]
async function callAI(contents) {
  if (aiProvider === "groq")   return callGroq(contents);
  if (aiProvider === "ollama") return callOllama(contents);
  return callGemini(contents);
}

async function callGemini(contents) {
  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${aiApiKey}`,
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
  let response;
  try {
    response = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false })
    });
  } catch {
    throw new Error(
      `Ollama is not running. Start it with: ollama serve\n` +
      `Then pull a model: ollama pull ${model}\n` +
      `Or switch to Groq/Gemini in Settings.`
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 404) throw new Error(`Ollama: model "${model}" not found. Run: ollama pull ${model}`);
    throw new Error(`Ollama ${response.status}: ${text || "Unexpected error"}`);
  }
  const data = await response.json();
  if (!data.message?.content) throw new Error("Ollama returned no response.");
  return data.message.content;
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
