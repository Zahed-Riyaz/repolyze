// ── Ask, focused on an issue or PR ───────────────────────────────────────────
// Every AI task runs in Ask. A brief's "Ask about this issue / PR" row (or one
// of its suggestions) opens Ask with that item in focus, shown as a chip above
// the input. While focused, answers are grounded in the item:
//   • issue — the issue and its discussion, plus the code the question points
//             at (chat retrieval; follow-ups carry the files behind the last answer)
//   • PR    — its description, status, whole activity log and numbered diff
// Removing the chip (✕) goes back to questions about the repo as a whole.

let chatFocus = null; // { kind: "issue" | "pr", number, key, title }

// The focused item with its loaded brief, if it belongs to the repo on screen
function focusedItem() {
  if (!chatFocus || !isCurrentRepo(chatFocus.key)) return null;
  const cache = cacheFor(chatFocus.key);
  const brief = chatFocus.kind === "pr" ? cache.prBriefs?.[chatFocus.number] : cache.briefs?.[chatFocus.number];
  return brief ? { ...chatFocus, brief } : null;
}

const focusLabel = (f) => `${f.kind === "pr" ? "PR " : ""}#${f.number}`;

function setChatFocus(focus) {
  chatFocus = focus;
  renderChatFocus();
}

function renderChatFocus() {
  const el = document.getElementById("chat-focus");
  const f = focusedItem();
  el.hidden = !f;
  el.innerHTML = f
    ? `${icon(f.kind === "pr" ? "pr" : "issue", "icon-sm")}<span class="chat-focus-text">About <strong>${focusLabel(f)}</strong> ${escapeHtml(f.title)}</span>` +
      `<button class="chat-focus-clear" title="Ask about the whole repo instead" aria-label="Stop asking about ${focusLabel(f)}">${icon("x", "icon-sm")}</button>`
    : "";
  document.getElementById("chat-input").placeholder = f ? `Ask about ${focusLabel(f)}…` : "Ask about this repo…";
}

// From a brief: focus Ask on it, then send a suggestion or wait for the
// user's own question. A reply that's still streaming is never interrupted —
// the suggestion waits in the input instead.
function askAboutBrief(kind, index = null) {
  const view = kind === "pr" ? activePrBrief : activeBrief;
  const brief = kind === "pr" ? currentPrBrief() : currentBrief();
  if (!view || !brief) return;
  setChatFocus({ kind, number: view.number, key: view.key, title: kind === "pr" ? brief.pr.title : brief.issue.title });
  switchTab("chat");
  const input = document.getElementById("chat-input");
  input.value = index === null ? "" : ASK_PROMPTS[kind][index].q(view.number);
  autosizeChatInput();
  if (index !== null && !document.getElementById("send-btn").disabled) return handleChat();
  input.focus();
}

// ── Context ──────────────────────────────────────────────────────────────────
function issueFocusContext(brief) {
  const { issue, comments, availability } = brief;
  const discussion = issueDiscussion(comments);
  return `<issue number="${issue.number}">
Title: ${issue.title}
Labels: ${issue.labels.map(l => l.name).join(", ") || "none"}
Opened by @${issue.user?.login || "unknown"} ${daysAgo(issue.created_at)}. Availability: ${availability.verdict} — ${availability.reasons.map(r => r.text).join("; ")}.

${(issue.body || "(no description)").slice(0, 3000)}
</issue>${discussion ? `\n\n<discussion>\n${discussion}\n</discussion>` : ""}`;
}

function prFocusContext(brief, budget) {
  const { pr, status, checks } = brief;
  const eventLog = prEventLog(pr, brief.timeline, brief.reviewComments, Math.floor(budget * 0.35));
  const diff = prDiffContext(brief.files, brief.reviewComments, Math.floor(budget * 0.4));
  const linked = linkedIssueNumbers(pr.body);
  return `<pull_request number="${pr.number}">
Title: ${pr.title}
Author: @${pr.user?.login}
Branch: ${pr.head?.label || pr.head?.ref} → ${pr.base?.ref}
Size: +${pr.additions ?? "?"} −${pr.deletions ?? "?"} across ${pr.changed_files ?? "?"} files, ${pr.commits ?? "?"} commits
${linked.length ? `Closes: ${linked.map(n => `#${n}`).join(", ")}\n` : ""}Status: ${status.verdict}. ${status.reasons.map(r => r.text).join("; ")}.${checks ? `\nChecks: ${checks.passed} passed, ${checks.failed.length} failed${checks.failed.length ? ` (${checks.failed.join(", ")})` : ""}, ${checks.pending.length} running.` : ""}

${(pr.body || "(no description)").slice(0, 2000)}
</pull_request>

<activity>
${eventLog.text || "(no activity yet)"}
</activity>

<diff>
Diff lines start with the new file's line number: "42+|" added, "42 |" unchanged, "  -|" removed.
${diff.text || "(no diff available)"}${diff.skipped.length ? `\n(Not shown: ${diff.skipped.join(", ")})` : ""}
</diff>`;
}

