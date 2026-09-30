// ── From clone to pull request ───────────────────────────────────────────────
// The last part of an issue brief: how to set the repo up locally, what CI will
// run, and what this repo expects of a pull request, with a title and a
// description (the repo's own PR template, "Fixes #N" filled in) ready to copy.
// Everything comes from the repo's own files (contributing docs, manifests,
// lockfiles, CI, PR template) and the titles of recently merged PRs — no AI.
//
// Repo-level facts are loaded once per repo (loadRepoFlow); what depends on
// the issue (branch name, PR title and body) is worked out when rendering.

// Headings of doc sections that explain how to get a working copy
const SETUP_HEADING = /\b(set ?up|setting up|install(ing|ation)?|getting started|get started|develop(ment|ing)?|local(ly)?|build(ing)? (it )?from source|prerequisites?|environment|quick ?start|hacking|dev env|running the (app|project)|bootstrap)/i;
const NOT_SETUP_HEADING = /\b(release|deploy|publish|licen[cs]e|code of conduct|security|sponsor)/i;
// Subsections under a setup heading that aren't setup
const NOT_SETUP_SUBSECTION = /\b(bench\w*|profil\w*|releas\w*|publish\w*|deploy\w*|debug\w*|troubleshoot\w*|coverage|fuzz\w*|docs? site|documentation|ecosystem|snapshot)/i;
// In a README, "Installation" usually means installing the package as a user
const README_SETUP_HEADING = /\b(develop(ment|ing)?|contribut\w*|from source|local development|hacking)\b/i;

// A command someone would type, as opposed to output or prose
const COMMAND_START = /^(?:(?:npm|npx|pnpm|yarn|bun|node|deno|pip3?|python3?|py|poetry|uv|pdm|pipenv|hatch|tox|nox|pytest|make|just|task|go|cargo|rustup|docker|docker-compose|podman|git|bundle|gem|rake|rails|mvn|\.\/mvnw|gradle|\.\/gradlew|composer|php|mix|dotnet|swift|flutter|dart|brew|apt(-get)?|nix|direnv|pre-commit|cp|mv|mkdir|export|source|bash|sh|corepack|nvm|fnm|volta|pyenv|asdf|mise|conda|mamba|virtualenv|venv|cmake|meson|ninja|bazel)(?=\s|$)|\.\/[\w./-]+|scripts\/\S+)/;

const SHELL_LANG = /^(sh|bash|shell|console|zsh|terminal|shell-session|shellsession|powershell|pwsh|ps1|cmd|bat|)$/;

