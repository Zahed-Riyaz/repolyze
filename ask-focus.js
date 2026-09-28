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

// → { context, sources, ref, cite, focus } for a question about the focused item.
// `cite` (PRs only) is the repo citations link into: the PR's head, in the
// author's fork if it's one. `focus` goes into the system prompt.
// `opts` ({ files, onFiles }) pass through to buildChatContext for issues.
async function buildFocusedContext(repo, item, question, previousQuestion, onStatus, previousFiles, opts = {}) {
  const isPr = item.kind === "pr";
  const noun = isPr ? "pull request" : "issue";
  const focus = `The user is asking about ${noun} #${item.number} ("${item.title}"), shown in the <${isPr ? "pull_request" : "issue"}> block of the context. Answer about this ${noun} specifically.` +
    (isPr ? " Cite changed code as `path:line` using the new line numbers from the diff, and attribute points in the discussion to people (@name)." : "");
  const budget = CONTEXT_BUDGET[aiProvider] || 20000;

  if (isPr) {
    onStatus("Reading the PR's conversation and diff…");
    const { pr, files } = item.brief;
    const [owner, name] = (pr.head?.repo?.full_name || `${repo.owner}/${repo.repo}`).split("/");
    return {
      context: prFocusContext(item.brief, budget),
      sources: files.slice(0, 100).map(f => ({ path: f.filename })),
      ref: pr.head?.sha, cite: { owner, repo: name }, focus,
    };
  }
  const retrieved = await buildChatContext(repo, question, previousQuestion || item.title, onStatus,
    { ...opts, previousFiles: previousFiles.length ? previousFiles : item.brief.likelyFiles || [] });
  return { context: `${issueFocusContext(item.brief)}\n\n${retrieved.context}`, sources: retrieved.sources, ref: retrieved.ref, cite: null, focus };
}
