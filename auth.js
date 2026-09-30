// ── Sign in with GitHub (OAuth device flow) ──────────────────────────────────
// No backend and no client secret: the panel asks GitHub for a one-time code,
// the user enters it at github.com/login/device and approves, and the panel
// polls until GitHub hands over a token. That token is stored exactly like a
// pasted one ("githubToken" in chrome.storage.local) and, like it, is only ever
// sent to api.github.com. No scopes are requested: public repos and the
// 5,000 requests/hour limit need none.
//
// Setup, once, by whoever ships the extension: register an OAuth App at
// github.com/settings/developers (any homepage URL; the callback URL isn't
// used), tick "Enable Device Flow", and put its Client ID below. A client ID
// isn't a secret. While it's empty, Settings shows only the paste-a-token form.
const AUTH = {
  clientId: "Iv23liarORnQeoxhJ8gO",
  deviceCodeUrl: "https://github.com/login/device/code",
  tokenUrl: "https://github.com/login/oauth/access_token",
  verifyUrl: "https://github.com/login/device",
};

const signInAvailable = () => !!AUTH.clientId;

async function postGitHubForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Step 1 → { device_code, user_code, verification_uri, expires_in, interval }
async function requestDeviceCode() {
  const { ok, status, data } = await postGitHubForm(AUTH.deviceCodeUrl, { client_id: AUTH.clientId, scope: "" });
  if (!ok || !data.device_code) {
    throw new Error(data.error === "device_flow_disabled"
      ? "Device flow isn't enabled for this OAuth App — tick “Enable Device Flow” in its settings."
      : data.error_description || `GitHub couldn't start sign-in (${status}).`);
  }
  return data;
}

