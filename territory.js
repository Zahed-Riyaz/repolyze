// territory.js: the repo map (FR-11a). Entry points, the import crawl and its stored graph (with each file's own
// description), core files and the reading path, the flow map's boxes and layout (drawn by map.js in its own tab),
// Explain this map's context, the Repo tab card and the issue brief's line. Loaded by the side panel and map.html;
// shares one global scope with them (ENTRY_FILE, CONTAINER_DIRS come from ask-focus.js).

const MAP_ENTRY_LIMIT = 6;
const MAP_ROOT_MANIFESTS = ["package.json", "pyproject.toml", "setup.cfg", "manifest.json"];

// Which manifest paths to read: the root ones, plus package.json one level into packages/, apps/ …
function MAP_MANIFESTS(paths) {
  const set = new Set(paths);
  const root = MAP_ROOT_MANIFESTS.filter(m => set.has(m));
  const workspaces = paths.filter(p => {
    const parts = p.split("/");
    return parts.length === 3 && parts[2] === "package.json" && CONTAINER_DIRS.has(parts[0]);
  });
  return [...root, ...workspaces];
}

function mapJson(text) {
  try { const v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

// "./src/app.ts" inside "apps/web" → "apps/web/src/app.ts"
function mapResolve(dir, rel) {
  if (typeof rel !== "string" || !rel) return "";
  const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
  const out = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

// "pkg.cli:main" → the file in the tree that is pkg/cli.py (or pkg/cli/__init__.py), under any source root
function mapPyModule(spec, paths) {
  const mod = spec.split(":")[0].trim().replace(/\./g, "/");
  if (!mod) return "";
  const wanted = [`${mod}.py`, `${mod}/__init__.py`];
  return paths.find(p => wanted.some(w => p === w || p.endsWith("/" + w))) || "";
}

// Top-level Python packages (a folder with __init__.py whose parent isn't one), wherever they sit —
// libs/core/core_pkg as much as src/pkg — biggest first: [{ name, dir, files }]
function mapPyPackages(paths) {
  const inits = new Set();
  for (const p of paths) if (p.endsWith("/__init__.py")) inits.add(p.slice(0, -"/__init__.py".length));
  const pkgs = new Map();
  for (const dir of inits) {
    if (inits.has(mapDirOf(dir)) || NOISE_PATH.test(dir + "/") || TEST_PATH.test(dir + "/")) continue;
    pkgs.set(dir, { name: dir.split("/").pop(), dir, files: 0 });
  }
  for (const p of paths) {
    if (!p.endsWith(".py")) continue;
    for (let d = mapDirOf(p); d; d = mapDirOf(d)) { const pkg = pkgs.get(d); if (pkg) { pkg.files++; break; } }
  }
  return [...pkgs.values()].sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir));
}

// package.json `exports` → the path behind ".", whichever condition names it ("" when none)
function mapExportsRoot(exp) {
  let root = typeof exp === "string" ? exp : exp && typeof exp === "object" ? (exp["."] ?? exp) : "";
  if (root && typeof root === "object") root = root.import || root.default || root.require || "";
  if (root && typeof root === "object") root = root.default || root.import || root.require || "";
  return typeof root === "string" ? root : "";
}

function mapManifestEntries(file, text, dir, paths) {
  const found = [];
  const add = (rel, reason) => found.push({ rel, reason: `${file} ${reason}` });
  const name = file.split("/").pop();
  const out = [];
  if (name === "package.json") {
    const pkg = mapJson(text);
    if (typeof pkg.main === "string") add(pkg.main, "main");
    if (typeof pkg.module === "string") add(pkg.module, "module");
    add(mapExportsRoot(pkg.exports), 'exports["."]');
    if (typeof pkg.bin === "string") add(pkg.bin, "bin");
    else if (pkg.bin && typeof pkg.bin === "object") for (const b of Object.values(pkg.bin)) add(b, "bin");
    for (const [script, label] of [["start", "start script"], ["dev", "dev script"]]) {
      const cmd = pkg.scripts?.[script];
      if (typeof cmd === "string") for (const word of cmd.split(/\s+/)) add(word, label);
    }
    // main/module/exports without an extension, or naming a build output not in the tree (dist/index.js):
    // the package's source entry, the same file `import "pkg"` lands on in the crawl
    const source = mapPackageEntry(dir, pkg, paths);
    if (source) out.push({ path: source, reason: `${file} package entry` });
  } else if (name === "manifest.json") {
    const m = mapJson(text);
    add(m.background?.service_worker, "background worker");
    for (const s of m.background?.scripts || []) add(s, "background script");
    add(m.side_panel?.default_path, "side panel");
    add(m.action?.default_popup, "popup");
    add(m.options_page, "options page");
    add(m.options_ui?.page, "options page");
    for (const cs of m.content_scripts || []) for (const s of cs.js || []) add(s, "content script");
  }
  const direct = [];
  for (const { rel, reason } of found) {
    const path = mapResolve(dir, rel);
    if (path && paths.has(path)) direct.push({ path, reason });
  }
  return [...direct, ...out];
}

function mapPythonEntries(file, text, paths) {
  const out = [];
  // pyproject: [project.scripts] / [tool.poetry.scripts]; setup.cfg: console_scripts lines
  const section = file === "pyproject.toml" ? /^\s*\[(project|tool\.poetry)\.scripts\]\s*$/ : /^\s*console_scripts\s*=/;
  let inSection = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line) && file === "pyproject.toml") inSection = section.test(line);
    else if (file === "setup.cfg" && section.test(line)) inSection = true;
    else if (file === "setup.cfg" && /^\S/.test(line)) inSection = false;
    else if (inSection) {
      const m = line.match(/^\s*[\w.-]+\s*=\s*["']?([\w.]+:[\w.]+)/);
      const path = m && mapPyModule(m[1], [...paths]);
      if (path) out.push({ path, reason: `${file} script` });
    }
  }
  return out;
}

// The files a person should open first, strongest first, ≤ 6.
// `files` holds manifest texts already read, keyed by path.
function findEntryPoints(paths, files = {}) {
  const tree = new Set(paths);
  const out = [];
  const seen = new Set();
  const push = (e) => { if (!seen.has(e.path) && out.length < MAP_ENTRY_LIMIT) { seen.add(e.path); out.push(e); } };

  for (const file of Object.keys(files)) {
    const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const text = String(files[file] ?? "");
    const base = file.split("/").pop();
    const entries = base === "pyproject.toml" || base === "setup.cfg" ? mapPythonEntries(base, text, tree) : mapManifestEntries(file, text, dir, tree);
    entries.forEach(push);
  }

  const byDepth = (a, b) => a.split("/").length - b.split("/").length;
  const real = (p) => !NOISE_PATH.test(p) && !TEST_PATH.test(p); // a tests/__main__.py runs the tests, not the app
  for (const name of ["__main__.py", "manage.py"]) {
    paths.filter(p => p.split("/").pop() === name && real(p)).sort(byDepth).forEach(path => push({ path, reason: name }));
  }
  // app.py / main.py at the root or directly in src/
  for (const name of ["app.py", "main.py"]) {
    for (const path of [name, `src/${name}`]) if (tree.has(path)) push({ path, reason: name });
  }

  if (!out.length) {
    // A Python library with no scripts starts at its packages' __init__.py
    for (const p of mapPyPackages(paths)) if (p.files >= 2) push({ path: `${p.dir}/__init__.py`, reason: `Python package ${p.name} · ${p.files} files` });
  }
  if (!out.length) {
    // Same pick as repoStarters: the shallowest main/index/cli file
    const code = paths.filter(p => isCodeCandidate({ path: p, type: "blob", size: 0 }) && !TEST_PATH.test(p) && !NOISE_PATH.test(p) && !/\.(md|mdx|ya?ml|toml)$/i.test(p));
    const entry = code.filter(p => ENTRY_FILE.test(p.split("/").pop()))
      .sort((a, b) => byDepth(a, b) || (/cli|main/.test(b) - /cli|main/.test(a)))[0];
    if (entry) push({ path: entry, reason: "shallowest main/index file" });
  }
  return out;
}

