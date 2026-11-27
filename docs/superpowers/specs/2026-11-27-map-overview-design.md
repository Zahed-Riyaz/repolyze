# Map overview — design

**Why:** an experienced developer opening an unfamiliar repo is asking three things:
1. What are the main parts?
2. What happens when it runs?
3. Which few ideas does everything revolve around?

The file map answered none of these at a glance, and it pointed readers at the wrong files:
- **Pass-through files** (`__init__.py`, `index.ts`) only re-export, yet took 5 of langchain's 8 reading steps and its biggest "Used by" counts.
- **Helpers** (`utils`, `compat`, `_types`…) filled requests' and vite's reading order.
- **Too much on screen:** 25 boxes.

**Approach** (agreed on a mockup with langchain, EvalAI and requests): the map tab opens on an **overview**, and the file map is one click away.

## What gets recognised (territory.js)

- **Pass-through files** (`barrel`). In JavaScript, every line re-exports. In Python, an `__init__.py` whose top-level statements are only:
  - imports;
  - `__all__`;
  - a docstring;
  - `TYPE_CHECKING` blocks;
  - lazy-import plumbing (`__getattr__`/`__dir__`, `_dynamic_imports = {…}`).

  Their imports are followed through to the real files (`mapView`): "Used by" counts and arrows go to the files behind them. One is kept only when it is a start point, and is shown as its folder (`prompts/`).
- **Helpers** (`helper`), recognised by name:
  - `utils`, `helpers`, `constants`, `types`/`typing`, `compat`, `exceptions`/`errors`, `logger`/`logging`, `globals`, `version`, `status_codes`, `structures`, `deprecation`, `import_utils`;
  - Django's `settings`, `config`, `admin` and `apps`;
  - private (`_x`) files or folders that tie fewer than 3 real files together.

  Helpers are never a reading step or a "used by many" file, and are hidden on the file map behind **Show helpers (N)**.
- **What a file defines** (`defs`), read during the crawl at no extra cost:
  - Python: top-level `class` and `def`;
  - JS/TS: `export class` / `function` / `const`, and `exports.x =`.

  Names are ranked by how many files import them, and the top few are kept.
- **Main parts** (`parts`): the count of code files per area (a top folder, or two levels under `src/`, `apps/`, `libs/`, `packages/`…), taken from the tree. Tests, scripts, docs, examples, migrations, static and vendored files don't count.

## How it runs (`readingPath`, replaced)

- **Start:** among the start points, the package the other parts depend on most. If the start loads no real file (Django's `manage.py`), the chain begins at the file in its part that ties the most real files together.
- **The chain:** each next file is loaded by the previous one, chosen by importance: used by many real files, plus twice the number of real files it ties together. At a dead end, it continues from an earlier step. It is never a helper, a pass-through file or a test.
- **Order:** a file comes before the files it uses.
- **Length:** at most 6 steps.
- **Same output shape as before** (`{ step, path, reason }`), so the Repo tab card, Explain this map's context and the issue brief all use it unchanged.

## The map tab

- **Overview** (opens first):
  - *How it runs:* the chain as numbered cards, each with the file name (or `folder/` for a package), its folder, its description and **defines** `Name · Name`.
  - *Main parts:* up to 6, each with its file count, a description from its package docstring, and "mainly `models` · `views`".
  - A note of what was left out, and **Show the full file map**.
  - Clicking a step opens the file map on that file. Clicking a part opens the file map with that folder picked out.
- **File map:**
  - about 12 boxes, down from 25;
  - pass-through files dissolved;
  - helpers hidden until **Show helpers**.
- Header switch: **Overview · File map**. `?file=` opens the file map directly.

**Crawl version 4:** stored maps are rebuilt once.

**Not changed:** the crawl's reach, pan and zoom, the look, Explain and Ask.
