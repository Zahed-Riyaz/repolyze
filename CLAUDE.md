# CLAUDE.md — GitHub Repo Analyzer

A Chrome (Manifest V3) side-panel extension that helps someone contribute to a GitHub repository they've never seen: find an issue that's actually free, understand where to start and who to ask, follow existing pull requests, and ask questions answered from the repo's real source code. It runs entirely in the browser — no backend — using the GitHub REST API and the user's own AI provider key.

---

## 1. Functional requirements

**Repo detection & navigation**
- FR-1 Detect the repository in the active tab of the panel's window (URL changes and tab switches); ignore background tabs and other windows.
- FR-2 Show a welcome screen on non-repo pages; keep Settings reachable there.
- FR-3 When the active tab is an issue page (`/issues/12`) or a pull request page (`/pull/123`, incl. Files/Commits tabs), open that item's brief on the Contribute tab. Close it when leaving the page if it was opened that way.
- FR-3b **Contributor guide on GitHub issue pages** (`content.js`): a small card in the issue's sidebar (or floating, if the sidebar can't be found) read as verdict → why (one line) → next step, then **Where to start** (files with a real signal, each with why; name-matching guesses folded under "N guesses by file name") and **Who owns it** (owners once, org dropped from team names), plus "Open the full brief in the panel". Shadow DOM, follows GitHub's in-page navigation, never posts or clicks anything; signed out it waits for a click (60/hour), signed in it loads right away. Switch off in Settings.
- FR-3a All AI work happens in **Ask**. Contribute and its briefs never call the AI; a brief's **Ask about this issue / PR** row (suggested questions or your own) opens Ask focused on that item.

Three tabs: **Repo** · **Contribute** · **Ask**. A repo opens on Contribute — what's available to work on.

