# Map tab look — design (prototype)

**Why:** the flow map was correct but tiring to read. Arrows tangled across rows, every box looked the same ("No description yet", "Used by N" on almost all), folders were scattered, and names broke mid-word. The goal is a map someone can read within seconds of opening it.

**Approaches considered** (shown as clickable demos on EvalAI's real map):
- A. One column per folder, with a shared strip at the bottom for folders every part uses. Most arrows would stay inside a column.
- **B. Keep the rows by import distance, declutter and polish. Chosen by the user.**

**What B does** (`map.js`, `map.css`, `map.html`):
- **Rows:** each row sits on a soft band, labelled on the left: ▶ Starts here, 1 step away, 2 steps away…
- **Within a row:** files sit next to others from the same folder, and folded "+N more" boxes go last.
- **Folder colours:** each folder gets a colour (a top folder, or two levels under `src/`, `apps/`, `packages/`…), biggest folder first, from an 8-colour palette. The colour shows as a small chip under the file name. A row of folder chips under the header picks one folder out; click it again or press Esc to clear.
- **Cards:**
  - the file name is large, with its folder small underneath;
  - the reading order is a numbered circle;
  - ▶ Starts here appears on the start file;
  - "Used by N files" appears only on the 6 most-used files;
  - a description appears only when there is one, so "No description yet" is gone;
  - names never break mid-word.
- **Arrows:** all are drawn but hidden. Pointing at a file (hover or keyboard focus) or picking it (click) shows its arrows. They fade in and flow in the import's direction: blue out to what it loads, amber in from what loads it. Linked cards get a matching outline, and everything else fades.
- **Motion:**
  - cards rise in row by row on the first draw only;
  - the picked card lifts and glows in its folder's colour;
  - all motion is off under `prefers-reduced-motion`.
- **Theme:** colours come from `theme.css`, so light and dark both work. The canvas has a faint dot grid.

**Not changed:** the crawl, `flowFiles` and `flowLayout` (rows and which files are shown), pan and zoom, Fit, Explain, Ask about this file, GitHub links, and the side panel card.

**Builder's calls:**
- The palette.
- `FM_USED_TOP = 6`.
- Rows are re-sorted by folder inside `map.js`, after `flowLayout` has ordered them by barycentre. Arrows are hidden until you point at a file, so crossings matter less than grouping.