// Commands in a Markdown section: fenced shell blocks (prompts stripped, output
// and comments skipped, "\" continuations joined), else inline `code` spans
// that start like a command.
function shellCommandsIn(markdown) {
  const out = [];
  for (const m of (markdown || "").matchAll(/^[ \t]*(```|~~~)[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)^[ \t]*\1/gm)) {
    if (!SHELL_LANG.test(m[2].toLowerCase())) continue;
    const lines = m[3].split("\n");
    const prompted = lines.some(l => /^\s*(\$|%|>)\s+\S/.test(l));
    let cont = "";
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      const p = line.match(/^(?:\$|%|>|PS [^>]*>)\s+(.*)$/);
      if (prompted && !p && !cont) continue; // output, in a block that uses prompts
      if (p) line = p[1];
      if (!cont && line.startsWith("#")) continue;
      line = cont ? `${cont} ${line}` : line;
      cont = "";
      if (/\\$/.test(line)) { cont = line.slice(0, -1).trim(); continue; }
      line = line.replace(/\s+#\s.*$/, "").trim(); // trailing comment
      if (COMMAND_START.test(line)) out.push(line);
    }
  }
  if (out.length) return out;
  for (const m of (markdown || "").matchAll(/`([^`\n]{3,120})`/g)) {
    const cmd = m[1].trim().replace(/^\$\s+/, "");
    if (COMMAND_START.test(cmd) && /\s/.test(cmd)) out.push(cmd);
  }
  return out;
}

// GitHub's heading anchors: lowercase, punctuation dropped, spaces → "-"
function headingSlug(heading) {
  return heading.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
}

// The doc section that best explains local setup → { path, heading, commands } | null.
// Contributing and development docs come first; a README only counts when the
// heading is about developing (its "Install" is usually for users).
function setupSectionFrom(docs) {
  for (const doc of docs) {
    const isReadme = /^readme/i.test(doc.path.split("/").pop());
    const headingOk = (s) => s.level && !NOT_SETUP_HEADING.test(s.path.join(" ")) && !NOT_SETUP_SUBSECTION.test(s.path.join(" ")) &&
      (isReadme ? README_SETUP_HEADING.test(s.path.join(" ")) : SETUP_HEADING.test(s.path.join(" ")));
    // Every matching section, with its subsections ("Setup" → "### Install deps"),
    // in document order: "Prerequisites" then "Development" both count
    const commands = [];
    let heading = null;
    for (let i = 0; i < doc.sections.length; i++) {
      const s = doc.sections[i];
      if (!headingOk(s)) continue;
      let j = i + 1;
      let body = s.body;
      for (; j < doc.sections.length && doc.sections[j].level > s.level; j++) {
        if (!NOT_SETUP_SUBSECTION.test(doc.sections[j].heading)) body += `\n${doc.sections[j].body}`;
      }
      const found = shellCommandsIn(body).filter(c => !commands.includes(c));
      if (found.length && heading === null) heading = s.heading;
      commands.push(...found);
      i = j - 1; // its subsections are done
    }
    if (commands.length) return { path: doc.path, heading, commands };
    // A development doc (docs/development.md…) is about setup as a whole
    if (!isReadme && !/contributing/i.test(doc.path)) {
      const all = shellCommandsIn(doc.sections.map(s => s.body).join("\n"));
      if (all.length) return { path: doc.path, heading: "", commands: all };
    }
  }
  return null;
}

// Versions the repo pins → ["Node 20", "Python ≥3.10", …]
function runtimeRequirements(files) {
  const out = [];
  const add = (s) => { if (s && !out.some(o => o.split(" ")[0] === s.split(" ")[0])) out.push(s); };
  const first = (t) => (t || "").split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#")) || "";
  if (files[".nvmrc"] || files[".node-version"]) add(`Node ${first(files[".nvmrc"] || files[".node-version"]).replace(/^v/, "")}`);
  try {
    const engines = JSON.parse(files["package.json"] || "{}").engines || {};
    if (engines.node) add(`Node ${engines.node}`);
  } catch { /* not JSON */ }
  if (files[".python-version"]) add(`Python ${first(files[".python-version"])}`);
  const py = (files["pyproject.toml"] || "").match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);
  if (py) add(`Python ${py[1].replace(/\s+/g, "")}`);
  const go = (files["go.mod"] || "").match(/^go\s+([\d.]+)/m);
  if (go) add(`Go ${go[1]}`);
  const rust = (files["rust-toolchain.toml"] || "").match(/channel\s*=\s*["']([^"']+)["']/) || (files["rust-toolchain"] ? [null, first(files["rust-toolchain"])] : null);
  if (rust) add(`Rust ${rust[1]}`);
  if (files[".ruby-version"]) add(`Ruby ${first(files[".ruby-version"])}`);
  for (const line of (files[".tool-versions"] || "").split("\n")) {
    const m = line.trim().match(/^([\w-]+)\s+(\S+)/);
    if (!m) continue;
    const name = { nodejs: "Node", node: "Node", python: "Python", golang: "Go", ruby: "Ruby", rust: "Rust", java: "Java", erlang: "Erlang", elixir: "Elixir" }[m[1]] || m[1];
    add(`${name} ${m[2]}`);
  }
  return out.slice(0, 4);
}

function packageManagerFor(has) {
  return has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
}

// Makefile targets that set things up → the first one found
function makeSetupTarget(makefile) {
  const targets = new Set([...(makefile || "").matchAll(/^([A-Za-z][\w-]*)\s*:(?!=)/gm)].map(m => m[1]));
  return ["setup", "bootstrap", "install", "dev-setup", "init", "deps", "develop"].find(t => targets.has(t)) || null;
}

// Setup commands worked out from manifests and lockfiles, each with where it came
// from → [{ cmd, from }]. Used when the docs don't say.
function inferredSetup(paths, files, ciInstall = []) {
  const has = (p) => paths.has(p);
  const out = [];
  const add = (cmd, from) => { if (!out.some(o => o.cmd === cmd)) out.push({ cmd, from }); };

  const target = makeSetupTarget(files.Makefile);
  if (target) add(`make ${target}`, "Makefile");
  if (ciInstall.length) {
    for (const c of ciInstall) add(c.cmd, c.from);
  } else if (!target) {
    if (has("package.json")) {
      const pm = packageManagerFor(has);
      const lock = { pnpm: "pnpm-lock.yaml", yarn: "yarn.lock", bun: has("bun.lock") ? "bun.lock" : "bun.lockb", npm: "package-lock.json" }[pm];
      add(pm === "npm" ? (has("package-lock.json") ? "npm ci" : "npm install") : `${pm} install`, has(lock) ? lock : "package.json");
    }
    if (has("uv.lock")) add("uv sync", "uv.lock");
    else if (has("poetry.lock")) add("poetry install", "poetry.lock");
    else if (has("pdm.lock")) add("pdm install", "pdm.lock");
    else if (has("Pipfile")) add("pipenv install --dev", "Pipfile");
    else if (has("pyproject.toml")) {
      const dev = /^\s*\[project\.optional-dependencies\][\s\S]*?^\s*(dev|test|tests)\s*=/m.test(files["pyproject.toml"] || "");
      add(dev ? `pip install -e ".[dev]"` : "pip install -e .", "pyproject.toml");
    } else if (has("requirements-dev.txt")) add("pip install -r requirements-dev.txt", "requirements-dev.txt");
    else if (has("requirements.txt")) add("pip install -r requirements.txt", "requirements.txt");
    if (has("go.mod")) add("go mod download", "go.mod");
    if (has("Cargo.toml")) add("cargo build", "Cargo.toml");
    if (has("Gemfile")) add("bundle install", "Gemfile");
    if (has("composer.json")) add("composer install", "composer.json");
    if (has("mix.exs")) add("mix deps.get", "mix.exs");
    if (has("gradlew")) add("./gradlew build", "gradlew");
    else if (has("mvnw")) add("./mvnw install -DskipTests", "mvnw");
  }
  if (has(".pre-commit-config.yaml")) add("pre-commit install", ".pre-commit-config.yaml");
  const env = [".env.example", ".env.sample", ".env.template", ".env.dist"].find(has);
  if (env) add(`cp ${env} .env`, env);
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find(has);
  if (compose) add("docker compose up -d", compose);
  try {
    const scripts = JSON.parse(files["package.json"] || "{}").scripts || {};
    const pm = packageManagerFor(has);
    const run = ["dev", "start", "serve"].find(s => scripts[s]);
    if (run) add(`${pm} run ${run}`, "package.json");
  } catch { /* not JSON */ }
  return out;
}

// Everything for step 1 → { commands: [{ cmd, from }], runtime, source, devcontainer }
// Clone and branch commands are added per issue (setupCommandsFor).
function setupSteps({ paths, files, docs, ciInstall = [] }) {
  const section = setupSectionFrom(docs);
  let commands;
  if (section) {
    const from = section.path;
    commands = section.commands
      // Cloning and branching are covered for this issue (your fork, a named branch)
      .filter(c => !/^git (clone|checkout|switch|remote add upstream|fork)\b|^gh repo (fork|clone)\b|^cd\s+\S+$/.test(c))
      .slice(0, 8)
      .map(cmd => ({ cmd, from }));
  }
  if (!commands?.length) commands = inferredSetup(paths, files, ciInstall);
  return {
    commands,
    runtime: runtimeRequirements(files),
    source: section && commands.length && commands[0].from === section.path ? { path: section.path, heading: section.heading } : null,
    devcontainer: paths.has(".devcontainer/devcontainer.json") || paths.has(".devcontainer.json"),
  };
}

// A short branch name for the issue: "fix/1234-countdown-drifts-on-windows"
function branchNameFor(issue) {
  const labels = (issue.labels || []).map(l => (typeof l === "string" ? l : l.name || "").toLowerCase()).join(" ");
  const type = /\bdoc/.test(labels) ? "docs" : /feat|enhancement|feature/.test(labels) ? "feat" : /bug|fix|regression|crash/.test(labels) ? "fix" : "issue";
  const slug = (issue.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ")
    .filter(w => w && !["a", "an", "the", "of", "to", "in", "on", "for", "and", "is", "be"].includes(w)).slice(0, 5).join("-").slice(0, 40).replace(/-+$/, "");
  return `${type}/${issue.number}${slug ? `-${slug}` : ""}`;
}

// Clone your fork, branch for this issue, then the repo's setup
function setupCommandsFor(repo, issue, setup, login) {
  const you = login || "YOUR-USERNAME";
  return [
    { cmd: `git clone https://github.com/${you}/${repo.repo}.git && cd ${repo.repo}`, from: "your fork" },
    { cmd: `git checkout -b ${branchNameFor(issue)}`, from: "a branch for this issue" },
    ...setup.commands,
  ];
}

// ── What this repo expects of a pull request ─────────────────────────────────
const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|perf|test|tests|build|ci|style|revert)(\([^)]+\))?!?:\s/i;
const BRACKET_PREFIX = /^\[[^\]]{1,30}\]\s/;
const AREA_PREFIX = /^[\w./-]{2,30}:\s/; // Go-style "net/http: fix …"

