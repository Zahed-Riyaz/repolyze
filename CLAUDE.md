# CLAUDE.md — GitHub Repo Analyzer

A Chrome (Manifest V3) side-panel extension that helps someone contribute to a GitHub repository they've never seen: find an issue that's actually free, understand where to start and who to ask, follow existing pull requests, and ask questions answered from the repo's real source code. It runs entirely in the browser — no backend — using the GitHub REST API and the user's own AI provider key.

---

## 1. Functional requirements

**Repo detection & navigation**
- FR-1 Detect the repository in the active tab of the panel's window (URL changes and tab switches); ignore background tabs and other windows.
- FR-2 Show a welcome screen on non-repo pages; keep Settings reachable there.
- FR-3 When the active tab is an issue page (`/issues/12`) or a pull request page (`/pull/123`, incl. Files/Commits tabs), open that item's brief on the Contribute tab. Close it when leaving the page if it was opened that way.
- FR-3a All AI work happens in **Ask**. Contribute and its briefs never call the AI; a brief's **Ask about this issue / PR** row (suggested questions or your own) opens Ask focused on that item.

Three tabs: **Repo** · **Contribute** · **Ask**. A repo opens on Contribute — what's available to work on.

**Contribute tab** — issues and PRs on one page; a brief replaces the lists (one at a time), and Back restores their scroll position
- FR-4 List open issues (unassigned by default), sortable by most discussed / newest / recently updated. Shows a 5-item preview; "Show all" expands from what's loaded, then "Load more" pages.
- FR-5 "Good first" and "Help wanted" filters search *all* open issues via the search API, matched against the repo's real label names (spelling variants included), showing the total.
- FR-5a Issue **Find** box: a number or an issue link opens its brief (a PR link opens the PR's), keywords search every issue in the repo — open and closed, best match first, closed ones marked; a filter or the Unclaimed toggle ends the search. A closed issue's brief says **Closed** (and why), not "Looks free".
- FR-6 "Unclaimed" toggle hides assigned issues and, for label filters, issues with a linked PR; when that hides everything, say so and offer to show them.
- FR-7 **Start this issue** brief per issue: availability verdict (assignees, PRs referencing it, "I'll take this" comments, maintainer replies), likely files (path ranking), who to ask (CODEOWNERS + maintainers in the thread), and **Run before opening a PR** (commands from CI and `package.json`). No AI.
- FR-12 Pull request list below the issues: open/closed toggle, a 5-item preview then paging, hints from the list data (draft, review requested, idle ≥21 days), and a Find box accepting a PR number, a PR link (an issue link opens the issue's brief), or keywords (searches every PR).
- FR-13 **Understand this PR** brief: status verdict (approved / waiting for review / changes requested / updated after review / checks failing / conflicts / draft / merged / closed), activity, files changed with code owners, and people. No AI.
- FR-13a Each brief has an **Ask about this issue / PR** row: suggestions (issue: *Summary & plan*, *Where do I start?*, *How do I test this?*; PR: *Summarise the PR*, *What's still open?*, *How could I help?*) are sent to Ask as visible questions; *Your own question* focuses Ask without sending.

**Repo tab** — context about the project
- FR-10a Top card: the owner's avatar (square for organisations, round for users), `owner/repo`, "by {owner}" with Organization/User, Archived when it is, the website (http(s) only) and up to 8 topics — all from the repo response, no extra request.
- FR-11 Contributor-friendliness health score (0–100) from measured signals — maintainer response, outside PRs merged, merge speed, activity, onboarding docs — each shown with its evidence; unmeasured signals are n/a and excluded, not zero.
- FR-8 Language breakdown (GitHub linguist colours) and detected tools/services (containers, CI, cloud, databases, testing…).
- FR-9 Active maintainers: users with OWNER/MEMBER/COLLABORATOR association who replied on issues/PRs in the last 90 days, merged with CODEOWNERS (users and teams); flag repos where nobody with access replies.
- FR-10 All-time top contributors by commits, as context.

**Ask tab**
- FR-14 Multi-turn chat grounded in the repo: code retrieval per question, answers cite `path:line` linked to GitHub, "Read N files" source chips, regenerate, starter prompts, per-repo history (50 messages).
- FR-14a **Focus chip** (`About #12 ✕`): while set from a brief, answers are grounded in that item — the issue and its discussion plus retrieved code, or the PR's status, checks, whole activity log and numbered diff (citations link to the PR's head, in the author's fork). Questions are tagged with the item; ✕ returns to repo-wide questions; a new repo clears it.
- FR-15 Files named in a question are read directly (`@path` with autocomplete from the tree; `@` also names files without an extension); follow-ups keep the previous answer's files.
- FR-15a **Follow the code**: after the chosen files are read, their imports (JS/TS, Python) are resolved and the most relevant read too; with a token, identifiers the question names that nothing read defines are found with GitHub code search.
- FR-15b **Check citations**: each `path:line` is checked against the excerpts sent — outside them it's marked unverified, a file not read is marked unread, and the answer gets a note.
- FR-15c **Edit what was read**: the files being read show as chips before the answer; under an answer, each file can be left out (✕) or another added, then **Re-run with these files**. Chips say how each file was found (dashed = followed from an import or code search).

**Settings & rate limits**
- FR-16 Five AI providers (Groq, Gemini, OpenAI, Anthropic, local Ollama) with key format checks; settings sync between the panel and the options page.
- FR-17 GitHub token: validated against `/rate_limit` before saving; "Get token" opens `github.com/settings/tokens` and waits on the token field.
- FR-18 Live quota badge; banner when the hourly limit is low or used up (with reset time and auto-resume) or the token is rejected.

**Header**
- FR-19 Repo name, description, stars, forks, license, fork-of link.

### 1.1 How GitHub is used (endpoints and URLs)

All API paths below are relative to `https://api.github.com/repos/{owner}/{repo}` unless shown in full. Every call goes through `fetchGitHub()` / `fetchGitHubPage()` → `githubRequest()` (cache, conditional requests, rate-limit handling); the token is only ever sent to `api.github.com`.

**Knowing where the user is — page URLs (`chrome.tabs`, no API call)**
| URL in the active tab | Result |
|---|---|
| `github.com/{owner}/{repo}/…` | That repo is loaded into the panel. |
| `github.com/{owner}/{repo}/pull/{n}` (also `/files`, `/commits`) | Repo loaded **and** PR #n's brief opens on the Contribute tab. |
| `github.com/{owner}/{repo}/issues/{n}` | Repo loaded **and** issue #n's brief opens on the Contribute tab (`GET /issues/{n}` unless it's in the loaded list). |
| `github.com/explore`, `/settings`, `/notifications`, … or any non-GitHub page | Welcome screen (not a repo). |

**Repo-level data**
| Purpose | Request |
|---|---|
| Header and Repo tab card (stars, forks, license, default branch, `pushed_at`, private?, owner avatar/type, homepage, topics) | `GET ""` (the repo itself) |
| Languages | `GET /languages` |
| All-time contributors | `GET /contributors?per_page=10` |
| CONTRIBUTING / templates / code of conduct | `GET /community/profile` |
| The repo's real label names | `GET /labels?per_page=100` |
| Quota (free, doesn't count) | `GET https://api.github.com/rate_limit` |

**Issues**
| Purpose | Request |
|---|---|
| Issues list ("All") | `GET /issues?state=open[&assignee=none]&sort={comments\|created\|updated}&direction=desc&per_page=30&page={n}` — PRs are filtered out (`pull_request` field); paging follows the `Link: rel="next"` header. |
| "Good first" / "Help wanted" (whole repo) | `GET https://api.github.com/search/issues?q=repo:{o}/{r} is:issue is:open label:"good first issue","E-easy" [no:assignee -linked:pr]&sort=…&order=desc` — labels come from `/labels`, OR-ed; search has its own quota (10/min anonymous). |
| Issue keyword search (Find box) | `GET https://api.github.com/search/issues?q=repo:{o}/{r} is:issue {words}` (best match, open and closed) |
| Unclaimed beginner-issue count (health score) | Same search with `per_page=1`, reading `total_count`. |
| Issue brief: discussion + claims | `GET /issues/{n}/comments?per_page=100` |
| Issue brief: linked/referencing PRs, assignment history | `GET /issues/{n}/timeline?per_page=100` (`cross-referenced` events whose source has `pull_request`) |
| Maintainer replies & response times | `GET /issues/comments?sort=created&direction=desc&since={90 days, day-aligned}&per_page=100&page={1–3}` (`author_association` identifies OWNER/MEMBER/COLLABORATOR) and `GET /issues?state=all&sort=created&direction=desc&per_page=50` |

**Pull requests**
| Purpose | Request |
|---|---|
| PR list (open / closed) | `GET /pulls?state={open\|closed}&sort={created\|updated}&direction=desc&per_page=15&page={n}` |
| PR keyword search (Find box) | `GET https://api.github.com/search/issues?q=repo:{o}/{r} is:pr {words}&sort=updated&order=desc` |
| Open-PR count (health) | `GET /pulls?state=open&per_page=1` — the count is the `rel="last"` page number in the `Link` header. |
| Merge speed & outside contributions (health) | `GET /pulls?state=closed&sort=updated&direction=desc&per_page=50` (`merged_at`, `author_association`) |
| PR brief: details (head SHA, fork, mergeable state, reviewers, size) | `GET /pulls/{n}` |
| PR brief: commits, reviews, comments, requests, force-pushes, references | `GET /issues/{n}/timeline?per_page=100` (up to 3 pages with a token) |
| PR brief: inline code-review threads | `GET /pulls/{n}/comments?per_page=100` (grouped by `in_reply_to_id`; `position: null` = outdated) |
| PR brief: changed files + diffs | `GET /pulls/{n}/files?per_page=100` (`patch` per file) |
| PR brief: CI status | `GET /commits/{head_sha}/check-runs?per_page=100` |

**Reading code**
| Purpose | Request |
|---|---|
| Every path in the repo (one call, shared by Stack, Maintainers, Chat, briefs) | `GET /git/trees/HEAD?recursive=1` |
| File contents — public repos (no API quota) | `GET https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/{path}` |
| File contents — private repos (needs the token) | `GET /contents/{path}?ref={default_branch}` (base64, decoded as UTF-8) |
| What gets read | CODEOWNERS (`CODEOWNERS`, `.github/`, `docs/`), README, CONTRIBUTING, dev docs (`docs/development.md`, `docs/testing.md`, …), manifests (`package.json`, `pyproject.toml`, `go.mod`, …), one CI workflow (`.github/workflows/*.yml`), and the source files chosen per question. |

**Links out (opened in the browser, not fetched)**
- Code citations → `https://github.com/{owner}/{repo}/blob/{ref}/{path}#L{start}-L{end}` (the default branch for chat and issue briefs; the PR's head SHA, in the author's fork if it is one, for PR briefs).
- Issues/PRs → their `html_url`; "Get token" → `https://github.com/settings/tokens`.

### 1.2 How RAG is used

The extension uses **retrieval-augmented generation**: before the AI answers, it retrieves the relevant parts of the repo and puts them in the prompt, so answers come from the actual code and can be cited. It's RAG **without embeddings or a vector database** — retrieval happens at question time with lexical ranking plus the model itself choosing files, which suits a backend-free extension (nothing to index up front, no embedding API needed, code questions usually contain the identifiers to search for).

| Stage | What happens | Where |
|---|---|---|
| Collect | File tree (1 API call) + file contents from raw GitHub on demand | `getRepoTree`, `readRepoFile` |
| Shortlist | Rank every path against the question: identifiers split (`handleRepoRefresh` → handle, repo, refresh), file-name hits beat directory hits, tests/vendor/lockfiles demoted or skipped | `queryTerms`, `rankCodeFiles` |
| Select | Files named in the question (or with `@`) are read directly; otherwise the AI picks ≤5 from the shortlist (60/120/250 paths by model size), falling back to the best path matches or the previous answer's files; an edited file list replaces all of this | `mentionedFiles`, `buildChatContext` |
| Follow | Imports of the files read are resolved against the tree (relative paths, extensions, index files, `@/` aliases, Python modules) and ranked — a file importing a name the question asks about first; the top 2–4 are read, snippets centred on the imported names. With a token, identifiers the question names that no file read defines go to `/search/code` (≤2) | `parseImports`, `resolveImport`, `relatedFiles`, `definesIdentifier`, `questionIdentifiers`, `searchCodeFor` |
| Chunk | Query-time chunking: small files whole; large files keep their head plus the best-matching 40-line windows (definitions weigh extra), with line numbers; followed files get 0.6 of a chosen file's share | `extractSnippets` |
| Pick doc sections | README, CONTRIBUTING and dev docs are split by heading once per repo; per question keep the intro + best-matching sections (heading hits weigh most) in order, and name the rest; `package.json` sent as a summary (scripts in full) | `splitMarkdownSections`, `selectSections`, `summarizePackageJson`, `contextPartsForQuestion` |
| Pack | Code first, then README, file tree, CONTRIBUTING/configs/CI, within a per-provider character budget | `packContext`, `CONTEXT_BUDGET` |
| Generate | System prompt with grounding rules; context in `<repository_context>`; question last; answer streams | `buildChatPrompt`, `callAIStreaming` |
| Verify | Each `path:line` is checked against the excerpts sent: verified ones link to the line, lines outside them are marked unverified, files not read are marked unread, and the answer gets a note; an editable "Read N files" row lists the excerpts and how each file was found | `checkCitations`, `linkifyCitations`, `citationNoteHtml`, `sourcesHtml` |

Where it's used:
- **Ask** — the full pipeline above, per question (follow-ups carry the previous files).
- **Ask focused on an issue** (`ask-focus.js`) — the same pipeline, with the issue and its discussion prepended to the retrieved code; follow-ups carry the files behind the last answer about the same item (falling back to the issue's likely files).
- **Ask focused on a PR** — grounded generation without the retrieval step: the "retrieved" context is the PR itself (status, checks, every timeline event, review thread and numbered diff), packed to fit the budget. `buildChatPrompt({ focus })` tells the model which item it's about.
- **Not used** for briefs, availability verdicts, PR status, the health score, maintainers or CI commands — those are computed deterministically from GitHub data, so they're consistent and work without AI.

---

## 2. Non-functional requirements

| Area | Requirement |
|---|---|
| **API budget** | Opening a repo costs 3 GitHub requests (header, first page of issues, first page of PRs); the Repo tab loads on first view; reopening the panel costs 0 (session cache); chat costs 0 (file contents come from `raw.githubusercontent.com`), plus ≤2 code-search requests with a token when the question names identifiers nothing read defines; an issue brief costs 2 (3 when opened from its page), a PR brief 5. |
| **AI budget** | No AI call happens without a user action, and only in Ask (on send, or a brief's suggestion). Opening a brief — from a list or by following the page — costs 0 AI credits. |
| **Rate-limit resilience** | Never collect raw 403s: stop requesting when the core quota is spent, serve stale cache instead of failing, track the search quota separately, honour `Retry-After` for secondary limits (not the hourly reset), auto-reload failed tabs when the window resets or a token is added. |
| **Correctness under navigation** | Every async render is guarded by the repo it started for (`isCurrentRepo(key)`); briefs are guarded by an active token so a stale response never renders into another repo or brief. |
| **Privacy** | No backend and no telemetry. Keys and chat history live in `chrome.storage.local`; GitHub responses in `chrome.storage.session`. The GitHub token is only ever sent to `api.github.com`. Repo content is sent only to the AI provider the user chose. |
| **Security** | All GitHub/AI text is HTML-escaped before rendering; Markdown links only render for `http(s)`; label colours are validated; AI instructions go in each provider's system slot and repo content is marked as data, not instructions. Minimal permissions: `sidePanel`, `storage`, `tabs`. |
| **AI answer quality** | Grounded answers with citations; per-provider context budgets (Groq/Ollama smaller); Ollama `num_ctx` sized to the request; temperature 0.2 (0 for file picking); history has its own budget. |
| **Performance** | Local ranking of 100k paths ≈ 150 ms; file reads in parallel; skeletons instead of layout jumps; streaming AI output. |
| **Accessibility** | Keyboard-reachable controls with visible focus rings, ARIA roles on tabs/status, `prefers-reduced-motion` respected, theme-aware label contrast. |
| **Compatibility** | Chrome with the Side Panel API (MV3); works at narrow panel widths (three text-only tabs); light and dark themes follow the OS. |
| **Maintainability** | Plain JS, no build step; pure logic separated from rendering and unit-tested; 169 tests (`npm test`, ~3s) run in CI on every push. |
| **Cost** | Zero infrastructure cost; users bring their own AI key (free tiers on Groq/Gemini, free local Ollama). |

---

## 3. Data flow

**Opening a repo**
1. `chrome.tabs.onUpdated` / `onActivated` fire in the side panel (active tab of its window only).
2. `handleRepoRefresh(url)` parses `owner/repo` (and an issue/PR number if on one — `briefPageFromPath`) and calls `updateRepoInfo()` for a new repo.
3. `updateRepoInfo()` resets per-repo UI, fetches repo metadata, loads chat history, and loads **only the visible tab** (`loadTabData`).
4. Every GitHub call goes through `githubRequest()`: check the session cache → serve if fresh (10 min) → otherwise send with `If-None-Match` (a 304 costs nothing) → record rate-limit headers → cache 200s and 404s in memory + `chrome.storage.session`.
5. Renders check `isCurrentRepo(key)` before touching the DOM; results are cached in `repoCache[owner/repo]`.

**Opening a tab**
6. `switchTab(name)` → `loadTabData(name)` runs that tab's loader once per repo; a loader that fails (rate limit, network) is un-marked so it retries next time the tab is shown.

**Asking in Chat**
7. `buildChatContext()`: fetch the file tree (1 request, shared) → if the question names files, read them directly; otherwise rank paths lexically (`rankCodeFiles`), let the AI pick ≤5 files from a shortlist sized to the model (falls back to lexical/previous files) → read files from raw GitHub in parallel → follow their imports (and code search, with a token) and read the relevant ones → `onFiles` shows the chips → keep the head plus best-matching 40-line windows (`extractSnippets`) with line numbers → `packContext()` code first, then README, tree, configs, within the provider's budget.
8. `buildChatPrompt()`: system prompt (rules) + trimmed history + final user message `<repository_context>…</repository_context> Question: …`.
9. `callAIStreaming()` → `providerBody()` builds the request for the selected provider → tokens stream into the bubble → citations to files actually read are linkified → the message and its sources are saved to the repo that asked.

**Start this issue**
10. Load the issue's comments + timeline (2 requests), CI commands (`loadVerifyCommands`, raw files) and CODEOWNERS → `issueAvailability()` verdict, likely files (path ranking) and their owners render instantly. No AI.

**Asking about a brief**
11a. A brief's suggestion → `askAboutBrief(kind, i)` → `setChatFocus()` shows the chip → `switchTab("chat")` → `handleChat()` sees `focusedItem()` → `buildFocusedContext()`: issue → `issueFocusContext()` + `buildChatContext()`; PR → `prFocusContext()` (no file picking) → `buildChatPrompt({ focus })` → answer streams in Ask and is saved with its `focus` tag (and `cite` repo for PRs).

**Understand this PR**
11. Load PR detail, then timeline, review comments, files and check runs (5 requests, paged with a token) → `prStatus()` verdict, activity, files and people render instantly. `prEventLog()` (every event, bodies shortened evenly to fit) and `prDiffContext()` (numbered diffs, most-discussed first) feed Ask when it's focused on the PR.

**Rate limits & tokens**
12. Response headers update `ghState` → `renderRateLimit()` updates the badge/banner and a countdown; at reset (or after a token is saved and validated via `/rate_limit`), `reloadCurrentRepo()` re-runs what's visible, deferring until the user is back on a repo page.

---

## 4. Tech stack

| Technology | Why (one line) |
|---|---|
| Chrome Extension, Manifest V3 | Required for modern Chrome extensions; service worker + side panel fit a companion tool. |
| Side Panel API | Keeps the tool open beside the repo instead of a popup that closes on every click. |
| Vanilla JavaScript (classic scripts, no build) | Zero tooling to load unpacked, easy to read, nothing to compile or keep up to date. |
| HTML + CSS custom properties (tokens) | One `theme.css` gives both pages consistent light/dark theming without a framework. |
| Inline SVG icon sprite | Crisp, theme-coloured icons with no network requests or icon font. |
| GitHub REST API | Complete public data (issues, PRs, timelines, reviews, checks, community profile) with conditional requests. |
| GitHub Search API | Repo-wide label filters and PR keyword search beyond the first page of results. |
| `raw.githubusercontent.com` | Reads file contents without spending API quota. |
| `chrome.storage.local` / `.session` | Persistent settings & chat history / a session-scoped response cache that survives panel reopen. |
| Groq, Gemini, OpenAI, Anthropic, Ollama | Bring-your-own-key choice from free and fast to paid and strong to fully local and private. |
| Server-Sent Events / NDJSON streaming | Answers appear as they're generated rather than after a long wait. |
| Node.js built-in test runner (`node --test`) | Tests with zero dependencies against the real extension scripts. |
| GitHub Actions | Runs the syntax check and test suite on every push and PR. |

---

## 5. Frontend design philosophy

- **Evidence over assertion.** Every verdict shows its reasons; every metric shows the numbers behind it; every AI claim about code cites `path:line` and links to it. Unlinked citations visibly mean "not verified".
- **Deterministic first, AI second.** Anything computable (availability, PR status, owners, CI commands, health signals) renders instantly and works without an AI key; AI lives in one place (Ask) and adds summaries and answers on top, grounded in the item you came from.
- **Honest states.** Skeletons instead of spinners-and-jumps; "n/a" instead of fake zeros; "Paused until 19:13" instead of raw 403s; "all 18 are already claimed" instead of an empty list.
- **Fit a narrow panel.** A fixed header and tab bar with independently scrolling panes; a pinned chat composer; a one-line header with the owner's avatar; lists page instead of growing unbounded.
- **Calm, native look.** GitHub-adjacent (Primer-like) tokens, system font at 13px, light and dark from the OS, subtle motion (≤250 ms) that respects reduced-motion. Hairlines over boxes: lists are hairline-separated rows (the row opens the brief, ↗ opens GitHub), labels are coloured dots, statuses are a thin tone rule, section titles are sentence case, and colour is saved for meaning (status, links, the active control).
- **Guide to the next action.** Banners and briefs end with what to do ("Get token", "comment before you start", "tag the code owner", commands to copy).

---

## 6. System design

```
┌───────────────────────────────────────── Chrome ──────────────────────────────────────────┐
│                                                                                           │
│  ┌──────────────┐  tab URL / switches   ┌──────────────────── Side panel ───────────────┐ │
│  │  Active tab  │ ───────────────────▶  │ sidepanel.html                                │ │
│  │ github.com/… │  (chrome.tabs)        │  ├ sidepanel.js  UI, tabs, chat, settings,    │ │
│  └──────────────┘                       │  │               GitHub layer, AI providers   │ │
│                                         │  ├ retrieval.js  tree, raw reads, ranking,    │ │
│  ┌──────────────┐  openPanelOnAction    │  │               snippets, packing, prompts   │ │
│  │background.js │ ───────────────────▶  │  ├ insights.js   maintainers, health score    │ │
│  │ (worker)     │                       │  ├ brief.js      Start this issue, focus view │ │
│  └──────────────┘                       │  ├ pr-brief.js   PR list, Find, PR brief      │ │
│                                         │  └ ask-focus.js  Ask focused on an issue / PR │ │
│                                         └───────┬───────────────────┬───────────────────┘ │
│  ┌──────────────┐   settings (onChanged)        │                   │                     │
│  │ options.html │ ◀──────────────┐              │                   │                     │
│  │ options.js   │                ▼              ▼                   │                     │
│  └──────────────┘   ┌───────────────────────────────────────────┐   │                     │
│                     │ chrome.storage.local   settings, chat     │   │                     │
│                     │ chrome.storage.session GitHub responses   │   │                     │
│                     └───────────────────────────────────────────┘   │                     │
└─────────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                      │ fetch
            ┌─────────────────────────────┬───────────────────────────┼────────────────────┐
            ▼                             ▼                           ▼                    ▼
 ┌─────────────────────┐   ┌───────────────────────────┐  ┌──────────────────────┐  ┌──────────────┐
 │ api.github.com      │   │ raw.githubusercontent.com │  │ Cloud AI providers   │  │ Ollama       │
 │ REST: repo, issues, │   │ file contents             │  │ Groq · Gemini ·      │  │ localhost:   │
 │ PRs, timeline,      │   │ (no API quota)            │  │ OpenAI · Anthropic   │  │ 11434        │
 │ checks, community   │   └───────────────────────────┘  │ (streaming, BYOK)    │  │ (local)      │
 │ Search: labels, PRs │                                  └──────────────────────┘  └──────────────┘
 │ /rate_limit (free)  │
 └─────────────────────┘

 Request path inside the panel:
   loader ─▶ fetchGitHub ─▶ githubRequest ─▶ [memory cache ─▶ session cache ─▶ quota gate ─▶ fetch
            (If-None-Match)] ─▶ rate-limit headers ─▶ ghState ─▶ badge / banner / auto-resume
```

---

## 7. Working in this repo

- **Run:** `chrome://extensions` → Developer mode → Load unpacked → this folder. Reload the extension after edits.
- **Test:** `npm test` (all suites) and `npm run check` (syntax). Node 22+. CI: `.github/workflows/test.yml`.
- **Script order matters:** `sidepanel.html` loads `retrieval.js`, `insights.js`, `brief.js`, `pr-brief.js`, `ask-focus.js`, then `sidepanel.js` as classic scripts sharing one global scope; `test/helpers/panel.js` loads them in the same order. New files must be added to both (and to `npm run check`).
- **Tests use the real code:** `loadPanel()` evals the scripts with a fake DOM, `chrome.*` and `fetch`; `githubMock()` fakes GitHub, raw files and AI replies and records requests. Use `panel.run("…")` to reach `let`/`const` state.
- **Conventions:** keep pure logic (verdicts, scoring, parsing, prompts) separate from rendering and unit-test it; escape everything interpolated into `innerHTML`; guard async renders with `isCurrentRepo(key)`; go through `fetchGitHub`/`fetchGitHubPage` (never raw `fetch`) for GitHub API calls; always pass `direction=desc` when sorting GitHub lists (it defaults to ascending); put AI instructions in `opts.system`.
- **Model IDs** live in `MODELS` (`sidepanel.js`); context budgets in `CONTEXT_BUDGET` and picker sizes in `PICKER_SHORTLIST` (`retrieval.js`).
- **Not yet done:** extension icons, privacy policy / private-repo warning, Web Store packaging, GitHub sign-in (device flow), real-model answer evaluation.

---

## 8. Summary

GitHub Repo Analyzer is a backend-free Chrome side panel that turns "a repo I've never seen" into "a contribution I can start today". It finds issues that are genuinely available across the whole repo, briefs each one (is it free, where to start, who to ask, what CI will run), explains pull requests including their full conversation and status, surfaces the people who actually maintain the project, scores contributor-friendliness from measured signals, and answers questions from the repo's real source code with line-level citations. Everything is computed client-side from the GitHub API — carefully budgeted, cached and rate-limit-aware — with the user's own AI provider adding summaries on top of deterministic, verifiable data. It's plain JavaScript with no build step, a token-based light/dark design built for a narrow panel, and 169 tests running in CI.