// Raw specs a file loads without importing: <script src> (any type, incl. module) and importScripts(...)
function parseLoads(text, path) {
  const out = [];
  if (/\.html?$/i.test(path)) {
    for (const m of text.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) out.push(m[1]);
  }
  for (const m of text.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) out.push(s[1]);
  }
  return out.filter(s => !/^(?:https?:)?\/\//i.test(s));
}

// JSON with // and /* */ comments and trailing commas (tsconfig style); {} when it can't be read
function mapLooseJson(text) {
  const strip = (re, t) => t.replace(re, m => m[0] === '"' ? m : "");
  let clean = strip(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, String(text ?? ""));
  clean = strip(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, clean);
  return mapJson(clean);
}

function mapDirOf(path) { return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""; }

// "libs/ui" + package.json → the file `import "ui"` lands on: main, exports["."], else src/index.*
function mapPackageEntry(dir, pkg, known) {
  for (const rel of [mapExportsRoot(pkg.exports), pkg.module, pkg.main]) {
    if (typeof rel !== "string" || !rel) continue;
    const hit = firstExistingModule([mapResolve(dir, rel)], known);
    if (hit) return hit;
  }
  return firstExistingModule([mapResolve(dir, "src/index")], known) || firstExistingModule([mapResolve(dir, "index")], known) || "";
}