// The issue or PR is the source of truth; these rules go into the system prompt
const FOCUS_RULES = {
  issue: [
    "Treat the issue as the source of truth. To reproduce it, use the steps the issue gives, not generic setup commands from the README.",
    "If the issue names functions or files, or suggests a fix, find them in the context and cite them as `path:line`. If one isn't in the context, say so; never name a different function in its place.",
  ],
  pr: [
    "The PR's changed files appear twice: as a diff (new line numbers, \"42+|\" added) and at the PR's head commit in <changed_files_at_head>. <related_code> is unchanged code from the default branch.",
    "Cite code as `path:line` and attribute points in the discussion to people (@name).",
  ],
};

// → { context, sources, ref, cite, focus } for a question about the focused item.
// Both kinds retrieve the files that matter, not just the item's own text:
//   issue — the question *and* the issue's text drive retrieval; the brief's
//           "Where to start" files are read first; names the issue mentions are
//           traced to their definitions (code search, or name search without a token)
//   PR    — its discussion and diff, the changed files read at the PR's head around
//           what changed, and related unchanged code (the changed files' imports and
//           names the PR mentions) from the default branch
// Sources carry `at` when they live somewhere other than the default branch (a
// PR's head, often in the author's fork), so citations link to the right place.
// `opts` ({ files, onFiles }) pass through to buildChatContext.
async function buildFocusedContext(repo, item, question, previousQuestion, onStatus, previousFiles, opts = {}) {
  const isPr = item.kind === "pr";
  const noun = isPr ? "pull request" : "issue";
  const focus = [`The user is asking about ${noun} #${item.number} ("${item.title}"), shown in the <${isPr ? "pull_request" : "issue"}> block of the context. Answer about this ${noun} specifically.`,
    ...FOCUS_RULES[item.kind]].join("\n- ");
  const budget = CONTEXT_BUDGET[aiProvider] || 20000;

  if (isPr) {
    const { pr, files } = item.brief;
    const [owner, name] = (pr.head?.repo?.full_name || `${repo.owner}/${repo.repo}`).split("/");
    const head = { owner, repo: name, ref: pr.head?.sha || pr.head?.ref };
    onStatus("Reading the PR's conversation and diff…");
    const prBlock = prFocusContext(item.brief, Math.floor(budget * 0.5));
    onStatus("Reading the changed files…");
    const atHead = head.ref ? await prHeadSnippets(head, files, Math.floor(budget * 0.2)) : { text: "", sources: [], files: [] };
    const related = await buildChatContext(repo, question, previousQuestion || pr.title, onStatus, {
      ...opts, previousFiles, about: `PR #${pr.number}: ${pr.title}\n${pr.body || ""}`,
      exclude: files.map(f => f.filename), followFrom: atHead.files, budgetShare: 0.25, docs: false, picker: false,
    }).catch(() => ({ context: "", sources: [], ref: null }));
    return {
      context: [prBlock,
        atHead.text && `<changed_files_at_head>\n${atHead.text}\n</changed_files_at_head>`,
        related.context && `<related_code>\n${related.context}\n</related_code>`].filter(Boolean).join("\n\n"),
      // Every changed file counts as read (the diff), at the PR's head; the read
      // excerpts and related files add their exact line ranges
      sources: [...files.slice(0, 100).map(f => ({ path: f.filename, via: "diff", at: head })), ...atHead.sources, ...related.sources],
      ref: related.ref, cite: null, focus,
    };
  }
  const { issue, fileSources = [] } = item.brief;
  const retrieved = await buildChatContext(repo, question, previousQuestion || item.title, onStatus, {
    ...opts, previousFiles,
    about: `Issue #${issue.number}: ${issue.title}\n${issue.body || ""}`,
    seedFiles: fileSources.filter(f => f.confidence !== "low").map(f => f.path),
    budgetShare: 0.85,
  });
  return { context: `${issueFocusContext(item.brief)}\n\n${retrieved.context}`, sources: retrieved.sources, ref: retrieved.ref, cite: null, focus };
}
