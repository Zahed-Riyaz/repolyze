# GitHub Repo Analyzer & RAG Chat

A Chrome extension that gives you an AI-powered side panel for any GitHub repository — browse issues, inspect the tech stack, see top contributors, generate a contributor quickstart guide, and chat with an AI that has read the repo's key files and file tree.

---

## Table of Contents

1. [Features](#features)
2. [Chrome Extension Primer](#chrome-extension-primer)
3. [File Structure](#file-structure)
4. [Architecture](#architecture)
   - [How the Pieces Connect](#how-the-pieces-connect)
   - [Data Flow: Opening a Repo](#data-flow-opening-a-repo)
   - [Data Flow: Sending a Chat Message](#data-flow-sending-a-chat-message)
5. [AI Providers](#ai-providers)
   - [Provider Routing](#provider-routing)
   - [Message Format Conversion](#message-format-conversion)
   - [Ollama Auto-Pull](#ollama-auto-pull)
6. [Chat Retrieval](#chat-retrieval) · [Health Score](#health-score)
7. [Storage Architecture](#storage-architecture)
8. [Session Cache](#session-cache)
9. [Installation](#installation)
10. [Setup](#setup)
11. [Provider Setup Notes](#provider-setup-notes)

---

## Features

| Tab | What it does |
|---|---|
| **Issues** | Open issues with sort (most discussed / newest / recently updated) and paging. **Good first** and **Help wanted** search *every* open issue using the repo's real label names (`good-first-issue`, `E-easy`, `first-timers-only`, …) and show the total. **Unclaimed** hides assigned issues and, for label filters, ones with a linked PR — and says so when that hides everything. |
| **Start this issue** | Every issue card opens a brief: **is it free?** (assignees, open/merged/closed PRs that reference it, "I'll take this" comments, whether a maintainer has replied), **what's being asked, where to start and a plan** (AI, citing the code as `path:line`), **who to ask** (CODEOWNERS for the files involved + maintainers in the thread) and **how to verify** (commands from the CI workflow and `package.json`). Works without an AI key too — availability, likely files, owners and commands are all deterministic. Costs 2 API requests. |
| **Stack** | Shows languages used (from GitHub's language breakdown) with percentage bars. |
| **Maintainers** | **Active maintainers**: people GitHub marks as owner / org member / collaborator who actually replied on issues or PRs in the last 90 days, ranked by threads answered, merged with `CODEOWNERS` (including code-owner teams). All-time top committers are listed below for context. |
| **Contribute** | A contributor-friendliness score built from measured signals — each shown with what it measured (see [Health Score](#health-score)) — plus open PRs and an AI-generated "Getting Started as a Contributor" guide. |
| **Chat** | Multi-turn chat that reads the repo's **actual source code** for each question and cites it as `path:line`, with links to the exact lines on GitHub (see [Chat Retrieval](#chat-retrieval)). |
| **Settings** (gear icon in the header) | Switch AI provider, enter/rotate API keys, configure Ollama model, and set a GitHub token — all without leaving the panel. |

The UI follows your system's light/dark setting, shows skeleton placeholders while data loads, and keeps the chat input pinned while the conversation scrolls.

---

## Chrome Extension Primer

If you have never built a Chrome extension, here is the minimum context to understand this codebase.

A Manifest V3 extension is a collection of plain web pages and scripts that Chrome loads with elevated permissions. This extension uses three execution contexts:

| Context | File | Lifetime | Access |
|---|---|---|---|
| **Service worker** | `background.js` | Event-driven; wakes on demand | `chrome.*` APIs, no DOM |
| **Side panel page** | `sidepanel.html` + `sidepanel.js` | Lives as long as the panel is open | Full DOM + `chrome.*` APIs |
| **Options page** | `options.html` + `options.js` | Opens in a new tab when user visits extension settings | Full DOM + `chrome.*` APIs |

Scripts in different contexts **cannot share variables**. They communicate through the shared `chrome.storage.local` key-value store (the side panel listens to `chrome.storage.onChanged`, so settings saved on the options page apply immediately). The side panel learns which repo you are viewing from the `chrome.tabs` API — no content script is needed.

`host_permissions` in `manifest.json` is what allows the extension to make `fetch()` calls to external domains (GitHub API, Gemini, Groq, OpenAI, Anthropic, local Ollama). Without those entries, all cross-origin requests would be blocked. The only other permissions are `sidePanel`, `storage` and `tabs` (to read the active tab's URL).

---

## File Structure

```
github-repo-analyzer/
├── manifest.json       # Extension manifest: declares permissions, pages, scripts
├── background.js       # Service worker: opens side panel when toolbar icon is clicked
├── sidepanel.html      # Side panel UI markup (tabs, chat, settings)
├── sidepanel.js        # Side panel UI, GitHub API layer, AI providers, chat, settings
├── retrieval.js        # Reading the repo: file tree, raw file reads, chat code retrieval
├── insights.js         # Maintainers, health signals & scoring, beginner-issue search
├── brief.js            # "Start this issue" brief: availability, owners, verify commands, AI plan
├── test/               # Node tests (see Running Tests) — not needed by Chrome
├── package.json        # `npm test` / `npm run check` — no dependencies
├── theme.css           # Design tokens (light + dark), base styles and shared controls — used by both pages
├── styles.css          # Side panel layout and components
├── options.html        # Standalone settings page (mirrors the in-panel ⚙ tab)
└── options.js          # Logic for the standalone settings page
```

---

## Architecture 
![repolyze](https://github.com/user-attachments/assets/b671e6ec-6527-4d40-b7ed-1d94a7125159)


### How the Pieces Connect

```
┌─────────────────────────────────────────────────────────────┐
│                        Chrome Browser                        │
│                                                              │
│  ┌──────────────┐  chrome.tabs.onUpdated /       ┌────────┐ │
│  │ active tab   │  onActivated (URL changes,     │        │ │
│  │ (github.com) │  tab switches) ───────────────▶ │        │ │
│  └──────────────┘                                 │ side   │ │
│                                                   │ panel  │ │
│  ┌──────────────┐     openPanelOnActionClick       │ .js    │ │
│  │background.js │ ──────────────────────────────▶ │        │ │
│  │(service wrkr)│  toolbar icon click             │        │ │
│  └──────────────┘                                 └───┬────┘ │
│                                                       │      │
│  ┌─────────────────────────────────────────────┐     │      │
│  │           chrome.storage.local               │◀───▶│      │
│  │  aiProvider, aiApiKey, ollamaModel,          │     │      │
│  │  githubToken, chat_{owner}_{repo}            │     │      │
│  └─────────────────────────────────────────────┘     │      │
└──────────────────────────────────────────────────────┼──────┘
                                                        │
              ┌─────────────────────────────────────────┤
              │         External HTTP requests           │
              ▼                                         ▼
   ┌─────────────────┐                    ┌──────────────────────┐
   │  GitHub REST API │                   │     AI Provider       │
   │  api.github.com  │                   │  (Groq / Gemini /    │
   │                  │                   │  OpenAI / Anthropic / │
   │  • /repos        │                   │  Ollama localhost)    │
   │  • /issues       │                   └──────────────────────┘
   │  • /languages    │
   │  • /contributors │
   │  • /contents/... │
   └─────────────────┘
```

### Data Flow: Opening a Repo

```
1. User navigates to https://github.com/owner/repo
        │
        ▼
2. chrome.tabs.onUpdated / onActivated fire in sidepanel.js
   (only for the active tab in the panel's own window)
        │
        ▼
3. handleRepoRefresh(url) parses owner + repo
        │
        ▼
4. updateRepoInfo() — parallel GitHub API fetches:
   ├── GET /repos/{owner}/{repo}          → stars, forks, description, license
   ├── GET /repos/{owner}/{repo}/issues   → open unassigned issues
   ├── GET /repos/{owner}/{repo}/languages → language bytes → percentages
   └── GET /repos/{owner}/{repo}/contributors → top 10 by commit count
        │
        ▼
5. Results stored in repoCache["{owner}/{repo}"]  (in-memory, session only)
   Each request remembers which repo it was for; if you have navigated
   away by the time it returns, it fills the cache but does not render.
        │
        ▼
6. UI tabs render from cache; subsequent tab switches never re-fetch
```

### Data Flow: Sending a Chat Message

```
1. User types a message and hits Send
        │
        ▼
2. handleChat()
   ├── Appends user bubble to #chat-history
   ├── Shows typing indicator
   └── Calls getDeepRepoContext()
              │
              ▼
        Fetches (in parallel, results cached):
        README, CONTRIBUTING.md, package.json,
        requirements.txt, pyproject.toml, Cargo.toml, Makefile,
        + the recursive file tree
              │
              ▼
3. Builds conversation history (last 6 turns) in Gemini format:
   [ {role:"user", parts:[{text:"..."}]}, ... ]
        │
        ▼
4. callAIStreaming(history, onChunk)
   └── routes to the Gemini / Groq / OpenAI / Anthropic / Ollama
       streaming call based on aiProvider; tokens render as they arrive
        │
        ▼
5. Response appended as bot bubble; saved to chrome.storage.local
   under key "chat_{owner}_{repo}" (max 50 messages, oldest trimmed)
```

---

## AI Providers

Five providers are supported. All are called through a single `callAIStreaming(contents, onChunk)` router function. Model IDs live in the `MODELS` constant at the top of `sidepanel.js` — the one place to update when a provider retires a model.

### Provider Routing

```javascript
// sidepanel.js
async function callAIStreaming(contents, onChunk) {
  if (aiProvider === "groq")      return callGroqStreaming(contents, onChunk);
  if (aiProvider === "ollama")    return callOllamaStreaming(contents, onChunk);
  if (aiProvider === "openai")    return callOpenAIStreaming(contents, onChunk);
  if (aiProvider === "anthropic") return callAnthropicStreaming(contents, onChunk);
  return callGeminiStreaming(contents, onChunk);   // default
}
```

| Provider | Endpoint | Auth | Default model | Cost |
|---|---|---|---|---|
| **Groq** | `api.groq.com/openai/v1/chat/completions` | `Authorization: Bearer {key}` | `llama-3.3-70b-versatile` | Free tier (14,400 req/day) |
| **Gemini** | `generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash` | `x-goog-api-key` header | `gemini-2.5-flash` | Free tier |
| **OpenAI** | `api.openai.com/v1/chat/completions` | `Authorization: Bearer {key}` | `gpt-4o-mini` | Pay-as-you-go |
| **Anthropic** | `api.anthropic.com/v1/messages` | `x-api-key: {key}` | `claude-haiku-4-5-20251001` | Pay-as-you-go |
| **Ollama** | `localhost:11434/api/chat` | None (local) | Configurable (default: `llama3.2`) | Free |

### Message Format Conversion

Internally, all message history is stored in **Gemini format**:

```javascript
[
  { role: "user",  parts: [{ text: "..." }] },
  { role: "model", parts: [{ text: "..." }] },
]
```

Groq, OpenAI, and Anthropic expect **OpenAI format**:

```javascript
[
  { role: "user",      content: "..." },
  { role: "assistant", content: "..." },
]
```

The `geminiToOpenAI(contents)` helper converts between the two. The Anthropic call also uses this converter since the Anthropic Messages API accepts the same role schema.

Anthropic requires two extra headers for browser-side requests:
```
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true
```

### Ollama Auto-Pull

Ollama is the only provider that runs locally and requires manual setup. The extension handles the common failure modes:

**Setup guide** — if Ollama is not running (or is blocking the extension's origin), the chat shows a card with copy-paste commands for macOS/Linux and Windows, and puts your message back in the input box so you can resend once Ollama is up.

**Auto-pull** — if Ollama is running but the requested model is not downloaded (HTTP 404 from `/api/chat`), the extension streams `POST /api/pull` and shows download progress in the typing indicator (e.g. *"Downloading llama3.2… 47%"*). Once complete, the original chat request is retried.

---

## Chat Retrieval

Each question is answered from the repo's real code, not just its README. Everything runs in the browser (`retrieval.js`):

1. **Shortlist** — every source file in the tree is ranked against the question by path. Identifiers are understood (`handleRepoRefresh` → `handle`, `repo`, `refresh`); tests, vendored code, lockfiles and huge files are demoted or skipped.
2. **Pick** — the AI is shown the top 250 paths and chooses up to 5 to read (or none, for "what is this project?"-type questions). If that fails, the best path matches are used.
3. **Read** — files come from `raw.githubusercontent.com`, which **doesn't count against the GitHub API limit**. Small files are read whole; for big ones the file head plus the line windows that best match the question are kept.
4. **Pack** — code excerpts (with line numbers), README, file tree, CONTRIBUTING, build configs and a CI workflow are packed in priority order into a per-provider budget (smaller for Groq's free tier and local Ollama models).

Answers cite code as `path:line`; citations to files that were actually read become links to those lines on GitHub, and a **Read N files** row under each answer links every excerpt. The model is told to say so — not guess — when the answer isn't in what it read.

The repo-wide context (README, CONTRIBUTING wherever it lives, `package.json` / `pyproject.toml` / `go.mod` / …, a CI workflow, the file tree) is found through the tree, so nothing is probed with 404s. A whole chat costs **one** API request (the tree), shared with the Stack and Maintainers tabs.

## Health Score

The Contribute tab scores contributor-friendliness from 0–100 using signals measured from GitHub (`insights.js`):

| Signal | Weight | What's measured |
|---|---|---|
| Maintainer response | 30 | For issues/PRs opened by non-maintainers (older than 2 days, bots excluded): share that got a maintainer reply or were closed, and the median time to that first response |
| Merges outside PRs | 25 | Of recently closed PRs from people without maintainer access: how many were merged, and what share of all merges they make up |
| Merge speed | 15 | Median time from open to merge for recent PRs |
| Recent activity | 15 | Days since the last push (archived repos are capped at 20 overall) |
| Onboarding | 15 | CONTRIBUTING, unclaimed beginner issues, issue templates, PR template, code of conduct |

Response and merges carry the most weight because a timely reply and a realistic chance of getting merged are what most decide whether a first-time contributor sticks around. A signal without enough data (e.g. fewer than 5 recent issues) is shown as **n/a** and left *out* of the score rather than counted as zero, and the card says how many of the five signals were measured. Every row shows the numbers behind its points.

## Storage Architecture

`chrome.storage.local` is a persistent key-value store shared across all extension pages. This extension uses it for two purposes:

### Settings (written by both options.js and sidepanel.js)

| Key | Type | Description |
|---|---|---|
| `aiProvider` | `string` | `"groq"` \| `"gemini"` \| `"ollama"` \| `"openai"` \| `"anthropic"` |
| `aiApiKey` | `string` | API key for the selected cloud provider |
| `ollamaModel` | `string` | Ollama model name, e.g. `"llama3.2"` |
| `githubToken` | `string` | GitHub personal access token (optional) |

### Chat History (written by sidepanel.js)

| Key pattern | Type | Description |
|---|---|---|
| `chat_{owner}_{repo}` | `array` | Array of `{role, text}` objects, capped at 50 messages |

---

## Session Cache

`repoCache` is a plain JavaScript object in `sidepanel.js`. It is **not** persisted — it clears whenever the side panel is closed or reloaded. This is intentional: repo data changes frequently and should be fresh each session.

```javascript
repoCache["owner/repo"] = {
  repoData:     { ... },  // stars, forks, description
  issues:       [ ... ],  // open issues list
  languages:    { ... },  // language byte counts
  contributors: [ ... ],  // top contributors
  health:       { ... },  // README/CONTRIBUTING/license checks
  prs:          [ ... ],  // recent open PRs
  quickstart:   "...",    // AI-generated quickstart guide text
  context:      "...",    // concatenated files + file tree sent with chat
}
```

---

## GitHub Rate Limits

Without a token GitHub allows **60 API requests an hour per IP address**, shared by everything on your network. The extension is built to fit inside that:

- **Tabs load lazily** — opening a repo costs 2 requests (metadata + issues); other tabs fetch the first time you open them. Visiting every tab costs about 12, and chat adds none: file contents come from `raw.githubusercontent.com`, which isn't rate-limited like the API.
- **Search has its own quota** (10/minute anonymously) and is tracked separately, so running out of searches never blocks other requests; label filters retry by themselves when it resets.
- **Responses are cached for the browser session** in `chrome.storage.session` (404s included), so closing and reopening the panel costs nothing. After 10 minutes entries are revalidated with `If-None-Match`; GitHub doesn't count `304 Not Modified` replies.
- **The real quota is read from `/rate_limit`**, which is free, and shown in the header badge.
- **When the quota runs out**, requests stop until the reset time. A banner shows when it resumes, and its **Get token** button opens [github.com/settings/tokens](https://github.com/settings/tokens) in a new tab while the panel jumps to the token field, ready to paste, tabs show "Paused until …" rather than an error, and everything reloads automatically once the window resets.

A token (no scopes needed for public repos) raises the limit to 5,000/hour. It's checked against GitHub before it's saved.

---

## Running Tests

```bash
npm test          # 91 unit + flow tests, ~3s, no dependencies (Node 22+)
npm run check     # syntax-check every script
```

The tests use Node's built-in runner. `test/helpers/panel.js` loads the real `retrieval.js`, `insights.js`, `brief.js` and `sidepanel.js` — in the same order as `sidepanel.html` — with in-memory stand-ins for the DOM, `chrome.*` and `fetch`; `test/helpers/github-mock.js` is a fake GitHub (API routes, raw files, AI replies) that records every request. So the suites exercise the actual extension code:

| File | Covers |
|---|---|
| `rendering.test.js` | Markdown (escaping, safe links, code blocks, lists), citation links, UTF-8 decoding, label matching |
| `github-api.test.js` | Response cache, ETag revalidation, session persistence, primary / secondary / search rate limits, bad tokens, token scoping, PR sort order |
| `retrieval.test.js` | File ranking, file picking, snippets, context budgets, chat context end-to-end, private repos |
| `insights.test.js` | Maintainer detection, CODEOWNERS, response times, PR stats, health scoring |
| `brief.test.js` | Code-owner matching, claim detection, availability verdicts, CI/package.json commands, the brief end-to-end (with and without AI), caching, stale-repo guards |
| `panel-flows.test.js` | API request budgets, lazy tabs and retries, token recovery, stale-response guards, issue search, rendering, chat saving, token validation |

GitHub Actions runs both commands on every push and pull request (`.github/workflows/test.yml`). When packaging for the Chrome Web Store, leave out `test/`, `package.json` and `.github/`.

---

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `github-repo-analyzer` folder.
5. The extension icon appears in your toolbar. Pin it for easy access.

> **No build step required.** This is plain HTML, CSS, and JavaScript — no bundler or transpiler.

---

## Setup

1. Navigate to any GitHub repository page (e.g. `https://github.com/owner/repo`).
2. Click the extension icon — the side panel opens on the right.
3. **Settings** (the gear icon, top right) opens automatically on first launch.
4. Choose an AI provider, enter your key, and click **Save**.
5. Optionally add a **GitHub Token** (no scopes needed) to raise the API rate limit from 60 to 5,000 requests/hour — recommended if you browse many repos.

---

## Provider Setup Notes

### Groq (recommended for getting started)
- Free account at [console.groq.com](https://console.groq.com/keys)
- 14,400 requests/day on the free tier
- Uses Llama 3.3 70B — fast and capable

### Gemini
- Free key at [aistudio.google.com](https://aistudio.google.com/app/apikey)
- Generous free tier; uses Gemini 2.5 Flash

### OpenAI
- Key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Pay-as-you-go; GPT-4o mini is very affordable

### Anthropic
- Key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- Pay-as-you-go; uses Claude Haiku 4.5, Anthropic's fastest/cheapest model

### Ollama (local, fully private)
1. Install from [ollama.com](https://ollama.com)
2. Start the server **with the Chrome extension origin allowed**:
   ```bash
   OLLAMA_ORIGINS='*' ollama serve
   ```
   > Without `OLLAMA_ORIGINS='*'`, Ollama will return HTTP 403 for requests from the extension because Chrome extensions send an `Origin: chrome-extension://...` header that Ollama blocks by default.
3. To make this permanent on macOS:
   ```bash
   launchctl setenv OLLAMA_ORIGINS "*"
   ```
   Then restart Ollama.
4. The model (`llama3.2` by default) is downloaded automatically the first time you send a message. Download progress is shown live in the typing indicator.
