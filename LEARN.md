# How This Extension Works — A First-Principles Guide

> **Goal of this document:** Give you a mental model of every architectural decision in this codebase. No syntax definitions. No "a function is a reusable block of code." You already know that. This is about *why* things are structured the way they are, with code pulled straight from this repo to illustrate each idea.

---

## Table of Contents

1. [The Problem This Solves](#1-the-problem-this-solves)
2. [The Fundamental Constraint — Isolated Worlds](#2-the-fundamental-constraint--isolated-worlds)
3. [How the Pieces Talk to Each Other](#3-how-the-pieces-talk-to-each-other)
4. [Three Tiers of State](#4-three-tiers-of-state)
5. [The GitHub API Layer](#5-the-github-api-layer)
6. [The AI Abstraction — One Router, Five Implementations](#6-the-ai-abstraction--one-router-five-implementations)
7. [RAG — How We Give the AI Memory of the Repo](#7-rag--how-we-give-the-ai-memory-of-the-repo)
8. [Streaming — How Bytes Become Words on Screen](#8-streaming--how-bytes-become-words-on-screen)
9. [The Health Score — Quantifying What Was Qualitative](#9-the-health-score--quantifying-what-was-qualitative)
10. [Building This From Scratch — The Mental Order](#10-building-this-from-scratch--the-mental-order)
11. [What To Learn Next](#11-what-to-learn-next)

---

## 1. The Problem This Solves

Before writing a single line, ask: **what friction does this remove?**

A developer lands on a GitHub repo they've never seen. They want to know:
- Is this repo actively maintained? Will my PR rot for 6 months?
- What are the easiest issues to pick up?
- How do I set up the dev environment?
- What does this file do? (without reading 3,000 lines)

Answering these questions currently requires: opening 6 tabs, reading the README top to bottom, clicking around the Issues page, and hunting for CONTRIBUTING.md. That's 10–15 minutes of overhead per repo.

This extension collapses all of that into one panel that opens alongside the page. The insight is not "GitHub has an API" — the insight is that **the right place to surface this information is inside the browser, contextually, while the user is already looking at the repo.**

That placement constraint is what forces every architectural decision that follows.

---

## 2. The Fundamental Constraint — Isolated Worlds

Here is the single most important thing to understand about Chrome extensions:

**Every piece of code runs in a separate JavaScript sandbox. None of them share memory.**

This isn't a quirk — it's a deliberate security boundary. The browser gives extensions power (access to any tab, any URL, persistent storage), so it enforces strict isolation between the moving parts.

There are four sandboxes:

```
┌──────────────────────────────────────────────────────────────┐
│                      Chrome Browser                          │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐  │
│  │ background.js│   │  content.js  │   │  sidepanel.js   │  │
│  │              │   │              │   │                 │  │
│  │ Service      │   │ Runs inside  │   │ Runs in the     │  │
│  │ worker.      │   │ the GitHub   │   │ side panel      │  │
│  │ No DOM.      │   │ tab. Can see │   │ window. Full    │  │
│  │ Wakes on     │   │ the page.    │   │ DOM. Full       │  │
│  │ events.      │   │              │   │ chrome.* APIs.  │  │
│  └──────────────┘   └──────────────┘   └─────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              chrome.storage.local                       │ │
│  │  The only shared memory. A persistent key-value store.  │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

This forces a question you'd never ask in a normal web app: **"Where does this piece of information live?"**

A variable you declare in `sidepanel.js` is completely invisible to `content.js`, and vice versa. The only way to share data between them is:
1. `chrome.runtime.sendMessage` — fire a one-time message
2. `chrome.storage.local` — write to the shared key-value store, read from the other side
3. `chrome.tabs.onUpdated` — listen for tab events (URL changes)

In our codebase, `background.js` is tiny because its only job is to tell Chrome "open the panel when the icon is clicked":

```javascript
// background.js — the entire file
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));
```

That's it. One line of real logic. Everything else happens in `sidepanel.js`.

`content.js` is also tiny — its only job is to be inside the GitHub tab (so it can access the URL) and broadcast that URL:

```javascript
// content.js — sending repo info to the side panel
chrome.runtime.sendMessage({
  type: "REPO_INFO",
  data: getRepoInfo()
});
```

All the real complexity lives in `sidepanel.js` because the side panel is where the user interacts. It has access to both the DOM (to render things) and the Chrome APIs (to talk to storage, tabs, etc.).

**The design lesson:** When building a multi-context system (microservices, distributed systems, multi-process apps), the first question is always "what are the boundaries?" Each boundary is a place where you *cannot* share a variable — so you need a protocol for communication instead.

---

## 3. How the Pieces Talk to Each Other

The side panel needs to know when the user navigates to a different repo. It can't watch the URL directly — it's not running inside the GitHub tab. So it listens for tab update events:

```javascript
// sidepanel.js — listening for URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.includes("github.com")) {
    handleRepoRefresh(changeInfo.url);
  }
});
```

`handleRepoRefresh` parses the URL, extracts owner and repo name, checks if it's actually a repo page (not `/explore` or `/login`), and fires off all the data fetches:

```javascript
// sidepanel.js
function handleRepoRefresh(url) {
  const pathParts = urlObj.pathname.split("/").filter(p => p);
  const nonRepoPaths = ["explore", "trending", "marketplace", "login", "settings", ...];
  if (pathParts.length < 2 || nonRepoPaths.includes(pathParts[0])) {
    showNotRepoMessage();
    return;
  }
  currentRepo = { owner: pathParts[0], repo: pathParts[1] };
  updateRepoInfo();
}
```

Notice that `currentRepo` is a plain JavaScript object in global scope — this is fine because the side panel is a single page. It doesn't need to be in `chrome.storage` because it only needs to survive as long as the panel is open.

---

## 4. Three Tiers of State

This is the data architecture. Every piece of data in the extension lives in exactly one of three places:

### Tier 1 — `chrome.storage.local` (persists forever)

User settings that should survive browser restarts: which AI provider to use, the API key, the GitHub token, chat history per repo.

```javascript
// sidepanel.js — loading settings on startup
const stored = await chrome.storage.local.get(["githubToken", "aiProvider", "aiApiKey", "ollamaModel"]);
githubToken = stored.githubToken || "";
aiProvider  = stored.aiProvider  || "groq";
aiApiKey    = stored.aiApiKey    || "";
```

```javascript
// sidepanel.js — saving chat history
async function saveChatHistory() {
  const key = `chat_${currentRepo.owner}_${currentRepo.repo}`;
  const trimmed = chatMessages.slice(-50); // cap at 50 to avoid storage bloat
  await chrome.storage.local.set({ [key]: trimmed });
}
```

The chat history key is namespaced by repo (`chat_owner_repo`) so visiting different repos keeps their histories separate.

### Tier 2 — `repoCache` (lives for the session, resets on panel close)

API responses from GitHub. Fetching the same data twice wastes API quota (only 60 requests/hour without a token). So after the first fetch, results go into an in-memory object:

```javascript
// sidepanel.js — the session cache
const repoCache = {};  // plain JS object, lives in this tab's memory

// Structure after a full fetch:
repoCache["facebook/react"] = {
  repoData:     { stars: 230000, forks: 47000, ... },
  issues:       [ { title: "...", number: 12345, ... }, ... ],
  languages:    { JavaScript: 4200000, TypeScript: 890000 },
  contributors: [ { login: "gaearon", contributions: 1840 }, ... ],
  health:       { hasContributing: true, avgMergeDays: 3, ... },
  context:      "=== README ===\n React lets you...",  // RAG context string
};
```

Subsequent tab switches just read from the cache — no network call. This is why switching between Issues/Stack/Maintainers tabs is instant.

### Tier 3 — DOM (ephemeral, immediate)

Anything that only affects the UI for this render. `chatMessages` is the in-memory array that mirrors what's on screen:

```javascript
let chatMessages = []; // [{role:"user"|"bot", text:"..."}]
```

When the user sends a message, it goes into `chatMessages`, gets rendered to the DOM, and then gets saved to `chrome.storage`. When the panel reloads, `loadChatHistory()` reads from storage and re-renders the DOM.

**The pattern:** write to storage for persistence, write to in-memory for speed, write to DOM for display. These are three separate concerns that happen to be triggered by the same action.

---

## 5. The GitHub API Layer

GitHub exposes a REST API at `api.github.com`. Every fetch in this extension goes through one helper:

```javascript
// sidepanel.js — the GitHub fetch wrapper
async function fetchGitHub(endpoint, rawResponse = false) {
  const headers = { "Accept": "application/vnd.github+json" };
  if (githubToken) headers["Authorization"] = `Bearer ${githubToken}`;

  const url = endpoint.startsWith("http")
    ? endpoint
    : `https://api.github.com/repos/${currentRepo.owner}/${currentRepo.repo}${endpoint}`;

  const response = await fetch(url, { headers });

  // Every response carries rate limit info — track it
  const remaining = response.headers.get("X-RateLimit-Remaining");
  if (remaining !== null) updateRateLimitBadge(remaining, limit);

  if (!response.ok) throw new Error(`GitHub API ${response.status}: ...`);
  return response.json();
}
```

This one function handles three things:
1. **Auth** — adds the token header if available, which raises the limit from 60 to 5,000 requests/hour
2. **URL construction** — so callers can write `/issues` instead of the full URL
3. **Rate limit tracking** — every response tells you how many calls are left; we surface that in the UI

All the parallel fetches for a repo fire at the same time using a technique called fan-out:

```javascript
// sidepanel.js — firing all fetches in parallel, not in sequence
async function updateRepoInfo() {
  fetchRepoData();      // GET /repos/{owner}/{repo}
  fetchIssues();        // GET /repos/{owner}/{repo}/issues
  fetchTechStack();     // GET /repos/{owner}/{repo}/languages
  fetchMaintainers();   // GET /repos/{owner}/{repo}/contributors
  fetchContributeTab(); // GET /repos/{owner}/{repo}/pulls + health checks
}
```

These five functions run concurrently. If you ran them in sequence (await each one), the total time would be 5× a single request. Running them in parallel means the total time is the slowest one — typically the same as one request.

For the health card, we use `Promise.allSettled` specifically because **we want results even when some files don't exist**:

```javascript
// sidepanel.js — checking for CONTRIBUTING.md, issue templates, PR data all at once
const [contribResult, templateResult, openPRsResult, closedPRsResult] = await Promise.allSettled([
  fetchGitHub("/contents/CONTRIBUTING.md", true).then(r => r.status === 200),
  fetchGitHub("/contents/.github/ISSUE_TEMPLATE", true).then(r => r.status === 200),
  fetchGitHub("/pulls?state=open&per_page=1", true).then(...),
  fetchGitHub("/pulls?state=closed&sort=updated&per_page=10").then(...)
]);
```

`Promise.all` would throw if any one of those 404s. `Promise.allSettled` collects all results regardless of success or failure — then we check each `.status`. A 404 on CONTRIBUTING.md just means `hasContributing = false`.

---

## 6. The AI Abstraction — One Router, Five Implementations

Five AI providers. Each has a different URL, different auth scheme, different request shape, different response shape. The naive approach: write `if groq ... else if gemini ...` everywhere a chat response is needed. That's a maintenance nightmare — change the model, and you touch five places.

The solution is a **routing pattern**: a single public function that all callers use, which internally dispatches to the correct implementation:

```javascript
// sidepanel.js — the non-streaming router
async function callAI(contents) {
  if (aiProvider === "groq")      return callGroq(contents);
  if (aiProvider === "ollama")    return callOllama(contents);
  if (aiProvider === "openai")    return callOpenAI(contents);
  if (aiProvider === "anthropic") return callAnthropic(contents);
  return callGemini(contents);  // default
}

// sidepanel.js — the streaming router (same shape)
async function callAIStreaming(contents, onChunk) {
  if (aiProvider === "groq")      return callGroqStreaming(contents, onChunk);
  if (aiProvider === "ollama")    return callOllamaStreaming(contents, onChunk);
  if (aiProvider === "openai")    return callOpenAIStreaming(contents, onChunk);
  if (aiProvider === "anthropic") return callAnthropicStreaming(contents, onChunk);
  return callGeminiStreaming(contents, onChunk);
}
```

`handleChat` only ever calls `callAIStreaming`. It has no idea which provider is active. When the user switches from Groq to Anthropic in settings, `aiProvider` changes — `handleChat` doesn't change at all. This is the **Open/Closed Principle** in practice: adding a sixth provider means adding one branch here and one implementation function. Nothing else changes.

### The Format Conversion Problem

Every provider expects a slightly different message format. Internally we store chat history in Gemini's format (role + parts array). Three providers — Groq, OpenAI, Anthropic — expect a different structure. Rather than converting in every implementation, one helper handles it:

```javascript
// sidepanel.js — Gemini format → OpenAI format
function geminiToOpenAI(contents) {
  return contents.map(c => ({
    role: c.role === "model" ? "assistant" : c.role,  // Gemini says "model", OpenAI says "assistant"
    content: c.parts.map(p => p.text).join("")         // flatten the parts array into a string
  }));
}
```

Gemini format:
```json
{ "role": "model", "parts": [{ "text": "Hello" }] }
```

OpenAI format:
```json
{ "role": "assistant", "content": "Hello" }
```

All three providers that use OpenAI format just call `geminiToOpenAI(contents)` before making their request. Anthropic needs two extra headers for browser-side access:

```javascript
// sidepanel.js — Anthropic requires these headers to allow direct browser calls
headers: {
  "x-api-key": aiApiKey,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true"  // tells Anthropic this is intentional
}
```

---

## 7. RAG — How We Give the AI Memory of the Repo

**RAG (Retrieval-Augmented Generation)** is the technique of answering questions by first *retrieving* relevant documents, then *augmenting* the AI's prompt with those documents before asking it to *generate* an answer.

Without RAG, you ask an AI "how do I contribute to this repo?" and it hallucinates a generic answer. With RAG, you first fetch the actual CONTRIBUTING.md, package.json, and README, then say "here are the real files — now answer the question." The AI can only fabricate things it doesn't have context for.

Our implementation is the simplest possible version of RAG — no embeddings, no vector database, just stuffing relevant files directly into the prompt:

```javascript
// sidepanel.js — fetching context files in parallel
async function getDeepRepoContext() {
  const fileTargets = [
    { endpoint: "/readme",                   label: "README",          limit: 3000 },
    { endpoint: "/contents/CONTRIBUTING.md", label: "CONTRIBUTING.md", limit: 1500 },
    { endpoint: "/contents/package.json",    label: "package.json",    limit: 1500 },
    { endpoint: "/contents/requirements.txt",label: "requirements.txt",limit: 1500 },
    // ... Cargo.toml, Makefile, pyproject.toml
  ];

  const results = await Promise.allSettled(
    fileTargets.map(f =>
      fetchGitHub(f.endpoint)
        .then(d => atob(d.content.replace(/\n/g, "")))  // GitHub returns files as base64
        .then(text => ({ label: f.label, text }))
    )
  );
  // ...
}
```

The context string that gets assembled looks like:

```
=== README ===
This project is a React component library...

=== package.json ===
{
  "scripts": { "test": "jest", "build": "rollup -c" },
  "dependencies": { "react": "^18.0.0" }
}

=== Root Files ===
README.md, package.json, rollup.config.js, jest.config.js, .eslintrc
```

Then before sending to the AI:

```javascript
// sidepanel.js — injecting context into the prompt
const systemText = `You are an expert on the GitHub repository "${owner}/${repo}".
Answer questions based on this context:\n\n${context}\n\nUser question: `;

history.push({ role: "user", parts: [{ text: systemText + query }] });
```

**Why this works:** Language models have a "context window" — a maximum amount of text they can process at once. Modern models (Gemini Flash, GPT-4o-mini, Claude Haiku) have context windows of 128k–200k tokens. A typical repo's README + config files fits easily within that. So we can give the model the literal source files rather than a summarized version.

**Why this is not "real" RAG:** True RAG would: (1) split documents into small chunks, (2) embed each chunk into a vector (a list of numbers representing its meaning), (3) store those vectors in a database, (4) when a question comes in, embed the question and find the most similar chunks, (5) inject only those chunks. This handles huge codebases that don't fit in a context window. Our approach just gets all relevant small files — good enough for this use case, dramatically simpler to implement.

**The caching insight:** Context fetching is expensive (7 API calls to GitHub). Once fetched, the context is stored in the session cache:

```javascript
repoCache[cacheKey].context = context;
```

Every subsequent chat message in the same session reads from this cache. The cost is paid once per repo, not once per message.

---

## 8. Streaming — How Bytes Become Words on Screen

When you send a message to an AI without streaming, the sequence is:

```
You send request → AI thinks for 5 seconds → You get full response → Screen updates once
```

With streaming:

```
You send request → AI starts generating → Each token arrives → Screen updates token by token
```

Streaming feels dramatically faster even when it isn't — because the user sees progress immediately instead of staring at a spinner. This is the same reason progress bars feel better than spinners.

Under the hood, all five providers use a technique called **Server-Sent Events (SSE)**. The server sends a stream of lines, each starting with `data:`, separated by newlines:

```
data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" world"}}]}
data: {"choices":[{"delta":{"content":"!"}}]}
data: [DONE]
```

You read this with a `ReadableStream` — a browser API for handling data that arrives incrementally:

```javascript
// sidepanel.js — the OpenAI/Groq SSE reader
async function readOpenAISSEStream(response, onChunk) {
  const reader  = response.body.getReader();  // byte-by-byte access to the response
  const decoder = new TextDecoder();           // convert bytes → string
  let buf = "", full = "";

  while (true) {
    const { done, value } = await reader.read(); // blocks until next chunk arrives
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop(); // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return full;
      const json  = JSON.parse(raw);
      const delta = json.choices?.[0]?.delta?.content; // the new token(s)
      if (delta) { full += delta; onChunk(full); }      // call back with cumulative text
    }
  }
  return full;
}
```

Two things to notice:

1. **The buffer trick** (`buf = lines.pop()`): A network chunk doesn't always end on a newline boundary. You might receive `data: {"choices":[{"delta":{"content":"He` — half a JSON object. We keep the incomplete fragment in `buf` and append the next network chunk to it. The next iteration will have `llo"}}]}`, which combined gives a complete line.

2. **`onChunk(full)` sends the cumulative text**, not just the new token. This makes it easy for the caller to just set `element.innerHTML = renderMarkdown(partial)` — no need to track the running total themselves.

In `handleChat`, the streaming integration looks like this:

```javascript
// sidepanel.js — creating the bot bubble before streaming starts
const botBubble = document.createElement("div");
botBubble.className = "chat-msg chat-msg-bot";
let streamStarted = false;

fullReply = await callAIStreaming(history, (partial) => {
  if (!streamStarted) {
    streamStarted = true;
    typingEl.style.display = "none";   // hide "Analyzing..." when first token arrives
    chatHistEl.appendChild(botBubble); // add bubble to DOM on first token
  }
  // Update the bubble with markdown-rendered partial response + blinking cursor
  botBubble.innerHTML = renderMarkdown(partial) + '<span class="streaming-cursor"></span>';
  chatHistEl.scrollTop = chatHistEl.scrollHeight; // auto-scroll
});

botBubble.innerHTML = renderMarkdown(fullReply); // final render, cursor removed
```

The bubble is created in JavaScript memory before any tokens arrive, then appended to the DOM on the first token. This means there's no flickering — the element just appears with content already in it.

### Ollama is Different

Ollama uses NDJSON (Newline-Delimited JSON) instead of SSE. Every line is a complete JSON object:

```json
{"message":{"role":"assistant","content":"Hello"},"done":false}
{"message":{"role":"assistant","content":" world"},"done":false}
{"done":true}
```

The reading logic is the same structure, but parses differently:

```javascript
// sidepanel.js — Ollama NDJSON reader (inside callOllamaStreaming)
const evt = JSON.parse(line);
if (evt.done) return full;
const delta = evt.message?.content;
if (delta) { full += delta; onChunk(full); }
```

---

## 9. The Health Score — Quantifying What Was Qualitative

The original health card was a list of checkboxes: ✓ CONTRIBUTING.md, ✗ Issue Templates, etc. This is information, but it requires the user to synthesize it themselves. "Is this a healthy repo to contribute to?" is a question that demands a judgment call.

The health score externalizes that judgment call. Instead of presenting raw signals, we weigh them and produce a number:

```javascript
// sidepanel.js — the scoring function
function calculateHealthScore(h, repoData) {
  let score = 0;

  // Recent activity is the most important signal (30 pts)
  // A repo pushed to yesterday is almost certainly alive.
  // A repo last pushed 2 years ago might not accept your PR.
  if (h.lastPush) {
    const days = Math.floor((Date.now() - new Date(h.lastPush)) / 86_400_000);
    if (days < 7)        score += 30;
    else if (days < 30)  score += 25;
    else if (days < 90)  score += 15;
    else if (days < 180) score += 5;
  }

  if (h.hasContributing) score += 20;  // Maintainers care about contributors
  if (h.hasIssueTemplates) score += 15; // Structured onboarding

  // PR merge speed directly predicts your experience (25 pts)
  if (h.avgMergeDays !== null) {
    if (h.avgMergeDays < 3)       score += 25;
    else if (h.avgMergeDays < 7)  score += 20;
    else if (h.avgMergeDays < 14) score += 12;
    else if (h.avgMergeDays < 30) score += 5;
  }

  if (repoData?.description) score += 5;
  if (h.openIssues > 0)      score += 5; // Has things to work on

  return { score: Math.min(100, score), ... };
}
```

The weighting is a design decision, not a mathematical truth. Activity gets 30 points because an inactive repo is the most likely reason a first-time contributor gives up. PR responsiveness gets 25 because slow feedback kills motivation. CONTRIBUTING.md gets 20 because it's the clearest signal that maintainers have thought about onboarding.

This pattern — converting checklist data into a weighted score — is used everywhere: credit scores, code quality tools (ESLint's complexity metrics), package health scores (npm's "quality" rating). The principle is the same: **turn qualitative signals into a single quantitative summary to enable fast decisions.**

---

## 10. Building This From Scratch — The Mental Order

If you were to build this from nothing, here are the conceptual steps in the order they build on each other:

### Step 1: Prove the extension can run
Write `manifest.json` with the minimal permissions, a `background.js` that logs "hello", and load it at `chrome://extensions`. Get the icon to appear in the toolbar. This sounds trivial but confirms your build environment works.

### Step 2: Open a panel and read the URL
Add the `sidePanel` permission. In `background.js`, add `setPanelBehavior({ openPanelOnActionClick: true })`. Create `sidepanel.html` with a `<div id="output">`. In `sidepanel.js`, add the `chrome.tabs.onUpdated` listener and display the URL. Now the panel reacts to navigation.

### Step 3: Make one GitHub API call
Write `fetchGitHub("/")` for the current repo and display the star count. This forces you to learn: `host_permissions` in the manifest (without it, the fetch is blocked), the `Authorization` header format, and async/await in the extension context.

### Step 4: Add multiple parallel fetches + a cache
Add issues, languages, contributors. Call them all from `updateRepoInfo()` without awaiting. Add the `repoCache` object. This is the moment where you feel the difference between sequential and parallel — the panel loads 4-5x faster.

### Step 5: Add settings persistence
Add `chrome.storage.local.get` on load and `chrome.storage.local.set` on save. This teaches you the storage API and forces the question "what survives a panel close?" — the distinction between session and persistent state.

### Step 6: Add non-streaming AI
Connect to one provider (Gemini is the easiest — just a fetch with your key). Build `handleChat` with the typing indicator, append messages, save to storage. Get a reply working end-to-end before adding more providers.

### Step 7: Add the provider abstraction
Add Groq. Notice that you're duplicating chat logic. Introduce `callAI()` as the router. Add `geminiToOpenAI()`. Now add OpenAI and Anthropic — they slot in as one function each, with no changes to `handleChat`.

### Step 8: Add RAG
Write `getDeepRepoContext()`. Change the chat prompt to prepend the context. Test: ask "what does this repo do?" — the answer should now be specific to whatever repo you're looking at. Then add the session cache so context is fetched once, not on every message.

### Step 9: Add streaming
This is the hardest step to add because it changes `handleChat` fundamentally — from "wait for result, then render" to "create element, update element progressively." Add one provider's streaming first (Groq is clean SSE). Get the buffer trick right. Then add the other providers. The Ollama NDJSON format makes a good contrast exercise.

### Step 10: Iterate on UX
Add the Ollama guide card when the server isn't running. Add the health score calculation. Add the fork badge. Each of these is small, but they're what makes the tool feel like software someone actually thought about, rather than a demo.

---

## 11. What To Learn Next

The natural extensions of what this codebase demonstrates:

**If you want to understand the AI layer more deeply:**
- Replace the context stuffing with real embeddings: fetch files, chunk them into 500-token pieces, embed each chunk using the Gemini Embeddings API, store in memory as vectors, on each question embed the query and find the most similar chunks by cosine similarity. This is "real" RAG.
- Read about the tradeoffs between context window stuffing (simple, expensive per call) vs. vector retrieval (complex setup, cheaper at scale).

**If you want to understand streaming more deeply:**
- Read the Fetch API spec section on `ReadableStream` and `TransformStream`.
- Build a text tokenizer that shows you exactly how many tokens a message uses (OpenAI has a library called `tiktoken` for this).
- Look at how the Vercel AI SDK handles streaming with React state — it's the production version of what we built by hand.

**If you want to understand browser extensions more deeply:**
- Add a proper backend proxy (a small Node.js server) that holds the API keys server-side. This removes the client-side key storage problem.
- Look at how Firefox handles extensions differently (WebExtensions API — mostly compatible but with differences).
- Investigate `IndexedDB` for storing large structured data (embeddings, large RAG contexts). `chrome.storage.local` has a 10MB limit.

**If you want to understand the architecture patterns:**
- The routing pattern (`callAI` → `callGemini/callGroq/...`) is a simplified version of the **Strategy pattern** in object-oriented design. Read about it.
- The cache pattern (`repoCache`) is **memoization** at the application level. The `Promise.allSettled` fan-out is a practical implementation of concurrent request handling. These patterns appear everywhere in distributed systems.
- The health score is a simplified version of how composite metrics work in ML feature engineering — weighting raw signals into a score. Read about feature weighting and normalization.

---

*This document was written alongside the codebase. The best way to use it: read a section, then find the corresponding code in `sidepanel.js` and read it with this mental model in mind. The code will make more sense because you understand the problem it's solving.*
