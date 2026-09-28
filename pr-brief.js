// ── PR brief ("Understand this PR") ──────────────────────────────────────────
// Everything a newcomer needs to follow existing work on a pull request:
//   • Where it stands   review states, commits since review, CI, conflicts, staleness
//   • Activity, files changed (+ code owners), people involved
// All deterministic. "Ask about this PR" opens Ask focused on the PR, where the
// AI gets its whole conversation and numbered diff (prEventLog, prDiffContext).
// Cost: 5 API requests (PR, timeline, review comments, files, check runs).

const prIndex = new Map(); // PR number → PR object from the Contribute list
let activePrBrief = null;  // { key, number, token }

const REVIEW_STATES = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "commented", DISMISSED: "dismissed" };

// ── Pure logic ───────────────────────────────────────────────────────────────
// Issues the PR says it closes ("Fixes #12", "closes owner/repo#34")
function linkedIssueNumbers(body) {
  const nums = new Set();
  for (const m of (body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi)) nums.add(Number(m[1]));
  return [...nums];
}

const eventTime = (ev) => ev.submitted_at || ev.created_at || ev.committer?.date || ev.author?.date || null;
const eventUser = (ev) => ev.user?.login || ev.actor?.login || ev.author?.name || null;

// Latest meaningful review per reviewer (a comment-only review doesn't change
// someone's approval; a dismissal clears it) → { approvals, changes, reviewed }
function latestReviews(timeline) {
  const byUser = new Map();
  for (const ev of timeline) {
    if (ev.event !== "reviewed" || !ev.user) continue;
    const state = String(ev.state || "").toUpperCase();
    const prev = byUser.get(ev.user.login);
    if (state === "DISMISSED") { byUser.delete(ev.user.login); continue; }
    if (state === "COMMENTED" && prev) continue;
    byUser.set(ev.user.login, { login: ev.user.login, state, at: eventTime(ev), user: ev.user });
  }
  const all = [...byUser.values()];
  return {
    approvals: all.filter(r => r.state === "APPROVED"),
    changes: all.filter(r => r.state === "CHANGES_REQUESTED"),
    reviewed: all,
  };
}

// Check runs → { passed, failed: [names], pending: [names] }
function summarizeChecks(checkRuns) {
  if (!checkRuns) return null;
  const failed = [], pending = [];
  let passed = 0;
  for (const c of checkRuns) {
    if (c.status !== "completed") pending.push(c.name);
    else if (["failure", "timed_out", "cancelled", "action_required", "startup_failure"].includes(c.conclusion)) failed.push(c.name);
    else passed++;
  }
  return { passed, failed, pending, total: checkRuns.length };
}

