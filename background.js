// ── Background service worker ────────────────────────────────────────────────
// Opens the side panel from the toolbar button, and serves the contributor
// guide that content.js shows on GitHub issue pages. The guide's data comes
// from the same code the panel uses (github.js, retrieval.js, …), loaded here
// with importScripts, so both share one response cache (chrome.storage.session)
// and the token is only ever sent to api.github.com.

let currentRepo = null; // the shared scripts default to it; the worker always passes a repo

importScripts("github.js", "retrieval.js", "insights.js", "brief.js", "guide.js", "stack.js");

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
  console.log("GitHub Repo Analyzer & RAG Chat extension installed.");
});

// The worker can be stopped at any time, so the token is re-read on wake-up
const tokenReady = chrome.storage.local.get(["githubToken"]).then(({ githubToken: t }) => { githubToken = t || ""; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.githubToken) githubToken = changes.githubToken.newValue || "";
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "issue-guide") {
    tokenReady
      .then(() => issueGuide(msg))
      .then(sendResponse, (err) => sendResponse({ error: err.message, rateLimited: !!err.rateLimited, status: err.status || 0 }));
    return true; // answers asynchronously
  }
  if (msg?.type === "open-panel" && sender.tab?.id) {
    // Must run while the click that sent the message still counts as a user action
    chrome.sidePanel.open({ tabId: sender.tab.id })
      .then(() => sendResponse({ ok: true }), (err) => sendResponse({ error: err.message }));
    return true;
  }
  return false;
});
