// ── GitHub layer (shared) ────────────────────────────────────────────────────
// Everything that talks to the GitHub API, used both by the side panel and by
// the background worker (which serves the contributor guide on GitHub pages).
// No DOM here: the panel hooks its rate-limit badge in via onRateLimitChange.
// Both contexts share the response cache through chrome.storage.local, so an
// issue opened in the panel and on the page is only fetched once — and reloading
// the extension or restarting Chrome doesn't throw it away.

let githubToken = "";                // set from chrome.storage.local by whoever loads this
let onRateLimitChange = () => {};    // the panel redraws its badge/banner here

// Session cache keyed by "owner/repo"
// Stores: { repoData, issues, languages, contributors, health, prs, … }
const repoCache = {};

function repoKey(repo = currentRepo) { return `${repo.owner}/${repo.repo}`; }
function cacheFor(key) { return (repoCache[key] ??= {}); }

// ── GitHub API layer ──────────────────────────────────────────────────────────
// Without a token GitHub allows 60 requests an hour per IP, so every request
// counts:
//  • responses (404s included — most probed files don't exist) are cached in
//    chrome.storage.local for up to 3 days, so reopening the panel, reloading the
//    extension or restarting Chrome is free. (chrome.storage.session was wiped by
//    each of those.) Old entries still carry their ETag: revalidating one costs
//    nothing when it hasn't changed.
//  • while fresh they're served without touching the network; after that they're
//    revalidated with If-None-Match, and GitHub doesn't count 304 replies
//  • once the quota is spent, requests stop until the reset time instead of
//    each tab collecting its own 403
const GH_FRESH_MS = 10 * 60 * 1000;
const GH_MAX_CACHED_CHARS = 400_000; // skip persisting huge bodies (e.g. file trees)
const GH_PERSIST_MS = 3 * 24 * 60 * 60 * 1000; // stored responses older than this are dropped
const GH_PERSIST_MAX_CHARS = 4_000_000;       // total stored, so chat history keeps room in storage.local
const ghMemCache = new Map();        // cache key → { status, body, etag, link, time }
const ghInflight = new Map();        // cache key → Promise of the same
// Core quota drives the badge/banner. Search (issues/PRs, 10/min anonymously)
// and code search (10/min) are separate quotas GitHub reports in the same
// headers, named by X-RateLimit-Resource; they must never touch the core numbers.
const ghState = { remaining: null, limit: null, resetAt: 0, badToken: false,
  search: { remaining: null, resetAt: 0 }, codeSearch: { remaining: null, resetAt: 0 } };
const otherLimits = {}; // any other resource GitHub names (graphql, …): tracked, never shown

class GitHubError extends Error {
  constructor(message, status, { rateLimited = false, resetAt = 0, resource = "core" } = {}) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
    this.resetAt = resetAt;
    this.resource = resource;
  }
}

function resourceFor(url) {
  const path = new URL(url).pathname;
  return path.startsWith("/search/code") ? "code_search" : path.startsWith("/search/") ? "search" : "core";
}
function limitsFor(resource) {
  if (resource === "core") return ghState;
  if (resource === "search") return ghState.search;
  if (resource === "code_search") return ghState.codeSearch;
  return (otherLimits[resource] ??= { remaining: null, resetAt: 0 });
}

function isRateLimited(resource = "core") {
  const l = limitsFor(resource);
  return l.remaining === 0 && Date.now() < l.resetAt;
}

function rateLimitError(resource = "core") {
  const { resetAt } = limitsFor(resource);
  const message = resource !== "core"
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
    const stored = (await chrome.storage.local.get(key))?.[key];
    if (!stored || Date.now() - stored.time > GH_PERSIST_MS) return null;
    ghMemCache.set(key, stored);
    return stored;
  } catch { return null; }
}

function ghCacheSet(key, entry) {
  ghMemCache.set(key, entry);
  if (JSON.stringify(entry).length > GH_MAX_CACHED_CHARS) return;
  pruneGitHubCache(); // once per page/worker: drop expired entries, keep within the size cap
  chrome.storage.local.set({ [key]: entry }).catch(() => pruneGitHubCache({ force: true })); // full → make room for next time
}

// Stored responses: drop expired ones, then the oldest until the total fits
// GH_PERSIST_MAX_CHARS. Runs once per page (or when storage is full).
let ghPruned = null;
function pruneGitHubCache({ force = false, maxChars = GH_PERSIST_MAX_CHARS } = {}) {
  if (ghPruned && !force) return ghPruned;
  ghPruned = (async () => {
    const all = await chrome.storage.local.get(null);
    const entries = Object.entries(all).filter(([k]) => k.startsWith("gh:"))
      .map(([k, v]) => ({ k, time: v?.time || 0, size: JSON.stringify(v).length }))
      .sort((a, b) => b.time - a.time); // newest first
    const drop = [];
    let total = 0;
    for (const e of entries) {
      if (Date.now() - e.time > GH_PERSIST_MS || total + e.size > maxChars) drop.push(e.k);
      else total += e.size;
    }
    if (drop.length) await chrome.storage.local.remove(drop);
    return { kept: entries.length - drop.length, dropped: drop.length };
  })().catch(() => ({ kept: 0, dropped: 0 }));
  return ghPruned;
}

// Forget stored responses for one auth mode ("auth" on sign-out: a signed-in
// token may have read private repos) or all of them
async function clearGitHubCache(mode = null) {
  for (const k of [...ghMemCache.keys()]) if (!mode || k.startsWith(`gh:${mode}:`)) ghMemCache.delete(k);
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => (mode ? k.startsWith(`gh:${mode}:`) : k.startsWith("gh:")));
  if (keys.length) await chrome.storage.local.remove(keys);
}

function noteRateLimitHeaders(res, resource) {
  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (remaining === null) return;
  const l = limitsFor(res.headers.get("X-RateLimit-Resource") || resource);
  l.remaining = Number(remaining);
  l.limit = Number(res.headers.get("X-RateLimit-Limit"));
  l.resetAt = Number(res.headers.get("X-RateLimit-Reset")) * 1000;
  if (l === ghState) onRateLimitChange();
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
    if (l === ghState) onRateLimitChange();
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
      onRateLimitChange();
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

// ── File decoding ─────────────────────────────────────────────────────────────
// The contents API returns base64 of the raw bytes; atob() alone yields Latin-1,
// which garbles any UTF-8 (emoji, CJK, accents), so decode the bytes properly.
function decodeGitHubContent(data) {
  const binary = atob((data.content || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
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
