// The GitHub request layer: caching, conditional requests, rate limits, tokens
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain, tick } = require("./helpers/panel");
const { githubMock, json } = require("./helpers/github-mock");

// Controllable clock (the scripts share this realm's Date)
const realNow = Date.now;
let now;
beforeEach(() => { now = Date.parse("2026-09-23T12:00:00Z"); Date.now = () => now; });
afterEach(() => { Date.now = realNow; });

const resetIn = (sec) => String(Math.floor(now / 1000) + sec);
const limited = (extra = {}) => json({ message: "API rate limit exceeded for 1.2.3.4." }, {
  status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "60", "X-RateLimit-Reset": resetIn(1800), ...extra } });

function setup(routes, opts) {
  const gh = githubMock(routes, opts);
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  return { gh, panel, fetchGitHub: (p) => panel.fn.fetchGitHub(p) };
}

test("primary rate limit: friendly error, no raw GitHub text, then no requests until reset", async () => {
  let isLimited = true;
  const { gh, fetchGitHub } = setup({ "/issues": () => (isLimited ? limited() : json({ ok: 1 })), "/languages": () => (isLimited ? limited() : json({ ok: 1 })) });

  const first = await fetchGitHub("/issues").catch(e => e);
  assert.equal(first.rateLimited, true);
  assert.equal(first.resetAt, (Math.floor(now / 1000) + 1800) * 1000);
  assert.ok(!/1\.2\.3\.4/.test(first.message), "the IP from GitHub's message must not reach the UI");

  const second = await fetchGitHub("/languages").catch(e => e);
  assert.equal(second.rateLimited, true);
  assert.equal(gh.apiCalls.length, 1, "no request is sent while limited");

  now += 1801 * 1000;
  isLimited = false;
  assert.deepEqual(plain(await fetchGitHub("/languages")), { ok: 1 });
  assert.equal(gh.apiCalls.filter(u => u === "/languages").length, 1, "requests resume after the reset");
  await tick(10);
  assert.ok(gh.apiCalls.some(u => u.startsWith("/issues?state=open")), "the visible tab reloads by itself once the window resets");
});

test("fresh cache hits and cached 404s cost nothing", async () => {
  const { gh, fetchGitHub } = setup({ "/languages": { TypeScript: 1 } });
  await fetchGitHub("/languages");
  await fetchGitHub("/languages");
  const e1 = await fetchGitHub("/contents/Cargo.toml").catch(e => e);
  const e2 = await fetchGitHub("/contents/Cargo.toml").catch(e => e);
  assert.equal(e1.status, 404);
  assert.equal(e2.status, 404);
  assert.equal(gh.apiCalls.length, 2);
});

test("concurrent identical requests share one network call", async () => {
  const { gh, fetchGitHub } = setup({ "/readme": { a: 1 } });
  await Promise.all([fetchGitHub("/readme"), fetchGitHub("/readme"), fetchGitHub("/readme")]);
  assert.equal(gh.apiCalls.length, 1);
});

test("stale entries revalidate with If-None-Match and keep their body on 304", async () => {
  let notModified = false;
  const { gh, fetchGitHub } = setup({
    "/languages": () => (notModified ? json(null, { status: 304, headers: { ETag: '"abc"' } }) : json({ v: 1 }, { headers: { ETag: '"abc"' } })),
  });
  await fetchGitHub("/languages");
  now += 11 * 60 * 1000;
  notModified = true;
  assert.deepEqual(plain(await fetchGitHub("/languages")), { v: 1 });
  assert.equal(gh.calls[1].init.headers["If-None-Match"], '"abc"');
});

test("while limited, a stale cached copy is served instead of an error", async () => {
  let isLimited = false;
  const { fetchGitHub } = setup({ "/contributors": () => (isLimited ? limited() : json({ v: 2 })) });
  await fetchGitHub("/contributors");
  now += 11 * 60 * 1000;
  isLimited = true;
  assert.deepEqual(plain(await fetchGitHub("/contributors")), { v: 2 });
});

test("responses survive reloading the extension or restarting Chrome (chrome.storage.local), for 3 days", async () => {
  const gh = githubMock({ "/languages": { Go: 1 } });
  const first = loadPanel({ fetch: gh.fetch });
  first.setRepo();
  await first.fn.fetchGitHub("/languages");
  const local = structuredClone(first.chrome.storage.local.data);
  assert.ok(Object.keys(local).some(k => k.startsWith("gh:anon:")), "stored, not just in memory");

  const reloaded = loadPanel({ fetch: gh.fetch, chrome: { local } });
  reloaded.setRepo();
  assert.deepEqual(plain(await reloaded.fn.fetchGitHub("/languages")), { Go: 1 });
  assert.equal(gh.apiCalls.length, 1, "no new request after a reload");

  // Older than 3 days → not trusted from storage
  const old = structuredClone(local);
  for (const k of Object.keys(old)) if (k.startsWith("gh:")) old[k].time = Date.now() - 4 * 86_400_000;
  const later = loadPanel({ fetch: gh.fetch, chrome: { local: old } });
  later.setRepo();
  await later.fn.fetchGitHub("/languages");
  assert.equal(gh.apiCalls.length, 2);
});