**Contribute tab** — issues and PRs on one page; a brief replaces the lists (one at a time), and Back restores their scroll position
- FR-4 List open issues (unassigned by default), sortable by most discussed / newest / recently updated. Shows a 5-item preview; "Show all" expands from what's loaded, then "Load more" pages.
- FR-5 "Good first" and "Help wanted" filters search *all* open issues via the search API, matched against the repo's real label names (spelling variants included), showing the total.
- FR-5a Issue **Find** box: a number or an issue link opens its brief (a PR link opens the PR's), keywords search every issue in the repo — open and closed, best match first, closed ones marked; a filter or the Unassigned toggle ends the search. A closed issue's brief says **Closed** (and why), not "Looks free".
- FR-5b **What each issue requires**: every issue row lists its stack — the languages of the files it likely touches (path ranking on its title/body, as in "Likely files") and languages/technologies it names — with the file behind each language on hover; the issue brief has a "What it requires" section. PR rows get the same line (from title, description and branch name — the list has no files, and fetching them per PR would cost a request each); the PR brief's **What it touches** uses the files it actually changes, languages ordered by how much of the PR is in them. No AI; shown signed in or not.
- FR-5c **Fit with your stack** (signed in): your profile is built from your own public repos (languages, topics, descriptions; forks skipped, recent repos weigh most) and bio. The parts of an issue's stack you know are shown brighter, and sort **Best fit for you** (issues and PRs, each scored against its own list) puts first the items needing the most of your stack — scored relative to the repo, so the repo's main language or a term most issues mention doesn't lift one issue over another. Settings → **Your stack** shows the profile and lets you hide or add items.
- FR-6 "Unassigned" toggle hides assigned issues and, for label filters, issues with a linked PR; when that hides everything, say so and offer to show them.
- FR-7 **Start this issue** brief per issue, laid out like the page card (verdict → why → next step → Where to start, with the issue's stack as a header note → Who to ask → Ask → From clone to pull request): availability verdict (assignees, PRs referencing it, "I'll take this" comments, maintainer replies), **files it needs** (`resolveIssueFiles`: named in the issue/comments incl. stack traces and links → changed by PRs that reference it → defines an identifier it names (code search, token) → their tests → name matching as a labelled guess), who to ask (CODEOWNERS + maintainers in the thread), and **From clone to pull request** (`flow.js`), three numbered steps in one section, each folded to a one-line summary ("Node 20 · 7 commands", "3 checks CI runs", "2 rules · their template, filled in") until opened: **Set up** (fork link, `git clone` of your fork, a branch named for the issue — `fix/12-short-title` — then the repo's own setup commands from the setup sections of CONTRIBUTING/dev docs, else worked out from lockfiles, manifests, a Makefile setup target, CI's install step, `.env.example`, compose and pre-commit files; pinned versions — `.nvmrc`, `engines`, `requires-python`, `go.mod`, `.tool-versions` — shown as "Needs Node 20"; a Codespaces link when there's a dev container), **Before you push** (what CI runs, from the workflow and `package.json`; installs belong to setup), and **Open the PR** (the repo's rules, each with its evidence — title style from commitlint config, CONTRIBUTING or ≥50% of recent merged PR titles; DCO sign-off; CLA; changesets / changelog fragments / CHANGELOG; tests and docs when CONTRIBUTING asks; a title in the repo's style to copy; **Copy description** = the repo's PR template with the issue linked — its own `Fixes #` placeholder completed, else under an issue heading, else at the top — or a short default; signed in, **Open the PR on GitHub** opens the compare form with title and description filled in for that branch). No AI.
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
- FR-14 Multi-turn chat grounded in the repo: code retrieval per question, answers cite `path:line` linked to GitHub, "Read N files" source chips, regenerate, per-repo history (50 messages). **Starters shaped by the repo** (`repoStarters`, from data already loaded: a free newcomer issue — opens its brief and asks where to start — the biggest area of code, the entry point, setup, tests). The header names the model in use (click → Settings). While answering: the step (Finding files → Reading N files → Writing), what it's doing and the seconds taken; **Stop** (button or Esc) replaces Send and keeps what arrived, marked Stopped — or, before a word arrives, puts the question back in the box; one answer at a time. Failed answers are saved as errors with **Try again**; answers have **Copy**; a **Latest** button appears when scrolled up.
- FR-14a **Focus chip** (`About #12 ✕`): while set from a brief, answers are grounded in that item — the issue and its discussion plus retrieved code, or the PR's status, checks, whole activity log and numbered diff (citations link to the PR's head, in the author's fork). Questions are tagged with the item; ✕ returns to repo-wide questions; a new repo clears it.
- FR-15 Files named in a question are read directly (`@path` with autocomplete from the tree; `@` also names files without an extension); follow-ups keep the previous answer's files.
- FR-15a **Follow the code**: after the chosen files are read, their imports (JS/TS, Python) are resolved and the most relevant read too; with a token, identifiers the question names that nothing read defines are found with GitHub code search.
- FR-15b **Check citations**: each `path:line` is checked against the excerpts sent — outside them it's marked unverified, a file not read is marked unread, and the answer gets a note.
- FR-15c **Edit what was read**: the files being read show as chips before the answer; under an answer, each file can be left out (✕) or another added, then **Re-run with these files**. Chips say how each file was found (dashed = followed from an import or code search).

**Settings & rate limits**
- FR-16 Five AI providers (Groq, Gemini, OpenAI, Anthropic, local Ollama) with key format checks; settings sync between the panel and the options page.
- FR-16a **Model per provider**: Settings offers a short list for each provider (`MODEL_CHOICES`, first = default — e.g. Groq: Llama 3.3 70B, **Kimi K2**, GPT-OSS 120B, Qwen3 32B, Llama 3.1 8B; Ollama: llama3.1:8b, qwen2.5-coder:7b, gemma3:12b, gpt-oss:20b, llama3.2) with a note on each, plus **Other…** for any model ID. Changing only the model keeps the saved key; the badge names the model in use. For Ollama, Settings (and the options page) show numbered terminal steps for the picked model and your OS (tabs for macOS / Linux / Windows), each with Copy: install Ollama, `ollama pull <model>`, `OLLAMA_ORIGINS='chrome-extension://*' ollama serve`, `ollama list`; the chat's "Ollama isn't running" help shows the same steps (download + start, or only the restart when Ollama is blocking the extension).
- FR-17 **Sign in with GitHub** (OAuth device flow, no backend, no scopes): the panel shows a one-time code, opens `github.com/login/device`, polls until approved, validates the token against `/rate_limit`, and shows "Signed in as @you" with Sign out. A personal access token can still be pasted (folded under "Use a personal access token instead"; the only option until `AUTH.clientId` is set). The limit banner's button is "Sign in".
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
| Sign-in: device code | `POST https://github.com/login/device/code` (`client_id`, empty scope) |
| Sign-in: token (polled every `interval`s; `slow_down` lengthens it) | `POST https://github.com/login/oauth/access_token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) |
| Signed-in account (name + avatar in Settings) | `GET https://api.github.com/user` |
| Your stack (once a day, signed in) | `GET https://api.github.com/users/{login}` (bio), `GET …/users/{login}/repos?type=owner&sort=pushed&direction=desc&per_page=100`, and `GET {repo.languages_url}` for your 6 most recently pushed own repos |

**Issues**
| Purpose | Request |
|---|---|
| Issues list ("All") | `GET /issues?state=open[&assignee=none]&sort={comments\|created\|updated}&direction=desc&per_page=30&page={n}` — PRs are filtered out (`pull_request` field); paging follows the `Link: rel="next"` header. |
| "Good first" / "Help wanted" (whole repo) | `GET https://api.github.com/search/issues?q=repo:{o}/{r} is:issue is:open label:"good first issue","E-easy" [no:assignee -linked:pr]&sort=…&order=desc` — labels come from `/labels`, OR-ed; search has its own quota (10/min anonymous). |
| Issue keyword search (Find box) | `GET https://api.github.com/search/issues?q=repo:{o}/{r} is:issue {words}` (best match, open and closed) |
| Unclaimed beginner-issue count (health score) | Same search with `per_page=1`, reading `total_count`. |
| Issue brief: discussion + claims | `GET /issues/{n}/comments?per_page=100` |
| Issue brief / page guide: files changed by PRs that reference the issue (≤2) | `GET /pulls/{n}/files?per_page=100` |
| Issue brief: linked/referencing PRs, assignment history | `GET /issues/{n}/timeline?per_page=100` (`cross-referenced` events whose source has `pull_request`) |
| Maintainer replies & response times | `GET /issues/comments?sort=created&direction=desc&since={90 days, day-aligned}&per_page=100&page={1–3}` (`author_association` identifies OWNER/MEMBER/COLLABORATOR) and `GET /issues?state=all&sort=created&direction=desc&per_page=50` |

**Pull requests**
| Purpose | Request |
|---|---|
| PR list (open / closed) | `GET /pulls?state={open\|closed}&sort={created\|updated}&direction=desc&per_page=15&page={n}` |
| PR keyword search (Find box) | `GET https://api.github.com/search/issues?q=repo:{o}/{r} is:pr {words}&sort=updated&order=desc` |
| Open-PR count (health) | `GET /pulls?state=open&per_page=1` — the count is the `rel="last"` page number in the `Link` header. |
| Merge speed & outside contributions (health); PR title conventions (issue brief) | `GET /pulls?state=closed&sort=updated&direction=desc&per_page=50` (`merged_at`, `author_association`, `title`) — one shared, cached request |
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
| Verify | Each `path:line` — and each prose citation ("line 58" in a paragraph naming exactly one file read, `proseCitations`) — is checked against the excerpts sent: verified ones link to the line, lines outside them are marked unverified, files not read are marked unread, and the answer gets a note; an editable "Read N files" row lists the excerpts and how each file was found | `checkCitations`, `linkifyCitations`, `citationNoteHtml`, `sourcesHtml` |

Where it's used:
- **Ask** — the full pipeline above, per question (follow-ups carry the previous files).
- **Ask focused on an issue** (`ask-focus.js`) — the same pipeline, but the *issue's text* drives retrieval too (`about`: terms, named files, identifiers), not just the question, and the prompt's own instruction words ("…which test to add") stop counting as search terms. The brief's "Where to start" files are read first (`seedFiles`); names the issue mentions are ranked (`questionIdentifiers`: function-style names first, then other camelCase, types, snake_case tool/field names, env vars last; product names like GitHub/TypeScript skipped; `a/b` split when it isn't a path), the top ones traced to their definitions (up to 4 with a large budget: code search with a token, else `findDefinitionByName`), and each named function's definition is guaranteed a window right after the file's head (`extractSnippets(…, strong)`). Imports are only followed when they bring in something the issue is about (`relatedFiles(…).related`); a PR's changed files' imports are always followed. The prompt makes the issue the source of truth: its own reproduction steps, and "say it's missing" rather than naming a nearby function.
- **Ask focused on a PR** — the PR itself (status, checks, every timeline event, review thread, numbered diff), plus its most-changed files **read at the PR's head** around what changed (`prHeadSnippets`, `readFileAt`), plus related unchanged code from the default branch (imports of the changed files via `followFrom`, and names the PR mentions). Sources carry `at` when they live elsewhere (the fork's head), so citations link to the right place. `buildChatPrompt({ focus })` tells the model which item it's about.
- **Not used** for briefs, availability verdicts, PR status, the health score, maintainers or CI commands — those are computed deterministically from GitHub data, so they're consistent and work without AI.

