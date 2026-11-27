# "How does X work?" — feature trace design

**Why:** the map shows a repo's structure but doesn't help someone with a specific question. A newcomer's real question is: "how does *this feature* work, and which functions do I read to understand it?" The answer should be **the functions to read, in the order they run**, placed on the map.

**Principle** (the user's): do everything that can be computed before involving the AI, as the retrieval behind Ask does. Call the AI only when the computed result is unsure, and send the smallest thing that answers the question.

## Step 1: no AI (feature.js)

- **Words:** `queryTerms(question)` minus filler ("how", "work", "feature", "function"…).
- **Files read:** ≤ 12 on public repos (raw, free), ≤ 6 on private ones (contents API). They're picked from:
  1. path ranking (`rankCodeFiles`);
  2. files whose recorded names (`defs`) contain a word;
  3. when signed in, `searchCodeFor` for the 2 strongest words (≤ 2 code-search requests).
- **Functions:** each function or class is pulled out with its line, docstring and body:
  - Python `def`/`class`, ended by indentation;
  - JS/TS `function`, methods, `const x = (…) =>`/`function`, ended by the next one.
- **Score:** 3 per word in the **name** (camelCase/snake_case split and stemmed), 1.5 per word in the **docstring**, and 0.5 per word in the **body** (at most 3 counted).
- **Calls:** f → g when f's body has `g(` or `.g(`.
- **Steps (≤ 6):** the best-scoring functions with a name or docstring hit, ordered callers first. Ties go to the file nearer the start on the map, then to the higher score.

## The threshold for AI (exact)

| Outcome | Rule | What happens |
|---|---|---|
| **Confident** | ≥ 2 functions with a word in their name **and** coverage ≥ ⅔ (the question's words found in those functions' names or docstrings — both words of a two-word question) **and** ≥ 2 of the steps linked by a call | The trace is shown, labelled "found by name". No AI. |
| **Partial** | ≥ 1 name match, but not confident | The trace is shown, labelled "partial — only *submission* matched", with **Fill the gaps with AI** (one click). |
| **Nothing** | No function name or docstring contains any word | AI runs at once on the index, since asking the question was the action. Without an AI provider: "No function mentions *grading*. Try a word from the code, or set up an AI provider." |

*Changed from the agreed 50% after testing on EvalAI: "how does a submission get scored" passed at 50% on "submission" alone (hundreds of functions) with nothing about scoring — a confident wrong answer.*

## Step 2: AI picks from an index (only for Partial on a click, or Nothing)

- **Index:** ≤ 80 numbered entries, `n. path:line name — first docstring line`. It holds every function in the files read, then the names the crawl recorded in the map's most-used and reading-path files. About 1–2k tokens; never whole files.
- **Prompt** (system slot):
  - pick from the list only;
  - return JSON `[{"n": 3, "why": "≤ 12 words"}]` in the order they run, at most 6;
  - `[]` if nothing fits.
- **Checking:** numbers outside the list are dropped. A picked entry without a line has its file read (free) to find the line.
- **Where it runs:** the side panel, which holds the AI keys. The map tab sends `map-feature-ai` and gets the picks back. If the panel is closed, the tab says to open it.
- **Labels:** "by name + AI" or "by AI".

## Step 3: Explain the code (a click)

This sends a visible question to Ask: "Walk me through how … works, in this order: ① @path name() …". `@path` reads those files directly, and answers cite `path:line` and are checked like any Ask answer.

## UI (map tab)

- **Where:** a bar under the header: **How does [ … ] work?** It's available in both the overview and the file map.
- **Results panel:** numbered steps, each showing `file · name()`, `L212` (linking to the line on GitHub) and its docstring line. Below the steps:
  - how it was found;
  - the threshold's numbers on hover;
  - buttons: **Fill the gaps with AI** (partial only), **Show on the file map** and **Explain the code**.
- **On the file map:** the steps' files are shown and numbered, and everything else fades.

**Budget:** 0 API requests on public repos (raw reads), plus ≤ 2 code searches when signed in. Private repos cost ≤ 6 contents requests. AI is used only as described above.