test("stored responses are pruned: expired first, then the oldest past the size cap; settings are never touched", async () => {
  const now = Date.now();
  const entry = (ageMs, size = 100) => ({ status: 200, body: "x".repeat(size), time: now - ageMs });
  const panel = loadPanel({ chrome: { local: {
    "gh:anon:https://api.github.com/a": entry(1000), "gh:anon:https://api.github.com/b": entry(2000),
    "gh:anon:https://api.github.com/c": entry(5000), "gh:anon:https://api.github.com/old": entry(4 * 86_400_000),
    aiApiKey: "gsk_keep", chat_o_r: [{ role: "user", text: "keep" }],
  } } });
  const r = plain(await panel.fn.pruneGitHubCache({ force: true, maxChars: 300 }));
  const left = Object.keys(panel.chrome.storage.local.data);
  assert.ok(left.includes("gh:anon:https://api.github.com/a") && left.includes("gh:anon:https://api.github.com/b"), "newest kept");
  assert.ok(!left.includes("gh:anon:https://api.github.com/c"), "oldest past the cap dropped");
  assert.ok(!left.includes("gh:anon:https://api.github.com/old"), "expired dropped");
  assert.ok(left.includes("aiApiKey") && left.includes("chat_o_r"), "only GitHub responses are pruned");
  assert.deepEqual(r, { kept: 2, dropped: 2 });
});

test("signing out forgets responses read with the token; anonymous ones stay", async () => {
  const panel = loadPanel({ chrome: { local: {
    githubToken: "gho_x", "gh:auth:https://api.github.com/repos/o/private": { status: 200, body: {}, time: Date.now() },
    "gh:anon:https://api.github.com/repos/o/public": { status: 200, body: {}, time: Date.now() },
  } } });
  panel.run(`githubToken = "gho_x"`);
  await panel.fn.signOutOfGitHub();
  const left = Object.keys(panel.chrome.storage.local.data);
  assert.ok(!left.some(k => k.startsWith("gh:auth:")), "private data read with the token is gone");
  assert.ok(left.includes("gh:anon:https://api.github.com/repos/o/public"));
});

test("secondary limit pauses for Retry-After only, not until the hourly reset", async () => {
  // Real secondary-limit responses still carry the primary window's reset time
  const { fetchGitHub } = setup({ "/issues": json({ message: "You have exceeded a secondary rate limit" }, {
    status: 403, headers: { "Retry-After": "30", "X-RateLimit-Remaining": "40", "X-RateLimit-Reset": resetIn(2400) } }) });
  const e = await fetchGitHub("/issues").catch(e => e);
  assert.equal(e.rateLimited, true);
  assert.equal(e.resetAt, now + 30000);
});

test("an ordinary 403 is not mistaken for a rate limit", async () => {
  const { fetchGitHub } = setup({ "/issues": json({ message: "Resource not accessible" }, { status: 403, headers: { "X-RateLimit-Remaining": "40" } }) });
  const e = await fetchGitHub("/issues").catch(e => e);
  assert.equal(e.rateLimited, false);
  assert.equal(e.status, 403);
});

test("search has its own quota: exhausting it doesn't block core requests or the badge", async () => {
  const { gh, panel, fetchGitHub } = setup({
    "/search/issues": json({ message: "API rate limit exceeded" }, { status: 403, headers: { "X-RateLimit-Resource": "search", "X-RateLimit-Remaining": "0", "X-RateLimit-Limit": "10", "X-RateLimit-Reset": resetIn(40) } }),
    "/languages": { ok: 1 },
  });
  const e = await fetchGitHub("https://api.github.com/search/issues?q=x").catch(e => e);
  assert.equal(e.rateLimited, true);
  assert.equal(e.resource, "search");
  assert.deepEqual(plain(await fetchGitHub("/languages")), { ok: 1 });
  assert.equal(panel.run("ghState.remaining"), 4999, "core quota comes from core responses only");
  assert.equal(gh.apiCalls.length, 2);
});

test("a rejected token (401) is flagged for the banner", async () => {
  const { panel, fetchGitHub } = setup({ "/issues": json({ message: "Bad credentials" }, { status: 401 }) });
  panel.setToken("ghp_bad");
  const e = await fetchGitHub("/issues").catch(e => e);
  assert.equal(e.status, 401);
  assert.equal(panel.run("ghState.badToken"), true);
});

test("the token is only sent to api.github.com", async () => {
  const { gh, panel } = setup({ "/issues": [] });
  panel.setToken("ghp_secret");
  await panel.fn.fetchGitHub("/issues");
  await panel.fn.fetchGitHub("https://evil.example/steal").catch(() => {});
  assert.equal(gh.calls[0].init.headers.Authorization, "Bearer ghp_secret");
  assert.ok(!gh.calls.slice(1).some(c => c.init.headers?.Authorization), "token leaked to another host");
});

test("cache is keyed by auth mode, so adding a token re-checks anonymous 404s", async () => {
  let authed = false;
  const { gh, panel, fetchGitHub } = setup({ "/private-thing": () => (authed ? json({ ok: 1 }) : json({ message: "Not Found" }, { status: 404 })) });
  assert.equal((await fetchGitHub("/private-thing").catch(e => e)).status, 404);
  panel.setToken("ghp_x");
  authed = true;
  assert.deepEqual(plain(await fetchGitHub("/private-thing")), { ok: 1 });
  assert.equal(gh.apiCalls.length, 2);
});

test("PR queries always ask for newest first", async () => {
  const gh = githubMock({ "/pulls": [], "": { pushed_at: new Date(now).toISOString() }, "/community/profile": { files: {} }, "/labels?per_page=100": [] });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  await panel.fn.fetchPrList();
  panel.fn.setPrState("closed"); await new Promise(r => setTimeout(r, 5));
  await panel.fn.fetchRepoHealth();
  const sorted = gh.apiCalls.filter(u => u.startsWith("/pulls?") && u.includes("sort="));
  assert.ok(sorted.length >= 2, sorted.join("\n"));
  for (const u of sorted) assert.match(u, /direction=desc/, u);
});