---

## 2. Non-functional requirements

| Area | Requirement |
|---|---|
| **API budget** | Opening a repo costs 4 GitHub requests (header, first page of issues, first page of PRs, the file tree — shared with briefs and Ask); the Repo tab loads on first view; reopening the panel, reloading the extension or restarting Chrome costs 0 (responses are stored for 3 days; older ones revalidate with their ETag, and a 304 is free); chat costs 0 (file contents come from `raw.githubusercontent.com`), plus ≤2 code-search requests with a token when the question names identifiers nothing read defines; an issue brief costs 2 (3 when opened from its page) plus, once per repo, the recent closed PRs for title conventions (shared with the health score; setup and the PR template come from raw files, free), plus ≤2 for PRs that reference it and, with a token, ≤2 code searches; the page guide the same (shared cache); a PR brief 5; signed in, your stack costs ≤8 a day. |
| **AI budget** | No AI call happens without a user action, and only in Ask (on send, or a brief's suggestion). Opening a brief — from a list or by following the page — costs 0 AI credits. |
| **Rate-limit resilience** | Never collect raw 403s: stop requesting when the core quota is spent, serve stale cache instead of failing, track the search quota separately, honour `Retry-After` for secondary limits (not the hourly reset), auto-reload failed tabs when the window resets or a token is added. |
| **Correctness under navigation** | Every async render is guarded by the repo it started for (`isCurrentRepo(key)`); briefs are guarded by an active token so a stale response never renders into another repo or brief. |
| **Privacy** | No backend and no telemetry. Keys, chat history and your stack profile (built from your public data, never sent anywhere but GitHub) live in `chrome.storage.local`; GitHub responses in `chrome.storage.local` for up to 3 days (capped at ~4M characters, oldest pruned first); responses read with a token are deleted on sign-out. The GitHub token is only ever sent to `api.github.com`. Repo content is sent only to the AI provider the user chose. |
| **Security** | All GitHub/AI text is HTML-escaped before rendering; Markdown links only render for `http(s)`; label colours are validated; AI instructions go in each provider's system slot and repo content is marked as data, not instructions. Minimal permissions: `sidePanel`, `storage`, `tabs`; host access to `github.com/*` for the sign-in endpoints (they don't allow cross-origin requests) and the contributor guide on issue pages (content script; switchable off). Sign out removes the token locally; revoking it is done on GitHub (Settings → Applications), since that needs the app's secret. |
| **AI answer quality** | Grounded answers with citations; per-provider context budgets (`contextBudget()`: Groq and small ≤4B local models smaller; Ollama's default `llama3.1:8b` — free, 128k-token context — gets the cloud providers' 40k characters); Ollama `num_ctx` sized to the request; temperature 0.2 (0 for file picking); history has its own budget. |
| **Performance** | Local ranking of 100k paths ≈ 150 ms; file reads in parallel; skeletons instead of layout jumps; streaming AI output. |
| **Accessibility** | Keyboard-reachable controls with visible focus rings, ARIA roles on tabs/status, `prefers-reduced-motion` respected, theme-aware label contrast. |
| **Compatibility** | Chrome with the Side Panel API (MV3); works at narrow panel widths (three text-only tabs); light and dark themes follow the OS. |
| **Maintainability** | Plain JS, no build step; pure logic separated from rendering and unit-tested; 245 tests (`npm test`, ~6s) run in CI on every push. |
| **Cost** | Zero infrastructure cost; users bring their own AI key (free tiers on Groq/Gemini, free local Ollama). |

