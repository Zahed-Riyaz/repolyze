# Flow map — design

Date: 2026-11-27 · Status: draft for approval · Replaces the treemap view of `2026-11-26-repo-map-design.md` (built on branch `territory-map`, uncommitted)

## Intent

The repo map's job is to make a newcomer understand **how the app runs** the moment they open it. The treemap built yesterday failed that: block size (amount of code), colour codes and scattered step numbers had to be decoded before it said anything. The user wants something explicit: **a map of files** — boxes for files, arrows for "loads", each file saying in plain words what it is — in **its own browser tab**, with no measure of code size.

## Goals

- Open the map → understand in seconds: where the app starts, what loads what, what everything depends on, what each file does.
- Every box is explicit: file path, a one-line description, and plain tags ("Starts here", "Used by 9 files").
- Descriptions are free and instant by default (taken from the file's own header comment); AI fills the gaps only when the user clicks.
- Public repos cost 0 GitHub API requests (unchanged from the existing crawl).

## Non-goals

- Code size anywhere on the map.
- Contribution views: Welcoming, Busy, Your stack — **dropped** (user decision), including their PR sampling and the "load automatically" setting.
- Call graphs, non-import relationships, languages the crawl doesn't trace (unchanged non-goals).

## Anti-goals

- A legend the user has to learn. If a box needs a legend to be understood, the design failed.
- Guessed descriptions presented as fact: a description is either the file's own comment, an AI line marked as AI, or absent ("No description · Explain").
- AI running without a click, or outside Ask (CLAUDE.md FR-3a stays).

## Constraints

- Plain JS, classic scripts, no build, **no libraries** (user picked a hand-written layout over dagre/ELK).
- Reuse the existing crawl and analysis in `territory.js`: `findEntryPoints`, `mapResolver`, `buildImportGraph`, `loadRepoMap` (0 requests public; private only after a click, ≤ 60 + ≤ 20 manifests), `rankCore`, `readingPath`, `globalScripts`, `mapStore` (newest 20 kept), private maps removed on sign-out.
- Escape everything; guard async renders; theme tokens; light/dark; keyboard reachable.

## Approaches considered (picked in conversation)

- **Where:** own browser tab (picked) · in the side panel (too narrow for branches) · overlay on github.com (fights GitHub's layout).
- **Look:** flow diagram (picked) · numbered reading order · annotated file tree.
- **Layout:** hand-written layered layout (picked) · bundled dagre/ELK (breaks no-libraries, 100–500 KB) · rows without arrows (branches unreadable).
- **Descriptions:** file header comment by default, AI on click for the rest (my proposal, not objected to).
- **Contribution lenses:** drop all three (user decision).

## Design

### 1. The page — `map.html` + `map.js`

- A new extension page, opened by `chrome.tabs.create({ url: "map.html?repo=owner/name" })` from the side panel's **Open the map** button (and from the brief's line, see §6). One tab per repo: if a map tab for that repo is open, focus it instead of opening another (`chrome.tabs.query` by URL).
- **One tab per repo** (my call): if a map tab for that repo is open, it's focused and told (by message) which file to highlight, if any — it doesn't reload.
- Loads the scripts the crawl needs (`github.js`, `retrieval.js`, `stack.js` for `languageOfPath`, `insights.js`/`brief.js` only if a dependency requires it, `territory.js`), then `map.js` (page UI only). The page sets `currentRepo` from the query string and defines its own `isCurrentRepo` stand-in (the panel's lives in sidepanel.js); settings/token are read from `chrome.storage.local` as the panel does.
- Data: `loadRepoMap(repo)` — the stored map (`map_{owner}_{repo}`) when its tree SHA matches, else crawl. Private repo without a stored map → the page shows "Read this private repo's files · about 60 requests" and crawls on click.
- Header: `owner/repo` · "How it runs" · a one-line summary ("Starts in src/index.js · 23 files shown of 140 read") · **Explain this map** button.

### 2. Which files are boxes — `flowFiles(graph, core, steps)` (pure)

- Always: every entry point, every reading-path step, every core file.
- Then files within 3 import steps of the strongest entry, ordered by importers, until **25 boxes** total.
- The rest: grouped per folder into one expandable box "+12 more in routes/"; clicking it replaces the group with its files (still laid out) — up to 60 boxes shown at once, beyond that the group opens as a list.
- Global-scope repos (`globalScripts`): the page is the top box, its scripts in load order below it, the note "These scripts share one global scope — shown in load order".

### 3. Layout — `flowLayout(nodes, edges, { width })` (pure)

- **Rows by depth**: row 0 = entry points; each file's row = its shortest import distance from an entry (from the graph's `depth`). Files reached only through a cap get the row after their importer.
- **Order within rows**: barycentre ordering — a few passes placing each box at the mean position of its importers in the row above, then of what it imports below, to reduce crossings. Ties by path.
- **Edges**: an edge between consecutive rows is a vertical curve; an edge skipping rows routes through the gaps between boxes; edges to an earlier row (cycles) are drawn dashed, not used for rows.
- **Shared dependencies**: a file imported by many (≥ 5 importers, or a core file) is drawn once at its row; instead of drawing every incoming arrow, at most 4 arrows are drawn and the box says "Used by 23 files" (hover lists them).
- Output: `{ boxes: [{ path, x, y, w, h, row }], edges: [{ from, to, points, dashed }], width, height }`. Box width fixed (≈ 220px), height by content.

### 4. A box

```
┌────────────────────────────┐
│ src/db.js      Used by 9 files│
│ Talks to the database        │
│ ↗ GitHub · Ask about this file│
└────────────────────────────┘
```

- Path (monospace). Tags in words, never colour alone: **Starts here** (+ why, e.g. "from package.json main") on entries; **Used by N files** on core files.
- Description line: (a) the file's header comment (see §5); else (b) the AI line after Explain, marked with a small "AI" badge; else (c) muted "No description yet".
- Actions on hover/focus: open on GitHub (`blob/{default}/path`), **Ask about this file** (existing `askAboutFile` → side panel Ask with `@path`).
- Click a box → highlight it, its importers and what it imports; dim the rest. Esc clears.
- Page: pan by drag, zoom with ctrl/⌘ + wheel and +/– buttons, "Fit" button. Keyboard: Tab through boxes in row order, arrow keys move between connected boxes.

### 5. Descriptions without AI — `fileSummary(text, path)` (pure)

- Read during the crawl (the text is already in hand), stored on the node as `desc` (≤ 120 chars, first sentence).
- Sources, first match wins: a JSDoc/block comment or `//` comment lines at the top of the file (after any shebang, `"use strict"`, license header); a Python module docstring; an HTML `<title>`.
- Skipped: license/copyright headers, `eslint`/`@ts-` pragmas, generated-file banners, comments that are only a path or filename.
- The stored map's format gains `desc`. No migration: the earlier map format never shipped (uncommitted), so no version field.

### 6. AI descriptions — Explain this map

- Button in the tab. AI stays in Ask: clicking sends a message to the extension (`chrome.runtime.sendMessage({ type: "explain-map", repo })`); the background opens the side panel for that window (`chrome.sidePanel.open({ windowId })`, allowed from the click) and the panel runs the existing `explainMap()` focused on the map. If the panel isn't loaded yet, the request is left in `chrome.storage.session`/`local` as `pendingExplain` and picked up when the panel starts.
- **What Explain reads** (my call): the boxes currently drawn in the tab (the default ~25, or more if groups are expanded) are sent in the message as a path list; Explain reads the head excerpt of each drawn box that has no description, sharing the provider's context budget with the reading path, and asks for descriptions only for files it actually sent. Public repos: free. Private repos: one contents request per file read, so the button says "Explain this map · about N requests" there.
- The prompt's `roles` block changes from "per folder + core file" to "one line per file shown on the map that has no description" (path — what it does, ≤ 12 words). Parsed by the existing `parseAreaRoles`, saved as `graph.roles` (existing `saveMapRoles`), and the tab redraws when storage changes (`chrome.storage.onChanged` on `map_{owner}_{repo}`).

### 7. The side panel and the brief

- **When the active tab is the map** (my call): the panel treats `map.html?repo=o/r` as repo o/r (Repo, Contribute and Ask stay on that repo, like being on its GitHub page) instead of showing the welcome screen. `handleRepoRefresh` gains this case. So "Ask about this file" and Explain work straight from the map tab.

- **Repo tab**: the treemap card is replaced by a compact card: "How it runs · Starts here: `src/index.js` → `src/app.js` → … · 23 files" + **Open the map** button (+ "Explain this map"). Same loading/needs-click/error states as today.
- **Issue brief**: the mini map is replaced by one line placing the issue's files on the path, e.g. "`index.js → app.js → **router.js**`" (shortest import chain from the entry), with "Open on the map" opening the tab with that file highlighted (`map.html?repo=o/r&file=src/router.js`). A `file=` that isn't among the default boxes is added as a box, with the files on its import chain from the entry (my call). Files the crawl never reached get the line "not reached from the entry point" and Open the map opens it without a highlight. The collision line is removed (it depended on Busy).

### 8. Removed

- Treemap: `mapNodes`, `squarify`, `mapToneOf`, `mapEvidence`, `mapCrumbs`, zoom, tones, lens buttons, legend and its CSS.
- Contribution lenses: `territorySampleSize`, `loadTerritory`, `readTerritory`, `territoryPicks`, `folderStats`, `mergeStats`, `classifyFolder`, `TERRITORY_RULES`, the Busy/Stack/Welcoming UI, `collisionLine`, the `territoryAuto` setting in the panel and options page, and their tests.
- CLAUDE.md updated to match (FR-11a rewritten, endpoints/budgets lose the PR-file sampling, tests table).

## Tests

- `fileSummary`: JSDoc, `//` lines, Python docstring, HTML title, license headers skipped, pragmas skipped, length cap.
- `flowFiles`: entries/steps/core always in; 25-box cap; folder grouping; expanding a group; global-scope case.
- `flowLayout`: rows by depth; crossings reduced on a known crossing example; skipped-row edges don't pass through boxes; cycle edges dashed; shared dependency drawn once with ≤ 4 arrows; deterministic output.
- Page: opening `map.html?repo=o/r` with a stored map draws boxes with paths, tags and descriptions, makes 0 API requests; private + no map → click gate; one tab per repo; `file=` highlights; escaping of hostile paths/descriptions.
- Explain: the tab's button reaches the panel's `explainMap` (also when the panel starts after the click); roles land in storage and the tab redraws with "AI" badges.
- Panel: Repo tab card and brief line render; Open the map opens/focuses the tab; removed features are gone (no lens buttons, no `territoryAuto`).
- Budgets unchanged: opening a repo 4; brief 2; public map 0.

## Left to the builder

- Exact box styling, spacing, curve shapes, pan/zoom feel, hover-list design.
- Barycentre pass count; minor routing details.
- Whether the background or the panel owns the "one tab per repo" lookup.
