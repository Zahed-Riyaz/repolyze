# Repo map — design

Date: 2026-11-26 · Status: draft for approval

## Intent

Understanding a large, unfamiliar repo is a bigger blocker for newcomers than finding an issue: they don't know which file to open first, where the app starts, or which files everything else depends on. The repo map answers that **visually, in the browser, before cloning anything**. It's a map of the repo that marks where the app starts, makes the core files stand out, draws a numbered reading path through them, and — when the user asks — has their AI explain what each area does and how the app runs, citing `path:line`.

Secondary views on the same map show contribution context (Welcoming, Busy, Your stack) from PR history — data Claude Code can't see from a local clone.

## Goals

- In one look: where the app starts, what the core is, and which ~8 files to read, in order.
- Every marking has its evidence: "entry point — `package.json` `main`", "imported by 23 files", "loaded by ② `app.ts`".
- **Explain this map** turns the structure into understanding: a one-line role per area on the map, and a short story of how the app starts and runs, with checked citations.
- Works with no AI key (everything except the explanation) and costs no GitHub API quota for public repos.

## Non-goals

- Following function calls (a call graph) — imports only in v1.
- Import tracing for languages other than JS/TS and Python in v1 (Go, Rust, Java etc. get structure + entry points, labelled "imports not traced for Go yet").
- Line-level heat, contributor progression, review-comment mining.
- Changes to the page guide on GitHub issue pages (`content.js`).

## Anti-goals

- A marking or role without evidence. Thin or missing data is shown as such ("not traced", "not enough data") — never guessed.
- AI running without a click, or outside Ask (keeps FR-3a: all AI work happens in Ask).
- Spending GitHub API requests the user didn't choose to spend. Opening a repo still costs 4; opening a brief still costs 2.

## Constraints

- Plain JS, classic script, no build, no libraries. New file `territory.js` (panel only, not in `background.js`), added to `sidepanel.html`, `test/helpers/panel.js` (same order) and `npm run check`; after `retrieval.js`, `insights.js`, `brief.js`, `guide.js`, `ask-focus.js`, `stack.js`, before `sidepanel.js`.
- GitHub API calls through `fetchGitHub` / `fetchGitHubPage`; file contents through `readRepoFile` (raw for public repos — no quota; the contents API for private ones — costs quota).
- Escape everything interpolated into markup; guard async renders with `isCurrentRepo(key)`; colours from `theme.css`; respect reduced motion.
- Pure logic separate from requests and rendering, unit-tested.

## Approaches considered

- **A. Import map, no AI** — entry points, most-imported files, reading path. Instant, free, deterministic; but names alone don't say what parts *do*.
- **B. A + AI explanation on click (chosen)** — adds the roles and the story, where the understanding comes from, while keeping AI user-triggered and inside Ask.
- **C. Call graph from the entry point** — the truest picture of execution, but needs per-language parsing; deferred.

Earlier in the conversation the map was designed for contribution only (folder colours from PR history). The user moved understanding to the centre; those views are kept as secondary lenses.

## How it works

### 1. Entry points — `findEntryPoints(tree, files)` (pure)

Returns `[{ path, reason }]`, strongest first:
- `package.json`: `main`, `module`, `bin` (each), `exports["."]`, and the file in `scripts.start` / `scripts.dev` when it names one (`node src/server.js`, `tsx src/index.ts`).
- Python: `[project.scripts]` / `console_scripts` targets in `pyproject.toml` / `setup.cfg` (module → file), `__main__.py`, `manage.py`, `app.py` / `main.py` at the root or one level into `src/`.
- Browser extensions: `manifest.json` `background.service_worker`, `side_panel.default_path`, `content_scripts[].js`.
- Fallback: the existing `ENTRY_FILE` rule from `repoStarters` (`ask-focus.js`) — shallowest `main|index|cli|app|server|__main__` file. Moved into `territory.js` (or `retrieval.js`) and shared so both use the same rule.
- Manifests are already read for the flow (`loadRepoFlow`); reuse those reads.
- In monorepos (`packages/*`, `apps/*`, the existing `CONTAINER_DIRS`), entries per package, capped at 6 overall.

### 2. Import graph — `buildImportGraph(repo, entries)` (reads files)