---

## 3. Data flow

**Opening a repo**
1. `chrome.tabs.onUpdated` / `onActivated` fire in the side panel (active tab of its window only).
2. `handleRepoRefresh(url)` parses `owner/repo` (and an issue/PR number if on one — `briefPageFromPath`) and calls `updateRepoInfo()` for a new repo.
3. `updateRepoInfo()` resets per-repo UI, fetches repo metadata, loads chat history, and loads **only the visible tab** (`loadTabData`).
4. Every GitHub call goes through `githubRequest()`: check the cache (memory, then `chrome.storage.local`, up to 3 days old) → serve if fresh (10 min) → otherwise send with `If-None-Match` (a 304 costs nothing) → record rate-limit headers → cache 200s and 404s in memory + `chrome.storage.local`.
5. Renders check `isCurrentRepo(key)` before touching the DOM; results are cached in `repoCache[owner/repo]`.

**Opening a tab**
6. `switchTab(name)` → `loadTabData(name)` runs that tab's loader once per repo; a loader that fails (rate limit, network) is un-marked so it retries next time the tab is shown.

**Asking in Chat**
7. `buildChatContext()`: fetch the file tree (1 request, shared) → if the question names files, read them directly; otherwise rank paths lexically (`rankCodeFiles`), let the AI pick ≤5 files from a shortlist sized to the model (falls back to lexical/previous files) → read files from raw GitHub in parallel → follow their imports (and code search, with a token) and read the relevant ones → `onFiles` shows the chips → keep the head plus best-matching 40-line windows (`extractSnippets`) with line numbers → `packContext()` code first, then README, tree, configs, within the provider's budget.
8. `buildChatPrompt()`: system prompt (rules) + trimmed history + final user message `<repository_context>…</repository_context> Question: …`.
9. `callAIStreaming()` → `providerBody()` builds the request for the selected provider → tokens stream into the bubble → citations to files actually read are linkified → the message and its sources are saved to the repo that asked.

**Start this issue**
10. Load the issue's comments + timeline (2 requests), the repo's flow once per repo (`loadRepoFlow`: docs, manifests, CI and PR template as raw files; recent merged PR titles, shared with health) and CODEOWNERS → `issueAvailability()` verdict, likely files and their owners, then setup / checks / PR rules and a draft (`setupCommandsFor`, `prDraftFor`, per issue) render instantly. No AI.

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
| `chrome.storage.local` | Settings, chat history, your stack profile, and the GitHub response cache (3 days, size-capped) — all survive panel reopen, extension reloads and browser restarts. (`storage.session` was dropped: Chrome wipes it on every reload and restart.) |
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
- **Skim, don't read.** One line per thing (a file, a person, an event, a health signal): name first, one short fact after, the rest in the tooltip. Reasons are joined into one line of fragments ("No assignee, PR or claim · No maintainer reply yet"), not sentences. Long lists show the first few and fold the rest ("12 more"); reference material (setup commands, CI checks, PR rules) folds to a one-line summary until opened. No explanatory notes under controls that already say what they do. People are chips (avatar, name, one word) or single rows, never two-line cards.
- **Guide to the next action.** Banners and briefs end with what to do ("Get token", "comment before you start", "tag the code owner", commands to copy).

