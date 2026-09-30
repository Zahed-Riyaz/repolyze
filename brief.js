// ── "Start this issue" brief ─────────────────────────────────────────────────
// One page that answers what a newcomer needs before picking up an issue:
//   • Is it free?      assignees, PRs that reference it, "I'll take this" comments
//   • Where to look    files that match the issue by path
//   • Who to ask       CODEOWNERS for the files involved + maintainers in the thread
//   • Run before opening a PR   the checks CI will run (workflow + package.json)
// Everything here is deterministic and works without AI. Summaries, plans and
// follow-up questions are Ask's job: "Ask about this issue" opens Ask focused
// on the issue (ask-focus.js).
// Cost: 2 API requests (issue comments + timeline), plus the issue itself when
// opened from its page; files come from raw reads.

const issueIndex = new Map(); // issue number → issue object from the current list
let activeBrief = null;       // { key, number, token, auto } of the brief on screen

// ── Pure logic ───────────────────────────────────────────────────────────────
// CODEOWNERS pattern → RegExp, following gitignore-style rules: a leading or
// inner "/" anchors to the repo root, a trailing "/" means a directory, "*"
// stays within a path segment and "**" crosses segments.
function codeOwnerRegex(pattern) {
  let p = pattern;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\//, "");
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const body = p.split("**").map(part => part
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")).join(".*");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${dir ? "/" : "(/|$)"}`);
}

// Owners of a file: the last matching rule wins, as on GitHub
function codeOwnersFor(path, rules) {
  let owners = [];
  for (const rule of rules) if (codeOwnerRegex(rule.pattern).test(path)) owners = rule.owners;
  return owners;
}

const CLAIM_RE = /\b(i'?m|i am|i'?ll|i will|can i|could i|may i|let me|i'?d like to|i would like to|i want to)\b[^.?!\n]{0,40}?\b(work|take|pick|tackle|fix|handle|try|give it a|look into|solve|grab)\b|\bassign (it|this) to me\b|\bassign me\b|\bworking on (it|this)\b/i;

function looksLikeClaim(text) {
  return CLAIM_RE.test(text || "");
}

// Can I work on this issue? → { status, kind, verdict, advice, reasons[] }
// Facts first (assignees, PRs, links, commits, claims), then the one case that
// best describes it, most blocking first — each with its own verdict and next step:
//   closed · assigned (Taken) · open PR · merged PR · linked PR · claimed ·
//   PR closed recently · commits · free
// `status` is the tone: free (green), maybe (amber: check first), taken (red).
const RECENT_MS = 30 * DAY_MS;

function issueAvailability(issue, comments, timeline, now) {
  const reasons = [];
  const recent = (iso) => !!iso && now - Date.parse(iso) <= RECENT_MS;
  const at = (login) => (login ? ` by @${login}` : "");

  const assignees = issue.assignees?.length ? issue.assignees : issue.assignee ? [issue.assignee] : [];
  if (assignees.length) reasons.push({ tone: "bad", text: `Assigned to ${assignees.map(a => `@${a.login}`).join(", ")}` });

  // PRs that reference it: open, merged, or closed unmerged (recently or long ago)
  const prs = new Map();
  for (const ev of timeline) {
    const src = ev.event === "cross-referenced" ? ev.source?.issue : null;
    if (src?.pull_request) prs.set(src.number, src);
  }
  const list = [...prs.values()];
  const openPrs = list.filter(pr => pr.state === "open");
  const mergedPrs = list.filter(pr => pr.state !== "open" && pr.pull_request.merged_at);
  const closedPrs = list.filter(pr => pr.state !== "open" && !pr.pull_request.merged_at);
  const recentClosed = closedPrs.filter(pr => recent(pr.closed_at));
  for (const pr of openPrs) reasons.push({ tone: "bad", text: `Open PR #${pr.number}${at(pr.user?.login)}`, url: pr.html_url });
  for (const pr of mergedPrs) reasons.push({ tone: "warn", text: `PR #${pr.number}${at(pr.user?.login)} merged`, url: pr.html_url });
  for (const pr of closedPrs) {
    reasons.push({ tone: recent(pr.closed_at) ? "warn" : "info", text: `PR #${pr.number}${at(pr.user?.login)} closed unmerged${pr.closed_at ? ` ${daysAgo(pr.closed_at)}` : ""}`, url: pr.html_url });
  }

  // A PR linked in the Development section leaves "connected" events (no PR named)
  let linked = 0;
  for (const ev of timeline) {
    if (ev.event === "connected") linked++;
    else if (ev.event === "disconnected") linked = Math.max(0, linked - 1);
  }
  const linkedOnly = linked > 0 && !openPrs.length;
  if (linkedOnly) reasons.push({ tone: "warn", text: "A PR is linked in its Development section", url: issue.html_url });

  // Commits that mention it ("fix #12"): work may be under way on a branch
  const commits = timeline.filter(ev => ev.event === "referenced" && ev.commit_id);
  const latestCommit = commits.map(ev => ev.created_at).filter(Boolean).sort().at(-1);
  if (commits.length && !prs.size) {
    const base = (issue.html_url || "").replace(/\/issues\/\d+$/, "");
    const last = commits[commits.length - 1];
    reasons.push({ tone: recent(latestCommit) ? "warn" : "info", text: `${commits.length === 1 ? "A commit mentions" : `${commits.length} commits mention`} it${latestCommit ? ` (${daysAgo(latestCommit)})` : ""}`,
      url: base && last.commit_id ? `${base}/commit/${last.commit_id}` : undefined });
  }

  // "I'll take this" comments: latest per person, not from maintainers or PR authors
  const prAuthors = new Set(list.map(pr => pr.user?.login));
  const claims = new Map();
  for (const c of comments) {
    if (!c.user || isBot(c.user) || MAINTAINER_ROLES.has(c.author_association)) continue;
    if (!looksLikeClaim(c.body) || prAuthors.has(c.user.login)) continue;
    claims.set(c.user.login, c);
  }
  const recentClaims = [...claims.values()].filter(c => recent(c.created_at));
  for (const c of claims.values()) {
    reasons.push({
      tone: recent(c.created_at) ? "warn" : "info",
      text: recent(c.created_at) ? `@${c.user.login} offered to take it ${daysAgo(c.created_at)}` : `@${c.user.login} offered ${daysAgo(c.created_at)}, no PR followed`,
      url: c.html_url,
    });
  }

  const maintainerReplied = comments.some(c => c.user && !isBot(c.user) && MAINTAINER_ROLES.has(c.author_association));
  if (!maintainerReplied) reasons.push({ tone: "info", text: "No maintainer reply yet" });

  // The one case that describes it best, most blocking first
  const who = (people) => people.map(p => `@${p}`).join(", ");
  const num = (pr) => `#${pr.number}`;
  let c;
  if (issue.state === "closed") {
    const how = issue.state_reason === "not_planned" ? " as not planned" : issue.state_reason === "completed" ? " as completed" : "";
    reasons.unshift({ tone: "bad", text: `Closed${how} ${daysAgo(issue.closed_at || issue.updated_at)}` });
    c = { status: "taken", kind: "closed", verdict: "Closed", advice: "Read why it was closed before working on anything similar." };
  } else if (assignees.length) {
    const names = assignees.map(a => a.login);
    c = { status: "taken", kind: "assigned", verdict: "Taken",
      advice: openPrs.length ? `Pick another issue, or review ${num(openPrs[0])}.` : `Pick another issue, or ask ${who(names)} if they'd like help.` };
  } else if (openPrs.length) {
    const pr = openPrs[0];
    c = { status: "maybe", kind: "open-pr", verdict: openPrs.length === 1 ? "Has an open PR" : `Has ${openPrs.length} open PRs`,
      advice: `Review or help on ${num(pr)}${pr.user?.login ? ` with @${pr.user.login}` : ""} instead of starting over.` };
  } else if (mergedPrs.length) {
    c = { status: "maybe", kind: "merged", verdict: "May already be fixed", advice: `Check whether ${num(mergedPrs[0])} fixed it before starting.` };
  } else if (linkedOnly) {
    c = { status: "maybe", kind: "linked", verdict: "Has a linked PR", advice: "Check the PR in the issue's Development section first." };
  } else if (recentClaims.length) {
    const names = recentClaims.map(x => x.user.login);
    c = { status: "maybe", kind: "claimed", verdict: "Claimed in the comments", advice: `Ask ${who(names)} if they're still on it before starting.` };
  } else if (recentClosed.length) {
    c = { status: "maybe", kind: "closed-pr", verdict: "A PR was closed recently", advice: `Read why ${num(recentClosed[0])} was closed, then ask before starting.` };
  } else if (commits.length && recent(latestCommit)) {
    c = { status: "maybe", kind: "commits", verdict: "Work may be under way", advice: "A recent commit mentions it; ask in the thread before starting." };
  } else {
    // Say "no PR" only when there's none at all
    reasons.unshift({ tone: "good", text: prs.size || linked || commits.length ? "No assignee or open PR" : "No assignee, PR or claim" });
    c = { status: "free", kind: "free", verdict: "Free to work on", advice: "Comment that you'd like to take it, then start." };
  }
  return { ...c, reasons };
}

// `run:` commands from a GitHub Actions workflow (single-line and `run: |` blocks)
function ciRunCommands(yaml) {
  const out = [];
  const lines = (yaml || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const value = m[2].trim();
    if (/^[|>][-+]?$/.test(value)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].match(/^\s*/)[0].length <= indent) break;
        out.push(lines[j].trim());
      }
    } else if (value) {
      out.push(value.replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return out;
}

const VERIFY_CMD = /\b(test|tests|lint|check|build|typecheck|tsc|pytest|tox|nox|cargo|go (test|vet|build)|make|npm|pnpm|yarn|bun|mvn|gradle|gradlew|ruff|flake8|mypy|eslint|prettier|rspec|rake|phpunit|dotnet|swift test|mix test|bundle exec)\b/;
const NOT_VERIFY = /\$\{\{|^(echo|export|cd|curl|wget|sudo|apt|brew|git |mkdir|rm |cp |mv |ls|cat|chmod|set )/;
// Commands that install dependencies: setup (flow.js), not "before you push"
const INSTALL_CMD = /^(npm (ci|install|i)\b|pnpm (i|install)\b|yarn( install)?( --[\w-]+)*$|bun (i|install)\b|(python3? -m )?pip3? install\b|poetry install\b|uv (sync|pip install)\b|pdm (install|sync)\b|pipenv (install|sync)\b|bundle( install)?$|bundle install\b|go mod (download|tidy)\b|composer install\b|mix deps\.get\b|dotnet restore\b|cargo fetch\b)/;


// What a contributor should run before opening a PR → [{ cmd, from }]
function verifyCommands({ workflowText, workflowPath, packageJson, packageManager = "npm" }) {
  const seen = new Set();
  const out = [];
  const add = (cmd, from) => {
    const key = cmd.replace(/\s+/g, " ");
    if (!seen.has(key) && out.length < 8) { seen.add(key); out.push({ cmd: key, from }); }
  };
  for (const cmd of ciRunCommands(workflowText)) {
    if (VERIFY_CMD.test(cmd) && !NOT_VERIFY.test(cmd) && !INSTALL_CMD.test(cmd)) add(cmd, workflowPath);
  }
  let scripts = {};
  try { scripts = JSON.parse(packageJson || "{}").scripts || {}; } catch { /* not JSON */ }
  const run = (name) => (name === "test" ? `${packageManager} test` : `${packageManager} run ${name}`);
  for (const name of ["test", "lint", "typecheck", "check", "build"]) {
    if (scripts[name] && ![...seen].some(c => c.includes(name))) add(run(name), "package.json");
  }
  return out;
}

// Who to ask: code owners of the files involved + maintainers already in the thread
function briefPeople(files, codeOwnerRules, comments) {
  const owners = new Map(); // "@handle" → Set(files)
  for (const f of files) {
    for (const o of codeOwnersFor(f, codeOwnerRules)) {
      if (!owners.has(o)) owners.set(o, new Set());
      owners.get(o).add(f);
    }
  }
  const inThread = new Map();
  for (const c of comments) {
    if (!c.user || isBot(c.user) || !MAINTAINER_ROLES.has(c.author_association)) continue;
    const p = inThread.get(c.user.login) || { login: c.user.login, avatar_url: c.user.avatar_url, html_url: c.user.html_url, role: c.author_association, replies: 0 };
    p.replies++;
    inThread.set(c.user.login, p);
  }
  return {
    owners: [...owners].map(([handle, fs]) => ({ handle, files: [...fs] })),
    inThread: [...inThread.values()].sort((a, b) => b.replies - a.replies),
  };
}

// The latest comments, one line each, for Ask's context about the issue
function issueDiscussion(comments) {
  return comments.slice(-10).map(c =>
    `@${c.user?.login} (${(c.author_association || "NONE").toLowerCase()}): ${(c.body || "").replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
}

// Plain-Markdown version for the Copy button
function briefMarkdown(repo, issue, brief) {
  const lines = [`# #${issue.number} ${issue.title}`, issue.html_url, "", `**${brief.availability.verdict}** — ${brief.availability.advice}`];
  for (const r of brief.availability.reasons) lines.push(`- ${r.text}${r.url ? ` (${r.url})` : ""}`);
  if (brief.fileSources?.length) lines.push("", "## Files it needs", ...brief.fileSources.map(f => `- ${f.path} (${f.why})`));
  const people = brief.people;
  if (people?.owners.length || people?.inThread.length) {
    lines.push("", "## Who to ask");
    for (const o of people.owners) lines.push(`- ${o.handle} — code owner of ${o.files.join(", ")}`);
    for (const p of people.inThread) lines.push(`- @${p.login} — replied ${p.replies}× in this thread`);
  }
  const flow = brief.flow || EMPTY_FLOW;
  const login = typeof githubUser !== "undefined" ? githubUser?.login : null;
  lines.push("", "## Set up", "```bash", ...setupCommandsFor(repo, issue, flow.setup, login).map(c => c.cmd), "```");
  if (brief.commands.length) {
    lines.push("", "## Before you push", "```bash", ...brief.commands.map(c => c.cmd), "```");
  }
  const draft = prDraftFor(repo, issue, flow, login, brief.commands);
  lines.push("", "## Open the PR", ...flow.pr.checklist.map(c => `- [ ] ${c.text}${c.cmd ? ` (\`${c.cmd}\`)` : ""}`), "", `**Title:** ${draft.title}`);
  return lines.join("\n");
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadIssueThread(repo, number, opts = {}) {
  const [comments, timeline] = await Promise.all([
    fetchGitHub(`/issues/${number}/comments?per_page=100`, repo, opts),
    loadIssueTimeline(repo, number, opts),
  ]);
  return { comments, timeline };
}

// The timeline is oldest first, 100 events a page: on a busy issue the PR
// that took it is often past page 1. Signed in, read up to 5 pages (and the
// last); signed out, add just the last page, the newest events (1 request).
async function loadIssueTimeline(repo, number, opts = {}) {
  const endpoint = (page) => `/issues/${number}/timeline?per_page=100${page > 1 ? `&page=${page}` : ""}`;
  const { data, link } = await fetchGitHubPage(endpoint(1), repo, opts);
  const last = Number((link || "").match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/)?.[1]) || 1;
  if (last <= 1) return data;
  const pages = githubToken ? [...new Set([...Array.from({ length: Math.min(last, 5) - 1 }, (_, i) => i + 2), last])] : [last];
  const rest = await Promise.all(pages.map(p => fetchGitHub(endpoint(p), repo, opts).catch(err => { if (err.rateLimited) throw err; return []; })));
  return [...data, ...rest.flat()];
}

// Setup, CI checks and PR conventions for the repo (flow.js); a repo that can't
// be read still gets a brief, just without the "From clone to PR" steps
const EMPTY_FLOW = { defaultBranch: "main", setup: { commands: [], runtime: [], source: null, devcontainer: false }, verify: [], pr: { template: null, checklist: [], titleStyle: null } };
async function loadFlowForBrief(repo) {
  try {
    return await loadRepoFlow(repo);
  } catch (err) {
    if (err.rateLimited) throw err;
    return EMPTY_FLOW;
  }
}

// ── View ─────────────────────────────────────────────────────────────────────
function openIssueBriefFromList(number) {
  const issue = issueIndex.get(Number(number));
  if (issue) showIssueBrief(issue);
}

// A brief (issue or PR) replaces the Contribute lists; closing it brings the
// lists back where they were scrolled to.
let browseScrollTop = 0;

function enterFocus(id) {
  const browse = document.getElementById("contribute-browse");
  const pane = document.getElementById("tab-content");
  if (!browse.hidden) browseScrollTop = pane.scrollTop;
  browse.hidden = true;
  for (const other of ["issue-brief", "pr-brief"]) document.getElementById(other).hidden = other !== id;
  pane.scrollTop = 0;
}

function leaveFocus(id) {
  const el = document.getElementById(id);
  if (el.hidden) return;
  el.hidden = true;
  document.getElementById("contribute-browse").hidden = false;
  document.getElementById("tab-content").scrollTop = browseScrollTop;
}

function closeIssueBrief() {
  activeBrief = null;
  leaveFocus("issue-brief");
}

// Takes the issue from the list, or just its number (opened from its GitHub
// page), in which case the issue itself is fetched too.
// A brief is reused for 10 minutes; after that (or when opened from the issue's
// own page, or with Refresh) its thread is checked again — free when unchanged.
const BRIEF_TTL_MS = 10 * 60 * 1000;

async function showIssueBrief(issueOrNumber, { auto = false, refresh = false } = {}) {
  const listIssue = typeof issueOrNumber === "object" ? issueOrNumber : issueIndex.get(Number(issueOrNumber)) || null;
  const number = Number(listIssue ? listIssue.number : issueOrNumber);
  const repo = currentRepo;
  const key = repoKey(repo);
  const token = {};
  activeBrief = { key, number, token, auto };
  const live = () => activeBrief?.token === token && isCurrentRepo(key);

  if (activePrBrief) closePrBrief(); // one brief at a time
  enterFocus("issue-brief");
  const body = document.getElementById("brief-body");
  const placeholder = () => (listIssue ? briefHeaderHtml(listIssue) : `<div class="brief-head"><span class="brief-title"><span class="issue-number">#${number}</span> Loading issue…</span></div>`);
  body.innerHTML = placeholder() + `<div class="card">${skeletonList(3)}</div>`;

  const briefs = (cacheFor(key).briefs ??= {});
  try {
    // Looking at the issue on GitHub, or asking to refresh: what the page shows now wins
    const revalidate = auto || refresh;
    let brief = briefs[number];
    if (brief && (revalidate || Date.now() - brief.loadedAt > BRIEF_TTL_MS)) brief = null;
    if (!brief) {
      const [issue, { comments, timeline }, flow, owners] = await Promise.all([
        listIssue && !revalidate ? listIssue : fetchGitHub(`/issues/${number}`, repo, { revalidate }),
        loadIssueThread(repo, number, { revalidate }),
        loadFlowForBrief(repo),
        loadCodeOwners(repo).catch(() => ({ rules: [] })),
      ]);
      if (issue.pull_request) {
        if (live()) body.innerHTML = placeholder() + stateItem(`#${number} is a pull request. <button class="btn btn-xs brief-open-pr" data-pr="${number}">Open its brief</button>`, { tag: "div" });
        return;
      }
      // Path matches point at where to look and whose code it is — no AI needed
      // Where the work is, from the strongest signals first (guide.js)
      const fileSources = await resolveIssueFiles(repo, issue, { comments, timeline }).catch(() => []);
      const files = fileSources.map(f => f.path);
      brief = briefs[number] = {
        issue, comments, flow, commands: flow.verify, codeOwnerRules: owners.rules, loadedAt: Date.now(),
        availability: issueAvailability(issue, comments, timeline, Date.now()),
        likelyFiles: files, fileSources, people: briefPeople(files, owners.rules, comments),
      };
    }
    if (!live()) return;
    renderBrief(repo, brief.issue, brief);
    return brief;
  } catch (err) {
    if (!live()) return;
    const notFound = err.status === 404
      ? stateItem(`There's no issue #${number} in ${escapeHtml(repo.owner)}/${escapeHtml(repo.repo)}.`, { tag: "div" })
      : errorState(err, "div");
    body.innerHTML = placeholder() + notFound;
  }
}

function briefHeaderHtml(issue) {
  const labels = issue.labels.map(labelDotHtml).join("");
  return `
    <div class="brief-head">
      <a href="${issue.html_url}" target="_blank" class="brief-title"><span class="issue-number">#${issue.number}</span> ${escapeHtml(issue.title)}</a>
      <div class="issue-meta">
        <span title="Comments">${icon("comment", "icon-sm")}${issue.comments}</span>
        <span class="issue-age">opened ${daysAgo(issue.created_at)}${issue.user ? ` by ${escapeHtml(issue.user.login)}` : ""}</span>
      </div>
      ${labels ? `<div class="issue-labels">${labels}</div>` : ""}
    </div>`;
}

const REASON_ICONS = { good: "check", bad: "x", warn: "alert", info: "inbox" };

function renderBrief(repo, issue, brief) {
  const a = brief.availability;
  // Reasons as one quiet line (links kept); the verdict and the next step lead
  const why = a.reasons.map(r => (r.url ? `<a href="${r.url}" target="_blank">${escapeHtml(r.text)}</a>` : escapeHtml(r.text))).join(" · ");
  document.getElementById("brief-body").innerHTML = `
    ${briefHeaderHtml(issue)}
    <section class="verdict verdict-${a.status}">
      <p class="verdict-line"><strong>${escapeHtml(a.verdict)}</strong></p>
      ${why ? `<p class="verdict-why">${why}</p>` : ""}
      <p class="verdict-next">${icon("arrow-right", "icon-sm")}<span>${escapeHtml(a.advice)}</span></p>
    </section>
    ${whereToStartHtml(repo, brief.fileSources, issueStack(issue, brief.likelyFiles))}
    <section class="brief-section">
      <h2 class="section-title">Who to ask</h2>
      <div id="brief-people"></div>
    </section>
    ${askRowHtml("issue")}
    ${flowHtml(repo, issue, brief.flow || EMPTY_FLOW)}`;
  renderBriefPeople(brief.people);
}

// One line per file: its name (linked, full path on hover) and why. The folder
// only shows when two files in the list share a name (errors.ts in core and cli).
function fileRowHtml(repo, f, ref = null, sameName = new Set()) {
  const { name, dir } = splitPath(f.path);
  const folder = dir && sameName.has(name) ? `<span class="file-dir">${escapeHtml(dir.split("/").pop())}/</span>` : "";
  return `<li class="file-row file-${f.confidence}">
    <a class="file-name" href="${sourceUrl(repo, ref, f.path)}" target="_blank" title="${escapeHtml(f.path)}">${folder}<code>${escapeHtml(name)}</code></a>
    <span class="file-why">${escapeHtml(f.why)}</span>
  </li>`;
}

// Names that appear more than once in a list of files
function repeatedNames(files) {
  const seen = new Map();
  for (const f of files) { const n = splitPath(f.path).name; seen.set(n, (seen.get(n) || 0) + 1); }
  return new Set([...seen].filter(([, c]) => c > 1).map(([n]) => n));
}

// Files with a real signal, then name-matching guesses folded away (open only
// when they're all there is); the stack the files need as a header note
function whereToStartHtml(repo, fileSources, stack) {
  const { start, guesses } = groupIssueFiles(fileSources || []);
  if (!start.length && !guesses.length) return "";
  const same = repeatedNames([...start, ...guesses]);
  const rows = (files) => `<ul class="file-list">${files.map(f => fileRowHtml(repo, f, null, same)).join("")}</ul>`;
  const plural = guesses.length === 1 ? "guess" : "guesses";
  return `<section class="brief-section">
      <div class="section-head"><h2 class="section-title">Where to start</h2>${stackLineHtml(stack)}</div>
      ${start.length ? rows(start) : `<p class="brief-note">Nothing in the issue or its PRs points at a file yet.</p>`}
      ${guesses.length ? `<details class="file-guesses"${start.length ? "" : " open"}>
        <summary>${guesses.length} ${plural} by file name</summary>
        ${rows(guesses)}
      </details>` : ""}
    </section>`;
}

// ── From clone to PR ─────────────────────────────────────────────────────────
function cmdRowHtml(c) {
  return `<div class="cmd-row"><code class="cmd-code">${escapeHtml(c.cmd)}</code>
    <button class="copy-btn" data-cmd="${escapeHtml(c.cmd)}" title="From ${escapeHtml(c.from)}">${icon("copy", "icon-sm")}Copy</button></div>`;
}

const fromList = (items) => [...new Set(items.map(c => c.from))].map(f => `<code>${escapeHtml(f)}</code>`).join(", ");

// Set up → before you push → open the PR, in the order you'll need them
function flowHtml(repo, issue, flow) {
  const login = typeof githubUser !== "undefined" ? githubUser?.login : null;
  const ref = flow.defaultBranch;
  const docLink = (path, heading) => `<a href="${sourceUrl(repo, ref, path)}${heading ? `#${encodeURIComponent(headingSlug(heading))}` : ""}" target="_blank">` +
    `${escapeHtml(path.split("/").pop())}${heading ? ` › ${escapeHtml(heading)}` : ""}</a>`;

  // 1. Set up
  const { setup } = flow;
  const setupCmds = setupCommandsFor(repo, issue, setup, login);
  const own = setup.commands;
  const setupFrom = setup.source
    ? `From ${docLink(setup.source.path, setup.source.heading)}`
    : own.length ? `From ${fromList(own)}` : `No setup steps found; check the README.`;
  const needs = setup.runtime.length ? `<p class="flow-needs">Needs ${setup.runtime.map(r => `<strong>${escapeHtml(r)}</strong>`).join(" · ")}</p>` : "";
  const devcontainer = setup.devcontainer
    ? `, or <a href="https://codespaces.new/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}" target="_blank">open a Codespace</a> and skip this` : "";

  // 2. Before you push
  const verify = flow.verify.length
    ? flow.verify.map(cmdRowHtml).join("") + `<p class="brief-note">What CI runs · from ${fromList(flow.verify)}</p>`
    : `<p class="brief-note">No CI workflow or test scripts found; check the README.</p>`;

  // 3. Open the PR
  const draft = prDraftFor(repo, issue, flow, login, flow.verify);
  const checklist = flow.pr.checklist.length ? `<ul class="flow-checklist">${flow.pr.checklist.map(c => `<li>
      <span class="flow-rule">${escapeHtml(c.text)}${c.cmd ? ` <code>${escapeHtml(c.cmd)}</code>` : ""}</span>
      <span class="flow-meta">${c.example ? `e.g. <q>${escapeHtml(c.example)}</q> · ` : ""}from ${escapeHtml(c.from)}</span></li>`).join("")}</ul>` : "";
  const guideLink = flow.pr.contributingPath && flow.pr.contributingPrSection
    ? `<p class="brief-note">Full guidelines: ${docLink(flow.pr.contributingPath, flow.pr.contributingPrSection)}</p>` : "";
  const bodyNote = draft.fromTemplate
    ? `From <code>${escapeHtml(flow.pr.templatePath.split("/").pop())}</code> · links #${issue.number}`
    : `A short one · links #${issue.number}, says how you tested`;
  const openRow = draft.compareUrl
    ? `<div class="pr-draft-foot">
        <a class="btn btn-primary pr-draft-open" href="${escapeHtml(draft.compareUrl)}" target="_blank">Open the PR on GitHub ${icon("external", "icon-sm")}</a>
        <p class="pr-draft-hint">Filled in for <code>${escapeHtml(branchNameFor(issue))}</code> once it's pushed to your fork</p></div>`
    : `<div class="pr-draft-foot"><p class="pr-draft-hint"><a href="#" class="brief-open-settings">Sign in</a> to open GitHub's PR form already filled in</p></div>`;
  const prDraft = `<div class="pr-draft">
      <div class="pr-draft-row">
        <div class="pr-draft-field"><span class="pr-draft-label">Title</span><span class="pr-draft-title">${escapeHtml(draft.title)}</span></div>
        <button class="copy-btn" data-cmd="${escapeHtml(draft.title)}" title="Copy the title">${icon("copy", "icon-sm")}Copy</button>
      </div>
      <div class="pr-draft-row">
        <div class="pr-draft-field"><span class="pr-draft-label">Description</span><span class="pr-draft-desc">${bodyNote}</span></div>
        <button class="copy-btn" data-cmd="${escapeHtml(draft.body)}" title="${escapeHtml(draft.body.slice(0, 600))}">${icon("copy", "icon-sm")}Copy</button>
      </div>
      ${openRow}
    </div>`;

  // Each step folds to one line saying what's inside; open the one you need
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const sums = [
    [setup.runtime[0], plural(setupCmds.length, "command")].filter(Boolean).join(" · "),
    flow.verify.length ? `${plural(flow.verify.length, "check")} CI runs` : "no CI found",
    [flow.pr.checklist.length ? plural(flow.pr.checklist.length, "rule") : "", draft.fromTemplate ? "their template, filled in" : "title and description ready"].filter(Boolean).join(" · "),
  ];
  const step = (n, label, body) => `<details class="flow-step">
      <summary class="flow-label"><span class="flow-num">${n}</span>${label}<span class="flow-sum">${escapeHtml(sums[n - 1])}</span></summary>
      <div class="flow-body">${body}</div>
    </details>`;

  return `<section class="brief-section brief-flow">
      <h2 class="section-title">From clone to pull request</h2>
      ${step(1, "Set up", `
        <p class="brief-note flow-lead"><a href="https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/fork" target="_blank">Fork the repo</a> first${login ? "" : " (replace YOUR-USERNAME below)"}${devcontainer}</p>
        ${needs}
        ${setupCmds.map(cmdRowHtml).join("")}
        <p class="brief-note">${setupFrom}</p>`)}
      ${step(2, "Before you push", verify)}
      ${step(3, "Open the PR", `${checklist}${guideLink}${prDraft}`)}
    </section>`;
}

// ── Asking about a brief ─────────────────────────────────────────────────────
// Briefs don't run the AI themselves; they hand off to Ask with the item in
// focus. Each suggestion is sent as a plain question the user can see.
const ASK_PROMPTS = {
  issue: [
    { label: "Summary & plan", q: (n) => `Summarise issue #${n} in two sentences: what's broken or missing, and what "done" looks like. Then give numbered steps to fix it, each naming the file and function to change and what to change, including how to reproduce it first and which test to add. End with anything to confirm with maintainers before starting.` },
    { label: "Where do I start?", q: (n) => `Where in the code should I start on issue #${n}? Name the files and functions, and say what each one does today and what needs to change in it.` },
    { label: "How do I test this?", q: (n) => `How do I reproduce issue #${n}? Give the exact commands or steps, what I should see, and which test file to add a test to and what it should check.` },
  ],
  pr: [
    { label: "Summarise the PR", q: (n) => `Summarise PR #${n}: what it changes, file by file, and the conversation so far in order (who asked for what, and whether a later commit addressed it). End with what's still open.` },
    { label: "What's still open?", q: (n) => `List what's still blocking PR #${n}: each unresolved review request, failing check, conflict or unanswered question, with who needs to act on it.` },
    { label: "How could I help?", q: (n) => `Give me one to three concrete things I could do to move PR #${n} forward, e.g. which branch to check out and what to test, or which file to review and what to look for.` },
  ],
};

function aiConfigured() {
  return aiProvider === "ollama" || !!aiApiKey;
}

function aiSetupNoteHtml(what) {
  return `<p class="brief-note">Add an AI provider in <a href="#" class="brief-open-settings">Settings</a> for ${what}.</p>`;
}

function askRowHtml(kind) {
  const noun = kind === "pr" ? "PR" : "issue";
  return `<section class="brief-ask">
    <div class="brief-ask-head">${icon("chat", "icon-sm")}<strong>Ask about this ${noun}</strong></div>
    ${aiConfigured() ? `
      <div class="brief-ask-chips">
        ${ASK_PROMPTS[kind].map((p, i) => `<button class="ask-chip" data-kind="${kind}" data-ask="${i}">${escapeHtml(p.label)}</button>`).join("")}
        <button class="ask-chip ask-chip-own" data-kind="${kind}" title="Answers appear in Ask, grounded in this ${noun}${kind === "pr" ? "'s discussion and diff" : " and the code it touches"}">Your own question${icon("arrow-right", "icon-sm")}</button>
      </div>`
    : aiSetupNoteHtml(`summaries and questions about this ${noun}`)}
  </section>`;
}

// Suggestion (or "your own question") button → Ask, focused on this item
function handleAskChip(e) {
  const chip = e.target.closest?.(".ask-chip");
  if (!chip) return false;
  const index = chip.dataset.ask === undefined ? null : Number(chip.dataset.ask);
  askAboutBrief(chip.dataset.kind, index);
  return true;
}

function renderBriefPeople({ owners, inThread }) {
  const el = document.getElementById("brief-people");
  if (!owners.length && !inThread.length) {
    el.innerHTML = `<p class="brief-note">No code owners here yet; ask in the issue thread.</p>`;
    return;
  }
  // One chip per person or team: who, and one word on why; details on hover
  el.innerHTML = `<ul class="people-chips">
    ${owners.map(o => {
      const name = o.handle.slice(1);
      const isTeam = name.includes("/");
      const files = o.files.map(f => f.split("/").pop());
      const why = `Code owner · ${files.length === 1 ? files[0] : `${files.length} of these files`}`;
      return `<li><a class="person-chip" href="https://github.com/${isTeam ? `orgs/${name.split("/")[0]}/teams/${name.split("/")[1]}` : encodeURIComponent(name)}" target="_blank" title="${escapeHtml(`${o.handle}\n${why}\n${o.files.join("\n")}`)}">
        ${isTeam ? `<span class="chip-avatar team">${icon("users", "icon-xs")}</span>` : `<img src="https://github.com/${encodeURIComponent(name)}.png?size=40" class="chip-avatar" alt="" loading="lazy">`}
        <span class="person-chip-name">${escapeHtml(ownerDisplay(o.handle, currentRepo?.owner))}</span><span class="person-chip-why">owner</span></a></li>`;
    }).join("")}
    ${inThread.map(p => `<li><a class="person-chip" href="${p.html_url}" target="_blank" title="${escapeHtml(`${ROLE_NAMES[p.role] || p.role} · replied ${p.replies}× here`)}">
        <img src="${avatarUrl(p.avatar_url, 40)}" class="chip-avatar" alt="" loading="lazy">
        <span class="person-chip-name">${escapeHtml(p.login)}</span><span class="person-chip-why">replied ${p.replies}×</span></a></li>`).join("")}
  </ul>`;
}

// Buttons inside the brief (event delegation, since the body is re-rendered)
function handleBriefClick(e) {
  const target = e.target;
  const copy = target.closest?.(".copy-btn");
  if (copy) {
    const label = copy.dataset.label || copy.innerHTML;
    copy.dataset.label = label;
    navigator.clipboard.writeText(copy.dataset.cmd).then(() => {
      copy.innerHTML = `${icon("check", "icon-sm")}Copied`;
      setTimeout(() => { copy.innerHTML = label; }, 1500);
    });
    return;
  }
  if (handleAskChip(e)) return;
  const openPr = target.closest?.(".brief-open-pr");
  if (openPr) {
    showPrBrief(Number(openPr.dataset.pr));
    return;
  }
  if (target.closest?.(".brief-open-settings")) {
    e.preventDefault();
    switchTab("settings");
  }
}

function currentBrief() {
  return activeBrief ? cacheFor(activeBrief.key).briefs?.[activeBrief.number] : null;
}

function refreshBrief() {
  if (activeBrief) showIssueBrief(activeBrief.number, { auto: activeBrief.auto, refresh: true });
}

function copyBrief() {
  const brief = currentBrief();
  if (!brief || !currentRepo) return;
  const btn = document.getElementById("brief-copy");
  navigator.clipboard.writeText(briefMarkdown(currentRepo, brief.issue, brief)).then(() => {
    btn.innerHTML = `${icon("check", "icon-sm")}Copied`;
    setTimeout(() => { btn.innerHTML = `${icon("copy", "icon-sm")}Copy`; }, 1500);
  });
}