// Step 2, one poll → { token } or { wait: seconds until the next poll }
async function pollDeviceToken(deviceCode, interval) {
  const { data } = await postGitHubForm(AUTH.tokenUrl, {
    client_id: AUTH.clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (data.access_token) return { token: data.access_token };
  switch (data.error) {
    case "authorization_pending": return { wait: interval };
    case "slow_down": return { wait: data.interval || interval + 5 }; // GitHub asks for a longer gap
    case "expired_token": throw new Error("The code expired before it was approved — start again.");
    case "access_denied": throw new Error("Sign-in was cancelled on GitHub.");
    default: throw new Error(data.error_description || "GitHub didn't return a token — try again.");
  }
}

class SignInCancelled extends Error {}

// The whole flow → token. `onCode` shows the code; `isCancelled` stops polling.
async function deviceFlowSignIn({ onCode, isCancelled = () => false, sleep = (s) => new Promise(r => setTimeout(r, s * 1000)), now = Date.now }) {
  const code = await requestDeviceCode();
  onCode(code);
  const deadline = now() + (code.expires_in || 900) * 1000;
  let interval = code.interval ?? 5;
  while (now() < deadline) {
    await sleep(interval);
    if (isCancelled()) throw new SignInCancelled("cancelled");
    const r = await pollDeviceToken(code.device_code, interval);
    if (r.token) return r.token;
    interval = r.wait;
  }
  throw new Error("The code expired before it was approved — start again.");
}

// Who a token belongs to → { login, avatar_url, html_url } (null if unknown)
async function fetchGitHubUser(token) {
  const url = "https://api.github.com/user";
  const res = await fetch(url, { headers: githubHeaders(url, token), cache: "no-store" });
  if (!res.ok) return null;
  const u = await res.json().catch(() => null);
  return u?.login ? { login: u.login, avatar_url: u.avatar_url, html_url: u.html_url } : null;
}

// ── Settings: the GitHub card ────────────────────────────────────────────────
let githubUser = null;  // { login, avatar_url, html_url } of the signed-in account
let signInFlow = null;  // { cancelled } while a sign-in is waiting on the user

// Signed in → who, and a Sign out button. Signed out → the sign-in button (when
// a client ID is set up) with the paste-a-token form folded underneath.
function renderGitHubAccount() {
  const account = document.getElementById("sp-gh-account");
  const signInBox = document.getElementById("sp-gh-signin");
  const details = document.getElementById("sp-token-details");
  const signedIn = !!githubToken;
  account.hidden = !signedIn;
  signInBox.hidden = signedIn || !signInAvailable();
  if (!signInAvailable()) details.open = true; // the token form is the only way in
  if (signedIn) {
    const who = githubUser
      ? `${githubUser.avatar_url ? `<img src="${avatarUrl(githubUser.avatar_url, 64)}" class="gh-account-avatar" alt="">` : ""}` +
        `<span>Signed in as <a href="${githubUser.html_url || `https://github.com/${encodeURIComponent(githubUser.login)}`}" target="_blank">@${escapeHtml(githubUser.login)}</a></span>`
      : `<span>Using a GitHub token</span>`;
    account.innerHTML = `<div class="gh-account-who">${who}</div>` +
      `<button id="sp-signout-btn" class="btn btn-ghost btn-xs">Sign out</button>`;
  }
}

function renderSignInCode(code) {
  const flow = document.getElementById("sp-signin-flow");
  flow.innerHTML = `
    <p class="signin-step">Enter this code on the GitHub tab that just opened:</p>
    <div class="signin-code">
      <code id="sp-signin-code">${escapeHtml(code.user_code)}</code>
      <button class="btn btn-xs" id="sp-signin-copy">${icon("copy", "icon-sm")}Copy</button>
    </div>
    <div class="signin-wait"><div class="typing-dots"><span></span><span></span><span></span></div>Waiting for you to approve on GitHub…</div>
    <p class="brief-note">Tab closed? <a href="${escapeHtml(code.verification_uri || AUTH.verifyUrl)}" target="_blank">Open github.com/login/device</a> · <a href="#" id="sp-signin-cancel">Cancel</a></p>`;
  flow.hidden = false;
}

// Sign in → code shown + GitHub opened → token saved → account shown
async function startGitHubSignIn() {
  if (!signInAvailable() || signInFlow) return;
  const flowState = { cancelled: false };
  signInFlow = flowState;
  const btn = document.getElementById("sp-signin-btn");
  const flow = document.getElementById("sp-signin-flow");
  btn.disabled = true;
  showSpStatus("sp-gh-status", "", false, 0);
  try {
    const token = await deviceFlowSignIn({
      onCode: (code) => {
        renderSignInCode(code);
        globalThis.navigator?.clipboard?.writeText(code.user_code).catch(() => {}); // paste-ready if the browser allows
        chrome.tabs.create({ url: code.verification_uri || AUTH.verifyUrl });
      },
      isCancelled: () => flowState.cancelled,
    });
    const { valid, core } = await checkRateLimit(token);
    if (!valid) throw new Error("GitHub issued a token it then rejected — try signing in again.");
    const user = await fetchGitHubUser(token).catch(() => null);
    await chrome.storage.local.set({ githubToken: token, githubUser: user });
    githubToken = token;
    githubUser = user;
    renderGitHubAccount();
    showSpStatus("sp-gh-status", `Signed in${user ? ` as @${user.login}` : ""} — ${(core?.limit ?? 5000).toLocaleString()} requests/hour.`);
    onGitHubTokenChanged();
  } catch (err) {
    if (!(err instanceof SignInCancelled)) showSpStatus("sp-gh-status", err.message, true, 0);
  } finally {
    if (signInFlow === flowState) signInFlow = null;
    flow.hidden = true;
    btn.disabled = false;
  }
}

function cancelGitHubSignIn() {
  if (signInFlow) signInFlow.cancelled = true;
  signInFlow = null;
  document.getElementById("sp-signin-flow").hidden = true;
  document.getElementById("sp-signin-btn").disabled = false;
}

// Removes the token from this browser. (Revoking it on GitHub needs the app's
// secret, so the note points the user to GitHub's Applications page for that.)
async function signOutOfGitHub() {
  await chrome.storage.local.remove(["githubToken", "githubUser", "stackProfile"]); // your stack edits are kept
  await clearGitHubCache("auth"); // responses read with the token (private repos included) go too
  githubToken = "";
  githubUser = null;
  document.getElementById("sp-gh-token").placeholder = "ghp_...";
  renderGitHubAccount();
  showSpStatus("sp-gh-status", "Signed out. To revoke access too, remove the app under GitHub → Settings → Applications.", false, 6000);
  onGitHubTokenChanged();
}

function handleGitHubCardClick(e) {
  const t = e.target;
  if (t.closest?.("#sp-signin-btn")) { startGitHubSignIn(); return; }
  if (t.closest?.("#sp-signout-btn")) { signOutOfGitHub(); return; }
  if (t.closest?.("#sp-signin-cancel")) { e.preventDefault(); cancelGitHubSignIn(); return; }
  const copy = t.closest?.("#sp-signin-copy");
  if (copy) {
    navigator.clipboard.writeText(document.getElementById("sp-signin-code").textContent).then(() => {
      copy.innerHTML = `${icon("check", "icon-sm")}Copied`;
      setTimeout(() => { copy.innerHTML = `${icon("copy", "icon-sm")}Copy`; }, 1500);
    });
  }
}