---

## 6. System design

```
┌───────────────────────────────────────── Chrome ──────────────────────────────────────────┐
│                                                                                           │
│  ┌──────────────┐  tab URL / switches   ┌──────────────────── Side panel ───────────────┐ │
│  │  Active tab  │ ───────────────────▶  │ sidepanel.html                                │ │
│  │ github.com/… │  (chrome.tabs)        │  ├ sidepanel.js  UI, tabs, chat, settings,    │ │
│  │ + content.js │                       │  │               AI providers                 │ │
│  │  (page guide)│                       │  ├ github.js     API layer & cache (shared)   │ │
│  └──────┬───────┘                       │  ├ retrieval.js  tree, raw reads, ranking,    │ │
│         │ message  openPanelOnAction    │  │               snippets, packing, prompts   │ │
│  ┌──────▼───────┐ ───────────────────▶  │  ├ insights.js   maintainers, health score    │ │
│  │background.js │                       │  ├ brief.js      Start this issue, focus view │ │
│  │ (worker: the │                       │  ├ guide.js      files an issue needs (shared)│ │
│  │  page guide) │                       │  ├ flow.js       setup, checks, PR template   │ │
│  │              │                       │  ├ pr-brief.js   PR list, Find, PR brief      │ │
│  └──────────────┘                       │  ├ ask-focus.js  Ask focused on an issue / PR │ │
│                                         │  ├ auth.js       Sign in with GitHub (device) │ │
│                                         │  └ stack.js      Your stack, fit per issue    │ │
│                                         └───────┬───────────────────┬───────────────────┘ │
│  ┌──────────────┐   settings (onChanged)        │                   │                     │
│  │ options.html │ ◀──────────────┐              │                   │                     │
│  │ options.js   │                ▼              ▼                   │                     │
│  └──────────────┘   ┌───────────────────────────────────────────┐   │                     │
│                     │ chrome.storage.local   settings, chat     │   │                     │
│                     │   + GitHub responses (3 days, capped)     │   │                     │
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
   loader ─▶ fetchGitHub ─▶ githubRequest ─▶ [memory cache ─▶ stored cache ─▶ quota gate ─▶ fetch
            (If-None-Match)] ─▶ rate-limit headers ─▶ ghState ─▶ badge / banner / auto-resume
```

---

## 7. Working in this repo

- **Run:** `chrome://extensions` → Developer mode → Load unpacked → this folder. Reload the extension after edits.
- **Test:** `npm test` (all suites) and `npm run check` (syntax). Node 22+. CI: `.github/workflows/test.yml`.
- **Retrieval eval:** `npm run eval` runs made-up issues about this repo (`eval/issues.js`, 5 ambiguity levels, from "names the file and function" to "vague symptom") through the brief's resolver and Ask's retrieval, offline — this repo is served from disk as GitHub, code search answered from disk — and reports which needed files and definitions reached the model, per level. `-- --anonymous` runs signed out; `EVAL_AI_PROVIDER`/`EVAL_AI_KEY` (and `EVAL_AI_MODEL`, e.g. `moonshotai/kimi-k2-instruct`) use a real model for file picking, at that setup's context budget — so models can be compared on the same issues. It measures, it doesn't gate: add an issue whenever an answer disappoints, and don't tune the code to these issues alone.
- **Shared code:** `github.js` (API layer, caches, rate limits — no DOM; the panel hooks its badge via `onRateLimitChange`) and `guide.js` are loaded by both the panel and `background.js` (`importScripts("github.js", "retrieval.js", "insights.js", "brief.js", "guide.js")`), so they and their dependencies must stay DOM-free at the top level. The worker also serves the page guide; `content.js` only renders and gets data by message (`issue-guide`, `open-panel`).
- **Script order matters:** `sidepanel.html` loads `github.js`, `retrieval.js`, `insights.js`, `brief.js`, `flow.js`, `guide.js`, `pr-brief.js`, `ask-focus.js`, `ollama.js`, `auth.js`, `stack.js`, then `sidepanel.js` as classic scripts sharing one global scope; `test/helpers/panel.js` loads them in the same order. New files must be added to both (and to `npm run check`).
- **Tests use the real code:** `loadPanel()` evals the scripts with a fake DOM, `chrome.*` and `fetch`; `githubMock()` fakes GitHub, raw files and AI replies and records requests. Use `panel.run("…")` to reach `let`/`const` state.
- **Conventions:** keep pure logic (verdicts, scoring, parsing, prompts) separate from rendering and unit-test it; escape everything interpolated into `innerHTML`; guard async renders with `isCurrentRepo(key)`; go through `fetchGitHub`/`fetchGitHubPage` (never raw `fetch`) for GitHub API calls; always pass `direction=desc` when sorting GitHub lists (it defaults to ascending); put AI instructions in `opts.system`.
- **GitHub sign-in** needs an OAuth App's Client ID in `AUTH.clientId` (`auth.js`), with "Enable Device Flow" ticked; empty → token form only.
- **Model IDs** live in `MODEL_CHOICES` (`sidepanel.js`; first per provider = default, `MODELS` derived from it; `modelFor(provider)` = the one in use, from `aiModels` in storage), and Ollama's default in `DEFAULT_OLLAMA_MODEL` (`llama3.1:8b`; setups still on the old `llama3.2` are moved once); the Ollama setup steps come from `ollama.js` (`ollamaSteps(model, os)`, `ollamaSetupHtml`; shared by the panel and the options page, no DOM globals) — install, pull the model, then `OLLAMA_ORIGINS='chrome-extension://*' ollama serve` (extensions only, not `*`); context budgets in `CONTEXT_BUDGET` and picker sizes in `PICKER_SHORTLIST` (`retrieval.js`).
- **Not yet done:** extension icons, privacy policy / private-repo warning, Web Store packaging, real-model answer evaluation.

