// auth.js: Sign in with GitHub (OAuth device flow) and the Settings account card
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel } = require("./helpers/panel");

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "4999", "X-RateLimit-Limit": "5000", "X-RateLimit-Reset": "9999999999" },
});

// A fake github.com device flow: `polls` are the token endpoint's replies, in order
function deviceGitHub({ polls = [{ access_token: "gho_new" }], code = {}, user = { login: "ada", avatar_url: "https://avatars.githubusercontent.com/u/5?v=4", html_url: "https://github.com/ada" } } = {}) {
  const calls = [];
  const queue = [...polls];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const u = new URL(url);
    if (u.href === "https://github.com/login/device/code") {
      return json({ device_code: "dev123", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 0, ...code });
    }
    if (u.href === "https://github.com/login/oauth/access_token") return json(queue.shift() || { error: "authorization_pending" });
    if (u.pathname === "/rate_limit") {
      const ok = init.headers?.Authorization === "Bearer gho_new";
      return ok ? json({ resources: { core: { remaining: 5000, limit: 5000, reset: 9999999999 } } }) : json({ message: "Bad credentials" }, 401);
    }
    if (u.pathname === "/user") return json(user);
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, calls };
}

function signInPanel(opts) {
  const gh = deviceGitHub(opts);
  const panel = loadPanel({ fetch: gh.fetch });
  panel.run(`AUTH.clientId = "Ov23liTEST"`);
  return { panel, gh };
}

// ── The flow ─────────────────────────────────────────────────────────────────
test("requesting a code sends only the client ID and no scopes", async () => {
  const { panel, gh } = signInPanel();
  const code = await panel.fn.requestDeviceCode();
  assert.equal(code.user_code, "WDJB-MJHT");
  assert.deepEqual(gh.calls[0].body, { client_id: "Ov23liTEST", scope: "" });
  assert.equal(gh.calls[0].init.headers.Accept, "application/json");
});

test("polling waits while pending, backs off on slow_down, and returns the token", async () => {
  const { panel, gh } = signInPanel({ polls: [{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "gho_new" }] });
  const waits = [];
  const token = await panel.fn.deviceFlowSignIn({ onCode: () => {}, sleep: async (s) => { waits.push(s); } });
  assert.equal(token, "gho_new");
  assert.deepEqual(waits, [0, 0, 10], "slow_down lengthens the gap GitHub asked for");
  const poll = gh.calls.find(c => c.url.endsWith("/access_token")).body;
  assert.deepEqual(poll, { client_id: "Ov23liTEST", device_code: "dev123", grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
});

test("a denied or expired code ends sign-in with a clear message; cancelling stops polling", async () => {
  const denied = signInPanel({ polls: [{ error: "access_denied" }] });
  await assert.rejects(denied.panel.fn.deviceFlowSignIn({ onCode: () => {}, sleep: async () => {} }), /cancelled on GitHub/);
  const expired = signInPanel({ polls: [{ error: "expired_token" }] });
  await assert.rejects(expired.panel.fn.deviceFlowSignIn({ onCode: () => {}, sleep: async () => {} }), /code expired/);
  const disabled = loadPanel({ fetch: async () => json({ error: "device_flow_disabled" }, 400) });
  disabled.run(`AUTH.clientId = "x"`);
  await assert.rejects(disabled.fn.requestDeviceCode(), /Enable Device Flow/);

  const cancel = signInPanel({ polls: [] });
  let cancelled = false;
  const pending = cancel.panel.fn.deviceFlowSignIn({ onCode: () => { cancelled = true; }, isCancelled: () => cancelled, sleep: async () => {} });
  await assert.rejects(pending, (err) => err.message === "cancelled");
  assert.ok(!cancel.gh.calls.some(c => c.url.endsWith("/access_token")), "no polls after cancelling");
});

// ── Settings ─────────────────────────────────────────────────────────────────
test("Sign in shows the code, opens GitHub, then saves the token and shows who's signed in", async () => {
  const { panel } = signInPanel({ polls: [{ error: "authorization_pending" }, { access_token: "gho_new" }] });
  panel.fn.initSettingsTab();
  await panel.fn.startGitHubSignIn();

  assert.deepEqual(panel.chrome.openedTabs, ["https://github.com/login/device"]);
  assert.match(panel.el("sp-signin-flow").innerHTML, /<code id="sp-signin-code">WDJB-MJHT<\/code>/);
  assert.equal(panel.chrome.storage.local.data.githubToken, "gho_new");
  assert.equal(panel.chrome.storage.local.data.githubUser.login, "ada");
  assert.equal(panel.run("githubToken"), "gho_new");
  assert.equal(panel.el("sp-gh-account").hidden, false);
  assert.match(panel.el("sp-gh-account").innerHTML, /Signed in as <a href="https:\/\/github\.com\/ada"[^>]*>@ada<\/a>[\s\S]*sp-signout-btn/);
  assert.equal(panel.el("sp-gh-signin").hidden, true);
  assert.match(panel.el("sp-gh-status").textContent, /Signed in as @ada — 5,000 requests\/hour/);
});

test("signing out removes the token and account from this browser", async () => {
  const { panel } = signInPanel();
  panel.fn.initSettingsTab();
  await panel.fn.startGitHubSignIn();
  await panel.fn.signOutOfGitHub();
  assert.equal(panel.chrome.storage.local.data.githubToken, undefined);
  assert.equal(panel.chrome.storage.local.data.githubUser, undefined);
  assert.equal(panel.run("githubToken"), "");
  assert.equal(panel.el("sp-gh-account").hidden, true);
  assert.equal(panel.el("sp-gh-signin").hidden, false);
  assert.match(panel.el("sp-gh-status").textContent, /GitHub → Settings → Applications/);
});

test("without a client ID, Settings falls back to the paste-a-token form", () => {
  const panel = loadPanel({ fetch: async () => json({}) });
  panel.fn.initSettingsTab();
  assert.equal(panel.fn.signInAvailable(), false);
  assert.equal(panel.el("sp-gh-signin").hidden, true);
  assert.equal(panel.el("sp-token-details").open, true);
});

test("the rate-limit banner offers Sign in when it's available, a token otherwise", () => {
  const withSignIn = signInPanel();
  withSignIn.panel.run(`ghState.remaining = 3; ghState.limit = 60; ghState.resetAt = Date.now() + 60000`);
  withSignIn.panel.fn.renderRateLimit();
  assert.equal(withSignIn.panel.el("rate-banner-btn").textContent, "Sign in");
  assert.match(withSignIn.panel.el("rate-banner-sub").textContent, /Signing in raises the limit/);

  const tokenOnly = loadPanel({ fetch: async () => json({}) });
  tokenOnly.run(`ghState.remaining = 3; ghState.limit = 60; ghState.resetAt = Date.now() + 60000`);
  tokenOnly.fn.renderRateLimit();
  assert.equal(tokenOnly.el("rate-banner-btn").textContent, "Get token");
});
