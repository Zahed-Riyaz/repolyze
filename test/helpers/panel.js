// Loads the side panel scripts (retrieval.js, insights.js, sidepanel.js — in the
// same order as sidepanel.html) into this Node process with in-memory stand-ins
// for the DOM, chrome.* and fetch, so tests exercise the real code.
//
//   const panel = loadPanel({ fetch: githubMock({...}) });
//   panel.fn.renderMarkdown("**hi**");            // any top-level function
//   panel.run("currentRepo = { owner: 'o', repo: 'r' }");  // reach let/const state
//   panel.el("issues-list").innerHTML               // what a render wrote
//
// Each loadPanel() call gives fresh module state (caches, rate limits, repo).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SCRIPTS = ["retrieval.js", "insights.js", "sidepanel.js"];
const SOURCE = SCRIPTS.map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n");

// ── Minimal DOM ──────────────────────────────────────────────────────────────
function fakeElement(id = "") {
  const classes = new Set();
  const listeners = {};
  const el = {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    placeholder: "",
    title: "",
    type: "text",
    className: "",
    dataset: {},
    offsetLeft: 0,
    offsetWidth: 40,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: { setProperty() {}, getPropertyValue: () => "" },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => ((force ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)),
      contains: (c) => classes.has(c),
    },
    listeners,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatch: (type, event = {}) => (listeners[type] || []).forEach(fn => fn({ preventDefault() {}, ...event })),
    // Elements found by selector are recorded so tests can reach them
    // (e.g. click a button that a render just wrote into innerHTML).
    queried: {},
    querySelector: (sel) => (el.queried[sel] ||= fakeElement()),
    querySelectorAll: () => [],
    appendChild: (child) => child,
    insertAdjacentHTML: (_pos, html) => { el.innerHTML += html; },
    remove() {},
    focus() {},
    scrollIntoView() {},
    setAttribute(name, value) { el[`attr:${name}`] = value; },
    getAttribute(name) { return el[`attr:${name}`] ?? null; },
  };
  return el;
}

function fakeDocument() {
  const byId = new Map();
  const doc = {
    body: fakeElement("body"),
    getElementById: (id) => { if (!byId.has(id)) byId.set(id, fakeElement(id)); return byId.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => fakeElement(),
    addEventListener() {},
  };
  return doc;
}

// ── chrome.* ─────────────────────────────────────────────────────────────────
function fakeChrome({ local = {}, session = {} } = {}) {
  const area = (data) => ({
    data,
    get: async (keys) => {
      const list = keys === undefined ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
    },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  });
  const opened = [];
  return {
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
    tabs: {
      create: ({ url }) => opened.push(url),
      onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
      query: async () => [],
      get: async () => null,
    },
    windows: { getCurrent: async () => ({ id: 1 }) },
    openedTabs: opened,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────
const realSetInterval = setInterval;

function loadPanel({ fetch: fetchImpl, chrome: chromeOpts } = {}) {
  global.document = fakeDocument();
  global.chrome = fakeChrome(chromeOpts);
  global.requestAnimationFrame = (fn) => fn();
  global.ResizeObserver = class { observe() {} };
  // The rate-limit countdown ticks with setInterval for as long as the panel is
  // open; unref it so a finished test file can exit.
  global.setInterval = (...args) => { const h = realSetInterval(...args); h.unref?.(); return h; };
  global.fetch = fetchImpl || (async () => { throw new Error("unexpected fetch — pass a fetch mock"); });

  // Indirect eval runs the scripts at global scope, like classic <script> tags.
  // The trailing accessor is a direct eval, so tests can read and set the
  // scripts' let/const state (currentRepo, githubToken, ghState…).
  (0, eval)(`${SOURCE}\n;globalThis.__panelRun = (code) => eval(code);`);
  const run = global.__panelRun;

  const panel = {
    run,
    fn: new Proxy({}, { get: (_t, name) => run(String(name)) }),
    el: (id) => global.document.getElementById(id),
    chrome: global.chrome,
    setRepo(owner = "o", repo = "r") {
      run(`currentRepo = { owner: ${JSON.stringify(owner)}, repo: ${JSON.stringify(repo)} }; onRepoPage = true;`);
    },
    setToken(token) { run(`githubToken = ${JSON.stringify(token)}`); },
  };
  return panel;
}

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// JSON round-trip: compare values produced inside the scripts with plain objects
const plain = (x) => JSON.parse(JSON.stringify(x));

module.exports = { loadPanel, tick, plain };