// A resolver for one repo: (fromPath, text) → { edges, order }.
// `files` holds manifest texts already read (package.json, pnpm-workspace.yaml, tsconfig.json), keyed by path.
function mapResolver({ known, files = {} }) {
  const packages = []; // { name, dir, entry }
  for (const file of Object.keys(files)) {
    if (file.split("/").pop() !== "package.json") continue;
    const pkg = mapJson(files[file]);
    if (typeof pkg.name !== "string" || !pkg.name) continue;
    const dir = mapDirOf(file);
    packages.push({ name: pkg.name, dir, entry: mapPackageEntry(dir, pkg, known) });
  }
  const tsconfigs = {};
  const tsconfigFor = (fromPath) => {
    let dir = mapDirOf(fromPath);
    for (;;) {
      const file = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
      if (file in files) {
        if (!(file in tsconfigs)) {
          const opts = mapLooseJson(files[file]).compilerOptions;
          tsconfigs[file] = opts && typeof opts === "object" ? { dir, baseUrl: mapResolve(dir, opts.baseUrl || "."), paths: opts.paths && typeof opts.paths === "object" ? opts.paths : {} } : null;
        }
        return tsconfigs[file];
      }
      if (!dir) return null;
      dir = mapDirOf(dir);
    }
  };

  const viaPackage = (spec) => {
    for (const p of packages) {
      if (spec === p.name) return p.entry ? [p.entry] : [];
      if (spec.startsWith(p.name + "/")) {
        const rest = spec.slice(p.name.length + 1);
        const hit = firstExistingModule([mapResolve(p.dir, rest), mapResolve(p.dir, `src/${rest}`)], known);
        return hit ? [hit] : [];
      }
    }
    return [];
  };
  const viaPaths = (spec, fromPath) => {
    const ts = tsconfigFor(fromPath);
    if (!ts) return [];
    for (const [pattern, targets] of Object.entries(ts.paths)) {
      const star = pattern.indexOf("*");
      let captured = null;
      if (star < 0) { if (spec === pattern) captured = ""; }
      else {
        const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
        if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) captured = spec.slice(pre.length, spec.length - post.length);
      }
      if (captured === null) continue;
      for (const t of Array.isArray(targets) ? targets : []) {
        if (typeof t !== "string") continue;
        const hit = firstExistingModule([mapResolve(ts.baseUrl, t.replace("*", captured))], known);
        if (hit) return [hit];
      }
    }
    return [];
  };

  // `import pkg.mod` → the package named pkg nearest the importer, wherever it sits
  let pyPkgs = null;
  const viaPyPackage = (imp, fromPath) => {
    pyPkgs ||= mapPyPackages([...known]);
    const parts = imp.spec.split(".");
    const near = (p) => { let n = 0; while (n < p.dir.length && p.dir[n] === fromPath[n]) n++; return n; };
    const pkg = pyPkgs.filter(p => p.name === parts[0]).sort((a, b) => near(b) - near(a))[0];
    if (!pkg) return [];
    const base = [pkg.dir, ...parts.slice(1)].join("/");
    const hit = [`${base}.py`, `${base}/__init__.py`].find(p => known.has(p));
    const found = hit ? [hit] : [];
    for (const n of imp.names) if (known.has(`${base}/${n}.py`)) found.push(`${base}/${n}.py`);
    return found;
  };

  // `named`: [file, names] per import, so a pass-through package can later be followed name by name
  return (fromPath, text) => {
    const edges = new Set();
    const order = [];
    const named = [];
    const dir = mapDirOf(fromPath);
    for (const imp of parseImports(text, fromPath)) {
      let hits = resolveImport(imp, fromPath, known);
      if (!hits.length && imp.py && !imp.spec.startsWith(".")) hits = viaPyPackage(imp, fromPath);
      if (!hits.length && !imp.py && !imp.spec.startsWith(".")) hits = viaPackage(imp.spec);
      if (!hits.length && !imp.py && !imp.spec.startsWith(".")) hits = viaPaths(imp.spec, fromPath);
      hits.forEach(h => { if (h !== fromPath) { edges.add(h); if (imp.names.length) named.push([h, imp.names]); } });
    }
    // A lazy-import table in an __init__.py (`_dynamic_imports = {"Runnable": "base"}` behind __getattr__): real links
    if (/(^|\/)__init__\.py$/.test(fromPath) && /def\s+__getattr__/.test(text)) {
      for (const m of text.matchAll(/["'](\w+)["']\s*:\s*["'](\.?[\w.]+)["']/g)) {
        const mod = m[2].replace(/^\./, "").replace(/\./g, "/");
        const hit = [`${dir ? dir + "/" : ""}${mod}.py`, `${dir ? dir + "/" : ""}${mod}/__init__.py`].find(p => known.has(p));
        if (hit && hit !== fromPath) { edges.add(hit); named.push([hit, [m[1]]]); }
      }
    }
    const isHtml = /\.html?$/i.test(fromPath);
    for (const spec of parseLoads(text, fromPath)) {
      const clean = spec.split(/[?#]/)[0];
      const path = clean.startsWith("/") ? mapResolve("", clean) : mapResolve(dir, clean);
      if (path && known.has(path) && path !== fromPath) {
        edges.add(path);
        if (isHtml && !order.includes(path)) order.push(path);
      }
    }
    return { edges: [...edges], order, named };
  };
}

// ── The crawl ────────────────────────────────────────────────────────────────
// Bump when the crawl changes what it finds: stored maps built by an older crawl are read again
// (1 = descriptions; 2 = Python packages anywhere in the tree; 3 = main code folders when imports reach little;
// 4 = Python pass-through files, what files define, code files per part)
const MAP_CRAWL_VERSION = 4;
const MAP_CAP_PUBLIC = 300;
const MAP_CAP_PRIVATE = 60;
const MAP_READS_IN_FLIGHT = 8;
const MAP_MANIFEST_CAP = 20;
const MAP_UNTRACED_SHARE = 0.05;
// What the crawl follows (languageOfPath names): .vue/.svelte are crawled for their imports; .astro has no language name
const MAP_TRACED = new Set(["JavaScript", "TypeScript", "Python", "HTML", "CSS", "SCSS", "Vue", "Svelte"]);
const MAP_CRAWLABLE = /\.(m?[jt]sx?|cjs|py|vue|svelte|astro|html?)$/i;

// Globs from a root package.json `workspaces` (array or { packages }) and pnpm-workspace.yaml `packages:`
function mapWorkspaceGlobs(files) {
  const globs = [];
  const ws = mapJson(files["package.json"] ?? "").workspaces;
  for (const g of Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : []) if (typeof g === "string") globs.push(g);
  let inPackages = false;
  for (const line of String(files["pnpm-workspace.yaml"] ?? "").split("\n")) {
    if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
    if (/^\S/.test(line)) inPackages = false;
    const m = inPackages && line.match(/^\s*-\s*["']?([^"'#\s]+)["']?/);
    if (m) globs.push(m[1]);
  }
  return globs;
}

// Does a package.json at `file` belong to one of the globs? Handles "dir/*", "dir/**" and exact dirs.
function mapInWorkspace(file, globs) {
  const dir = mapDirOf(file);
  const included = (g) => {
    const pat = g.replace(/^\.\//, "").replace(/\/$/, "");
    if (pat.endsWith("/**")) return dir.startsWith(pat.slice(0, -2));
    if (pat.endsWith("/*")) { const base = pat.slice(0, -2); return dir.startsWith(base + "/") && !dir.slice(base.length + 1).includes("/"); }
    return dir === pat;
  };
  let hit = false;
  for (const g of globs) {
    if (g.startsWith("!")) { if (included(g.slice(1))) return false; }
    else if (included(g)) hit = true;
  }
  return hit;
}

// The manifest/config files to read, root first, ≤ 20: manifests, workspace package.json files, tsconfigs
async function mapReadManifests(repo, paths) {
  const set = new Set(paths);
  const files = {};
  const read = async (list) => {
    for (const p of list) {
      if (Object.keys(files).length >= MAP_MANIFEST_CAP || p in files) continue;
      const text = await readRepoFile(p, repo).catch(() => null);
      if (text != null) files[p] = text;
    }
  };
  await read([...MAP_ROOT_MANIFESTS, "pnpm-workspace.yaml", "tsconfig.json"].filter(p => set.has(p)));
  const globs = mapWorkspaceGlobs(files);
  const workspaces = globs.length
    ? paths.filter(p => p.split("/").pop() === "package.json" && p.includes("/") && !NOISE_PATH.test(p) && mapInWorkspace(p, globs)).sort((a, b) => a.split("/").length - b.split("/").length)
    : MAP_MANIFESTS(paths).filter(p => p.includes("/"));
  await read(workspaces);
  const configs = paths.filter(p => p.split("/").pop() === "tsconfig.json" && p.split("/").length <= 4 && !NOISE_PATH.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length);
  await read(configs);
  return files;
}

// A file that only passes imports along: JS/TS whose every line re-exports, or a Python __init__.py whose
// top-level statements are only imports, __all__, a docstring, TYPE_CHECKING blocks and lazy-import plumbing.
function mapIsBarrel(text, path = "") {
  if (/\.py$/.test(path)) {
    if (!/(^|\/)__init__\.py$/.test(path)) return false;
    const body = String(text).replace(/^\s*[rRuU]?("""|\'\'\')[\s\S]*?\1/, "").replace(/#.*$/gm, "");
    const defs = [...body.matchAll(/^(?:async\s+)?(?:class|def)\s+(\w+)/gm)].map(m => m[1]);
    if (defs.some(d => d !== "__getattr__" && d !== "__dir__")) return false;
    return body.split("\n").filter(l => /^\S/.test(l)).every(l =>
      /^(from\s|import\s|__all__|if\s+(typing\.)?TYPE_CHECKING|_\w+\s*[:=]|(async\s+)?def\s+__(getattr|dir)__|[)\]}]|try:|except\b|else:|logger\s*=|__version__)/.test(l));
  }
  const lines = String(text).split("\n").filter(l => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l));
  return lines.length > 0 && lines.every(l => /^export .* from /.test(l) || /^export\s*\*/.test(l));
}

// Files to look up rather than read first: named as plumbing by convention (and Django's settings/admin/apps)
const MAP_HELPER = /(^|\/)_?_?(\w*(?:utils?|helpers?)|constants?|consts|types|typing|_types|compat|exceptions|errors|logger|logging|globals|version|status_codes|structures|deprecation|import_utils|internal_utils|settings|config|conf|admin|apps)_?_?(\/__init__)?\.[^/]+$/i;
const mapIsHelper = (path) => MAP_HELPER.test(path) || /(^|\/)settings\//.test(path);

// A file's own top-level names: Python classes and public functions, JS/TS exports. In order of appearance.
function mapDefines(text, path) {
  const out = [];
  const t = String(text ?? "");
  if (/\.py$/.test(path)) {
    for (const m of t.matchAll(/^(?:class\s+([A-Za-z]\w*)|(?:async\s+)?def\s+([a-zA-Z]\w*))/gm)) out.push(m[1] || m[2]);
  } else {
    for (const m of t.matchAll(/^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function\*?|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) out.push(m[1] || m[2]);
  }
  return [...new Set(out)];
}

// A file's part of the repo: its top folder, or two levels under src/, apps/, libs/, packages/…
function mapAreaOf(path) {
  const s = path.split("/");
  return s.length > 2 && CONTAINER_DIRS.has(s[0]) ? s[1] : s.length > 1 ? s[0] : "(root)";
}

// When the imports from the start reach little of the code (Django's manage.py names its settings in a
// string; frameworks load files by folder or by name), the crawl also reads the main code folders' files.
// "Little": fewer than 25 files and under half of the candidates. Up to 150 reads in all, within the cap.
const MAP_TOPUP_BELOW = 25;
const MAP_TOPUP_TO = 150;
const MAP_TOPUP_CODE = /\.(m?[jt]sx?|cjs|py|vue|svelte)$/i;
const MAP_TOPUP_SKIP = /(^|\/)(migrations|docs?|scripts?|static|assets|public|examples?|samples?|playgrounds?|demos?|sandbox|templates?|template-[^/]+|\.[^/]+)(\/|$)|(^|\/)(setup|conftest|noxfile|[\w.-]+\.config)\.[^/]+$/i;

// The files to add, in reading order: round-robin over code areas (a top folder, or two levels under
// src/, apps/, packages/…), biggest area first; in each, shallower then bigger files first.
function mapTopUpFiles(known, sizes, seen) {
  const areas = new Map();
  for (const p of known) {
    if (seen.has(p) || !MAP_TOPUP_CODE.test(p) || TEST_PATH.test(p) || MAP_TOPUP_SKIP.test(p)) continue;
    const parts = p.split("/");
    const key = parts.length > 2 && CONTAINER_DIRS.has(parts[0]) ? parts.slice(0, 2).join("/") : parts.length > 1 ? parts[0] : "";
    const a = areas.get(key) || areas.set(key, { bytes: 0, files: [] }).get(key);
    a.bytes += sizes.get(p) || 0;
    a.files.push(p);
  }
  const lists = [...areas.values()].sort((a, b) => b.bytes - a.bytes).map(a => a.files.sort((x, y) =>
    x.split("/").length - y.split("/").length || (sizes.get(y) || 0) - (sizes.get(x) || 0) || x.localeCompare(y)));
  const out = [];
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// Languages with ≥ 5% of the repo's code bytes that the crawl can't follow
function mapUntraced(entries) {
  const bytes = {};
  let total = 0;
  for (const e of entries) {
    if (e.type !== "blob" || NOISE_PATH.test(e.path) || NOT_CODE.test(e.path)) continue;
    const lang = languageOfPath(e.path);
    if (!lang) continue;
    bytes[lang] = (bytes[lang] || 0) + e.size;
    total += e.size;
  }
  return Object.keys(bytes).filter(l => !MAP_TRACED.has(l) && total && bytes[l] / total >= MAP_UNTRACED_SHARE).sort((a, b) => bytes[b] - bytes[a]);
}

// Crawl the import graph breadth-first from the entry points. Plain objects, so it survives chrome.storage.
// What a file says about itself: its header comment or docstring, first sentence, ≤ 120 chars.
// No AI — the text is already in hand during the crawl. null when the file doesn't say.
const MAP_DESC_SKIP = /(^module dependencies|copyright|license|licence|spdx|@ts-|eslint|prettier|jshint|generated|do not edit|auto-?generated|@flow|^#!)/i;
function fileSummary(text, path = "") {
  if (!text) return null;
  const pick = (raw) => {
    // A comment's first line is usually its title ("Background service worker"): use it when it says enough
    const line = raw.split("\n").map(l => l.replace(/[─━═=~]{2,}|-{3,}/g, " ").trim()).find(l => /\w{3,}/.test(l));
    if (line && raw.includes("\n") && line.split(/\s+/).length >= 3) raw = line;
    const t = raw.replace(/[─━═=~]{2,}|-{3,}/g, " ").replace(/\s+/g, " ").replace(/^[-*#\s]+/, "").trim();
    const base = path.split("/").pop();
    if (base && t.startsWith(base)) return pick(t.slice(base.length).replace(/^\s*[:—–-]\s*/, ""));
    if (!t || MAP_DESC_SKIP.test(t) || t.length < 8) return null;
    if (/^[\w./@-]+\.\w+$/.test(t) || t.includes(path.split("/").pop()) && t.split(" ").length < 3) return null;
    const first = (t.match(/^.+?[.!?](\s|$)/) || [t])[0].trim();
    return first.length > 120 ? first.slice(0, 117).trimEnd() + "…" : first;
  };
  if (/\.html?$/i.test(path)) return pick((text.match(/<title>([^<]*)<\/title>/i) || [])[1] || "");
  let rest = text.replace(/^﻿/, "").replace(/^#!.*\n/, "");
  if (/\.py$/.test(path)) {
    rest = rest.replace(/^(\s*#.*\n)*/, (m) => (m.split("\n").some(l => /#\s*\w{3,}/.test(l) && !MAP_DESC_SKIP.test(l)) ? m : ""));
    const doc = rest.match(/^\s*[rRuU]?("""|\'\'\')([\s\S]*?)\1/);
    if (doc) return pick(doc[2].split(/\n\s*\n/)[0]);
  }
  // Leading comment blocks: /** … */, /* … */, consecutive // or # lines; skip license-style blocks
  for (let i = 0; i < 4; i++) {
    rest = rest.replace(/^\s*(["']use strict["'];?|["']use client["'];?)\s*/, "");
    let m = rest.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
    let body = m && m[1].split("\n").map(l => l.replace(/^\s*\*\s?/, "")).filter(l => !/^\s*@/.test(l)).join("\n");
    if (!m) { m = rest.match(/^\s*((?:\/\/.*\n?|#(?!!).*\n?)+)/); body = m && m[1].split("\n").map(l => l.replace(/^\s*(\/\/+|#)\s?/, "")).join("\n"); }
    if (!m) return null;
    const got = pick(body);
    if (got) return got;
    rest = rest.slice(m[0].length);
  }
  return null;
}

async function buildImportGraph(repo = currentRepo, { cap = MAP_CAP_PUBLIC, isStale = () => false } = {}) {
  const tree = await getRepoTree(repo);
  const sizes = new Map(tree.entries.filter(e => e.type === "blob").map(e => [e.path, e.size]));
  const paths = [...sizes.keys()];
  const known = new Set(paths.filter(p => MAP_CRAWLABLE.test(p) && !NOISE_PATH.test(p) && !NOT_CODE.test(p) && sizes.get(p) < MAX_FILE_BYTES));

  const manifests = await mapReadManifests(repo, paths);
  const entries = findEntryPoints(paths, manifests);
  const resolve = mapResolver({ known, files: manifests });

  const nodes = {}, order = {}, edgeSet = new Map(), depth = new Map(), failed = new Set();
  const queue = [];
  const seen = new Set();
  const enqueue = (path, d) => { if (!seen.has(path)) { seen.add(path); depth.set(path, d); queue.push(path); } };
  entries.forEach(e => enqueue(e.path, 0));

  const nameUses = new Map(); // how many files import each name, to rank what a file defines
  const via = {}; // { from: { package file: [names] } }
  let read = 0, topup = 0, extra = null;
  for (;;) {
    if (!queue.length && !isStale() && read < Math.min(cap, MAP_TOPUP_TO)) {
      if (!extra) {
        const candidates = [...known].filter(p => MAP_TOPUP_CODE.test(p) && !TEST_PATH.test(p) && !MAP_TOPUP_SKIP.test(p)).length;
        extra = read < MAP_TOPUP_BELOW && read * 2 < candidates ? mapTopUpFiles(known, sizes, seen) : [];
      }
      // Added files sit one row below the start; what they import is followed as usual
      while (extra.length && queue.length < MAP_READS_IN_FLIGHT) {
        const p = extra.shift();
        if (!seen.has(p)) { enqueue(p, 1); topup++; }
      }
    }
    if (!queue.length || read >= cap || isStale()) break;
    const wave = queue.splice(0, Math.min(MAP_READS_IN_FLIGHT, cap - read));
    const texts = await Promise.all(wave.map(p => readRepoFile(p, repo).catch(() => null)));
    wave.forEach((path, i) => {
      const text = texts[i];
      if (text == null) { failed.add(path); return; }
      read++;
      nodes[path] = { inDegree: 0, depth: depth.get(path), size: sizes.get(path) || 0, read: true };
      if (mapIsBarrel(text, path)) nodes[path].barrel = true;
      const defs = mapDefines(text, path);
      if (defs.length) nodes[path].defs = defs;
      for (const imp of parseImports(text, path)) for (const n of imp.names) nameUses.set(n, (nameUses.get(n) || 0) + 1);
      const desc = fileSummary(text, path);
      if (desc) nodes[path].desc = desc;
      const { edges, order: loads, named } = resolve(path, text);
      // Which names go through which package file, and which file a package file gets each name from
      for (const [to, names] of named) if (MAP_PKG_FILE.test(to)) {
        const v = ((via[path] ||= {})[to] ||= []);
        for (const n of names) if (!v.includes(n)) v.push(n);
      }
      if (nodes[path].barrel) {
        const ex = {};
        for (const [to, names] of named) for (const n of names) ex[n] ??= to;
        nodes[path].exports = ex;
      }
      if (loads.length) order[path] = loads;
      edgeSet.set(path, edges);
      edges.forEach(to => enqueue(to, depth.get(path) + 1));
    });
  }

  // Every read failed (an outage, not a repo): that is an error to show, never a map to draw or keep
  if (!read && failed.size) throw new Error("Couldn't read the repo's files");
  const edges = [];
  // Files the cap kept us from reading still count as nodes (read: false); ones that failed to read don't
  for (const [from, tos] of edgeSet) for (const to of tos) {
    if (failed.has(to)) continue;
    nodes[to] ??= { inDegree: 0, depth: depth.get(to), size: sizes.get(to) || 0, read: false };
    edges.push([from, to]);
    nodes[to].inDegree++;
  }
  // What each file defines, most imported first, ≤ 4
  for (const n of Object.values(nodes)) {
    if (n.defs) n.defs = n.defs.map((d, i) => [d, nameUses.get(d) || 0, i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).slice(0, 4).map(x => x[0]);
  }
  // Code files per part, from the whole tree (tests, scripts, docs, static and vendored files don't count)
  const parts = {};
  for (const p of paths) {
    if (!MAP_TOPUP_CODE.test(p) || NOISE_PATH.test(p) || TEST_PATH.test(p) || MAP_TOPUP_SKIP.test(p) || NOT_CODE.test(p)) continue;
    const a = mapAreaOf(p);
    if (a !== "(root)") parts[a] = (parts[a] || 0) + 1;
  }
  // Keep the names only where they go through a pass-through file
  for (const from of Object.keys(via)) {
    for (const to of Object.keys(via[from])) if (!nodes[to]?.barrel) delete via[from][to];
    if (!Object.keys(via[from]).length) delete via[from];
  }
  return {
    sha: tree.sha, entries, nodes, edges, order, read, parts, via, v: MAP_CRAWL_VERSION,
    topup, truncated: queue.length > 0 || (read >= cap && !!extra?.length), treeTruncated: !!tree.truncated,
    untraced: mapUntraced(tree.entries),
  };
}

// Stored maps are 100–250 KB for a large crawl and there is no unlimitedStorage: keep the newest 20.
const MAP_STORE_LIMIT = 20;
const mapStoreKey = (owner, repo) => `map_${owner}_${repo}`;

// Save one repo's graph (stamped with `time`), then drop the oldest maps past the limit
async function mapStore(storeKey, graph) {
  graph.time = Date.now();
  await chrome.storage.local.set({ [storeKey]: graph });
  const all = await chrome.storage.local.get(null);
  const maps = Object.keys(all).filter(k => k.startsWith("map_") && all[k] && typeof all[k] === "object")
    .sort((a, b) => (all[b].time || 0) - (all[a].time || 0) || (a === storeKey ? -1 : b === storeKey ? 1 : 0));
  const drop = maps.slice(MAP_STORE_LIMIT);
  if (drop.length) await chrome.storage.local.remove(drop);
}

// The stored map when its tree SHA still matches, else a fresh crawl (saved). Private repos wait for a click.
async function loadRepoMap(repo = currentRepo, { allowPrivate = false, isStale } = {}) {
  const key = repoKey(repo);
  const cache = cacheFor(key);
  const tree = await getRepoTree(repo);
  const fresh = (g) => g && tree.sha && g.sha === tree.sha && g.v === MAP_CRAWL_VERSION; // maps from an older crawl are read again
  if (fresh(cache.map)) return cache.map;
  const storeKey = mapStoreKey(repo.owner, repo.repo);
  const stored = (await chrome.storage.local.get(storeKey).catch(() => ({})))[storeKey];
  if (fresh(stored)) return (cache.map = stored);
  const meta = await loadRepoData(repo);
  if (meta.private && !allowPrivate) return { needsClick: true, cost: MAP_CAP_PRIVATE };
  // One crawl is shared by every caller of this repo, but one that was stopped because its starter left the
  // repo is incomplete: a caller whose repo is current starts a fresh crawl instead of taking it.
  for (;;) {
    let job = cache.mapJob;
    if (!job) {
      job = cache.mapJob = { stopped: false };
      const stale = () => { const s = !!isStale?.(); if (s) job.stopped = true; return s; };
      job.promise = buildImportGraph(repo, { cap: meta.private ? MAP_CAP_PRIVATE : MAP_CAP_PUBLIC, isStale: stale })
        .then(async g => {
          if (meta.private) g.private = true; // removed on sign-out with the rest of what the token read
          if (!job.stopped) { cache.map = g; await mapStore(storeKey, g).catch(() => {}); }
          return g;
        })
        .finally(() => { if (cache.mapJob === job) delete cache.mapJob; });
    }
    const g = await job.promise;
    if (!job.stopped || isStale?.()) return g;
  }
}

const MAP_CORE_LIMIT = 10;
const MAP_CORE_MIN_IMPORTERS = 3;
const MAP_PATH_LIMIT = 6;
const mapCircled = (n) => String.fromCharCode(0x2460 + n - 1);
const mapBase = (p) => p.split("/").pop();

// The strongest entry's scripts in load order when it is an HTML page that loads ≥ 3 independent (global-scope) scripts
function globalScripts(graph) {
  const entry = graph.entries?.[0]?.path;
  if (!entry || !/\.html?$/i.test(entry)) return null;
  const scripts = graph.order?.[entry];
  if (!scripts || scripts.length < 3) return null;
  const set = new Set(scripts);
  if ((graph.edges || []).some(([from, to]) => set.has(from) && set.has(to))) return null;
  return [...scripts];
}

// The map as a reader should see it: imports followed through pass-through files (which drop out unless they
// are a start point), importer counts redone, helpers marked. Idempotent; the stored graph is never changed.
function mapView(graph) {
  if (!graph || graph.viewed) return graph;
  const nodes0 = graph.nodes || {};
  const starts = new Set((graph.entries || []).map(e => e.path));
  const out = new Map();
  for (const [a, b] of graph.edges || []) (out.get(a) || out.set(a, []).get(a)).push(b);
  const pass = (p) => !!nodes0[p]?.barrel;
  // Through a pass-through file: to the files that define the names asked for, when known; else to all it passes along
  const through = (p, seen, names) => {
    if (seen.has(p)) return [];
    seen.add(p);
    if (!pass(p)) return [p];
    const ex = nodes0[p].exports;
    const tos = names?.length && ex ? [...new Set(names.map(n => ex[n]).filter(Boolean))] : [];
    return tos.length ? tos.flatMap(q => through(q, seen, names)) : (out.get(p) || []).flatMap(q => through(q, seen, null));
  };
  const nodes = {};
  for (const [p, n] of Object.entries(nodes0)) if (!pass(p) || starts.has(p)) nodes[p] = { ...n, inDegree: 0 };
  const edges = [], seen = new Set(), importers = new Map();
  for (const [a, tos] of out) {
    if (pass(a) && !starts.has(a)) continue;
    for (const b of tos) for (const t of through(b, new Set([a]), graph.via?.[a]?.[b])) {
      const k = a + "\n" + t;
      if (t === a || seen.has(k)) continue;
      seen.add(k);
      edges.push([a, t]);
      (importers.get(t) || importers.set(t, new Set()).get(t)).add(a);
    }
  }
  for (const [t, s] of importers) if (nodes[t]) nodes[t].inDegree = s.size;
  // Helpers: plumbing by name, or a private (_x) file or folder that ties fewer than 3 other files together
  const named = (p) => mapIsHelper(p) && !starts.has(p);
  const privateLeaf = (p) => /(^|\/)_(?!_)[^/]*(\/|$)/.test(p) && !starts.has(p)
    && edges.filter(([a, b]) => a === p && nodes[b] && !named(b) && !TEST_PATH.test(b)).length < 3;
  for (const p of Object.keys(nodes)) if (named(p) || privateLeaf(p)) nodes[p].helper = true;
  return { ...graph, nodes, edges, viewed: true };
}

// Most-imported files, counting through barrels, without tests, type declarations or helpers
function rankCore(graph) {
  graph = mapView(graph);
  const scripts = globalScripts(graph);
  if (scripts) {
    return scripts.map((path, i) => ({ path, i, size: graph.nodes[path]?.size || 0 }))
      .sort((a, b) => b.size - a.size || a.i - b.i).slice(0, 3)
      .map(({ path }) => ({ path, importers: 0, reason: "largest script" }));
  }
  const nodes = graph.nodes || {};
  const importers = new Map();
  for (const [from, to] of graph.edges || []) {
    if (TEST_PATH.test(from)) continue;
    (importers.get(to) || importers.set(to, new Set()).get(to)).add(from);
  }
  return [...importers]
    .filter(([p, s]) => !nodes[p]?.barrel && !nodes[p]?.helper && !TEST_PATH.test(p) && !/\.d\.ts$/i.test(p) && s.size >= MAP_CORE_MIN_IMPORTERS)
    .map(([path, s]) => ({ path, importers: s.size }))
    .sort((a, b) => b.importers - a.importers || a.path.localeCompare(b.path))
    .slice(0, MAP_CORE_LIMIT);
}

// ≤ 6 files to read, in order — how it runs. It starts at the start point the other parts depend on most;
// each next file is loaded by a step so far, chosen by importance: used by
// many real files plus twice the real files it ties together. Never a helper, a pass-through file or a test.
// When the start loads no real file (Django's manage.py), the chain begins at the file that ties the most
// together. Then a file comes before the files it uses.
function readingPath(graph, core = []) {
  graph = mapView(graph);
  const nodes = graph.nodes || {};
  const scripts = globalScripts(graph);
  if (scripts) {
    const entry = graph.entries[0];
    return [entry.path, ...scripts].slice(0, MAP_PATH_LIMIT).map((path, i) => ({
      step: i + 1, path,
      reason: i === 0 ? "entry point · " + entry.reason : `script ${i} of ${scripts.length} on ${entry.path}`,
    }));
  }
  const users = {};
  for (const [a, b] of graph.edges || []) { const x = mapAreaOf(a), y = mapAreaOf(b); if (x !== y) (users[y] ||= new Set()).add(x); }
  // Ties: not in a playground or example folder, then the start in the biggest part (vite's own package, not create-vite)
  const size = (p) => graph.parts?.[mapAreaOf(p)] || 0;
  const aside = (p) => MAP_TOPUP_SKIP.test(p) || TEST_PATH.test(p);
  const entry = (graph.entries || []).map((e, i) => ({ e, i }))
    .sort((a, b) => (users[mapAreaOf(b.e.path)]?.size || 0) - (users[mapAreaOf(a.e.path)]?.size || 0)
      || aside(a.e.path) - aside(b.e.path) || size(b.e.path) - size(a.e.path) || a.i - b.i)[0]?.e;
  if (!entry) return [];
  const out = new Map();
  for (const [a, b] of graph.edges || []) (out.get(a) || out.set(a, new Set()).get(a)).add(b);
  const real = (p) => p in nodes && !nodes[p].helper && !nodes[p].barrel && !TEST_PATH.test(p) && nodes[p].read !== false;
  const fan = (p) => [...(out.get(p) || [])].filter(real).length;
  const score = (p) => (nodes[p].inDegree || 0) + 2 * fan(p);
  const path = [entry.path], have = new Set(path);
  const next = (from) => [...(out.get(from) || [])].filter(q => !have.has(q) && real(q)).sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
  if (!next(entry.path)) {
    const pick = (ok) => Object.keys(nodes).filter(p => !have.has(p) && real(p) && ok(p)).sort((a, b) => fan(b) - fan(a) || score(b) - score(a) || a.localeCompare(b))[0];
    const area = mapAreaOf(entry.path);
    const best = (area !== "(root)" && pick(p => mapAreaOf(p) === area)) || pick(p => mapAreaOf(p) !== "(root)") || pick(() => true);
    if (best) { path.push(best); have.add(best); }
  }
  while (path.length < MAP_PATH_LIMIT) { // the best file loaded by any step so far
    const q = path.map(next).filter(Boolean).sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
    if (!q) break;
    path.push(q); have.add(q);
  }
  for (const c of core) { // a short chain is filled with the files most others use
    if (path.length >= MAP_PATH_LIMIT) break;
    if (!have.has(c.path) && real(c.path)) { path.push(c.path); have.add(c.path); }
  }
  // A file before the files it uses (otherwise in the order found)
  const rest = path.slice(1), ordered = [];
  while (rest.length) {
    const i = rest.findIndex(p => !rest.some(q => q !== p && out.get(q)?.has(p)));
    ordered.push(...rest.splice(i < 0 ? 0 : i, 1));
  }
  const steps = [entry.path, ...ordered];
  return steps.map((p, i) => {
    if (!i) return { step: 1, path: p, reason: "entry point · " + entry.reason };
    const used = nodes[p].inDegree || 0;
    const by = steps.findIndex((f, j) => j < i && out.get(f)?.has(p));
    const reason = by >= 0 ? `loaded by ${mapCircled(by + 1)} ${mapBase(steps[by])}${used > 1 ? ` · used by ${used} files` : ""}`
      : fan(p) ? `ties ${fan(p)} files together${used > 1 ? ` · used by ${used} files` : ""}` : `used by ${used} files`;
    return { step: i + 1, path: p, reason };
  });
}

// The overview the map tab opens on: how it runs (the reading path, with what each file defines), the main
// parts (code files per part, a description from the part's package, the files it mainly is), what was left out.
const MAP_PARTS_LIMIT = 6;
const MAP_VAGUE_DESC = /^this (file|module)\b|^(the )?(main )?entry ?point\b|^(package|module) (init|initiali[sz]ation)\b|^init\b/i;
const MAP_PKG_FILE = /(^|\/)(__init__\.py|index\.[mc]?[jt]sx?)$/;
// A package's front file — an __init__.py, or an index file that only passes imports along — reads as its folder
const mapIsPackageFront = (path, graph) => path.includes("/") && (/(^|\/)__init__\.py$/.test(path) || (!!graph?.nodes?.[path]?.barrel && MAP_PKG_FILE.test(path)));
function mapShortName(path, graph) {
  const s = path.split("/");
  return mapIsPackageFront(path, graph) ? s[s.length - 2] + "/" : s[s.length - 1];
}
function mapOverview(graph) {
  const view = mapView(graph);
  const nodes = graph.nodes || {};
  const steps = readingPath(view, rankCore(view)).map(s => ({
    ...s, defs: nodes[s.path]?.defs || [], desc: nodes[s.path]?.desc || graph.roles?.[s.path] || null,
    pkg: mapIsPackageFront(s.path, graph),
  }));
  let counts = graph.parts;
  if (!counts || !Object.keys(counts).length) { // maps saved before parts were counted
    counts = {};
    for (const p of Object.keys(nodes)) { const a = mapAreaOf(p); if (a !== "(root)" && !TEST_PATH.test(p)) counts[a] = (counts[a] || 0) + 1; }
  }
  const depth = (p) => p.split("/").length;
  const parts = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b)).slice(0, MAP_PARTS_LIMIT).map(name => {
    const inPart = Object.keys(nodes).filter(p => mapAreaOf(p) === name);
    // The part's own package description; none when it holds several packages side by side, or says nothing
    const pkgs = inPart.filter(p => MAP_PKG_FILE.test(p) && nodes[p].desc).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    const pkg = pkgs.length && !(pkgs[1] && depth(pkgs[1]) === depth(pkgs[0])) && !MAP_VAGUE_DESC.test(nodes[pkgs[0]].desc) ? pkgs[0] : null;
    const main = [...new Set(inPart.filter(p => view.nodes[p] && !view.nodes[p].helper && !view.nodes[p].barrel && !TEST_PATH.test(p) && !MAP_PKG_FILE.test(p))
      .sort((a, b) => view.nodes[b].inDegree - view.nodes[a].inDegree || a.localeCompare(b))
      .map(p => mapBase(p).replace(/\.[^.]+$/, "")))].slice(0, 3);
    return { name, files: counts[name], desc: pkg ? nodes[pkg].desc : null, main };
  });
  const starts = new Set((graph.entries || []).map(e => e.path));
  const hidden = {
    helpers: Object.keys(view.nodes).filter(p => view.nodes[p].helper).length,
    pass: Object.keys(nodes).filter(p => nodes[p].barrel && !starts.has(p)).length,
  };
  return { steps, parts, hidden };
}

// ── The flow map: which files are boxes and where they go (drawn by map.js) ──
const FLOW = {
  BOX_W: 230, GAP_X: 36, GAP_Y: 64, PAD: 40,
  DEFAULT_BOXES: 12, MAX_BOXES: 60, NEAR_DEPTH: 3, PER_ROW: 6, MAX_INCOMING: 4, MAX_GROUPS: 8,
};

// ── Which files are boxes ────────────────────────────────────────────────────
function flowFiles(graph, { expanded = new Set(), extra = new Set(), helpers = false } = {}) {
  graph = mapView(graph);
  const nodes = graph.nodes;
  const starts = new Set(graph.entries.map(e => e.path));
  // Helpers stay off the map until asked for (a file the brief asks for still shows)
  const hidden = (p) => !helpers && nodes[p]?.helper && !starts.has(p);
  const core = rankCore(graph);
  const steps = readingPath(graph, core);
  const shown = new Set();
  const add = (p, force = false) => { if (p in nodes && (force || !hidden(p)) && shown.size < FLOW.MAX_BOXES) shown.add(p); };
  graph.entries.forEach(e => add(e.path));
  steps.forEach(s => add(s.path));
  core.forEach(c => add(c.path));
  const near = Object.keys(nodes)
    .filter(p => !shown.has(p) && !hidden(p) && (nodes[p].depth ?? 99) <= FLOW.NEAR_DEPTH && !TEST_PATH.test(p) && !nodes[p].barrel)
    .sort((a, b) => nodes[b].inDegree - nodes[a].inDegree || nodes[a].depth - nodes[b].depth || a.localeCompare(b));
  for (const p of near) { if (shown.size >= FLOW.DEFAULT_BOXES) break; add(p); }
  for (const p of extra) for (const q of chainTo(graph, p)) add(q, q === p);

  // Files that shown boxes load but that aren't shown: folded per folder
  const groups = new Map();
  for (const [from, to] of graph.edges) {
    if (!shown.has(from) || shown.has(to) || TEST_PATH.test(to) || hidden(to)) continue;
    const dir = mapDirOf(to) || "(root)";
    if (expanded.has(dir)) { add(to); continue; }
    const g = groups.get(dir) || { dir, files: new Set(), from: new Set() };
    g.files.add(to); g.from.add(from);
    groups.set(dir, g);
  }
  // Expanding can make more files shown, which may reveal edges into still-folded groups — recompute once
  for (const g of groups.values()) for (const f of [...g.files]) if (shown.has(f)) g.files.delete(f);
  const groupList = [...groups.values()].filter(g => g.files.size).sort((a, b) => b.files.size - a.files.size).slice(0, FLOW.MAX_GROUPS);
  const helperCount = Object.keys(nodes).filter(p => nodes[p].helper && !starts.has(p)).length;
  return { shown, steps, core, groups: groupList, helpers: helperCount };
}

// The shortest import chain from an entry to `path` (inclusive), or [] when it isn't reached
function chainTo(graph, path) {
  graph = mapView(graph);
  if (!(path in graph.nodes)) return [];
  const out = new Map();
  for (const [from, to] of graph.edges) (out.get(from) || out.set(from, []).get(from)).push(to);
  const prev = new Map(), queue = [];
  for (const e of graph.entries) if (e.path in graph.nodes && !prev.has(e.path)) { prev.set(e.path, null); queue.push(e.path); }
  while (queue.length) {
    const p = queue.shift();
    if (p === path) break;
    for (const q of out.get(p) || []) if (!prev.has(q)) { prev.set(q, p); queue.push(q); }
  }
  if (!prev.has(path)) return [path];
  const chain = [];
  for (let p = path; p != null; p = prev.get(p)) chain.unshift(p);
  return chain;
}

// ── Layout: rows by import depth, barycentre ordering ───────────────────────
function flowLayout(graph, files) {
  graph = mapView(graph);
  const { shown, groups } = files;
  const items = [...shown].map(p => ({ id: p, kind: "file", depth: graph.nodes[p].depth ?? 0 }));
  groups.forEach(g => {
    const d = Math.min(...[...g.files].map(f => graph.nodes[f]?.depth ?? 1));
    items.push({ id: `group:${g.dir}`, kind: "group", group: g, depth: d });
  });
  const byId = new Map(items.map(i => [i.id, i]));

  // Edges between items (file→file, file→group); a shared file keeps ≤ MAX_INCOMING arrows
  const seen = new Set(), edges = [];
  for (const [from, to] of graph.edges) {
    if (!shown.has(from)) continue;
    let target = shown.has(to) ? to : null;
    if (!target) { const g = groups.find(g => g.files.has(to)); if (g) target = `group:${g.dir}`; }
    if (!target || target === from) continue;
    const k = from + "→" + target;
    if (!seen.has(k)) { seen.add(k); edges.push({ from, to: target }); }
  }
  // Rows: depth, but an item never sits above something that loads it in the same chain (keeps arrows downward)
  const rowOf = new Map(items.map(i => [i.id, i.depth]));
  graph.entries.forEach(e => byId.has(e.path) && rowOf.set(e.path, 0));
  const rowsByIndex = new Map();
  for (const i of items) { const r = rowOf.get(i.id); (rowsByIndex.get(r) || rowsByIndex.set(r, []).get(r)).push(i); }
  let rows = [...rowsByIndex.keys()].sort((a, b) => a - b).map(r => rowsByIndex.get(r));
  rows.forEach(r => r.sort((a, b) => (graph.nodes[b.id]?.inDegree || 0) - (graph.nodes[a.id]?.inDegree || 0) || a.id.localeCompare(b.id)));

  // Wide rows wrap so a page that loads 13 scripts doesn't become one 3,000px row
  rows = rows.flatMap(r => { const out = []; for (let i = 0; i < r.length; i += FLOW.PER_ROW) out.push(r.slice(i, i + FLOW.PER_ROW)); return out; });

  const parents = new Map(), children = new Map();
  for (const e of edges) {
    (parents.get(e.to) || parents.set(e.to, []).get(e.to)).push(e.from);
    (children.get(e.from) || children.set(e.from, []).get(e.from)).push(e.to);
  }
  const pos = new Map();
  const index = () => rows.forEach(r => r.forEach((it, i) => pos.set(it.id, i - (r.length - 1) / 2)));
  index();
  const bary = (it, rel) => { const ps = (rel.get(it.id) || []).filter(p => pos.has(p)); return ps.length ? ps.reduce((s, p) => s + pos.get(p), 0) / ps.length : pos.get(it.id); };
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < rows.length; r++) { rows[r].sort((a, b) => bary(a, parents) - bary(b, parents)); index(); }
    for (let r = rows.length - 2; r >= 0; r--) { rows[r].sort((a, b) => bary(a, children) - bary(b, children)); index(); }
  }
  // Keep ≤ MAX_INCOMING arrows into a shared file: the ones from the nearest rows
  const rowIdx = new Map(); rows.forEach((r, i) => r.forEach(it => rowIdx.set(it.id, i)));
  const kept = [];
  for (const [to, froms] of parents) {
    const sorted = [...froms].sort((a, b) => Math.abs(rowIdx.get(to) - rowIdx.get(a)) - Math.abs(rowIdx.get(to) - rowIdx.get(b)));
    sorted.slice(0, FLOW.MAX_INCOMING).forEach(from => kept.push({ from, to, back: rowIdx.get(from) >= rowIdx.get(to), hidden: froms.length - FLOW.MAX_INCOMING }));
  }
  return { rows, edges: kept, allEdges: edges, rowIdx };
}


// ── Explain this map (Ask) ───────────────────────────────────────────────────
const topFolder = (p) => p.includes("/") ? p.split("/")[0] : "(root files)";

// The <repo_map> block: folders, how they import each other, entries, core, reading path
function mapSummary(graph, tree) {
  const blobs = (tree?.entries || []).filter(e => e.type === "blob");
  const bytes = new Map();
  for (const e of blobs) if (!NOISE_PATH.test(e.path) && !NOT_CODE.test(e.path)) bytes.set(topFolder(e.path), (bytes.get(topFolder(e.path)) || 0) + (e.size || 0));
  const folders = [...bytes].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([f, n]) => `- ${f} (${Math.round(n / 1024) || "<1"} KB of code)`);
  const links = new Map();
  for (const [from, to] of graph.edges || []) {
    const a = topFolder(from), b = topFolder(to);
    if (a !== b) links.set(`${a} → ${b}`, (links.get(`${a} → ${b}`) || 0) + 1);
  }
  const imports = [...links].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 20).map(([k, n]) => `- ${k}: ${n} imports`);
  const core = rankCore(graph);
  const steps = readingPath(graph, core);
  const list = (title, rows) => `${title}:
${rows.length ? rows.join("\n") : "- none"}`;
  return `<repo_map>
${list("Top folders", folders)}

${list("Imports between folders", imports)}

${list("Entry points", (graph.entries || []).map(e => `- ${e.path} (${e.reason})`))}

${list("Core files", core.map(c => `- ${c.path} (${c.importers ? `imported by ${c.importers} files` : c.reason})`))}

${list("Reading path", steps.map(s => `${s.step}. ${s.path} — ${s.reason}`))}
</repo_map>`;
}

// The names a file offers: exports (ES, CommonJS), and top-level functions/classes (global-scope scripts, Python)
function mapExportedNames(text) {
  const names = new Set();
  const add = (n) => { if (n && n.length >= 3 && !n.startsWith("_")) names.add(n); };
  for (const m of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([\w$]+)/g)) add(m[1]);
  for (const m of text.matchAll(/\bexport\s*\{([^}]*)\}/g)) for (const part of m[1].split(",")) add(part.trim().split(/\s+as\s+/).pop().trim());
  for (const m of text.matchAll(/\b(?:module\.)?exports\.([\w$]+)\s*=/g)) add(m[1]);
  for (const m of text.matchAll(/^(?:async\s+)?(?:function\*?|class|def)\s+([\w$]+)/gm)) add(m[1]);
  return [...names].slice(0, 40);
}

// → { context, sources } the map plus the head and best windows of each reading-path file (or of `files`,
// an edited list), within `budget`. Windows go to what the file offers the rest of the path: the names the
// other files import from it (their definitions first), then its exported names.
async function mapFocusContext(graph, tree, budget, { repo = currentRepo, files = null, onFiles = () => {} } = {}) {
  const summary = mapSummary(graph, tree);
  const known = new Set((tree?.entries || []).filter(e => e.type === "blob").map(e => e.path));
  const paths = files ? files.filter(p => known.has(p)) : readingPath(graph, rankCore(graph)).map(s => s.path);
  const via = files ? "chosen" : "map";
  onFiles(paths.map(path => ({ path, via })));
  const texts = await Promise.all(paths.map(p => readRepoFile(p, repo).catch(() => null)));
  const wanted = new Map(); // path → names other files on the path import from it
  paths.forEach((from, i) => {
    if (!texts[i]) return;
    for (const imp of parseImports(texts[i], from)) {
      for (const hit of resolveImport(imp, from, known)) {
        if (!wanted.has(hit)) wanted.set(hit, new Set());
        imp.names.forEach(n => wanted.get(hit).add(n.toLowerCase()));
      }
    }
  });
  const parts = [summary], sources = [];
  let left = budget - summary.length;
  for (let i = 0; i < paths.length; i++) {
    if (left <= 0) break;
    const text = texts[i];
    if (!text) continue;
    const share = Math.floor(left / (paths.length - i));
    const strong = [...(wanted.get(paths[i]) || [])].filter(n => n.length >= 3);
    const terms = [...new Set([...strong, ...mapExportedNames(text).map(n => n.toLowerCase())])];
    const lines = text.split("\n");
    for (const range of extractSnippets(text, terms, share, strong)) {
      const part = formatSnippet(paths[i], lines, range);
      if (part.length > left) { left = 0; break; }
      parts.push(part);
      sources.push({ path: paths[i], start: range.start, end: range.end, via });
      left -= part.length + 2;
    }
  }
  return { context: parts.join("\n\n"), sources };
}

const ROLES_BLOCK = /```roles[^\n]*\n([\s\S]*?)```/;
const ROLE_LINE = /^[-*\s]*`?([\w@.\/-]+?)\/?`?(?:\s+[-\u2013\u2014]\s+|\s*[\u2013\u2014]\s*|:\s+)(.+)$/;

// The role the answer gave each area: lines "path — role" in a closed ```roles block
function parseAreaRoles(answer) {
  const out = {};
  const m = ROLES_BLOCK.exec(String(answer || ""));
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const r = ROLE_LINE.exec(line.trim());
    const role = r?.[2].trim().replace(/\.$/, "").slice(0, 120);
    if (r && role && !/^unclear$/i.test(role)) out[r[1]] = role;
  }
  return out;
}

// The answer without its roles block — also while that block is still streaming
function stripRolesBlock(answer) {
  return String(answer || "").replace(/```roles[^\n]*\n[\s\S]*?```\n?/g, "").replace(/```roles[\s\S]*$/, "");
}

// Put the answer's roles on the map: cached, stored, and redrawn if it's on screen
async function saveMapRoles(key, roles) {
  const graph = cacheFor(key).map;
  if (!graph || !Object.keys(roles).length) return;
  graph.roles = roles;
  const [owner, repo] = key.split("/");
  await mapStore(mapStoreKey(owner, repo), graph).catch(() => {});
}

function explainMap() {
  const key = currentRepo && repoKey();
  if (!key || !cacheFor(key).map) return;
  setChatFocus({ kind: "map", key, title: "the repo map" });
  switchTab("chat");
  const input = document.getElementById("chat-input");
  input.value = "Explain how this repo is organised and how it runs.";
  autosizeChatInput();
  if (!document.getElementById("send-btn").disabled) return handleChat();
  input.focus();
}

function askAboutFile(path) {
  setChatFocus(null);
  switchTab("chat");
  const input = document.getElementById("chat-input");
  input.value = `@${path} `;
  autosizeChatInput();
  input.focus();
}

// ── The issue brief: where its files sit ─────────────────────────────────────
// "index.js → app.js → router.js" for the first file the brief points at, once the map is built.
// Never reads files by itself; "Open on the map" opens the tab, which builds the map if needed.
function briefChain(graph, path) {
  if (!graph?.nodes || !(path in graph.nodes)) return null;
  const chain = chainTo(graph, path);
  return chain.length > 1 || graph.entries.some(e => e.path === path) ? chain : null;
}

// A map problem never takes the brief down with it
async function drawBriefMap(repo, brief, live = () => true) {
  try {
    const el = document.getElementById("brief-map");
    const paths = (groupIssueFiles(brief.fileSources || []).start || []).map(f => f.path);
    if (!el || !paths.length || !live()) return;
    const graph = cacheFor(repoKey(repo)).map;
    const path = paths.find(p => briefChain(graph, p)) || paths[0];
    const chain = briefChain(graph, path);
    const base = (p) => escapeHtml(p.split("/").pop());
    const line = chain
      ? `<span class="brief-chain">${chain.map((p, i) => i === chain.length - 1 ? `<strong>${base(p)}</strong>` : base(p)).join(" → ")}</span>`
      : graph?.nodes ? `<span class="brief-chain">${base(path)} isn't reached from where the app starts</span>` : "";
    el.innerHTML = `${line}<button type="button" class="btn btn-xs brief-map-open" data-file="${escapeHtml(path)}">Open on the map ↗</button>`;
  } catch { /* the files listed above still stand */ }
}

// ── The Repo tab card ────────────────────────────────────────────────────────
// How the app starts in one line, and the buttons: the map itself lives in its own tab (map.html)
let mapState = null; // { key, graph } of the card on screen

function mapCardHtml(graph) {
  const core = rankCore(graph);
  const steps = readingPath(graph, core);
  // A package's front file reads as its folder (`prompts/`); the start is the reading path's
  const name = (p) => `<code>${escapeHtml(mapShortName(p, graph))}</code>`;
  const start = steps[0]?.path || graph.entries[0]?.path;
  const chain = steps.slice(0, 4).map(s => name(s.path)).join(" → ") + (steps.length > 4 ? " → …" : "");
  return `<div class="map-card-head"><h2 class="section-title">How it runs</h2></div>
    <p class="map-card-line">${start ? `Starts in <code>${escapeHtml(start)}</code>${steps.length > 1 ? ` · ${chain}` : ""}` : "Couldn't find where this app starts."}</p>
    <p class="map-card-sub">${graph.read} files read${core.length ? ` · ${core.length} used by many files` : ""}${globalScripts(graph) ? " · scripts share one global scope" : ""}</p>
    <div class="map-card-actions">
      <button type="button" id="map-open" class="btn btn-xs btn-primary">Open the map ↗</button>
      <button type="button" id="map-explain" class="btn btn-xs">Explain this map</button>
    </div>`;
}

async function fetchRepoMap({ allowPrivate = false } = {}) {
  const el = document.getElementById("repo-map");
  const repo = currentRepo;
  const key = repoKey(repo);
  const live = () => isCurrentRepo(key);
  mapState = null;
  el.innerHTML = `<div class="sk sk-line short"></div><div class="sk sk-line"></div>`;
  try {
    const graph = await loadRepoMap(repo, { allowPrivate, isStale: () => !live() });
    if (!live()) return true;
    if (graph.needsClick) {
      el.innerHTML = `<div class="map-card-head"><h2 class="section-title">How it runs</h2></div>
        <p class="map-card-sub">A private repo: the map reads its files with GitHub requests (about ${graph.cost}).</p>
        <div class="map-card-actions"><button type="button" id="map-open" class="btn btn-xs btn-primary">Open the map ↗</button></div>`;
      return true;
    }
    mapState = { key, graph };
    el.innerHTML = mapCardHtml(graph);
  } catch (err) {
    // Try again keeps this attempt's consent: an unclicked private repo still waits for its click
    if (live()) el.innerHTML = `${errorState(err, "div")}<button type="button" id="map-retry" class="btn btn-xs"${allowPrivate ? ' data-private="1"' : ""}>${icon("refresh", "icon-sm")}Try again</button>`;
  }
  return true;
}

// The flow map lives in its own tab (map.html); one tab per repo
async function openMapTab(repo, file = "") {
  if (!repo) return;
  const base = chrome.runtime.getURL(`map.html?repo=${encodeURIComponent(repoKey(repo))}`);
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("map.html") + "*" }).catch(() => []);
  const open = tabs.find(t => (t.url || "").startsWith(base));
  if (open) {
    chrome.tabs.update(open.id, { active: true });
    if (file) chrome.runtime.sendMessage({ type: "map-highlight", repo: repoKey(repo), file }).catch(() => {});
    return;
  }
  chrome.tabs.create({ url: base + (file ? `&file=${encodeURIComponent(file)}` : "") });
}

// Requests from the map tab: AI work stays in Ask, here in the panel
function handleMapTabMessage(msg) {
  if (!msg || !currentRepo || msg.repo !== repoKey()) return;
  if (msg.type === "map-ask-file") askAboutFile(msg.file);
  if (msg.type === "map-explain") explainMap();
}

function handleMapClick(e) {
  const t = e.target;
  const retry = t.closest?.("#map-retry");
  if (retry) return fetchRepoMap({ allowPrivate: retry.dataset?.private === "1" });
  if (t.closest?.("#map-open")) return openMapTab(currentRepo);
  if (t.closest?.("#map-explain")) return explainMap();
}

function initRepoMap() {
  document.getElementById("repo-map").addEventListener("click", handleMapClick);
  chrome.runtime?.onMessage?.addListener((msg) => { handleMapTabMessage(msg); });
}