// Where the PR stands → { status: ready|review|changes|blocked|draft|merged|closed, verdict, advice, reasons[] }
function prStatus(pr, timeline, checks, now) {
  const reasons = [];
  const { approvals, changes, reviewed } = latestReviews(timeline);
  const commitTimes = timeline.filter(e => e.event === "committed").map(eventTime).filter(Boolean);
  const lastActivity = [pr.updated_at, ...timeline.map(eventTime)].filter(Boolean).sort().at(-1);

  let status = null;
  if (pr.merged_at) {
    status = "merged";
    reasons.push({ tone: "good", text: `Merged${pr.merged_by ? ` by @${pr.merged_by.login}` : ""} ${daysAgo(pr.merged_at)}` });
  } else if (pr.state === "closed") {
    status = "closed";
    reasons.push({ tone: "bad", text: `Closed without merging ${daysAgo(pr.closed_at || pr.updated_at)}` });
  } else if (pr.draft) status = "draft";

  if (changes.length) {
    const since = Math.min(...changes.map(c => Date.parse(c.at)));
    const pushedAfter = commitTimes.filter(t => Date.parse(t) > since).length;
    reasons.push({ tone: "bad", text: `${changes.map(c => `@${c.login}`).join(", ")} requested changes ${daysAgo(changes[0].at)}` });
    if (pushedAfter) reasons.push({ tone: "info", text: `${pushedAfter} commit${pushedAfter === 1 ? "" : "s"} pushed since — waiting on re-review` });
    status ??= pushedAfter ? "review" : "changes";
  }
  if (checks?.failed.length) {
    reasons.push({ tone: "bad", text: `${checks.failed.length} check${checks.failed.length === 1 ? "" : "s"} failing: ${checks.failed.slice(0, 3).join(", ")}${checks.failed.length > 3 ? "…" : ""}` });
    status ??= "blocked";
  }
  if (pr.mergeable_state === "dirty") {
    reasons.push({ tone: "bad", text: "Has merge conflicts with the base branch" });
    status ??= "blocked";
  }
  if (approvals.length) {
    reasons.push({ tone: "good", text: `Approved by ${approvals.map(a => `@${a.login}`).join(", ")}` });
    status ??= checks?.pending.length ? "review" : "ready";
  }
  if (checks?.pending.length) reasons.push({ tone: "info", text: `${checks.pending.length} check${checks.pending.length === 1 ? "" : "s"} still running` });
  if (checks && !checks.failed.length && !checks.pending.length && checks.total) reasons.push({ tone: "good", text: `All ${checks.total} checks passed` });

  const pending = [...(pr.requested_reviewers || []).map(u => `@${u.login}`), ...(pr.requested_teams || []).map(t => `@${t.slug || t.name}`)];
  const open = pr.state !== "closed";
  if (pending.length && open) reasons.push({ tone: "info", text: `Waiting on review from ${pending.join(", ")}` });
  if (!reviewed.length && open) reasons.push({ tone: "info", text: "No reviews yet" });

  const idleDays = lastActivity ? Math.floor((now - Date.parse(lastActivity)) / DAY_MS) : 0;
  if (idleDays >= 21 && pr.state !== "closed") reasons.push({ tone: "warn", text: `No activity for ${idleDays} days` });

  status ??= "review";
  const verdict = {
    ready: "Approved — ready to merge",
    review: changes.length ? "Updated — waiting on re-review" : "Waiting for review",
    changes: "Changes requested",
    blocked: checks?.failed.length ? "Checks failing" : "Merge conflicts",
    draft: "Draft — still in progress",
    merged: "Merged",
    closed: "Closed without merging",
  }[status];
  const advice = {
    ready: "Nothing left for contributors to do — a maintainer just needs to merge it.",
    review: "Reviews are welcome from anyone: try the branch locally and leave feedback.",
    changes: "It's waiting on the author to address the requested changes.",
    blocked: "The author needs to fix the failing checks or conflicts before it can merge.",
    draft: "The author is still working on it — hold off on detailed review unless asked.",
    merged: "Already merged — a good example of how changes like this get accepted here.",
    closed: "Read the conversation for why it was closed before attempting similar work.",
  }[status];
  return { status, verdict, advice, reasons, approvals, changes, reviewed, pendingReviewers: pending, idleDays };
}

// Unified diff → numbered lines using the new file's line numbers, so the
// model can cite `path:line` on the PR's head. "42+|" added, "42 |" context, "  -|" removed.
function numberPatch(patch) {
  const out = [];
  let n = 0;
  for (const line of (patch || "").split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { n = Number(hunk[1]); out.push(line); continue; }
    if (line.startsWith("+")) out.push(`${n++}+| ${line.slice(1)}`);
    else if (line.startsWith("-")) out.push(`  -| ${line.slice(1)}`);
    else if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    else out.push(`${n++} | ${line.slice(1)}`);
  }
  return out.join("\n");
}

