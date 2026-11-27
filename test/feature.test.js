// feature.js: "How does X work?" — the functions to read, in the order they run, AI only past a threshold
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const pure = loadPanel().fn;

// A small app: a view submits, a task queues, an evaluator scores
const PY = {
  "apps/jobs/views.py": `from apps.jobs.tasks import enqueue_submission


def submit_submission(request):
    """Accept a participant's submission."""
    data = request.data
    return enqueue_submission(data)


def list_jobs(request):
    return []
`,
  "apps/jobs/tasks.py": `from worker.evaluator import score_submission


def enqueue_submission(data):
    """Queue a submission for the worker."""
    job = make_job(data)
    return score_submission(job)


def make_job(data):
    return data
`,
  "worker/evaluator.py": `class Evaluator:
    """Runs the challenge's grading script."""

    def run(self, job):
        return 1


def score_submission(job):
    """Score a submission against the test set."""
    return Evaluator().run(job)
`,
  "apps/accounts/models.py": `class Profile:
    """A user's profile."""
    pass
`,
};
const files = (raw = PY) => Object.entries(raw).map(([path, text]) => ({ path, text }));

test("featureTerms keeps what the question is about, not its filler", () => {
  assert.deepEqual(plain(pure.featureTerms("How do submissions get scored?")), ["submission", "scor"]);
  assert.deepEqual(plain(pure.featureTerms("How does the streaming feature work in this function?")), ["stream"]);
});

test("codeFunctions finds Python and JS functions with their line, docstring and body", () => {
  const py = plain(pure.codeFunctions(PY["worker/evaluator.py"], "worker/evaluator.py"));
  assert.deepEqual(py.map(f => [f.name, f.line, f.doc]), [["Evaluator", 1, "Runs the challenge's grading script."], ["run", 4, null], ["score_submission", 8, "Score a submission against the test set."]]);
  assert.match(py[2].body, /Evaluator\(\)\.run/);
  const js = plain(pure.codeFunctions(`/** Opens a socket. */
export async function connectStream(url) {
  return open(url);
}
const parseChunk = (line) => {
  return JSON.parse(line);
};
class Client {
  send(msg) {
    return this.ws.send(msg);
  }
}
`, "src/stream.ts"));
  assert.deepEqual(js.map(f => [f.name, f.line]), [["connectStream", 2], ["parseChunk", 5], ["Client", 8], ["send", 9]]);
  assert.equal(js[0].doc, "Opens a socket.");
});

test("confident: two name matches covering the question and linked by calls — no AI, callers first", () => {
  const t = plain(pure.featureTrace("How do submissions get scored?", files()));
  assert.equal(t.verdict.kind, "confident");
  assert.deepEqual(t.steps.map(s => s.name), ["submit_submission", "enqueue_submission", "score_submission"]);
  assert.equal(t.steps[0].line, 4);
  assert.equal(t.verdict.coverage, 1);
  assert.ok(t.verdict.linked >= 2);
  assert.ok(!t.steps.some(s => s.name === "list_jobs" || s.name === "Profile"));
});

test("partial: a name matches but the question's other words don't — AI is offered, not run", () => {
  const t = plain(pure.featureTrace("How are submissions ranked on the leaderboard?", files()));
  assert.equal(t.verdict.kind, "partial");
  assert.ok(t.verdict.missing.includes("leaderboard"));
  assert.ok(t.steps.length >= 1);
});

test("nothing: no function name or docstring has any of the words", () => {
  const t = plain(pure.featureTrace("How does billing work?", files()));
  assert.equal(t.verdict.kind, "none");
  assert.deepEqual(t.steps, []);
});

test("a single matched function that calls nothing matched is partial, not confident", () => {
  const t = plain(pure.featureTrace("How is a profile created?", files()));
  assert.equal(t.verdict.kind, "partial");
});

test("the trace keeps at most 6 steps", () => {
  const raw = {};
  for (let i = 0; i < 10; i++) raw[`src/s${i}.py`] = `def stream_part_${i}():\n    """Stream part."""\n    return stream_part_${i + 1}()\n`;
  const t = plain(pure.featureTrace("how does streaming work", files(raw)));
  assert.equal(t.steps.length, 6);
});