// How merged PR titles here are written → { kind, count, total, example } | null
function titleConvention(titles) {
  const t = titles.filter(Boolean);
  if (t.length < 6) return null;
  for (const [kind, re] of [["conventional", CONVENTIONAL], ["bracket", BRACKET_PREFIX], ["area", AREA_PREFIX]]) {
    const hits = t.filter(x => re.test(x) && (kind !== "area" || !CONVENTIONAL.test(x)));
    if (hits.length / t.length < 0.5) continue;
    // A person's change makes a better example than a release or dependency bot's
    const human = hits.filter(x => !/\b(bump|release|version|deps?|dependabot|renovate|merge|revert|nightly)\b/i.test(x));
    const example = human.find(x => /^(feat|fix)\b/i.test(x)) || human[0] || hits[0];
    return { kind, count: hits.length, total: t.length, example };
  }
  return null;
}

// The repo's rules for PRs, each with its evidence → { checklist: [{ text, cmd?, from }], titleStyle }
function prConventions({ paths, contributing = "", mergedTitles = [], packageManager = "npm", docName = "CONTRIBUTING" }) {
  const has = (p) => paths.has(p);
  const hasDir = (d) => [...paths].some(p => p.startsWith(`${d}/`));
  const doc = contributing;
  const checklist = [];

  const commitlint = [...paths].find(p => /^(commitlint\.config\.[cm]?[jt]s|\.commitlintrc(\.\w+)?)$/.test(p));
  const titles = titleConvention(mergedTitles);
  let titleStyle = null;
  if (commitlint || /conventional commits?/i.test(doc) || titles?.kind === "conventional") {
    titleStyle = "conventional";
    const from = commitlint || (/conventional commits?/i.test(doc) ? docName : `${titles.count} of ${titles.total} recent merged PRs`);
    checklist.push({ text: "Write the title as type(scope): summary", example: titles?.kind === "conventional" ? titles.example : "fix(parser): handle empty input", from });
  } else if (titles) {
    titleStyle = titles.kind;
    checklist.push({ text: titles.kind === "bracket" ? "Start the title with the area in brackets" : "Start the title with the package or area",
      example: titles.example, from: `${titles.count} of ${titles.total} recent merged PRs` });
  }
  if (/\bDCO\b|developer certificate of origin|signed-off-by|sign[- ]off (your|each|all|every)? ?commits?/i.test(doc) || has(".github/dco.yml")) {
    checklist.push({ text: "Sign off every commit", cmd: "git commit -s", from: has(".github/dco.yml") ? ".github/dco.yml" : docName });
  }
  if (/\bCLA\b|contributor license agreement/i.test(doc)) {
    checklist.push({ text: "Sign the Contributor License Agreement; a bot asks on your first PR", from: docName });
  }
  if (hasDir(".changeset")) {
    checklist.push({ text: "Add a changeset describing the change", cmd: `${packageManager === "npm" ? "npx" : packageManager} changeset`, from: ".changeset/" });
  } else {
    const fragments = ["changelog.d", "newsfragments", "news", "changes", ".changelog"].find(hasDir);
    if (fragments && /towncrier|news ?fragment|changelog/i.test(doc + [...paths].join(" "))) {
      checklist.push({ text: `Add a changelog fragment in ${fragments}/`, from: `${fragments}/` });
    } else if ((has("CHANGELOG.md") || has("CHANGES.md")) && /changelog|changes\.md/i.test(doc)) {
      checklist.push({ text: `Add an entry to ${has("CHANGELOG.md") ? "CHANGELOG.md" : "CHANGES.md"}`, from: docName });
    }
  }
  if (/\b(add|include|write)(ing)? (unit |new |appropriate |relevant )?tests\b|tests? (are|is) required|with tests\b|must (be )?(covered|tested)/i.test(doc)) {
    checklist.push({ text: "Include tests for the change", from: docName });
  }
  if (/\b(update|add)(ing)? (the )?(docs|documentation)\b/i.test(doc)) {
    checklist.push({ text: "Update the docs if behaviour changes", from: docName });
  }
  return { checklist, titleStyle };
}

