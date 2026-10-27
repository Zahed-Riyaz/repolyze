// ── Contributor guide: the files an issue needs ──────────────────────────────
// Path ranking alone guesses from file names. This combines stronger signals
// and says where each file came from, so the reader can judge it:
//   high   — named in the issue or its comments (paths, stack traces, links);
//            changed by a PR that references the issue (even a closed one)
//   medium — defines an identifier the issue names (code search, with a token);
//            the tests for a file found above
//   low    — its name matches the issue (the old path ranking), as a fallback
// Used by the side panel's issue brief and, through the background worker, by
// the guide on GitHub's issue pages. Cost: the issue's PRs' file lists (≤2
// requests) and, with a token, ≤2 code searches; file reads come from raw.

const GUIDE_MAX_FILES = 8;

// Paths written anywhere in the text → repo files. Handles "src/x.ts:12",
// Python tracebacks with absolute paths (File "/home/me/proj/app/db.py"), and
// GitHub blob links: leading segments are dropped until a path matches. A bare
// file name that matches several files ("index.ts") is ambiguous and skipped.
function namedPaths(text, blobs, limit = 6) {
  const paths = blobs.map(b => b.path);
  const found = [];
  for (const raw of (text || "").match(/[\w@.~/-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}\b/g) || []) {
    const segs = raw.replace(/^[./~]+/, "").split("/").filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const suffix = segs.slice(i).join("/");
      const hits = paths.filter(p => p === suffix || p.endsWith(`/${suffix}`));
      const lastSegment = i === segs.length - 1;
      if (hits.length === 1 || (hits.length > 1 && !lastSegment)) {
        if (!found.includes(hits[0])) found.push(hits[0]);
        break;
      }
      if (hits.length > 1) break; // only a bare, ambiguous file name is left
    }
    if (found.length >= limit) break;
  }
  return found;
}

// PRs that reference the issue (timeline cross-references), most telling first:
// merged, then open, then closed without merging
function referencingPrs(timeline) {
  const prs = new Map();
  for (const ev of timeline || []) {
    const src = ev.event === "cross-referenced" ? ev.source?.issue : null;
    if (src?.pull_request) prs.set(src.number, { number: src.number, state: src.state, merged: !!src.pull_request.merged_at });
  }
  const rank = (p) => (p.merged ? 0 : p.state === "open" ? 1 : 2);
  return [...prs.values()].sort((a, b) => rank(a) - rank(b) || b.number - a.number);
}

