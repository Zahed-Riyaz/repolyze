// ── Repo insights: maintainers, health signals, beginner issues ───────────────
// Measured from GitHub data rather than guessed:
//  • maintainers = people GitHub marks OWNER / MEMBER / COLLABORATOR who actually
//    replied on issues or PRs recently, plus CODEOWNERS entries
//  • health = response time and rate, outside PRs merged, merge speed, activity
//    and onboarding docs; signals without enough data are left out of the
//    score instead of counting as zero
// The pure functions at the bottom do the maths and are unit-tested.

const DAY_MS = 86_400_000;
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const ACTIVITY_WINDOW_DAYS = 90;

function isBot(user) {
  return user?.type === "Bot" || /\[bot\]$|-bot$|^(dependabot|renovate|github-actions|codecov|netlify|vercel)/i.test(user?.login || "");
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ── Data loading (cached per repo) ───────────────────────────────────────────
// Recent issue/PR comments + recently opened issues/PRs. One page of comments
// anonymously (quota is tight), up to three with a token.
function loadRepoActivity(repo = currentRepo) {
  const cache = cacheFor(repoKey(repo));
  cache.activityPromise ??= (async () => {
    // Day-aligned so the URL (and therefore the response cache key) is stable
    const since = new Date(Math.floor((Date.now() - ACTIVITY_WINDOW_DAYS * DAY_MS) / DAY_MS) * DAY_MS).toISOString();
    const [comments, recent] = await Promise.all([
      (async () => {
        const all = [];
        const pages = githubToken ? 3 : 1;
        for (let page = 1; page <= pages; page++) {
          const batch = await fetchGitHub(`/issues/comments?sort=created&direction=desc&since=${since}&per_page=100&page=${page}`, repo);
          all.push(...batch);
          if (batch.length < 100) return { items: all, complete: true };
        }
        return { items: all, complete: false };
      })(),
      fetchGitHub("/issues?state=all&sort=created&direction=desc&per_page=50", repo),
    ]);
    return { comments: comments.items, commentsComplete: comments.complete, recent, since };
  })().catch(err => { delete cache.activityPromise; throw err; });
  return cache.activityPromise;
}

function loadLabels(repo = currentRepo) {
  const cache = cacheFor(repoKey(repo));
  cache.labelsPromise ??= fetchGitHub("/labels?per_page=100", repo)
    .then(labels => labels.map(l => l.name))
    .catch(err => { delete cache.labelsPromise; throw err; });
  return cache.labelsPromise;
}

// This repo's actual label names for a filter ("good-first-issue" → ["good first issue", "E-easy"…])
async function labelsForFilter(filter, repo = currentRepo) {
  return (await loadLabels(repo)).filter(name => labelMatchesFilter(name, filter) && !name.includes(","));
}

async function loadCodeOwners(repo = currentRepo) {
  const tree = await getRepoTree(repo);
  const file = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"].find(p => tree.entries.some(e => e.path === p));
  if (!file) return { file: null, rules: [] };
  const text = await readRepoFile(file, repo).catch(() => null);
  return { file, rules: text ? parseCodeOwners(text) : [] };
}

// Everything the health score needs, fetched in parallel
async function loadHealthSignals(repo = currentRepo) {
  const [meta, profile, closed, activity, openPRCount, beginnerCount] = await Promise.allSettled([
    loadRepoData(repo),
    fetchGitHub("/community/profile", repo),
    fetchGitHub("/pulls?state=closed&sort=updated&direction=desc&per_page=50", repo),
    loadRepoActivity(repo),
    fetchGitHubPage("/pulls?state=open&per_page=1", repo).then(({ data, link }) => {
      const m = (link || "").match(/page=(\d+)>; rel="last"/);
      return m ? parseInt(m[1]) : data.length;
    }),
    countBeginnerIssues(repo),
  ]);
  // A score built from rate-limited gaps would be wrong and then cached
  const limited = [meta, profile, closed, activity, openPRCount].find(r => r.status === "rejected" && r.reason?.rateLimited);
  if (limited) throw limited.reason;

  const val = (r) => (r.status === "fulfilled" ? r.value : null);
  const files = val(profile)?.files || null;
  let hasIssueTemplates = files?.issue_template ? true : null;
  if (hasIssueTemplates === null) {
    // The profile misses directory-style templates (.github/ISSUE_TEMPLATE/…)
    const tree = await getRepoTree(repo).catch(() => null);
    hasIssueTemplates = tree ? tree.entries.some(e => /^\.github\/ISSUE_TEMPLATE(\/|\.md$)/i.test(e.path)) : null;
  }
  const act = val(activity);
  return {
    now: Date.now(),
    repoData: val(meta),
    docs: files ? {
      contributing: !!files.contributing,
      issueTemplates: hasIssueTemplates,
      prTemplate: !!files.pull_request_template,
      codeOfConduct: !!files.code_of_conduct,
    } : null,
    response: act ? responseStats(act.recent, act.comments, act.commentsComplete ? act.since : null, Date.now()) : null,
    prs: val(closed) ? prStats(val(closed)) : null,
    openPRs: val(openPRCount),
    beginnerIssues: val(beginnerCount),
  };
}

// Count of open, unassigned beginner issues with no linked PR (search API, own quota)
async function countBeginnerIssues(repo = currentRepo) {
  const labels = await labelsForFilter("good-first-issue", repo);
  if (!labels.length) return 0;
  const q = beginnerSearchQuery(repo, labels, { unclaimed: true });
  const res = await fetchGitHub(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=1`, repo);
  return res.total_count ?? 0;
}

// ── Pure calculations ────────────────────────────────────────────────────────
// CODEOWNERS → [{ pattern, owners: ["@user", "@org/team"] }]
function parseCodeOwners(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...rest] = line.split(/\s+/);
    const owners = rest.filter(o => o.startsWith("@"));
    if (owners.length) rules.push({ pattern, owners });
  }
  return rules;
}

// People who keep the project moving: maintainer-role replies in the window,
// merged with individual CODEOWNERS. Sorted by threads replied to.
function activeMaintainers(comments, codeOwnerRules = []) {
  const people = new Map();
  for (const c of comments) {
    if (!c.user || isBot(c.user) || !MAINTAINER_ROLES.has(c.author_association)) continue;
    const login = c.user.login;
    const p = people.get(login) || {
      login, avatar_url: c.user.avatar_url, html_url: c.user.html_url,
      role: c.author_association, replies: 0, threads: new Set(), lastActive: c.created_at, owns: [],
    };
    p.replies++;
    p.threads.add(c.issue_url);
    if (c.created_at > p.lastActive) p.lastActive = c.created_at;
    people.set(login, p);
  }
  const teams = new Set();
  for (const rule of codeOwnerRules) {
    for (const owner of rule.owners) {
      const name = owner.slice(1);
      if (name.includes("/")) { teams.add(owner); continue; }
      const p = people.get(name) || {
        login: name, avatar_url: `https://github.com/${encodeURIComponent(name)}.png?size=64`, html_url: `https://github.com/${encodeURIComponent(name)}`,
        role: null, replies: 0, threads: new Set(), lastActive: null, owns: [],
      };
      if (p.owns.length < 3 && !p.owns.includes(rule.pattern)) p.owns.push(rule.pattern);
      p.codeOwner = true;
      people.set(name, p);
    }
  }
  const list = [...people.values()].map(p => ({ ...p, threads: p.threads.size }));
  list.sort((a, b) => b.threads - a.threads || (b.lastActive || "").localeCompare(a.lastActive || "") || a.login.localeCompare(b.login));
  return { people: list, teams: [...teams] };
}