// Every event on the PR, oldest first, as one line each — commits (grouped),
// reviews, comments, inline review threads, requests, state changes. When the
// bodies don't fit `maxChars` they're all shortened evenly; no event is dropped.
function prEventLog(pr, timeline, reviewComments, maxChars = 12000) {
  const events = [];
  const who = (u, assoc) => `@${u || "unknown"}${assoc && assoc !== "NONE" ? ` (${assoc.toLowerCase()})` : ""}`;
  let commitRun = null;
  for (const ev of timeline) {
    const at = eventTime(ev);
    if (ev.event === "committed") {
      const msg = (ev.message || "").split("\n")[0];
      if (commitRun && events[events.length - 1] === commitRun) { commitRun.count++; commitRun.messages.push(msg); continue; }
      commitRun = { at, kind: "commits", count: 1, messages: [msg] };
      events.push(commitRun);
      continue;
    }
    if (ev.event === "commented") events.push({ at, kind: "comment", head: `${who(eventUser(ev), ev.author_association)} commented`, body: ev.body });
    else if (ev.event === "reviewed") {
      const state = String(ev.state || "").toUpperCase();
      events.push({ at, kind: "review", state, head: `${who(ev.user?.login, ev.author_association)} ${REVIEW_STATES[state] || state.toLowerCase()}`, body: ev.body });
    }
    else if (ev.event === "review_requested") events.push({ at, kind: "meta", head: `@${eventUser(ev)} requested review from @${ev.requested_reviewer?.login || ev.requested_team?.slug || ev.requested_team?.name}` });
    else if (ev.event === "ready_for_review") events.push({ at, kind: "meta", head: `@${eventUser(ev)} marked it ready for review` });
    else if (ev.event === "convert_to_draft") events.push({ at, kind: "meta", head: `@${eventUser(ev)} converted it to a draft` });
    else if (ev.event === "head_ref_force_pushed") events.push({ at, kind: "meta", head: `@${eventUser(ev)} force-pushed the branch` });
    else if (ev.event === "renamed") events.push({ at, kind: "meta", head: `@${eventUser(ev)} renamed it from "${ev.rename?.from}"` });
    else if (ev.event === "labeled") events.push({ at, kind: "meta", head: `@${eventUser(ev)} added label "${ev.label?.name}"` });
    else if (ev.event === "cross-referenced" && ev.source?.issue) events.push({ at, kind: "meta", head: `Referenced from ${ev.source.issue.pull_request ? "PR" : "issue"} #${ev.source.issue.number} "${ev.source.issue.title}"` });
  }

  // Inline review comments → threads (replies point at the first comment)
  const threads = new Map();
  for (const c of reviewComments) {
    const root = c.in_reply_to_id || c.id;
    if (!threads.has(root)) threads.set(root, []);
    threads.get(root).push(c);
  }
  for (const thread of threads.values()) {
    const first = thread[0];
    const line = first.line || first.original_line;
    const outdated = first.position === null || first.position === undefined ? " (outdated — the code has changed since)" : "";
    events.push({
      at: first.created_at, kind: "thread",
      head: `Review thread on \`${first.path}${line ? `:${line}` : ""}\`${outdated}`,
      replies: thread.map(c => ({ head: who(c.user?.login, c.author_association), body: c.body })),
    });
  }
  events.sort((a, b) => (a.at || "").localeCompare(b.at || ""));

  const render = (cap) => events.map(e => {
    const date = e.at ? `[${e.at.slice(0, 10)}] ` : "";
    const clip = (t) => { const s = (t || "").replace(/\s+/g, " ").trim(); return s.length > cap ? `${s.slice(0, cap)}…` : s; };
    if (e.kind === "commits") return `${date}${e.count} commit${e.count === 1 ? "" : "s"} pushed: ${e.messages.map(m => `"${clip(m).slice(0, 80)}"`).join("; ")}`;
    if (e.kind === "thread") return `${date}${e.head}\n${e.replies.map(r => `    ${r.head}: ${clip(r.body)}`).join("\n")}`;
    return `${date}${e.head}${e.body ? `: ${clip(e.body)}` : ""}`;
  }).join("\n");

  let cap = 1500;
  let text = render(cap);
  while (text.length > maxChars && cap > 80) { cap = Math.floor(cap * 0.7); text = render(cap); }
  return { text, events, shortened: cap < 1500 };
}

