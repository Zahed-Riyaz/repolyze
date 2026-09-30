// Made-up issues about this repo, for the retrieval eval (eval/run.js). None of
// them will be implemented; they exist because we know exactly which code a
// correct answer needs. Each level is more ambiguous than the last:
//   1 — names the file and the function
//   2 — names the function only
//   3 — names a UI element or concept the code also uses, but no code names
//   4 — describes behaviour in the user's words only
//   5 — a vague symptom; any one of several places counts as a good start
// `expect.files` must all be read (or, with `any: true`, at least one);
// `expect.defs` are functions whose definition line must be in what's sent.
// To add one: write it as a user would (no peeking at file names past level 2),
// then fill in what a correct answer must reach.

module.exports = [
  // ── Level 1: file and function named ──────────────────────────────────────
  { level: 1, title: "extractSnippets in retrieval.js should use longer windows for Python files",
    body: "In retrieval.js, extractSnippets always keeps 40-line windows. Python functions are often longer than that, so use 60 lines for .py files.",
    expect: { files: ["retrieval.js"], defs: ["extractSnippets"] } },
  { level: 1, title: "parseCodeOwners in insights.js ignores negated patterns",
    body: "parseCodeOwners in insights.js should skip CODEOWNERS lines that start with ! the way GitHub treats them.",
    expect: { files: ["insights.js"], defs: ["parseCodeOwners"] } },
  { level: 1, title: "prStatus in pr-brief.js should mention dismissed reviews",
    body: "When a review was dismissed, prStatus in pr-brief.js drops it silently. Add a reason line saying who dismissed it.",
    expect: { files: ["pr-brief.js"], defs: ["prStatus"] } },

  // ── Level 2: function named, no file ──────────────────────────────────────
  { level: 2, title: "looksLikeClaim misses \"I'll open a PR for this\"",
    body: "Comments like \"I'll open a PR for this tonight\" aren't treated as claims by looksLikeClaim, so the issue still shows as free.",
    expect: { files: ["brief.js"], defs: ["looksLikeClaim"] } },
  { level: 2, title: "suggestFiles should prefer files from earlier answers",
    body: "When typing @ in the chat, suggestFiles only ranks by name. Files that were read for earlier answers in the conversation should come first.",
    expect: { files: ["sidepanel.js"], defs: ["suggestFiles"] } },
  { level: 2, title: "pollDeviceToken should give up after repeated slow_down",
    body: "If GitHub keeps answering slow_down, pollDeviceToken keeps polling until the code expires. Stop after three and tell the user.",
    expect: { files: ["auth.js"], defs: ["pollDeviceToken"] } },

  // ── Level 3: UI or concept words, no code names ───────────────────────────
  { level: 3, title: "Rate-limit banner should say how many requests are left",
    body: "The banner that appears when GitHub's hourly limit is low only says it's low. It should show the exact number of requests left, and the badge tooltip should show when the limit resets.",
    expect: { files: ["sidepanel.js"], defs: ["renderRateLimit"] } },
  { level: 3, title: "Health score should ignore issues closed as not planned",
    body: "The contributor-friendliness score counts every closed issue when it measures maintainer response. Issues closed as not planned shouldn't count as a response.",
    expect: { files: ["insights.js"], defs: ["scoreHealth"] } },
  { level: 3, title: "Contributor guide card should remember being collapsed",
    body: "The contributor guide card on GitHub issue pages opens again after every page reload, even when I collapsed it last time.",
    expect: { files: ["content.js"], defs: ["startGuide"] } },

  // ── Level 4: behaviour in the user's words only ───────────────────────────
  { level: 4, title: "My languages stay highlighted after I sign out",
    body: "After I sign out, the issue list still highlights the languages I know until I close and reopen the panel.",
    expect: { files: ["stack.js", "auth.js"], any: true } },
  { level: 4, title: "Links in answers open the wrong copy of the code for pull requests from forks",
    body: "When I ask about a pull request that comes from someone's fork, some of the links in the answer open the main repository instead of the fork, so the line numbers don't match.",
    expect: { files: ["sidepanel.js", "ask-focus.js"], any: true } },
  { level: 4, title: "Pasting a commit link into the pull request search should find its PR",
    body: "If I paste a link to a commit into the pull request search box, nothing useful happens. It should find the pull request that contains that commit.",
    expect: { files: ["pr-brief.js"], defs: ["parseFindQuery"] } },

  // ── Level 5: vague ────────────────────────────────────────────────────────
  { level: 5, title: "The panel feels slow on really big projects",
    body: "On large repositories everything takes a while to show up.",
    expect: { files: ["retrieval.js", "stack.js", "github.js", "guide.js"], any: true } },
  { level: 5, title: "The list of what an issue needs sometimes looks wrong",
    body: "For some issues the files it says I need don't seem related at all.",
    expect: { files: ["guide.js", "stack.js"], any: true } },
  { level: 5, title: "Hard to tell which parts of an answer to trust",
    body: "Some answers sound sure of themselves but I can't tell what they're based on.",
    expect: { files: ["sidepanel.js", "retrieval.js"], any: true } },
];