// Time to first maintainer response on issues/PRs opened by non-maintainers.
// Only items older than 2 days count (newer ones haven't had a fair chance),
// and only those inside the comment sample (`coverageStart`), so a reply we
// didn't fetch is never mistaken for silence. Closing counts as a response.
function responseStats(recent, comments, coverageStart, now) {
  const oldestComment = comments.reduce((min, c) => (!min || c.created_at < min ? c.created_at : min), null);
  const from = coverageStart || oldestComment;
  if (!from) return null;

  const firstReply = new Map(); // issue number → earliest maintainer comment time
  for (const c of comments) {
    if (!c.user || isBot(c.user) || !MAINTAINER_ROLES.has(c.author_association)) continue;
    const num = Number(c.issue_url?.split("/").pop());
    const t = Date.parse(c.created_at);
    if (!firstReply.has(num) || t < firstReply.get(num)) firstReply.set(num, t);
  }

  const hours = [];
  let sample = 0;
  for (const item of recent) {
    if (isBot(item.user) || MAINTAINER_ROLES.has(item.author_association)) continue;
    const created = Date.parse(item.created_at);
    if (item.created_at < from || now - created < 2 * DAY_MS) continue;
    sample++;
    const replies = [firstReply.get(item.number), item.closed_at ? Date.parse(item.closed_at) : null].filter(t => t && t >= created);
    if (replies.length) hours.push((Math.min(...replies) - created) / 3_600_000);
  }
  if (sample < 5) return { sample, answered: hours.length, rate: null, medianHours: null };
  return { sample, answered: hours.length, rate: hours.length / sample, medianHours: median(hours) };
}