test("the AI's index is numbered, capped, and its picks are checked against it", () => {
  const fns = plain(pure.featureTrace("billing", files())).index;
  assert.ok(fns.length >= 6 && fns.length <= 80);
  assert.deepEqual(Object.keys(fns[0]).sort(), ["doc", "line", "n", "name", "path"]);
  const prompt = pure.featurePickPrompt("How does billing work?", [], fns);
  assert.match(prompt, /1\. apps\/jobs\/views\.py:4 submit_submission — Accept a participant's submission\./);
  assert.deepEqual(plain(pure.parseFeaturePicks('Sure: [{"n": 3, "why": "queues it"}, {"n": 999}, {"n": 1, "why": "x"}, {"n": 3}]', fns.length)),
    [{ n: 3, why: "queues it" }, { n: 1, why: "x" }]);
  assert.deepEqual(plain(pure.parseFeaturePicks("no idea", fns.length)), []);
  assert.match(pure.FEATURE_PICK_SYSTEM, /only/i);
});

function featurePanel({ ai, configured = true, raw = PY } = {}) {
  const requests = [];
  const gh = githubMock({
    "": { default_branch: "main" },
    "/git/trees/HEAD?recursive=1": { sha: "t1", tree: Object.keys(raw).map(p => ({ path: p, type: "blob", size: raw[p].length })) },
  }, { raw, ai: ai && (async (_u, init) => { requests.push(JSON.parse(init.body)); return sseReply(ai); }) });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = "groq"; aiApiKey = ${configured ? '"gsk_test"' : '""'};`);
  return { panel, gh, requests };
}

test("traceFeature reads the likely files from raw GitHub — no API requests beyond the tree — and calls no AI", async () => {
  const { panel, gh, requests } = featurePanel({ ai: "[]" });
  const repo = panel.run("currentRepo");
  await panel.fn.getRepoTree(repo);
  await panel.fn.loadRepoData(repo); // the map tab has both before anyone asks
  const before = gh.apiCalls.length;
  // The map tab passes the map: the names each file defines find files whose paths say nothing
  const graph = { entries: [], edges: [], order: {}, read: 4, nodes: {
    "apps/jobs/views.py": { depth: 1, inDegree: 0, defs: ["submit_submission", "list_jobs"] },
    "apps/jobs/tasks.py": { depth: 2, inDegree: 1, defs: ["enqueue_submission", "make_job"] },
    "worker/evaluator.py": { depth: 3, inDegree: 1, defs: ["Evaluator", "score_submission"] },
    "apps/accounts/models.py": { depth: 1, inDegree: 0, defs: ["Profile"] } } };
  const t = plain(await panel.fn.traceFeature("How do submissions get scored?", repo, graph));
  assert.equal(t.verdict.kind, "confident");
  assert.equal(gh.apiCalls.length, before);
  assert.equal(requests.length, 0);
});

test("the side panel answers the map tab's AI request from the index, keeping only listed entries", async () => {
  const { panel, requests } = featurePanel({ ai: '[{"n": 2, "why": "queues the job"}, {"n": 7, "why": "scores it"}, {"n": 500}]' });
  const index = [1, 2, 3, 4, 5, 6, 7].map(n => ({ n, path: `f${n}.py`, name: `fn${n}`, line: n, doc: null }));
  const r = plain(await panel.fn.handleMapTabMessage({ type: "map-feature-ai", repo: "o/r", question: "How does billing work?", found: [], index }));
  assert.deepEqual(r.picks, [{ n: 2, why: "queues the job" }, { n: 7, why: "scores it" }]);
  assert.equal(requests.length, 1);
  const sent = JSON.stringify(requests[0]);
  assert.match(sent, /fn7/);
  assert.ok(sent.length < 6000, "an index, not files");
});

test("without an AI provider the side panel says so and calls nothing", async () => {
  const { panel, requests } = featurePanel({ ai: "[]", configured: false });
  const r = plain(await panel.fn.handleMapTabMessage({ type: "map-feature-ai", repo: "o/r", question: "q", found: [], index: [] }));
  assert.equal(r.error, "no-ai");
  assert.equal(requests.length, 0);
});

test("Explain the code sends one visible question to Ask that names each step's file", async () => {
  const { panel } = featurePanel({ ai: "Step one…" });
  panel.fn.handleMapTabMessage({ type: "map-feature-explain", repo: "o/r", question: "How do submissions get scored?",
    steps: [{ path: "apps/jobs/views.py", name: "submit_submission", line: 4 }, { path: "worker/evaluator.py", name: "score_submission", line: 8 }] });
  const q = panel.el("chat-input").value || panel.run("chatMessages").find?.(m => m.role === "user")?.text || "";
  assert.match(q, /How do submissions get scored\?/);
  assert.match(q, /① @apps\/jobs\/views\.py submit_submission\(\) \(line 4\)/);
  assert.match(q, /② @worker\/evaluator\.py score_submission\(\)/);
});
test("one common word can't make a two-word question confident: both words must match", () => {
  const raw = {
    "apps/a.py": "def handle_submission_rerun(s):\n    return resume_submission(s)\n\ndef resume_submission(s):\n    return s\n",
    "apps/b.py": "def submission_paused(c):\n    return False\n",
  };
  const t = plain(pure.featureTrace("How does a submission get scored?", files(raw)));
  assert.equal(t.verdict.kind, "partial");
  assert.deepEqual(t.verdict.missing, ["scor"]);
});