// Changed files, most-discussed and biggest first, as numbered diffs within budget
function prDiffContext(files, reviewComments, maxChars) {
  const discussed = new Map();
  for (const c of reviewComments) discussed.set(c.path, (discussed.get(c.path) || 0) + 1);
  const ordered = [...files].sort((a, b) => (discussed.get(b.filename) || 0) - (discussed.get(a.filename) || 0) || b.changes - a.changes);
  const parts = [];
  const skipped = [];
  let used = 0;
  for (const f of ordered) {
    if (!f.patch) { skipped.push(f.filename); continue; }
    const block = `=== ${f.filename} (${f.status}, +${f.additions} −${f.deletions}) ===\n${numberPatch(f.patch)}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used - 2; // leave room for the "\n…" marker
      if (room > 600) { parts.push(`${block.slice(0, room)}\n…`); used = maxChars; }
      skipped.push(f.filename);
      continue;
    }
    parts.push(block);
    used += block.length + 2;
  }
  return { text: parts.join("\n\n"), skipped };
}

function prBriefMarkdown(pr, brief) {
  const lines = [`# PR #${pr.number} ${pr.title}`, pr.html_url, "", `**${brief.status.verdict}** — ${brief.status.advice}`];
  for (const r of brief.status.reasons) lines.push(`- ${r.text}`);
  lines.push("", "## Files changed", ...brief.files.map(f => `- ${f.filename} (+${f.additions} −${f.deletions})`));
  return lines.join("\n");
}

// ── Data loading ─────────────────────────────────────────────────────────────
// Follows "next" links up to `maxPages` (more with a token, where quota allows)
async function fetchAllPages(endpoint, repo, maxPages) {
  const items = [];
  let url = endpoint;
  for (let page = 0; page < maxPages && url; page++) {
    const { data, link } = await fetchGitHubPage(url, repo);
    items.push(...data);
    url = (link || "").match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return items;
}

async function loadPrData(repo, number) {
  const pages = githubToken ? 3 : 1;
  const pr = await fetchGitHub(`/pulls/${number}`, repo);
  const [timeline, reviewComments, files, checkRuns] = await Promise.all([
    fetchAllPages(`/issues/${number}/timeline?per_page=100`, repo, pages),
    fetchAllPages(`/pulls/${number}/comments?per_page=100`, repo, pages),
    fetchGitHub(`/pulls/${number}/files?per_page=100`, repo),
    fetchGitHub(`/commits/${pr.head.sha}/check-runs?per_page=100`, repo).then(r => r.check_runs).catch(err => { if (err.rateLimited) throw err; return null; }),
  ]);
  return { pr, timeline, reviewComments, files, checkRuns };
}

// ── View ─────────────────────────────────────────────────────────────────────
function openPrBriefFromList(number) {
  const pr = prIndex.get(Number(number));
  if (pr) showPrBrief(pr);
}

function closePrBrief() {
  activePrBrief = null;
  leaveFocus("pr-brief");
}

async function showPrBrief(prOrNumber, { auto = false } = {}) {
  const listPr = typeof prOrNumber === "object" ? prOrNumber : null;
  const number = Number(listPr ? listPr.number : prOrNumber);
  const repo = currentRepo;
  const key = repoKey(repo);
  const token = {};
  activePrBrief = { key, number, token, auto };
  const live = () => activePrBrief?.token === token && isCurrentRepo(key);

  if (activeBrief) closeIssueBrief(); // one brief at a time
  enterFocus("pr-brief");
  const body = document.getElementById("pr-brief-body");
  const placeholder = () => (listPr ? prHeaderHtml(listPr) : `<div class="brief-head"><span class="brief-title"><span class="issue-number">#${number}</span> Loading pull request…</span></div>`);
  body.innerHTML = placeholder() + `<div class="card">${skeletonList(3)}</div>`;

  const briefs = (cacheFor(key).prBriefs ??= {});
  try {
    let brief = briefs[number];
    if (!brief) {
      const [data, owners] = await Promise.all([loadPrData(repo, number), loadCodeOwners(repo).catch(() => ({ rules: [] }))]);
      const checks = summarizeChecks(data.checkRuns);
      brief = briefs[number] = {
        ...data, checks, codeOwnerRules: owners.rules,
        status: prStatus(data.pr, data.timeline, checks, Date.now()),
      };
    }
    if (!live()) return;
    renderPrBrief(repo, brief);
    return brief;
  } catch (err) {
    if (!live()) return;
    const notFound = err.status === 404
      ? stateItem(`There's no pull request #${number} in ${escapeHtml(repo.owner)}/${escapeHtml(repo.repo)} — it may be an issue number.`, { tag: "div" })
      : errorState(err, "div");
    body.innerHTML = placeholder() + notFound;
  }
}

function prHeaderHtml(pr, full = null) {
  const p = full || pr;
  const linked = linkedIssueNumbers(p.body);
  const size = full ? `<span>+${full.additions} −${full.deletions}</span><span>${full.changed_files} files</span><span>${full.commits} commits</span>` : "";
  return `
    <div class="brief-head">
      <a href="${p.html_url}" target="_blank" class="brief-title"><span class="issue-number">#${p.number}</span> ${escapeHtml(p.title)}</a>
      <div class="issue-meta">
        <span><img src="${avatarUrl(p.user.avatar_url, 32)}" class="avatar-sm" alt="" loading="lazy">${escapeHtml(p.user.login)}</span>
        ${p.draft ? `<span class="chip">Draft</span>` : ""}
        ${size}
        <span class="issue-age">opened ${daysAgo(p.created_at)}</span>
      </div>
      ${full ? `<div class="pr-branch"><code>${escapeHtml(full.head?.label || full.head?.ref || "")}</code> → <code>${escapeHtml(full.base?.ref || "")}</code></div>` : ""}
      ${linked.length ? `<div class="issue-labels">${linked.map(n => `<a class="chip" href="https://github.com/${currentRepo.owner}/${currentRepo.repo}/issues/${n}" target="_blank">Closes #${n}</a>`).join("")}</div>` : ""}
    </div>`;
}

const PR_TONE = { ready: "free", merged: "free", review: "maybe", draft: "maybe", changes: "taken", blocked: "taken", closed: "taken" };

function renderPrBrief(repo, brief) {
  const { pr, status, files, reviewComments } = brief;
  const reasons = status.reasons.map(r => `
    <li class="reason reason-${r.tone}">${icon(REASON_ICONS[r.tone], "icon-sm")}<span>${escapeHtml(r.text)}</span></li>`).join("");

  // Key events only — the AI summary covers the discussion itself
  const { events } = prEventLog(pr, brief.timeline, reviewComments, 200);
  const keyEvents = events.filter(e => (e.kind === "review" && e.state !== "COMMENTED") || e.kind === "commits" || e.kind === "meta");
  const shown = keyEvents.slice(-12);
  const activity = shown.length ? `
    ${keyEvents.length > shown.length ? `<p class="brief-note">${keyEvents.length - shown.length} earlier events not shown</p>` : ""}
    <ul class="pr-activity">${shown.map(e => {
      const text = e.kind === "commits" ? `${e.count} commit${e.count === 1 ? "" : "s"} pushed` : e.head;
      const tone = e.state === "APPROVED" ? "good" : e.state === "CHANGES_REQUESTED" ? "bad" : "info";
      return `<li class="reason reason-${tone}">${icon(e.kind === "commits" ? "pr" : REASON_ICONS[tone], "icon-sm")}<span>${escapeHtml(text)}${e.at ? ` <em>${daysAgo(e.at)}</em>` : ""}</span></li>`;
    }).join("")}</ul>` : `<p class="brief-note">No reviews or updates yet.</p>`;

  const discussed = new Map();
  for (const c of reviewComments) discussed.set(c.path, (discussed.get(c.path) || 0) + 1);
  const fileRows = files.slice(0, 20).map(f => {
    const owners = codeOwnersFor(f.filename, brief.codeOwnerRules);
    return `<li class="pr-file">
      <span class="pr-file-name" title="${escapeHtml(f.filename)}"><span class="pr-file-status pr-file-${f.status}">${f.status[0].toUpperCase()}</span><span class="pr-file-path">${escapeHtml(f.filename)}</span></span>
      <span class="pr-file-meta">${discussed.get(f.filename) ? `${icon("comment", "icon-sm")}${discussed.get(f.filename)} ` : ""}<span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span>
      ${owners.length ? `<span class="pr-file-owners">owned by ${owners.map(o => escapeHtml(o)).join(", ")}</span>` : ""}
    </li>`;
  }).join("");

  const people = [
    ...status.reviewed.map(r => ({ login: r.login, avatar: r.user?.avatar_url, note: REVIEW_STATES[r.state] || r.state.toLowerCase(), tone: r.state === "APPROVED" ? "good" : r.state === "CHANGES_REQUESTED" ? "bad" : "info" })),
    ...(pr.requested_reviewers || []).filter(u => !status.reviewed.some(r => r.login === u.login)).map(u => ({ login: u.login, avatar: u.avatar_url, note: "review requested", tone: "info" })),
  ];
  const owners = [...new Set(files.flatMap(f => codeOwnersFor(f.filename, brief.codeOwnerRules)))];

  document.getElementById("pr-brief-body").innerHTML = `
    ${prHeaderHtml(pr, pr)}
    <section class="card availability availability-${PR_TONE[status.status]}">
      <div class="availability-head"><span class="availability-dot"></span><strong>${status.verdict}</strong></div>
      <ul class="reason-list">${reasons}</ul>
      <p class="brief-note">${escapeHtml(status.advice)}</p>
    </section>
    ${askRowHtml("pr")}
    ${stackSectionHtml(prStack(pr, files), stackProfile, "What it touches")}
    <section class="brief-section">
      <h2 class="section-title">Activity</h2>
      ${activity}
    </section>
    <section class="brief-section">
      <h2 class="section-title">Files changed · ${pr.changed_files ?? files.length}</h2>
      <ul class="pr-files">${fileRows}</ul>
      ${files.length > 20 || (pr.changed_files || 0) > files.length ? `<p class="brief-note"><a href="${pr.html_url}/files" target="_blank">See all ${pr.changed_files} files on GitHub</a></p>` : ""}
    </section>
    <section class="brief-section">
      <h2 class="section-title">People</h2>
      ${people.length || owners.length ? `<ul class="people-list">
        ${people.map(p => `<li class="person">
          <img src="${avatarUrl(p.avatar || `https://github.com/${encodeURIComponent(p.login)}.png`, 64)}" class="contributor-avatar" alt="" loading="lazy">
          <div class="contributor-info"><div class="contributor-top">
            <a href="https://github.com/${encodeURIComponent(p.login)}" target="_blank" class="contributor-name">${escapeHtml(p.login)}</a>
            <span class="role-chips"><span class="role-chip reason-${p.tone}">${escapeHtml(p.note)}</span></span></div></div></li>`).join("")}
      </ul>` : ""}
      ${owners.length ? `<p class="brief-note">Code owners of the changed files: ${owners.map(o => `<code>${escapeHtml(o)}</code>`).join(" ")}</p>` : ""}
      ${!people.length && !owners.length ? `<p class="brief-note">No reviewers yet.</p>` : ""}
    </section>`;
}

function handlePrBriefClick(e) {
  const target = e.target;
  if (handleAskChip(e)) return;
  if (target.closest?.(".brief-open-settings")) {
    e.preventDefault();
    switchTab("settings");
  }
}

function currentPrBrief() {
  return activePrBrief ? cacheFor(activePrBrief.key).prBriefs?.[activePrBrief.number] : null;
}

function copyPrBrief() {
  const brief = currentPrBrief();
  if (!brief) return;
  const btn = document.getElementById("pr-brief-copy");
  navigator.clipboard.writeText(prBriefMarkdown(brief.pr, brief)).then(() => {
    btn.innerHTML = `${icon("check", "icon-sm")}Copied`;
    setTimeout(() => { btn.innerHTML = `${icon("copy", "icon-sm")}Copy`; }, 1500);
  });
}

// ── Pull request list (Contribute tab) ───────────────────────────────────────
// Open or closed PRs, paged; or a search across every PR by keyword. The Find
// box also takes a number or a PR link and opens that PR's brief directly.
const prView = { state: "open", query: "", sort: "newest", expanded: false }; // previewed like the issue list; "fit" reorders what's loaded
const PR_PAGE = 15;
const prViewKey = (v) => `${v.state}|${v.query}`;

// What was typed into a Find box (PRs or issues):
//   "123" / "#123"            → { number, sameRepo: true }
//   an issue or PR link       → { number, sameRepo, owner, repo, kind: "issue" | "pr" }
//   anything else             → { terms }
function parseFindQuery(text, repo) {
  const t = (text || "").trim();
  if (!t) return null;
  const url = t.match(/github\.com\/([^/\s]+)\/([^/\s#?]+)\/(pull|issues)\/(\d+)/i);
  if (url) {
    const sameRepo = url[1].toLowerCase() === repo.owner.toLowerCase() && url[2].toLowerCase() === repo.repo.toLowerCase();
    return { number: Number(url[4]), sameRepo, owner: url[1], repo: url[2], kind: url[3].toLowerCase() === "pull" ? "pr" : "issue" };
  }
  const num = t.match(/^#?(\d+)$/);
  if (num) return { number: Number(num[1]), sameRepo: true };
  return { terms: t };
}

async function fetchPrList({ append = false } = {}) {
  const repo = currentRepo;
  const cacheKey = repoKey(repo);
  const view = { ...prView };
  const key = prViewKey(view);
  const views = (cacheFor(cacheKey).prViews ??= {});
  const list = document.getElementById("prs-list");
  const more = document.getElementById("prs-more");
  const current = () => isCurrentRepo(cacheKey) && prViewKey(prView) === key;

  if (!append && views[key]) {
    await annotateStacks(repo, views[key].items, "pr");
    if (current()) renderPrList(views[key], view);
    return true;
  }
  if (append) { more.disabled = true; more.textContent = "Loading…"; }
  else { list.innerHTML = skeletonList(3); more.hidden = true; document.getElementById("prs-summary").textContent = ""; }

  try {
    const page = append ? views[key].page + 1 : 1;
    let result;
    if (view.query) {
      const q = `repo:${repo.owner}/${repo.repo} is:pr ${view.query}`;
      const res = await fetchGitHub(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PR_PAGE}&page=${page}`, repo);
      result = { items: res.items || [], page, total: res.total_count ?? 0, hasMore: page * PR_PAGE < Math.min(res.total_count ?? 0, 1000) };
    } else {
      // GitHub sorts ascending unless told otherwise, so always pass direction=desc
      const sort = view.state === "open" ? "created" : "updated";
      const { data, link } = await fetchGitHubPage(`/pulls?state=${view.state}&sort=${sort}&direction=desc&per_page=${PR_PAGE}&page=${page}`, repo);
      result = { items: data, page, total: null, hasMore: /rel="next"/.test(link || "") };
    }
    views[key] = append ? { ...result, items: [...views[key].items, ...result.items] } : result;
    await annotateStacks(repo, views[key].items, "pr");
    if (current()) renderPrList(views[key], view);
    return true;
  } catch (err) {
    if (current()) {
      if (append) { more.disabled = false; more.textContent = "Couldn't load more — try again"; }
      else list.innerHTML = errorState(err);
    }
    if (err.rateLimited && err.resource === "search") {
      setTimeout(() => { if (current()) fetchPrList({ append }); }, Math.max(1000, err.resetAt - Date.now() + 500));
    }
    return false;
  }
}

