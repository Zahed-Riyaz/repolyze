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

// Is the issue actually free? → { status: free|maybe|taken, verdict, advice, reasons[] }
function issueAvailability(issue, comments, timeline, now) {
  const order = { free: 0, maybe: 1, taken: 2 };
  let status = "free";
  const bump = (s) => { if (order[s] > order[status]) status = s; };
  const reasons = [];

  const assignees = issue.assignees?.length ? issue.assignees : issue.assignee ? [issue.assignee] : [];
  if (assignees.length) {
    bump("taken");
    reasons.push({ tone: "bad", text: `Assigned to ${assignees.map(a => `@${a.login}`).join(", ")}` });
  }

  const prs = new Map();
  for (const ev of timeline) {
    const src = ev.event === "cross-referenced" ? ev.source?.issue : null;
    if (src?.pull_request) prs.set(src.number, src);
  }
  for (const pr of prs.values()) {
    const by = pr.user?.login ? ` by @${pr.user.login}` : "";
    if (pr.state === "open") {
      bump("taken");
      reasons.push({ tone: "bad", text: `Open PR #${pr.number}${by} references it`, url: pr.html_url });
    } else if (pr.pull_request.merged_at) {
      bump("maybe");
      reasons.push({ tone: "warn", text: `PR #${pr.number}${by} that references it was merged — it may already be fixed`, url: pr.html_url });
    } else {
      reasons.push({ tone: "info", text: `PR #${pr.number}${by} was closed without merging — worth reading why`, url: pr.html_url });
    }
  }

  // Latest claim per person; someone who already opened a PR is covered above
  const prAuthors = new Set([...prs.values()].map(pr => pr.user?.login));
  const claims = new Map();
  for (const c of comments) {
    if (!c.user || isBot(c.user) || MAINTAINER_ROLES.has(c.author_association)) continue;
    if (!looksLikeClaim(c.body) || prAuthors.has(c.user.login)) continue;
    claims.set(c.user.login, c);
  }
  for (const c of claims.values()) {
    const recent = now - Date.parse(c.created_at) <= 30 * DAY_MS;
    if (recent) bump("maybe");
    reasons.push({
      tone: recent ? "warn" : "info",
      text: recent
        ? `@${c.user.login} offered to work on it ${daysAgo(c.created_at)}`
        : `@${c.user.login} offered ${daysAgo(c.created_at)} but no PR followed — probably free, but ask first`,
      url: c.html_url,
    });
  }

  const maintainerReplied = comments.some(c => c.user && !isBot(c.user) && MAINTAINER_ROLES.has(c.author_association));
  if (!maintainerReplied) {
    reasons.push({ tone: "info", text: comments.length ? "No maintainer has replied in the thread yet" : "No comments yet — no maintainer has weighed in" });
  }
  // A closed issue (e.g. found with Find) isn't available, whatever else is true
  if (issue.state === "closed") {
    const how = issue.state_reason === "not_planned" ? " as not planned" : issue.state_reason === "completed" ? " as completed" : "";
    reasons.unshift({ tone: "bad", text: `Closed${how} ${daysAgo(issue.closed_at || issue.updated_at)}` });
    return {
      status: "taken", verdict: "Closed", reasons,
      advice: "Read the thread for why it was closed before working on anything similar; reopening it is a maintainer's call.",
    };
  }
  if (status === "free") reasons.unshift({ tone: "good", text: "No assignee, linked PR or recent claim" });

  const verdict = { free: "Looks free", maybe: "Possibly taken", taken: "Already taken" }[status];
  const advice = {
    free: "Leave a short comment saying you'd like to work on it before you start.",
    maybe: "Ask in the thread whether it's still being worked on before you start.",
    taken: "Pick another issue, or offer to help whoever has it.",
  }[status];
  return { status, verdict, advice, reasons };
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

// What a contributor should run before opening a PR → [{ cmd, from }]
function verifyCommands({ workflowText, workflowPath, packageJson, packageManager = "npm" }) {
  const seen = new Set();
  const out = [];
  const add = (cmd, from) => {
    const key = cmd.replace(/\s+/g, " ");
    if (!seen.has(key) && out.length < 8) { seen.add(key); out.push({ cmd: key, from }); }
  };
  for (const cmd of ciRunCommands(workflowText)) {
    if (VERIFY_CMD.test(cmd) && !NOT_VERIFY.test(cmd)) add(cmd, workflowPath);
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
  if (brief.likelyFiles?.length) lines.push("", "## Likely files", ...brief.likelyFiles.map(f => `- ${f}`));
  const people = brief.people;
  if (people?.owners.length || people?.inThread.length) {
    lines.push("", "## Who to ask");
    for (const o of people.owners) lines.push(`- ${o.handle} — code owner of ${o.files.join(", ")}`);
    for (const p of people.inThread) lines.push(`- @${p.login} — replied ${p.replies}× in this thread`);
  }
  if (brief.commands.length) {
    lines.push("", "## Run before opening a PR", "```bash", ...brief.commands.map(c => c.cmd), "```");
  }
  return lines.join("\n");
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadIssueThread(repo, number) {
  const [comments, timeline] = await Promise.all([
    fetchGitHub(`/issues/${number}/comments?per_page=100`, repo),
    fetchGitHub(`/issues/${number}/timeline?per_page=100`, repo),
  ]);
  return { comments, timeline };
}

async function loadVerifyCommands(repo) {
  const tree = await getRepoTree(repo);
  const has = (p) => tree.entries.some(e => e.path === p);
  const workflow = pickWorkflow(tree.entries);
  const [workflowText, packageJson] = await Promise.all([
    workflow ? readRepoFile(workflow.path, repo).catch(() => null) : null,
    has("package.json") ? readRepoFile("package.json", repo).catch(() => null) : null,
  ]);
  const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
  return verifyCommands({ workflowText, workflowPath: workflow?.path, packageJson, packageManager });
}

// Files the issue is probably about: the best path matches for its title and body
async function likelyFiles(repo, issue) {
  const tree = await getRepoTree(repo);
  const terms = queryTerms(`${issue.title} ${(issue.body || "").slice(0, 600)}`);
  return rankCodeFiles(tree.entries, terms).filter(f => f.score >= 1).slice(0, 5).map(f => f.path);
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
async function showIssueBrief(issueOrNumber, { auto = false } = {}) {
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
    let brief = briefs[number];
    if (!brief) {
      const [issue, { comments, timeline }, commands, owners] = await Promise.all([
        listIssue || fetchGitHub(`/issues/${number}`, repo),
        loadIssueThread(repo, number),
        loadVerifyCommands(repo).catch(() => []),
        loadCodeOwners(repo).catch(() => ({ rules: [] })),
      ]);
      if (issue.pull_request) {
        if (live()) body.innerHTML = placeholder() + stateItem(`#${number} is a pull request. <button class="btn btn-xs brief-open-pr" data-pr="${number}">Open its brief</button>`, { tag: "div" });
        return;
      }
      // Path matches point at where to look and whose code it is — no AI needed
      const files = await likelyFiles(repo, issue).catch(() => []);
      brief = briefs[number] = {
        issue, comments, commands, codeOwnerRules: owners.rules,
        availability: issueAvailability(issue, comments, timeline, Date.now()),
        likelyFiles: files, people: briefPeople(files, owners.rules, comments),
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
  const reasons = a.reasons.map(r => `
    <li class="reason reason-${r.tone}">${icon(REASON_ICONS[r.tone], "icon-sm")}
      <span>${r.url ? `<a href="${r.url}" target="_blank">${escapeHtml(r.text)}</a>` : escapeHtml(r.text)}</span></li>`).join("");
  const commands = brief.commands.length
    ? brief.commands.map(c => `
        <div class="cmd-row"><code class="cmd-code">${escapeHtml(c.cmd)}</code>
          <button class="copy-btn" data-cmd="${escapeHtml(c.cmd)}" title="From ${escapeHtml(c.from)}">${icon("copy", "icon-sm")}Copy</button></div>`).join("") +
      `<p class="brief-note">From ${[...new Set(brief.commands.map(c => c.from))].map(f => `<code>${escapeHtml(f)}</code>`).join(" and ")}</p>`
    : `<p class="brief-note">No CI workflow or test scripts found — check the README or CONTRIBUTING for how to run tests.</p>`;

  document.getElementById("brief-body").innerHTML = `
    ${briefHeaderHtml(issue)}
    <section class="card availability availability-${a.status}">
      <div class="availability-head"><span class="availability-dot"></span><strong>${a.verdict}</strong></div>
      <ul class="reason-list">${reasons}</ul>
      <p class="brief-note">${escapeHtml(a.advice)}</p>
    </section>
    ${askRowHtml("issue")}
    ${stackSectionHtml(issueStack(issue, brief.likelyFiles))}
    ${brief.likelyFiles.length ? `<section class="brief-section">
      <h2 class="section-title">Likely files</h2>
      <ul class="brief-files">${brief.likelyFiles.map(f => `<li><a href="${sourceUrl(repo, null, f)}" target="_blank"><code>${escapeHtml(f)}</code></a></li>`).join("")}</ul>
    </section>` : ""}
    <section class="brief-section">
      <h2 class="section-title">Who to ask</h2>
      <div id="brief-people"></div>
    </section>
    <section class="brief-section">
      <h2 class="section-title">Run before opening a PR</h2>
      ${commands}
    </section>`;
  renderBriefPeople(brief.people);
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
        <button class="ask-chip ask-chip-own" data-kind="${kind}">Your own question${icon("arrow-right", "icon-sm")}</button>
      </div>
      <p class="brief-note">Answers appear in Ask, grounded in this ${noun}${kind === "pr" ? "'s discussion and diff" : " and the code it touches"}.</p>`
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
    el.innerHTML = `<p class="brief-note">No code owners or maintainers found for this area — ask in the issue thread and the maintainers will route it.</p>`;
    return;
  }
  el.innerHTML = `<ul class="people-list">
    ${owners.map(o => {
      const name = o.handle.slice(1);
      const isTeam = name.includes("/");
      return `<li class="person">
        ${isTeam ? `<span class="team-avatar">${icon("users", "icon-sm")}</span>` : `<img src="https://github.com/${encodeURIComponent(name)}.png?size=64" class="contributor-avatar" alt="" loading="lazy">`}
        <div class="contributor-info">
          <div class="contributor-top"><a href="https://github.com/${isTeam ? `orgs/${name.split("/")[0]}/teams/${name.split("/")[1]}` : encodeURIComponent(name)}" target="_blank" class="contributor-name">${escapeHtml(isTeam ? o.handle : name)}</a>
            <span class="role-chips"><span class="role-chip role-owner">Code owner</span></span></div>
          <div class="person-sub">Owns ${o.files.map(f => `<code>${escapeHtml(f.split("/").pop())}</code>`).join(", ")}</div>
        </div></li>`;
    }).join("")}
    ${inThread.map(p => `<li class="person">
        <img src="${avatarUrl(p.avatar_url, 64)}" class="contributor-avatar" alt="" loading="lazy">
        <div class="contributor-info">
          <div class="contributor-top"><a href="${p.html_url}" target="_blank" class="contributor-name">${escapeHtml(p.login)}</a>
            <span class="role-chips"><span class="role-chip">${ROLE_NAMES[p.role] || p.role}</span></span></div>
          <div class="person-sub">Replied ${p.replies}× in this thread</div>
        </div></li>`).join("")}
  </ul>`;
}

// Buttons inside the brief (event delegation, since the body is re-rendered)
function handleBriefClick(e) {
  const target = e.target;
  const copy = target.closest?.(".copy-btn");
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.cmd).then(() => {
      copy.innerHTML = `${icon("check", "icon-sm")}Copied`;
      setTimeout(() => { copy.innerHTML = `${icon("copy", "icon-sm")}Copy`; }, 1500);
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

function copyBrief() {
  const brief = currentBrief();
  if (!brief || !currentRepo) return;
  const btn = document.getElementById("brief-copy");
  navigator.clipboard.writeText(briefMarkdown(currentRepo, brief.issue, brief)).then(() => {
    btn.innerHTML = `${icon("check", "icon-sm")}Copied`;
    setTimeout(() => { btn.innerHTML = `${icon("copy", "icon-sm")}Copy`; }, 1500);
  });
}