// The test file for a source file, by the usual naming conventions
// (timer.ts → timer.test.ts / timer.spec.ts; db.py → test_db.py / db_test.py)
function testFileFor(path, blobs) {
  const name = path.split("/").pop();
  const base = name.replace(/\.[^.]+$/, "");
  if (!base || TEST_PATH.test(path)) return null;
  const re = new RegExp(`^(?:test_)?${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[._-](?:test|spec))?\\.[A-Za-z0-9]+$`, "i");
  const dir = path.slice(0, path.lastIndexOf("/"));
  const hits = blobs.filter(b => b.path !== path && TEST_PATH.test(b.path) && re.test(b.path.split("/").pop()));
  // Prefer one next to the source, then unit-test folders over e2e/benchmarks, then the shortest path
  const top = dir.split("/")[0];
  const rank = (p) => (top && p.startsWith(`${top}/`) ? 2 : 0) + (/(^|\/)(tests?|__tests__)\//.test(p) ? 1 : 0) - (/(^|\/)(e2e|bench|benchmarks?|examples?)\//.test(p) ? 1 : 0);
  hits.sort((a, b) => rank(b.path) - rank(a.path) || a.path.length - b.path.length);
  return hits[0]?.path || null;
}

const labelFor = (pr) => `changed by #${pr.number}${pr.merged ? " (merged)" : pr.state === "open" ? " (open PR)" : " (closed PR)"}`;

// The files an issue needs → [{ path, why, confidence: "high"|"medium"|"low" }]
async function resolveIssueFiles(repo, issue, { comments = [], timeline = [] } = {}) {
  const tree = await getRepoTree(repo);
  const blobs = tree.entries.filter(e => e.type === "blob" && !NOISE_PATH.test(e.path));
  const known = new Set(blobs.map(b => b.path));
  const out = new Map();
  const add = (path, why, confidence) => {
    if (!known.has(path) || out.has(path) || NOT_CODE.test(path)) return;
    out.set(path, { path, why, confidence });
  };

  // 1. Named in the issue or its comments
  const text = [issue.title, issue.body || "", ...comments.map(c => c.body || "")].join("\n");
  for (const p of namedPaths(text, blobs)) add(p, "named in the issue", "high");

  // 2. Changed by PRs that reference it
  for (const pr of referencingPrs(timeline).slice(0, 2)) {
    const files = await fetchGitHub(`/pulls/${pr.number}/files?per_page=100`, repo).catch(() => []);
    for (const f of files.filter(f => f.status !== "removed").slice(0, 5)) add(f.filename, labelFor(pr), "high");
  }

  // 3. Where identifiers it names are defined (code search needs a token)
  if (githubToken) {
    for (const id of questionIdentifiers(`${issue.title}\n${issue.body || ""}`).slice(0, 2)) {
      const paths = (await searchCodeFor(id, repo).catch(() => []))
        .filter(p => known.has(p) && isCodeCandidate({ path: p, type: "blob", size: 0 }))
        .slice(0, 3);
      let hit = null;
      for (const p of paths) {
        const src = await readRepoFile(p, repo).catch(() => null);
        if (src && definesIdentifier(src, id)) { hit = p; break; }
      }
      if (hit) add(hit, `defines ${id}`, "medium");
      else if (paths[0]) add(paths[0], `uses ${id}`, "medium");
    }
  }

  // 3b. Nothing concrete yet: with a token, search the code for the issue's most
  //     specific words — content, not file names ("banner" finds the code that draws it)
  if (githubToken && ![...out.values()].some(f => f.confidence !== "low")) {
    const words = searchWords(issue.title);
    for (const query of [words.slice(0, 2), words.slice(0, 1)]) {
      if (!query.length) continue;
      const paths = (await searchCodeFor(query.join(" "), repo).catch(() => []))
        .filter(p => known.has(p) && isCodeCandidate({ path: p, type: "blob", size: 0 }) && !TEST_PATH.test(p));
      paths.slice(0, 3).forEach(p => add(p, `mentions “${query.join(" ")}”`, "medium"));
      if (paths.length) break;
    }
  }

  // 4. Tests for the source files found so far
  for (const f of [...out.values()].filter(f => !TEST_PATH.test(f.path)).slice(0, 3)) {
    const t = testFileFor(f.path, blobs);
    if (t) add(t, `tests ${f.path.split("/").pop()}`, "medium");
  }

  // 5. Fallback: file names that match the issue
  if (out.size < 3) {
    const ranked = rankCodeFiles(blobs, queryTerms(`${issue.title} ${(issue.body || "").slice(0, 600)}`)).filter(f => f.score >= 1);
    for (const f of ranked.slice(0, 5 - out.size)) add(f.path, "name matches the issue", "low");
  }
  return [...out.values()].slice(0, GUIDE_MAX_FILES);
}

// ── Presenting it (shared by the panel's brief and the page card) ────────────
// Files with a real signal come first as "where to start"; name-matching
// guesses are kept apart and folded, so they never read as facts.
function groupIssueFiles(files) {
  return { start: files.filter(f => f.confidence !== "low"), guesses: files.filter(f => f.confidence === "low") };
}

// "packages/core/src/tools/gemini-3.ts" → { name: "gemini-3.ts", dir: "packages/core/src/tools" }
function splitPath(path) {
  const i = path.lastIndexOf("/");
  return { name: path.slice(i + 1), dir: i > 0 ? path.slice(0, i) : "" };
}

// A long folder, shortened in the middle so both ends stay readable:
// "packages/core/src/tools/definitions/model-family-sets" → "packages/…/definitions/model-family-sets"
function shortDir(dir, max = 42) {
  if (dir.length <= max) return dir;
  const parts = dir.split("/");
  let tail = parts.slice(-2).join("/");
  if (`${parts[0]}/…/${tail}`.length > max) tail = parts.at(-1);
  return parts.length > 2 ? `${parts[0]}/…/${tail}` : `…${dir.slice(-(max - 1))}`;
}

// "@google-gemini/gemini-cli-maintainers" in a google-gemini repo → "gemini-cli-maintainers"
function ownerDisplay(handle, repoOwner) {
  const m = handle.match(/^@([^/]+)\/(.+)$/);
  return m && repoOwner && m[1].toLowerCase() === repoOwner.toLowerCase() ? m[2] : handle.replace(/^@/, "");
}

// Code owners across the files, once each, most files first
function ownerSummary(files, rules, repoOwner) {
  const owners = new Map();
  for (const f of files) {
    for (const h of codeOwnersFor(f.path, rules)) {
      const o = owners.get(h) || { handle: h, display: ownerDisplay(h, repoOwner), files: [] };
      o.files.push(f.path);
      owners.set(h, o);
    }
  }
  return [...owners.values()].sort((a, b) => b.files.length - a.files.length);
}

// Everything the page guide shows for one issue (served by the background worker)
async function issueGuide({ owner, repo: name, number }) {
  const repo = { owner, repo: name };
  const [issue, thread, owners, meta] = await Promise.all([
    // The card sits on the issue's own page: check what's there now (free when unchanged)
    fetchGitHub(`/issues/${number}`, repo, { revalidate: true }),
    loadIssueThread(repo, number, { revalidate: true }),
    loadCodeOwners(repo).catch(() => ({ rules: [] })),
    loadRepoData(repo).catch(() => ({})),
  ]);
  if (issue.pull_request) return { kind: "pr" };
  const files = await resolveIssueFiles(repo, issue, thread);
  const a = issueAvailability(issue, thread.comments, thread.timeline, Date.now());
  // Names and short folders worked out here, so the page card only renders
  const shape = (f) => { const { name, dir } = splitPath(f.path); return { ...f, name, dir: shortDir(dir, 36) }; };
  const { start, guesses } = groupIssueFiles(files.map(shape));
  return {
    kind: "issue", number, title: issue.title, ref: meta.default_branch || "HEAD",
    availability: { status: a.status, verdict: a.verdict, advice: a.advice, reasons: a.reasons.slice(0, 3).map(r => r.text) },
    start, guesses,
    owners: ownerSummary(start.length ? start : guesses, owners.rules, owner).slice(0, 3),
    stack: issueStack(issue, files.map(f => f.path)).map(i => i.name),
  };
}