function renderPrList(state, view) {
  const list = document.getElementById("prs-list");
  const more = document.getElementById("prs-more");
  const summary = document.getElementById("prs-summary");
  summary.innerHTML = view.query
    ? `<strong>${state.total.toLocaleString()}</strong> PR${state.total === 1 ? "" : "s"} matching “${escapeHtml(view.query)}” <button class="btn btn-ghost btn-xs pr-clear-search">Clear</button>`
    : prView.sort === "fit"
      ? (stackProfile
        ? `${view.state === "open" ? "Open" : "Closed"} pull requests needing more of your stack first · among the ${state.items.length} loaded`
        : `${signInAvailable() || githubToken ? "Sign in to sort by fit with your own repos." : "Add a GitHub token in Settings to sort by fit with your repos."} <a href="#" class="fit-sign-in">Set up</a>`)
      : `${view.state === "open" ? "Open pull requests, newest first" : "Closed pull requests, most recently updated first"}`;

  if (!state.items.length) {
    more.hidden = true;
    list.innerHTML = stateItem(view.query ? "No pull requests match that search." : `No ${view.state} pull requests.`);
    return;
  }
  state.items.forEach(pr => prIndex.set(pr.number, pr));
  const items = prView.sort === "fit" && stackProfile && !view.query ? sortByFit(state.items, "pr") : state.items;
  // A search is something the user asked for, so show all its results
  const preview = listPreview({ ...state, items }, prView.expanded || !!view.query);
  list.innerHTML = preview.items.map(prCard).join("");
  more.hidden = !preview.button;
  more.disabled = false;
  more.textContent = preview.button === "all" ? `Show all ${view.state} pull requests` : "Load more";
}