// Where GitHub looks for a PR template → the default one (not an alternative
// in PULL_REQUEST_TEMPLATE/, unless it's the only one)
function findPrTemplate(paths) {
  const all = [...paths];
  const single = all.find(p => /^(\.github\/|docs\/)?pull_request_template\.md$/i.test(p));
  if (single) return single;
  const multi = all.filter(p => /^(\.github\/|docs\/)?pull_request_template\/[^/]+\.md$/i.test(p));
  return multi.find(p => /default|feature|bug|fix|pull_request_template/i.test(p.split("/").pop())) || multi[0] || null;
}

// The template with this issue filled in: an existing "Fixes #…" placeholder is
// completed, else "Fixes #N" goes under an issue heading, else at the top.
function fillPrTemplate(template, number) {
  const ref = `#${number}`;
  if (!template?.trim()) return null;
  // "Fixes #", "Closes #(issue)", "Resolves #<number>", "Fixes #XXXX"… outside <!-- comments -->
  const comments = [...template.matchAll(/<!--[\s\S]*?-->/g)].map(m => [m.index, m.index + m[0].length]);
  const inComment = (i) => comments.some(([a, b]) => i >= a && i < b);
  const placeholder = /\b(fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b(:?[ \t]*)#(?!\d)(?:[ \t]*(?:\([^)\n]*\)|<[^>\n]*>|\[[^\]\n]*\]|\{[^}\n]*\}|[xXnN_*]+(?!\w)|issue(?:[ _-]?(?:number|no|id))?(?!\w)))?/gi;
  const hit = [...template.matchAll(placeholder)].find(m => !inComment(m.index));
  if (hit) return template.slice(0, hit.index) + `${hit[1]}${hit[2]}${ref}` + template.slice(hit.index + hit[0].length);
  const lines = template.split("\n");
  const h = lines.findIndex(l => /^#{1,4}\s.*\b(issues?|related|ticket|closes|fixes|links?)\b/i.test(l));
  if (h >= 0) {
    lines.splice(h + 1, 0, "", `Fixes ${ref}`);
    return lines.join("\n");
  }
  return `Fixes ${ref}\n\n${template}`;
}

// A title in the repo's style: "fix: countdown drifts on Windows"
function prTitleFor(issue, titleStyle) {
  const title = (issue.title || "").trim();
  if (titleStyle !== "conventional" || CONVENTIONAL.test(title)) return title;
  const type = branchNameFor(issue).split("/")[0];
  return `${type === "issue" ? "fix" : type}: ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
}

// Title, description and (signed in) a link to GitHub's PR form, filled in
function prDraftFor(repo, issue, flow, login, verify = []) {
  const title = prTitleFor(issue, flow.pr.titleStyle);
  const tests = verify.slice(0, 3).map(c => `- [ ] \`${c.cmd}\``).join("\n");
  const body = fillPrTemplate(flow.pr.template, issue.number) ||
    `Fixes #${issue.number}\n\n## What changed\n\n<!-- A sentence or two on the change and why -->\n\n## How I tested it\n\n${tests || "<!-- The commands you ran and what you checked -->"}\n`;
  let compareUrl = null;
  if (login) {
    const base = `https://github.com/${repo.owner}/${repo.repo}/compare/${encodePath(flow.defaultBranch || "main")}...${encodeURIComponent(login)}:${encodePath(branchNameFor(issue))}?expand=1&title=${encodeURIComponent(title)}`;
    const withBody = `${base}&body=${encodeURIComponent(body)}`;
    compareUrl = withBody.length <= 7000 ? withBody : base; // GitHub drops overlong URLs
  }
  return { title, body, compareUrl, fromTemplate: !!flow.pr.template };
}

// ── Loading ──────────────────────────────────────────────────────────────────
const FLOW_FILES = [".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions", "rust-toolchain", "rust-toolchain.toml",
  "package.json", "pyproject.toml", "go.mod", "Makefile"];
const DEV_DOC = /^(docs\/)?(development|developing|hacking|setup|install(ation)?|getting[-_]started|local[-_]development|building)\.(md|markdown)$/i;

// Repo-level facts for the flow, once per repo: raw files (no API quota), the
// tree (shared) and the recent closed PRs (shared with the health score).
function loadRepoFlow(repo) {
  const cache = cacheFor(repoKey(repo));
  cache.flow ??= buildRepoFlow(repo).catch(err => { delete cache.flow; throw err; });
  return cache.flow;
}

async function buildRepoFlow(repo) {
  const [tree, meta] = await Promise.all([getRepoTree(repo), loadRepoData(repo)]);
  const blobs = tree.entries.filter(e => e.type === "blob").map(e => e.path);
  const paths = new Set(blobs);
  const read = (p) => readRepoFile(p, repo).catch(() => null);

  const contributingPath = blobs.find(p => /^(\.github\/|docs\/)?contributing(\.(md|markdown))?$/i.test(p));
  const docPaths = [contributingPath, ...blobs.filter(p => DEV_DOC.test(p)).slice(0, 3), blobs.find(p => /^readme(\.(md|markdown))?$/i.test(p))].filter(Boolean);
  const workflow = pickWorkflow(tree.entries);
  const templatePath = findPrTemplate(paths);

  const [docTexts, fileTexts, workflowText, template, closed] = await Promise.all([
    Promise.all(docPaths.map(read)),
    Promise.all(FLOW_FILES.map(p => (paths.has(p) ? read(p) : null))),
    workflow ? read(workflow.path) : null,
    templatePath ? read(templatePath) : null,
    fetchGitHub("/pulls?state=closed&sort=updated&direction=desc&per_page=50", repo).catch(err => {
      if (err.rateLimited) throw err;
      return [];
    }),
  ]);
  const files = Object.fromEntries(FLOW_FILES.map((p, i) => [p, fileTexts[i]]).filter(([, t]) => t));
  const docs = docPaths.map((path, i) => ({ path, sections: splitMarkdownSections(docTexts[i] || "") })).filter((d, i) => docTexts[i]);
  const packageManager = packageManagerFor(p => paths.has(p));

  const ciInstall = ciRunCommands(workflowText).filter(c => INSTALL_CMD.test(c) && !/\$\{\{/.test(c))
    .slice(0, 2).map(cmd => ({ cmd, from: workflow.path }));
  const verify = verifyCommands({ workflowText, workflowPath: workflow?.path, packageJson: files["package.json"], packageManager });
  const mergedTitles = (Array.isArray(closed) ? closed : []).filter(p => p.merged_at).map(p => p.title);

  return {
    defaultBranch: meta.default_branch || "main",
    setup: setupSteps({ paths, files, docs, ciInstall }),
    verify,
    pr: {
      template, templatePath,
      contributingPath,
      contributingPrSection: contributingPath
        ? (docs.find(d => d.path === contributingPath)?.sections || []).find(s => s.level && /pull request|\bPRs?\b|submit|patch/i.test(s.heading))?.heading || null
        : null,
      ...prConventions({ paths, contributing: docTexts[0] && contributingPath ? docTexts[0] : "", mergedTitles, packageManager,
        docName: contributingPath ? contributingPath.split("/").pop() : "CONTRIBUTING" }),
    },
  };
}
