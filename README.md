![repolyze](https://github.com/user-attachments/assets/b671e6ec-6527-4d40-b7ed-1d94a7125159)# GitHub Repo Analyzer & RAG Chat

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

## Architecture ![<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="919pt" height="344pt" viewBox="0.00 0.00 919.00 344.00">
<g id="graph0" class="graph" transform="scale(1 1) rotate(0) translate(4 339.65)">
<title>CleanArch</title>
<polygon fill="white" stroke="none" points="-4,4 -4,-339.65 914.54,-339.65 914.54,4 -4,4"/>
<g id="clust1" class="cluster">
<title>cluster_ui</title>
<polygon fill="none" stroke="black" stroke-width="0" points="187,-268.45 187,-327.65 491,-327.65 491,-268.45 187,-268.45"/>
</g>
<g id="clust2" class="cluster">
<title>cluster_logic</title>
<polygon fill="#f5f5f5" stroke="#bdbdbd" stroke-dasharray="5,2" points="8,-8 8,-228.65 443,-228.65 443,-8 8,-8"/>
<text xml:space="preserve" text-anchor="middle" x="225.5" y="-212.05" font-family="Times,serif" font-size="14.00" fill="#757575">CORE LOGIC ABSTRACTIONS</text>
</g>
<g id="clust4" class="cluster">
<title>cluster_cloud</title>
</g>
<!-- UI -->
<g id="node1" class="node">
<title>UI</title>
<path fill="#2979ff" stroke="black" stroke-width="0" d="M471,-319.65C471,-319.65 207,-319.65 207,-319.65 201,-319.65 195,-313.65 195,-307.65 195,-307.65 195,-288.45 195,-288.45 195,-282.45 201,-276.45 207,-276.45 207,-276.45 471,-276.45 471,-276.45 477,-276.45 483,-282.45 483,-288.45 483,-288.45 483,-307.65 483,-307.65 483,-313.65 477,-319.65 471,-319.65"/>
<text xml:space="preserve" text-anchor="middle" x="339" y="-301.35" font-family="Arial" font-size="11.00" fill="white">User Interface (DOM)</text>
<text xml:space="preserve" text-anchor="middle" x="339" y="-288.15" font-family="Arial" font-size="11.00" fill="white">(Tabs, Chat Window, Settings)</text>
</g>
<!-- StatsEngine -->
<g id="node2" class="node">
<title>StatsEngine</title>
<path fill="white" stroke="#2979ff" stroke-width="2" d="M173.88,-195.85C173.88,-195.85 28.12,-195.85 28.12,-195.85 22.12,-195.85 16.12,-189.85 16.12,-183.85 16.12,-183.85 16.12,-164.65 16.12,-164.65 16.12,-158.65 22.12,-152.65 28.12,-152.65 28.12,-152.65 173.88,-152.65 173.88,-152.65 179.88,-152.65 185.88,-158.65 185.88,-164.65 185.88,-164.65 185.88,-183.85 185.88,-183.85 185.88,-189.85 179.88,-195.85 173.88,-195.85"/>
<text xml:space="preserve" text-anchor="middle" x="101" y="-177.55" font-family="Arial" font-size="11.00">Repo Analyzer Engine</text>
<text xml:space="preserve" text-anchor="middle" x="101" y="-164.35" font-family="Arial" font-size="11.00">(Parallel Fetcher + Health Calc)</text>
</g>
<!-- UI&#45;&gt;StatsEngine -->
<g id="edge1" class="edge">
<title>UI-&gt;StatsEngine</title>
<path fill="none" stroke="#555555" stroke-width="1.2" d="M208.96,-276.58C208.96,-242.79 208.96,-181 208.96,-181 208.96,-181 198.67,-181 198.67,-181"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="198.67,-177.5 188.67,-181 198.67,-184.5 198.67,-177.5"/>
<text xml:space="preserve" text-anchor="middle" x="188.27" y="-239.35" font-family="Arial" font-size="9.00"> User opens Repo</text>
</g>
<!-- AIEngine -->
<g id="node3" class="node">
<title>AIEngine</title>
<path fill="white" stroke="#00c853" stroke-width="2" d="M422.58,-195.85C422.58,-195.85 255.42,-195.85 255.42,-195.85 249.42,-195.85 243.42,-189.85 243.42,-183.85 243.42,-183.85 243.42,-164.65 243.42,-164.65 243.42,-158.65 249.42,-152.65 255.42,-152.65 255.42,-152.65 422.58,-152.65 422.58,-152.65 428.58,-152.65 434.58,-158.65 434.58,-164.65 434.58,-164.65 434.58,-183.85 434.58,-183.85 434.58,-189.85 428.58,-195.85 422.58,-195.85"/>
<text xml:space="preserve" text-anchor="middle" x="339" y="-177.55" font-family="Arial" font-size="11.00">AI &amp; RAG Router</text>
<text xml:space="preserve" text-anchor="middle" x="339" y="-164.35" font-family="Arial" font-size="11.00">(Context Builder + Stream Decoder)</text>
</g>
<!-- UI&#45;&gt;AIEngine -->
<g id="edge2" class="edge">
<title>UI-&gt;AIEngine</title>
<path fill="none" stroke="#555555" stroke-width="1.2" d="M339,-276.49C339,-276.49 339,-208.64 339,-208.64"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="342.5,-208.64 339,-198.64 335.5,-208.64 342.5,-208.64"/>
<text xml:space="preserve" text-anchor="middle" x="382.52" y="-239.35" font-family="Arial" font-size="9.00"> User sends Message</text>
</g>
<!-- SessionCache -->
<g id="node4" class="node">
<title>SessionCache</title>
<polygon fill="#fff9c4" stroke="black" stroke-width="0" points="166.94,-61.25 23.06,-61.25 23.06,-18.05 172.94,-18.05 172.94,-55.25 166.94,-61.25"/>
<polyline fill="none" stroke="black" stroke-width="0" points="166.94,-61.25 166.94,-55.25"/>
<polyline fill="none" stroke="black" stroke-width="0" points="172.94,-55.25 166.94,-55.25"/>
<text xml:space="preserve" text-anchor="middle" x="98" y="-42.95" font-family="Arial" font-size="11.00">Session Cache (RAM)</text>
<text xml:space="preserve" text-anchor="middle" x="98" y="-29.75" font-family="Arial" font-size="11.00">(Repo Data / RAG Context)</text>
</g>
<!-- StatsEngine&#45;&gt;SessionCache -->
<g id="edge3" class="edge">
<title>StatsEngine-&gt;SessionCache</title>
<path fill="none" stroke="#555555" stroke-width="1.2" stroke-dasharray="1,5" d="M98,-139.9C98,-139.9 98,-72.73 98,-72.73"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="94.5,-139.9 98,-149.9 101.5,-139.9 94.5,-139.9"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="101.5,-72.73 98,-62.73 94.5,-72.73 101.5,-72.73"/>
<text xml:space="preserve" text-anchor="middle" x="97.76" y="-115.55" font-family="Arial" font-size="9.00"> Read/Write</text>
<text xml:space="preserve" text-anchor="middle" x="97.76" y="-104.75" font-family="Arial" font-size="9.00">Data</text>
</g>
<!-- GitHub -->
<g id="node6" class="node">
<title>GitHub</title>
<path fill="#24292e" stroke="black" stroke-width="0" d="M605,-61.25C605,-61.25 485,-61.25 485,-61.25 479,-61.25 473,-55.25 473,-49.25 473,-49.25 473,-30.05 473,-30.05 473,-24.05 479,-18.05 485,-18.05 485,-18.05 605,-18.05 605,-18.05 611,-18.05 617,-24.05 617,-30.05 617,-30.05 617,-49.25 617,-49.25 617,-55.25 611,-61.25 605,-61.25"/>
<text xml:space="preserve" text-anchor="middle" x="545" y="-42.95" font-family="Arial" font-size="11.00" fill="white">GitHub API</text>
<text xml:space="preserve" text-anchor="middle" x="545" y="-29.75" font-family="Arial" font-size="11.00" fill="white">(Data Source)</text>
</g>
<!-- StatsEngine&#45;&gt;GitHub -->
<g id="edge6" class="edge">
<title>StatsEngine-&gt;GitHub</title>
<path fill="none" stroke="#555555" stroke-width="1.2" d="M179.41,-151.82C179.41,-132.6 179.41,-108 179.41,-108 179.41,-108 476.33,-108 476.33,-108 476.33,-108 476.33,-72.72 476.33,-72.72"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="479.83,-72.72 476.33,-62.72 472.83,-72.72 479.83,-72.72"/>
<text xml:space="preserve" text-anchor="middle" x="457.77" y="-115.55" font-family="Arial" font-size="9.00"> Fetch Issues,</text>
<text xml:space="preserve" text-anchor="middle" x="457.77" y="-104.75" font-family="Arial" font-size="9.00">Contributors, Code</text>
</g>
<!-- AIEngine&#45;&gt;SessionCache -->
<g id="edge4" class="edge">
<title>AIEngine-&gt;SessionCache</title>
<path fill="none" stroke="#555555" stroke-width="1.2" stroke-dasharray="1,5" d="M242.61,-167C230.87,-167 222.92,-167 222.92,-167 222.92,-167 222.92,-40 222.92,-40 222.92,-40 184.64,-40 184.64,-40"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="184.64,-36.5 174.64,-40 184.64,-43.5 184.64,-36.5"/>
<text xml:space="preserve" text-anchor="middle" x="213.77" y="-110.15" font-family="Arial" font-size="9.00"> Read Context</text>
</g>
<!-- PersistentStore -->
<g id="node5" class="node">
<title>PersistentStore</title>
<path fill="#ffe0b2" stroke="black" stroke-width="0" d="M375.13,-59C375.13,-61.37 344.14,-63.3 306,-63.3 267.86,-63.3 236.87,-61.37 236.87,-59 236.87,-59 236.87,-20.3 236.87,-20.3 236.87,-17.93 267.86,-16 306,-16 344.14,-16 375.13,-17.93 375.13,-20.3 375.13,-20.3 375.13,-59 375.13,-59"/>
<path fill="none" stroke="black" stroke-width="0" d="M375.13,-59C375.13,-56.63 344.14,-54.7 306,-54.7 267.86,-54.7 236.87,-56.63 236.87,-59"/>
<text xml:space="preserve" text-anchor="middle" x="306" y="-42.95" font-family="Arial" font-size="11.00">Local Storage (Disk)</text>
<text xml:space="preserve" text-anchor="middle" x="306" y="-29.75" font-family="Arial" font-size="11.00">(API Keys / Chat History)</text>
</g>
<!-- AIEngine&#45;&gt;PersistentStore -->
<g id="edge5" class="edge">
<title>AIEngine-&gt;PersistentStore</title>
<path fill="none" stroke="#555555" stroke-width="1.2" stroke-dasharray="1,5" d="M309.27,-139.9C309.27,-139.9 309.27,-74.97 309.27,-74.97"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="305.77,-139.9 309.27,-149.9 312.77,-139.9 305.77,-139.9"/>
<polygon fill="#555555" stroke="#555555" stroke-width="1.2" points="312.77,-74.97 309.27,-64.97 305.77,-74.97 312.77,-74.97"/>
<text xml:space="preserve" text-anchor="middle" x="331.51" y="-115.55" font-family="Arial" font-size="9.00"> Read Key /</text>
<text xml:space="preserve" text-anchor="middle" x="331.51" y="-104.75" font-family="Arial" font-size="9.00">Save History</text>
</g>
<!-- AIEngine&#45;&gt;GitHub -->
<g id="edge7" class="edge">
<title>AIEngine-&gt;GitHub</title>
<path fill="none" stroke="#00c853" stroke-width="1.2" d="M435.54,-167C460.09,-167 479.67,-167 479.67,-167 479.67,-167 479.67,-72.78 479.67,-72.78"/>
<polygon fill="#00c853" stroke="#00c853" stroke-width="1.2" points="483.17,-72.78 479.67,-62.78 476.17,-72.78 483.17,-72.78"/>
<text xml:space="preserve" text-anchor="middle" x="601.26" y="-110.15" font-family="Arial" font-size="9.00"> 1. Fetch Files (RAG)</text>
</g>
<!-- AIProviders -->
<g id="node7" class="node">
<title>AIProviders</title>
<path fill="#673ab7" stroke="black" stroke-width="0" d="M807,-61.25C807,-61.25 687,-61.25 687,-61.25 681,-61.25 675,-55.25 675,-49.25 675,-49.25 675,-30.05 675,-30.05 675,-24.05 681,-18.05 687,-18.05 687,-18.05 807,-18.05 807,-18.05 813,-18.05 819,-24.05 819,-30.05 819,-30.05 819,-49.25 819,-49.25 819,-55.25 813,-61.25 807,-61.25"/>
<text xml:space="preserve" text-anchor="middle" x="747" y="-42.95" font-family="Arial" font-size="11.00" fill="white">AI Providers</text>
<text xml:space="preserve" text-anchor="middle" x="747" y="-29.75" font-family="Arial" font-size="11.00" fill="white">(Groq / OpenAI / Ollama)</text>
</g>
<!-- AIEngine&#45;&gt;AIProviders -->
<g id="edge8" class="edge">
<title>AIEngine-&gt;AIProviders</title>
<path fill="none" stroke="#00c853" stroke-width="1.2" d="M435.4,-181C549.15,-181 723,-181 723,-181 723,-181 723,-72.93 723,-72.93"/>
<polygon fill="#00c853" stroke="#00c853" stroke-width="1.2" points="726.5,-72.93 723,-62.93 719.5,-72.93 726.5,-72.93"/>
<text xml:space="preserve" text-anchor="middle" x="754.15" y="-110.15" font-family="Arial" font-size="9.00"> 2. Send Prompt + Files</text>
</g>
<!-- AIProviders&#45;&gt;UI -->
<g id="edge9" class="edge">
<title>AIProviders-&gt;UI</title>
<path fill="none" stroke="#673ab7" stroke-width="1.2" stroke-dasharray="5,2" d="M771,-61.23C771,-123.32 771,-298 771,-298 771,-298 494.67,-298 494.67,-298"/>
<polygon fill="#673ab7" stroke="#673ab7" stroke-width="1.2" points="494.67,-294.5 484.67,-298 494.67,-301.5 494.67,-294.5"/>
<text xml:space="preserve" text-anchor="middle" x="873.27" y="-171.55" font-family="Arial" font-size="9.00"> Stream Response</text>
</g>
</g>
</svg>loading repolyze.svg…]()


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