---

## 8. Tests and evals

Two different things, kept apart on purpose:
- **Tests** (`npm test`, 245 in 18 files, ~6s, run in CI) check that the code *behaves as designed*: fixed fake data, no network, no AI, deterministic. They gate every push.
- **The retrieval eval** (`npm run eval`) *measures* how well the extension finds the code an issue needs. It reports a score; it doesn't pass or fail, and isn't in CI.

### How the tests work
- `test/helpers/panel.js` — `loadPanel()` evals the real extension scripts (in `sidepanel.html` order) into Node with a fake DOM (`getElementById` creates elements on demand; `querySelector` results are recorded so tests can click them), fake `chrome.*` (storage, tabs, windows) and an injected `fetch`. `panel.fn.X` calls any top-level function; `panel.run("…")` reads or sets `let`/`const` state; `panel.el(id)` reads what a render wrote. Every `loadPanel()` is fresh state.
- `test/helpers/github-mock.js` — `githubMock(routes, { raw, ai })` fakes the GitHub API (routes by path, repo prefix stripped; unknown → 404), `raw.githubusercontent.com` files, and AI providers; it records every request so tests can assert on **request budgets** (`gh.apiCalls`). `sseReply(text)` fakes a streamed AI answer.
- `content.js` is tested by loading it into a bare `vm` context (no `chrome`/`location`, so it doesn't start) and calling its pure functions.
- Conventions: test the pure function first (verdicts, scoring, parsing, prompts), then one flow test through the panel; assert on what the user sees (rendered HTML) and what it cost (API calls, AI calls); every async render gets a "stale response never renders into another repo" test.

### Test files
| File | Tests | What it guarantees |
|---|---|---|
| `github-api.test.js` | 15 | The shared GitHub layer (`github.js`): fresh cache and cached 404s cost nothing; identical requests share one call; `If-None-Match` revalidation keeps bodies on 304; stale copies served while rate-limited; responses survive reloads and restarts in `storage.local` (3 days), pruned oldest-first past the size cap without touching settings; sign-out deletes responses read with the token; secondary limits pause for `Retry-After` only; an ordinary 403 isn't a rate limit; search quota is separate; a 401 flags the token; **the token is only ever sent to `api.github.com`**; cache keyed by auth mode; sorted lists always ask for `direction=desc`. |
| `panel-flows.test.js` | 18 | End to end against a mocked repo: opening a repo costs **4 requests**, a full visit stays in budget, chat costs none, reopening costs none; rate-limit → token → reload recovery; failed tabs retry; stale responses never render into another repo; issue list (All, Good first/Help wanted via search, "all claimed" message, missing-label message, previews, Load more); Maintainers and quiet-repo message; health card evidence and n/a; chat replies saved to the repo that asked; token validated before saving; Get token; Repo tab identity card (avatar, owner, safe homepage, topics). |
| `rendering.test.js` | 12 | Markdown is escaped before formatting, only `http(s)` links, code fences (also unclosed mid-stream) and lists; citations link only to files read; `escapeHtml` covers attributes; base64 → UTF-8; label-name spellings; number formatting; file-tree formatting; sized avatars. |
| `brief.test.js` | 20 | "Start this issue": CODEOWNERS pattern rules and last-match-wins; claim detection ("I'll take this"); availability (free / possibly taken / taken, merged vs closed PRs, old vs recent claims, maintainer replies); CI + `package.json` verify commands (installs left to setup); people; Markdown export; the brief's layout and cost (its **2 requests** plus the shared merged-PR list) with **no AI calls**; Ask hand-off chips; instant reopen; stale-render guard. |
| `flow.test.js` | 15 | "From clone to pull request": shell commands from docs (prompts, output, comments, continuations, inline code); the setup sections of CONTRIBUTING/dev docs (subsections in, benchmarks/releases out; a README's user-facing Install ignored); setup worked out from lockfiles, manifests, Makefile targets, CI installs, `.env.example`, compose, pre-commit; pinned versions; branch names; title conventions from merged PRs (conventional, `[area]`, Go-style); rules with evidence (DCO, CLA, changesets, tests, docs) and nothing claimed without evidence; PR template location and filling (placeholder completed, not inside comments, else under an issue heading, else on top); the draft and signed-in compare link (overlong bodies left to GitHub); in the brief: the three steps rendered and escaped, signed-out `YOUR-USERNAME`, the repo's flow read once, the Markdown copy. |
| `pr-brief.test.js` | 16 | "Understand this PR": closing keywords; latest-review logic (comments don't reset approval, dismissals clear); checks summary; status verdicts (ready / changes / updated / blocked / draft / stale / pending reviewers); numbered diffs; the event log keeps every event and shortens bodies evenly instead of dropping any; diff context ordering; the brief for **5 requests** with "What it touches"; timeline paging with a token; no AI on open. |
| `pr-browse.test.js` | 21 | Contribute lists and page following: Find parses numbers, issue/PR links (either box opens either kind) and keywords; PR list sorting, paging, merged/closed marks, search; issue search (open and closed, filters end a search); following issue and PR pages (opens once, stays closed if you close it, auto-closes when you leave, per-repo); a closed issue reads "Closed", not free. |
| `insights.test.js` | 14 | Maintainers and health: median, bot detection, CODEOWNERS parsing, active maintainers (roles, bots, teams), response stats (first reply or close, too-new, capped samples), PR stats, **health score** (100 when healthy, unmeasured signals excluded not zeroed, archived capped at 20, onboarding weighs only what was checked), beginner search query. |
| `retrieval.test.js` | 15 | Core retrieval: query terms (identifiers kept whole and split, stemming), path ranking (tests demoted, vendor/lockfiles excluded), picker reply parsing, snippets (small files whole, head + matching definition), context packing within budget, repo context found via the tree (no 404 probing), picker fallback, README-only answers, provider budgets, private repos via the contents API, rate-limited tree. |
| `sections.test.js` | 9 | Section-aware docs: Markdown split by heading (ATX, underlined, HTML; fences ignored), the best-matching sections kept in document order within the limit, `package.json` summarised with every script, nested packages listed. |
| `ai-requests.test.js` | 16 | How providers are called: instructions in each provider's system slot, low temperature, Ollama context sized to the request, context first and question last, history budgeted newest-first, named files read directly (no picker), follow-ups carry files, shortlist and context budget sized to the model (small ≤4B local models stay tight), the Ollama setup steps per OS (install, pull the chosen model, start allowing only Chrome extensions; the chat help shows only what's needed), and the model picker (defaults, labels, the chosen model reaching every provider incl. Gemini's URL, Other…, saving a model change keeps the key). |
| `follow-code.test.js` | 15 | Following the code: JS/TS and Python import parsing and resolution (extensions, index files, `.js`→`.ts`, `@/` aliases, relative Python), definition detection across languages (not calls), code names from questions, ranking imports, code search only with a token, edited file lists read exactly, `@file`; **citation checks** (verified / outside what was read / not read, marked and noted); the editable "Read N files" row; `@` suggestions. |
| `retrieval-focus.test.js` | 12 | Issue- and PR-focused retrieval, on made-up repos that reproduce known failure patterns: a function only the **issue** names is found and its definition (deep in a 600-line file) is sent; a helper found **by name** without a token; the brief's files read first; a PR's changed file read **at its head** plus a helper it imports from the default branch, each source knowing where it lives; the issue-as-source-of-truth prompt rules; uncited answers flagged; names ending a sentence still count; code names ranked (functions before tool names and env vars, product names skipped) so a helper named after noise is still found; unrelated imports not followed for issues; prose citations ("line 58") counted and linked; a named function's definition always sent. |
| `ask-focus.test.js` | 6 | Ask focused on an issue or PR: suggestions open Ask with the chip and send a visible question grounded in the item; PR questions read the discussion, diff and head files and cite the fork's head; "Your own question" sends nothing; a streaming reply is never interrupted; removing the chip or changing repo drops the focus; follow-ups keep the same item's files and PR files don't leak into repo-wide questions. |
| `ask-ui.test.js` | 8 | The Ask tab: starters shaped by the repo (a newcomer issue beats the first unassigned one, the biggest area, the entry point named so it's read directly; sensible with nothing loaded), redrawn when the tree arrives, or a set-up button without an AI provider; the header names the model and shows Clear only when needed; Stop mid-answer keeps the partial answer marked stopped and brings Send back; Stop before any text restores the question; failed answers saved as retryable errors; one answer at a time. |
| `guide.test.js` | 11 | "Files it needs" (`guide.js`): paths, stack traces and links in the issue; PRs that reference it (merged first); test files by convention; confidence labels (named / changed by PR / defines X / tests / guesses); code search only with a token; `issueGuide` for the page card; presentation helpers (owners without the org, short folders, guesses apart); the page card (`content.js`) only on issue pages, waits for a click signed out, reads verdict → where to start → owners, escapes errors; the worker's `importScripts` order. |
| `stack.test.js` | 15 | Your stack and fit: profile from your repos (recent weigh most, forks skipped, only known tech from descriptions/bio), edits, fit relative to the repo (the repo's main language or a term every issue has doesn't lift one issue), whole-word tech matching, the required-stack tags on issue and PR rows (brighter when you know them), Best fit sorting for issues and PRs, sign-in prompt, ≤8 requests and a day's cache, `prStack` from a PR's real changed files. |
| `auth.test.js` | 7 | Sign in with GitHub (device flow): only the client ID and no scopes are sent; pending / `slow_down` / token polling; denied, expired and disabled-device-flow messages; cancel stops polling; Settings shows who's signed in; sign-out clears the token, account and stack; no client ID → token form; the limit banner offers Sign in. |

### The retrieval eval
- **Why:** tests prove the design works on fake data; they can't say whether the extension finds the *right* code in a real repo. The eval does, on the one repo where we know the right answer: this one.
- **The issues** — `eval/issues.js`: 15 made-up issues about this repo that will never be built, each with what a correct answer must reach (`expect.files`, all or `any`; `expect.defs`, functions whose definition line must be sent). Five levels of ambiguity, three each:

  | Level | The issue… | Example | Must reach |
  |---|---|---|---|
  | 1 | names the file and function | "extractSnippets in retrieval.js should use longer windows for Python files" | `retrieval.js`, `extractSnippets` |
  | 2 | names the function only | "looksLikeClaim misses \"I'll open a PR for this\"" | `brief.js`, `looksLikeClaim` |
  | 3 | uses UI or concept words | "Rate-limit banner should say how many requests are left" | `sidepanel.js`, `renderRateLimit` |
  | 4 | uses only the user's words | "My languages stay highlighted after I sign out" | `stack.js` or `auth.js` |
  | 5 | is a vague symptom | "Hard to tell which parts of an answer to trust" | any of `sidepanel.js`, `retrieval.js` |

  The others: `parseCodeOwners` negation, `prStatus` dismissed reviews (1); `suggestFiles` ranking, `pollDeviceToken` giving up (2); health score and not-planned issues (`scoreHealth`), the guide card remembering collapse (`startGuide`) (3); fork links in answers, commit links in PR search (`parseFindQuery`) (4); slowness on big repos, wrong "files it needs" (5).
- **How it runs** — `eval/run.js` serves this repo from disk as GitHub (`eval/` excluded so the issue texts can't leak in; code search answered by searching the files on disk) and runs each issue through the brief's `resolveIssueFiles` and Ask's `buildChatContext` for "Summary & plan", then reports per issue whether a needed file was in the brief's top 5, whether Ask read the needed files, and whether each needed definition line was sent; then a pass rate per level.
  - `npm run eval` — signed in (code search available) · `npm run eval -- --anonymous` — signed out · `-- --json` — machine-readable.
  - Without a model the file picker's fallback (path ranking) is used; `EVAL_AI_PROVIDER=groq EVAL_AI_KEY=gsk_… EVAL_AI_MODEL=moonshotai/kimi-k2-instruct npm run eval` uses a real one.
- **Results so far** (Ask got everything a correct answer needs):

  | | L1 | L2 | L3 | L4 | L5 | Overall |
  |---|---|---|---|---|---|---|
  | First run, signed in | 3/3 | 0/3 | 0/3 | 1/3 | 0/3 | 4/15 |
  | After the first fixes, signed in | 3/3 | 3/3 | 2/3 | 3/3 | 0/3 | 11/15 |
  | Now, signed in | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | **12/15** |
  | Now, signed out | 3/3 | 0/3 | 0/3 | 1/3 | 0/3 | 4/15 |

  What moved it: instruction words in the prompt ("…which test to add") stopped counting as search terms; names ending a sentence were recognised; named functions always make the excerpt; the brief searches code for the issue's key words when nothing points at a file; a PR's changed files' imports are always followed; code names ranked so tool names and env vars don't crowd out the function that matters; product names (GitHub) no longer count as code names; a named function's definition is always sent. Signed out, nothing looks inside files, so levels 2+ mostly fail — the case for signing in. Level 5 needs the model to pick files.
- **Caveats:** we wrote the issues knowing the code (bias, even at level 4–5); this repo is small; the on-disk code search only approximates GitHub's ranking; it measures **retrieval**, not whether the final answer is right.
- **Adding to it:** whenever an answer disappoints — here or on a real repo — write the issue as a user would (no file names past level 2), fill in what a correct answer must reach, and run the eval before and after a change. Fix causes that generalise; don't tune the code to these issues alone.

## 9. Summary

GitHub Repo Analyzer is a backend-free Chrome side panel that turns "a repo I've never seen" into "a contribution I can start today". It finds issues that are genuinely available across the whole repo, briefs each one (is it free, where to start, who to ask, how to set it up, what CI will run, and a PR in the repo's own format), explains pull requests including their full conversation and status, surfaces the people who actually maintain the project, scores contributor-friendliness from measured signals, and answers questions from the repo's real source code with line-level citations. Everything is computed client-side from the GitHub API — carefully budgeted, cached and rate-limit-aware — with the user's own AI provider adding summaries on top of deterministic, verifiable data. It's plain JavaScript with no build step, a token-based light/dark design built for a narrow panel, and 245 tests running in CI.