function showMorePrs() {
  if (prView.expanded || prView.query) { fetchPrList({ append: true }); return; }
  prView.expanded = true;
  fetchPrList(); // served from cache
}

function prCard(pr) {
  const merged = pr.merged_at || pr.pull_request?.merged_at;
  // Open PRs get hints the list already carries (no extra requests): drafts,
  // pending review requests, and PRs gone quiet that someone could pick up
  const idleDays = Math.floor((Date.now() - Date.parse(pr.updated_at)) / DAY_MS);
  const chip = pr.state === "closed"
    ? `<span class="chip ${merged ? "chip-merged" : "chip-closed"}">${merged ? "Merged" : "Closed"}</span>`
    : pr.draft ? `<span class="chip">Draft</span>`
    : idleDays >= 21 ? `<span class="chip chip-stale" title="No activity for ${idleDays} days">Idle ${idleDays}d</span>`
    : pr.requested_reviewers?.length ? `<span class="chip chip-review">Review requested</span>` : "";
  // The whole row opens the brief; ↗ opens the PR on GitHub
  return `
    <li class="list-row">
      <button class="row-open pr-brief-btn" data-pr="${pr.number}" title="Understand this PR">
        <span class="row-title"><span class="issue-number">#${pr.number}</span> ${escapeHtml(pr.title)}</span>
        <span class="row-meta">
          <span><img src="${avatarUrl(pr.user.avatar_url, 32)}" class="avatar-sm" alt="" loading="lazy">${escapeHtml(pr.user.login)}</span>
          ${chip}
          <span class="row-age">${daysAgo(pr.state === "closed" ? (pr.closed_at || pr.updated_at) : pr.created_at)}</span>
        </span>
        ${stackLineHtml(stackFor(pr.number, "pr"))}
      </button>
      <a class="row-external" href="${pr.html_url}" target="_blank" title="Open on GitHub" aria-label="Open PR #${pr.number} on GitHub">${icon("external", "icon-sm")}</a>
    </li>`;
}

function setPrState(state) {
  prView.state = state;
  prView.query = "";
  document.getElementById("pr-find-input").value = "";
  document.querySelectorAll(".pr-state-btn").forEach(b => b.classList.toggle("active", b.dataset.state === state));
  fetchPrList();
}

// Find box: a number or PR link opens the brief (an issue link opens the
// issue's); words search every PR
function findPr(text) {
  const q = parseFindQuery(text, currentRepo);
  const note = document.getElementById("prs-summary");
  if (!q) { prView.query = ""; fetchPrList(); return; }
  if (q.number && !q.sameRepo) {
    note.innerHTML = `That ${q.kind === "issue" ? "issue" : "PR"} is in <strong>${escapeHtml(q.owner)}/${escapeHtml(q.repo)}</strong> — open it on GitHub and the panel will follow.`;
    return;
  }
  if (q.kind === "issue") { showIssueBrief(q.number); return; }
  if (q.number) { showPrBrief(q.number); return; }
  prView.query = q.terms;
  fetchPrList();
}
