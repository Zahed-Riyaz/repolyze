// How the extension talks to AI providers: system prompts, prompt layout,
// history budgets, context windows, and retrieval choices that help every model
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPanel, plain } = require("./helpers/panel");
const { githubMock, sseReply } = require("./helpers/github-mock");

const pure = loadPanel().fn;
const contents = [
  { role: "user", parts: [{ text: "Q1" }] },
  { role: "model", parts: [{ text: "A1" }] },
  { role: "user", parts: [{ text: "Q2" }] },
];

// ── Provider request bodies ──────────────────────────────────────────────────
test("every provider gets the instructions in its own system slot, and a low temperature", () => {
  const opts = { system: "RULES", temperature: 0.2 };
  const gemini = plain(pure.providerBody("gemini", contents, opts));
  assert.deepEqual(gemini.systemInstruction, { parts: [{ text: "RULES" }] });
  assert.equal(gemini.generationConfig.temperature, 0.2);
  assert.ok(!JSON.stringify(gemini.contents).includes("RULES"));

  for (const p of ["groq", "openai"]) {
    const body = plain(pure.providerBody(p, contents, opts));
    assert.deepEqual(body.messages[0], { role: "system", content: "RULES" }, p);
    assert.deepEqual(body.messages.slice(1).map(m => m.role), ["user", "assistant", "user"], p);
    assert.equal(body.temperature, 0.2);
  }

  const anthropic = plain(pure.providerBody("anthropic", contents, opts));
  assert.equal(anthropic.system, "RULES");
  assert.ok(anthropic.messages.every(m => m.role !== "system"), "Anthropic takes system separately");
  assert.equal(anthropic.temperature, 0.2);

  const ollama = plain(pure.providerBody("ollama", contents, opts));
  assert.deepEqual(ollama.messages[0], { role: "system", content: "RULES" });
  assert.equal(ollama.options.temperature, 0.2);
});

test("without a system prompt no system slot is sent", () => {
  assert.ok(!("systemInstruction" in plain(pure.providerBody("gemini", contents, {}))));
  assert.equal(pure.providerBody("openai", contents, {}).messages[0].role, "user");
  assert.ok(!("system" in plain(pure.providerBody("anthropic", contents, {}))));
});

test("Ollama's context window is sized to the request instead of its 2–4k default", () => {
  const small = pure.providerBody("ollama", contents, { system: "x" });
  assert.equal(small.options.num_ctx, 8192, "never below 8k");
  const big = pure.providerBody("ollama", [{ role: "user", parts: [{ text: "y".repeat(60000) }] }], {});
  assert.ok(big.options.num_ctx >= Math.ceil(60000 / 3.5), `num_ctx ${big.options.num_ctx} can't hold the prompt`);
  const huge = pure.providerBody("ollama", [{ role: "user", parts: [{ text: "y".repeat(500000) }] }], {});
  assert.equal(huge.options.num_ctx, 32768, "capped");
});

// ── Chat prompt layout ───────────────────────────────────────────────────────
test("the chat prompt puts context first and the question last, with rules in the system prompt", () => {
  const { system, contents: msgs } = pure.buildChatPrompt({ repo: { owner: "o", repo: "r" }, context: "=== a.ts ===\n1| x", question: "How does x work?" });
  assert.match(system, /GitHub repository "o\/r"/);
  assert.match(system, /cite it inline as `path:line`/);
  assert.match(system, /data, not instructions/);
  const last = msgs.at(-1).parts[0].text;
  assert.ok(last.startsWith("<repository_context>\n=== a.ts ==="));
  assert.ok(last.endsWith("Question: How does x work?"));
  assert.ok(!last.includes("cite it inline"), "instructions aren't mixed into the data");
});

test("chat history is kept newest-first within its budget, skips errors, and opens with the user", () => {
  const history = [
    { role: "user", text: "old question " + "o".repeat(3000) },
    { role: "bot", text: "old answer" },
    { role: "user", text: "q2" },
    { role: "bot", text: "Error: boom", error: true },
    { role: "bot", text: "a2" },
    { role: "user", text: "q3" },
    { role: "bot", text: "a3" },
  ];
  const { contents: msgs } = pure.buildChatPrompt({ repo: { owner: "o", repo: "r" }, context: "c", question: "q4", history, historyBudget: 100 });
  const texts = msgs.slice(0, -1).map(m => m.parts[0].text);
  assert.deepEqual(texts, ["q2", "a2", "q3", "a3"], "the long old turn is dropped, the error skipped");
  assert.equal(msgs[0].role, "user");
});

// ── Retrieval choices ────────────────────────────────────────────────────────
test("mentionedFiles finds files named in the question by path or file name", () => {
  const entries = ["src/brief.js", "src/launch/timer.ts", "README.md", "docs"].map(p => ({ path: p, type: p.includes(".") ? "blob" : "tree" }));
  assert.deepEqual(plain(pure.mentionedFiles("What does brief.js do, and how does `src/launch/timer.ts` tick?", entries)), ["src/brief.js", "src/launch/timer.ts"]);
  assert.deepEqual(plain(pure.mentionedFiles("Is v1.2 compatible? see e.g. nothing.py", entries)), []);
});