// Recently closed PRs → merge speed and how open the project is to outsiders
function prStats(closedPRs) {
  const human = closedPRs.filter(p => !isBot(p.user));
  const merged = human.filter(p => p.merged_at);
  const outside = human.filter(p => !MAINTAINER_ROLES.has(p.author_association));
  const outsideMerged = outside.filter(p => p.merged_at);
  return {
    sample: human.length,
    merged: merged.length,
    medianMergeDays: median(merged.map(p => (Date.parse(p.merged_at) - Date.parse(p.created_at)) / DAY_MS)),
    outsideClosed: outside.length,
    outsideMerged: outsideMerged.length,
    outsideAcceptance: outside.length ? outsideMerged.length / outside.length : null,
    outsideShare: merged.length ? outsideMerged.length / merged.length : null,
  };
}

const tier = (value, steps) => { for (const [limit, pts] of steps) if (value <= limit) return pts; return 0; };
const pct = (x) => `${Math.round(x * 100)}%`;
const fmtHours = (h) => (h < 1 ? "<1h" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

// Weights reflect what research on newcomer onboarding flags most: getting a
// timely reply matters most, then whether outside PRs actually land.
function scoreHealth(sig) {
  const factors = [];

  // Maintainer response (30): speed of first reply + share that get one
  const r = sig.response;
  if (r && r.rate !== null) {
    const speed = r.medianHours === null ? 0 : tier(r.medianHours, [[24, 20], [72, 16], [168, 10], [720, 4]]);
    const coverage = r.rate >= 0.8 ? 10 : r.rate >= 0.5 ? 6 : r.rate >= 0.25 ? 3 : 0;
    factors.push({ key: "response", label: "Maintainer response", max: 30, points: speed + coverage,
      detail: `${pct(r.rate)} of ${r.sample} new issues/PRs got a reply${r.medianHours !== null ? ` · median ${fmtHours(r.medianHours)}` : ""}` });
  } else {
    factors.push({ key: "response", label: "Maintainer response", max: 30, points: null, detail: "Not enough recent issues to measure" });
  }

  // Outside contributions (25): do non-maintainers' PRs get merged?
  const p = sig.prs;
  if (p && p.outsideClosed >= 3) {
    const share = p.outsideShare === null ? 0 : p.outsideShare >= 0.3 ? 15 : p.outsideShare >= 0.1 ? 10 : p.outsideShare > 0 ? 5 : 0;
    const accept = p.outsideAcceptance >= 0.6 ? 10 : p.outsideAcceptance >= 0.3 ? 6 : p.outsideAcceptance > 0 ? 3 : 0;
    factors.push({ key: "outside", label: "Merges outside PRs", max: 25, points: share + accept,
      detail: `${p.outsideMerged} of ${p.outsideClosed} recent PRs from outside contributors merged` });
  } else {
    factors.push({ key: "outside", label: "Merges outside PRs", max: 25, points: null, detail: "Too few recent outside PRs to judge" });
  }

  // Merge speed (15)
  if (p && p.merged >= 3 && p.medianMergeDays !== null) {
    factors.push({ key: "merge", label: "Merge speed", max: 15, points: tier(p.medianMergeDays, [[2, 15], [7, 11], [14, 7], [30, 3]]),
      detail: `Median ${p.medianMergeDays < 1 ? "<1 day" : `${Math.round(p.medianMergeDays)} days`} from open to merge (${p.merged} PRs)` });
  } else {
    factors.push({ key: "merge", label: "Merge speed", max: 15, points: null, detail: "Too few recent merges to judge" });
  }

  // Activity (15)
  if (sig.repoData?.pushed_at) {
    const days = (sig.now - Date.parse(sig.repoData.pushed_at)) / DAY_MS;
    factors.push({ key: "activity", label: "Recent activity", max: 15, points: tier(days, [[7, 15], [30, 11], [90, 6], [180, 2]]),
      detail: `Last push ${daysAgo(sig.repoData.pushed_at)}${sig.repoData.archived ? " · archived" : ""}` });
  } else {
    factors.push({ key: "activity", label: "Recent activity", max: 15, points: null, detail: "Unknown" });
  }

  // Onboarding (15): each known item earns its share; unknown items are skipped
  const d = sig.docs;
  const items = [
    ["CONTRIBUTING guide", d?.contributing, 5],
    ["beginner issues", sig.beginnerIssues === null || sig.beginnerIssues === undefined ? null : sig.beginnerIssues > 0, 4],
    ["issue templates", d?.issueTemplates, 3],
    ["PR template", d?.prTemplate, 2],
    ["code of conduct", d?.codeOfConduct, 1],
  ].filter(([, v]) => v !== null && v !== undefined);
  if (items.length) {
    const avail = items.reduce((n, [, , w]) => n + w, 0);
    const got = items.reduce((n, [, v, w]) => n + (v ? w : 0), 0);
    const missing = items.filter(([, v]) => !v).map(([name]) => name);
    factors.push({ key: "onboarding", label: "Onboarding", max: 15, points: Math.round((got / avail) * 15),
      detail: missing.length ? `Missing: ${missing.join(", ")}` : "Guide, templates and beginner issues all present" });
  } else {
    factors.push({ key: "onboarding", label: "Onboarding", max: 15, points: null, detail: "Unknown" });
  }

  const measured = factors.filter(f => f.points !== null);
  const maxAvail = measured.reduce((n, f) => n + f.max, 0);
  const earned = measured.reduce((n, f) => n + f.points, 0);
  let score = maxAvail ? Math.round((earned / maxAvail) * 100) : null;
  // An archived repo doesn't accept contributions, whatever its history says
  if (score !== null && sig.repoData?.archived) score = Math.min(score, 20);
  return { score, factors, measured: measured.length };
}

// Search query for beginner/help-wanted issues using the repo's real labels
function beginnerSearchQuery(repo, labels, { unclaimed }) {
  const labelList = labels.map(l => `"${l.replace(/"/g, "")}"`).join(",");
  return [`repo:${repo.owner}/${repo.repo}`, "is:issue", "is:open", `label:${labelList}`,
    ...(unclaimed ? ["no:assignee", "-linked:pr"] : [])].join(" ");
}