- Crawl outward from the entry points: read a file (`readRepoFile`), `parseImports` → `resolveImport` (both existing, `retrieval.js`) against the tree's paths, queue what it imports. Breadth-first, so the files nearest the entry are read first.
- Cap: 300 files read (public repos — no quota, ~8 in parallel). Private repos: 60, and only on a click (each read costs a request); the section says "about 60 requests".
- Skips `NOISE_PATH`, `NOT_CODE`, files over `MAX_FILE_BYTES` (existing).
- **Loads that aren't imports** (my call): a map-only `parseLoads(text, path)` adds edges for HTML `<script src>` (incl. `type="module"`, so Vite-style `index.html` entries work), `importScripts(...)` in workers, and `manifest.json`'s script/page fields. HTML files are read and crawled like code. Shared `parseImports` is not changed, so Ask's retrieval and the eval are unaffected.
- **Classic-script repos** (scripts loaded by one HTML page sharing a global scope, e.g. this repo): import edges between them don't exist. The map says "These N scripts share one global scope — shown in load order", the reading path follows the HTML's load order (entry page → its scripts in order, ≤ 8), and core falls back to the largest of them. Cross-file identifier analysis is out of scope.
- **Monorepos** (my call): a map-only resolver wraps `resolveImport` — first `resolveImport`, then workspace packages (`package.json` `workspaces` / `pnpm-workspace.yaml` → each package's `name` → its `main`/`exports`/`src/index`) and `tsconfig.json` `compilerOptions.paths`. Shared `resolveImport` is not changed; improving Ask's resolution the same way is a possible follow-up, not part of this.
- Output: `{ nodes: Map<path, { inDegree, depth }>, edges: [[from, to]], entries, truncated, traced: Set<language> }`. Files in the tree that weren't reached stay on the map as "not reached from the entry points".
- Stored in `repoCache[key].map` and in `chrome.storage.local` (small: paths + edges), keyed by the tree's SHA, so reopening costs 0 reads until the default branch changes. Pruned with the existing cache rules.

### 3. Core and reading path — `rankCore(graph)`, `readingPath(graph)` (pure)

- **Core** = the reached files with the most importers (top 10, and at least 3 importers), excluding tests, types-only files and barrels (an `index` file whose body is only re-exports counts through to what it re-exports).
- **Reading path** (≤ 8 steps): start at the strongest entry; then repeatedly take the not-yet-listed file that the path so far imports and that has the highest in-degree, preferring smaller depth; core files not yet reached by step 6 are appended. Each step carries its reason: "entry point (`package.json` main)", "loaded by ① `index.ts` · imported by 23 files".

### 4. The map — `squarify` + `renderTerritory` (layout pure, drawing DOM)

- Treemap (squarified, sized by code bytes from the tree) of folders, two levels visible; click to zoom; at a leaf folder the blocks are files. Breadcrumb to go back up. Tiny blocks merge into "N smaller folders/files".
- **How it runs** view (default): entry blocks in the accent colour, core files strong, reached files normal, not-reached dim, not-traced languages hatched with a note. Reading-path numbers (①②③) sit on the blocks that contain those files.
- Under the map, the **reading path as a list**: number, file, reason. Each row: open on GitHub (`blob/{default}/path`), and **Ask about this file** (opens Ask with `@path` filled in — the existing `@` file mention).
- Hover/focus on a block: path, size, its marking with evidence, and its role once explained. Blocks are keyboard-focusable; `aria-label` = path + marking.
- Lens buttons: **How it runs** · Welcoming · Busy · Your stack.

### 5. Explain this map — AI, in Ask

- A button on the map: **Explain this map**. Clicking it sets a new Ask focus kind, `map` (`setChatFocus({ kind: "map", key, title: "the repo map" })`; chip "About the repo map"), switches to Ask and sends a visible question: "Explain how this repo is organised and how it runs." (`focusedItem`, `renderChatFocus` and `focusLabel` in `ask-focus.js` currently assume issue/PR and need a `map` case.)
- `buildFocusedContext` gets a `map` branch (`mapFocusContext`): a compact graph summary (folders with sizes, folder-to-folder import counts, entries, core, the reading path with reasons) plus the reading-path files' heads and key windows via the existing `extractSnippets` / `packContext`, within the provider's `CONTEXT_BUDGET`.
- The prompt asks for two parts:
  1. A fenced block tagged `roles` with one line per top folder (and per core file): `path — role` (≤ 12 words, from the code sent, "unclear" if the excerpts don't show it).
  2. A short walk-through: how the app starts and what happens next, following the reading path, citing `path:line`.
- `parseAreaRoles(answer)` (pure) reads the `roles` block; roles are stored with the map (same tree SHA) and shown on the map's blocks and in hover. The walk-through renders in Ask like any answer: citations checked by `checkCitations`, saved to history with its `focus` tag. The `roles` block itself is hidden from the rendered answer.
- Follow-ups while the chip is on stay grounded in the map. ✕ clears it, as for briefs.
- **Ask about this file** (reading-path row) clears the map focus first and uses the normal `@path` mention, which reads the file directly (my call — keeps `mapFocusContext` simple and the file's answer about the file).
- No AI key → the button opens the existing "set up a provider" prompt.

### 6. Contribution lenses (secondary)

Designed first, now secondary:
- **Welcoming**: from a sample of PRs' changed files (`/pulls/{n}/files`; signed in: 20 closed — outsider PRs first — plus every open PR up to 30; signed out: 6 + 4). Closed PRs come from the request `loadHealthSignals` already makes (shared cache). Fewer than 3 PRs in a folder → "not enough data"; ≥ 60% of outside PRs merged and median outsider decision (open → merged/closed) ≤ 14 days → welcoming; < 30% merged → guarded; only member PRs → "only maintainers have changed this recently"; anything in between (30–60% merged, or ≥ 60% but slower than 14 days) → neutral, "mixed: 45% of outside PRs merged · median 21 days". Thresholds in `TERRITORY_RULES`.
- **Two levels on the treemap**: every folder gets its own tone from its own rolled-up stats (parent and child classified independently); the parent's tone is the block's frame, children's tones fill it.
- **Busy**: open PRs changing a folder; says "N of M open PRs checked" when not all were. The open-PR list reuses the Contribute tab's already-loaded open PRs when present; otherwise one `/pulls?state=open&sort=updated&direction=desc&per_page=30` request.
- **Your stack**: a folder's languages (`languageOfPath`) vs. your stack (`loadStackProfile`); signed out → sign-in prompt.
- Counting (`folderStats`, pure): a PR counts once per folder, rolled up to every ancestor; outsider = `author_association` not OWNER/MEMBER/COLLABORATOR; bots skipped (`isBot`); owners via `codeOwnersFor`. Colours via `classifyFolder(stats, lens)` → `{ tone, reasons[] }`.
- These cost GitHub API requests (about 1 + up to 50 signed in, 11 signed out), so they follow the user's choice (decided in conversation): Settings toggle **Load contribution views automatically** (`territoryAuto` in `chrome.storage.local`, synced with the options page; default **off** — my call). Off: picking one of these lenses shows "Load · about N requests". A rate limit mid-way draws what arrived, marked "Partial — k of N PRs"; a partial result isn't treated as complete next time. A failure here never marks the Repo tab as failed.

### Where it appears

- **Repo tab, at the top** (understanding is the point). The How it runs view loads when the Repo tab opens for public repos (0 API requests; file reads from raw); private repos show "Show the map · about 60 requests".
- **Issue brief**: under "Where to start", a mini map in the How it runs view with the issue's files (`resolveIssueFiles`) outlined and a line placing them: "`src/router.ts` is step ③ on the reading path" or "2 imports from the entry point". Draws only from an already-built map; otherwise "Show on the map" (public: free; private: costs as above). If Busy data is loaded and an open PR touches those files: "PR #412 is already changing `src/router.ts`".

## Tests (`test/territory.test.js`)

With `loadPanel()` / `githubMock()` (raw files from the mock):
- `findEntryPoints`: package.json main/bin/scripts, pyproject scripts, `__main__.py`, extension manifest, monorepo packages, fallback rule (and `repoStarters` still picks the same entry).
- `buildImportGraph`: crawls from entries, stops at the cap and says truncated, skips noise, unsupported languages listed as not traced, cached by tree SHA (second build reads 0 files).
- `rankCore` / `readingPath`: barrels counted through, tests excluded, path order and reasons.
- `squarify`: full coverage, no overlaps, tiny blocks merged.
- Explain: the click sends one visible question with focus `map`; the context holds the graph summary and reading-path files within budget; `parseAreaRoles` reads roles and they appear on the map; the roles block isn't shown in the answer; no AI call before the click.
- Budget: opening a repo still 4; Repo tab's How it runs view 0 API requests (public); private → nothing until clicked; contribution lenses 0 until loaded unless the toggle is on; brief still 2.
- Contribution lenses: outsider-first sampling, outsider-only decision days, "not enough data", "N of M checked", partial loads.
- Stale render never draws into another repo; folder/file names escaped.

## Left to the builder

- Visual styling, tone colours, tooltip, minimum block size, exact layout of the reading-path list.
- Exact `roles` prompt wording and how many core files get roles.
- Whether the shared entry rule lives in `territory.js` or `retrieval.js`.
- Updating `CLAUDE.md` once built (new FR on the Repo tab, the `map` focus kind in Ask, the API/AI budget rows, endpoints, tests table and count, system diagram).