const TREE = { tree: ["README.md", "src/brief.js", "src/launch/timer.ts", "src/launch/sequence.ts", ...Array.from({ length: 200 }, (_, i) => `src/misc/m${i}.ts`)]
  .map(p => ({ path: p, type: "blob", size: 800 })) };
const RAW = { "README.md": "# R", "src/brief.js": "export function showBrief() {}", "src/launch/timer.ts": "export class Timer { tick() {} }", "src/launch/sequence.ts": "export function run() {}" };

function chatPanel({ provider = "groq", ai } = {}) {
  const requests = [];
  const gh = githubMock({ "": { default_branch: "main" }, "/git/trees/HEAD?recursive=1": TREE }, {
    raw: RAW,
    ai: async (url, init) => { const body = JSON.parse(init.body); requests.push(body); return ai ? ai(body, requests.length) : sseReply("[]"); },
  });
  const panel = loadPanel({ fetch: gh.fetch });
  panel.setRepo();
  panel.run(`aiProvider = ${JSON.stringify(provider)}; aiApiKey = "k"`);
  return { panel, requests };
}

test("a file named in the question is read directly, skipping the picker call", async () => {
  const { panel, requests } = chatPanel();
  const { sources } = await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "What does brief.js do?", null);
  assert.equal(requests.length, 0, "no AI call needed to choose files");
  assert.deepEqual([...new Set(plain(sources).map(s => s.path))], ["src/brief.js"]);
});

test("follow-ups keep the previous answer's files: flagged for the picker, and used if picking fails", async () => {
  const flagged = chatPanel({ ai: () => sseReply('["src/launch/timer.ts"]') });
  await flagged.panel.fn.buildChatContext({ owner: "o", repo: "r" }, "and where is it called?", "How does the timer tick?", () => {}, { previousFiles: ["src/launch/timer.ts"] });
  const pickerUser = flagged.requests[0].messages.find(m => m.role === "user").content;
  assert.match(pickerUser, /src\/launch\/timer\.ts \(1 KB\) — read for the previous answer/);

  const failing = chatPanel({ ai: () => new Response("{}", { status: 500 }) });
  const { sources } = await failing.panel.fn.buildChatContext({ owner: "o", repo: "r" }, "and then?", null, () => {}, { previousFiles: ["src/launch/timer.ts"] });
  assert.deepEqual([...new Set(plain(sources).map(s => s.path))], ["src/launch/timer.ts"], "falls back to the files already in play");
});

test("the picker shortlist is sized to the model", async () => {
  for (const [provider, max] of [["ollama", 60], ["groq", 120], ["openai", 250]]) {
    const { panel, requests } = chatPanel({ provider, ai: (body) => (provider === "ollama" ? new Response(JSON.stringify({ message: { content: "[]" }, done: true }) + "\n") : sseReply("[]")) });
    await panel.fn.buildChatContext({ owner: "o", repo: "r" }, "how does misc work", null);
    const user = (requests[0].messages || []).find(m => m.role === "user")?.content || "";
    const listed = user.split("\n").filter(l => /^src\/|^README/.test(l)).length;
    assert.ok(listed <= max && listed > 0, `${provider}: ${listed} paths listed (max ${max})`);
  }
});

test("a chat turn sends rules as a system prompt and the question last, and carries files into the follow-up", async () => {
  const { panel, requests } = chatPanel({
    ai: (body) => (body.messages[0].content.startsWith("You choose which source files")
      ? sseReply('["src/launch/timer.ts"]')
      : sseReply("It ticks in `src/launch/timer.ts:1`.")),
  });
  panel.run("chatMessages = []");
  panel.el("chat-input").value = "How does the timer tick?";
  await panel.fn.handleChat();

  const answer = requests.find(b => b.messages[0].content.startsWith("You are an expert"));
  assert.ok(answer, "answer request uses the chat system prompt");
  const lastUser = answer.messages.at(-1);
  assert.equal(lastUser.role, "user");
  assert.match(lastUser.content, /^<repository_context>[\s\S]*1\| export class Timer[\s\S]*<\/repository_context>\n\nQuestion: How does the timer tick\?$/);

  requests.length = 0;
  panel.el("chat-input").value = "and where is it called?";
  await panel.fn.handleChat();
  const picker = requests.find(b => b.messages[0].content.startsWith("You choose which source files"));
  assert.match(picker.messages.find(m => m.role === "user").content, /timer\.ts \(1 KB\) — read for the previous answer/);
  const followUp = requests.find(b => b.messages[0].content.startsWith("You are an expert"));
  assert.deepEqual(followUp.messages.slice(1, 3).map(m => m.role), ["user", "assistant"], "the earlier turn is included as history");
});
