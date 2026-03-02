# GitHub Repo Analyzer & RAG Chat

A Chrome extension that gives you an AI-powered side panel for any GitHub repository — browse issues, inspect the tech stack, see top contributors, generate a contributor quickstart guide, and chat with the repo using retrieval-augmented generation (RAG).

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
   - [Ollama Auto-Pull & Auto-Wait](#ollama-auto-pull--auto-wait)
6. [RAG (Retrieval-Augmented Generation)](#rag-retrieval-augmented-generation)
7. [Storage Architecture](#storage-architecture)
8. [Session Cache](#session-cache)
9. [Installation](#installation)
10. [Setup](#setup)
11. [Provider Setup Notes](#provider-setup-notes)

---

## Features

| Tab | What it does |
|---|---|
| **Issues** | Lists open, unassigned issues. Filter by `good first issue` or `help wanted`. |
| **Stack** | Shows languages used (from GitHub's language breakdown) with percentage bars. |
| **Maintainers** | Top contributors by commit count with avatars. |
| **Contribute** | Repo health card (has README? CONTRIBUTING? license? recent activity?), open PRs, and an AI-generated "Getting Started as a Contributor" guide. |
| **Chat** | Multi-turn chat grounded in the repo's actual files (README, CONTRIBUTING, package.json, etc.). |
| **Settings ⚙** | Switch AI provider, enter/rotate API keys, configure Ollama model, and set a GitHub token — all without leaving the panel. |

---

## Chrome Extension Primer

If you have never built a Chrome extension, here is the minimum context to understand this codebase.

A Manifest V3 extension is a collection of plain web pages and scripts that Chrome loads with elevated permissions. There are four distinct execution contexts:

| Context | File | Lifetime | Access |
|---|---|---|---|
| **Service worker** | `background.js` | Event-driven; wakes on demand | `chrome.*` APIs, no DOM |
| **Content script** | `content.js` | Runs inside each GitHub tab | Limited DOM + `chrome.runtime` |
| **Side panel page** | `sidepanel.html` + `sidepanel.js` | Lives as long as the panel is open | Full DOM + `chrome.*` APIs |
| **Options page** | `options.html` + `options.js` | Opens in a new tab when user visits extension settings | Full DOM + `chrome.*` APIs |

Scripts in different contexts **cannot share variables**. They communicate either through `chrome.runtime.sendMessage` / `chrome.tabs.onUpdated`, or through the shared `chrome.storage.local` key-value store.

`host_permissions` in `manifest.json` is what allows the extension to make `fetch()` calls to external domains (GitHub API, Gemini, Groq, OpenAI, Anthropic, local Ollama). Without those entries, all cross-origin requests would be blocked.

---

## File Structure

```
github-repo-analyzer/
├── manifest.json       # Extension manifest: declares permissions, pages, scripts
├── background.js       # Service worker: opens side panel when toolbar icon is clicked
├── content.js          # Content script: runs on github.com, extracts owner/repo from URL
├── sidepanel.html      # Side panel UI markup (tabs, chat, settings)
├── sidepanel.js        # All side panel logic (~1000 lines) — the core of the extension
├── styles.css          # All styling for the side panel
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
│  ┌──────────────┐     chrome.tabs.onUpdated      ┌────────┐ │
│  │ content.js   │ ──────────────────────────────▶ │        │ │
│  │ (github.com) │  URL change events              │        │ │
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
2. content.js fires chrome.tabs.onUpdated with the new URL
        │
        ▼
3. sidepanel.js handleRepoRefresh(url) parses owner + repo
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
        requirements.txt, pyproject.toml, Cargo.toml, Makefile
              │
              ▼
3. Builds conversation history (last 6 turns) in Gemini format:
   [ {role:"user", parts:[{text:"..."}]}, ... ]
        │
        ▼
4. callAI(history)
   └── routes to callGemini / callGroq / callOpenAI /
       callAnthropic / callOllama based on aiProvider global
        │
        ▼
5. Response appended as bot bubble; saved to chrome.storage.local
   under key "chat_{owner}_{repo}" (max 50 messages, oldest trimmed)
```

---

## AI Providers

Five providers are supported. All are called through a single `callAI(contents)` router function.

### Provider Routing

```javascript
// sidepanel.js
async function callAI(contents) {
  if (aiProvider === "groq")      return callGroq(contents);
  if (aiProvider === "ollama")    return callOllama(contents);
  if (aiProvider === "openai")    return callOpenAI(contents);
  if (aiProvider === "anthropic") return callAnthropic(contents);
  return callGemini(contents);   // default
}
```

| Provider | Endpoint | Auth | Default model | Cost |
|---|---|---|---|---|
| **Groq** | `api.groq.com/openai/v1/chat/completions` | `Authorization: Bearer {key}` | `llama-3.3-70b-versatile` | Free tier (14,400 req/day) |
| **Gemini** | `generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash` | `?key={key}` query param | `gemini-2.0-flash` | Free tier (1,500 req/day) |
| **OpenAI** | `api.openai.com/v1/chat/completions` | `Authorization: Bearer {key}` | `gpt-4o-mini` | Pay-as-you-go |
| **Anthropic** | `api.anthropic.com/v1/messages` | `x-api-key: {key}` | `claude-3-5-haiku-20241022` | Pay-as-you-go |
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

### Ollama Auto-Pull & Auto-Wait

Ollama is the only provider that runs locally and requires manual setup. Two quality-of-life automations handle common failure modes:

**Auto-wait** — if Ollama is not running when the user sends a message, instead of showing an error, the extension polls `GET /api/tags` every 2 seconds and shows *"Waiting for Ollama… run `ollama serve` in your terminal"* in the typing indicator. The Send button becomes a Cancel button. When Ollama comes online the pending request continues automatically.

**Auto-pull** — if Ollama is running but the requested model is not downloaded (HTTP 404 from `/api/chat`), the extension streams `POST /api/pull` and shows download progress in the typing indicator (e.g. *"Downloading llama3.2… 47%"*). Once complete, the original chat request is retried.

---

## RAG (Retrieval-Augmented Generation)

RAG means augmenting the AI's prompt with content retrieved from an external source — here, the repository itself.

`getDeepRepoContext()` fetches up to seven files via the GitHub Contents API:

| File | Max chars included | Why |
|---|---|---|
| `README` | 3,000 | Project overview, purpose, usage |
| `CONTRIBUTING.md` | 1,500 | Contribution workflow |
| `package.json` | 1,500 | JS/Node dependencies and scripts |
| `requirements.txt` | 1,500 | Python dependencies |
| `pyproject.toml` | 1,500 | Modern Python project config |
| `Cargo.toml` | 1,500 | Rust dependencies |
| `Makefile` | 1,500 | Build commands |

All fetches run in parallel with `Promise.allSettled` so missing files (404) are silently skipped. The combined text is prepended to every chat message as a system prompt:

```
You are an expert on the GitHub repository "{owner}/{repo}".
Answer questions based on this context:

=== README ===
...
=== package.json ===
...

User question: {query}
```

The context is cached in `repoCache` for the session so it is only fetched once per repo.

---

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
  context:      "...",    // concatenated RAG context string
}
```

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
3. The **⚙ Settings tab** opens automatically on first launch.
4. Choose an AI provider, enter your key, and click **Save**.
5. Optionally add a **GitHub Token** to raise the API rate limit from 60 to 5,000 requests/hour.

---

## Provider Setup Notes

### Groq (recommended for getting started)
- Free account at [console.groq.com](https://console.groq.com/keys)
- 14,400 requests/day on the free tier
- Uses Llama 3.3 70B — fast and capable

### Gemini
- Free key at [aistudio.google.com](https://aistudio.google.com/app/apikey)
- 1,500 requests/day, 15 requests/minute on the free tier

### OpenAI
- Key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Pay-as-you-go; GPT-4o mini is very affordable

### Anthropic
- Key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
- Pay-as-you-go; Claude 3.5 Haiku is the fastest/cheapest option

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
