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
  for (const [provider, max, model] of [["ollama", 60, "llama3.2"], ["ollama", 120, "llama3.1:8b"], ["groq", 120], ["openai", 250]]) {
    const { panel, requests } = chatPanel({ provider, ai: (body) => (provider === "ollama" ? new Response(JSON.stringify({ message: { content: "[]" }, done: true }) + "\n") : sseReply("[]")) });
    if (model) panel.run(`ollamaModel = ${JSON.stringify(model)}`);
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

test("Ollama's budget follows the model: small local models stay tight, 7B+ get the cloud providers' room", () => {
  const { fn, run } = loadPanel();
  run(`aiProvider = "ollama"`);
  for (const [model, budget] of [["llama3.1:8b", 40000], ["qwen2.5-coder:7b", 40000], ["gpt-oss:20b", 40000],
    ["llama3.2", 10000], ["llama3.2:3b", 10000], ["qwen2.5:1.5b", 10000], ["phi3:mini-4b", 10000], ["gemma3:1b", 10000]]) {
    run(`ollamaModel = ${JSON.stringify(model)}`);
    assert.equal(fn.contextBudget(), budget, model);
  }
  assert.equal(fn.contextBudget("groq"), 14000);
  assert.equal(fn.contextBudget("gemini"), 48000);
});

test("Ollama setup: install, download the chosen model, and start it allowing only Chrome extensions, per OS", () => {
  const { fn } = loadPanel();
  const mac = plain(fn.ollamaSteps("gemma3:12b", "mac"));
  assert.equal(mac.install.cmd, "brew install ollama");
  assert.equal(mac.pull.cmd, "ollama pull gemma3:12b");
  assert.equal(mac.serve.cmd, "OLLAMA_ORIGINS='chrome-extension://*' ollama serve");
  assert.match(mac.serve.note, /quit it from the menu bar first/);
  assert.equal(mac.list.cmd, "ollama list");
  assert.equal(fn.ollamaSteps("x", "linux").install.cmd, "curl -fsSL https://ollama.com/install.sh | sh");
  const win = plain(fn.ollamaSteps("gpt-oss:20b", "windows"));
  assert.equal(win.install.cmd, "winget install Ollama.Ollama");
  assert.equal(win.serve.cmd, "$env:OLLAMA_ORIGINS='chrome-extension://*'; ollama serve");
  for (const os of ["mac", "linux", "windows"]) assert.doesNotMatch(fn.ollamaSteps("m", os).serve.cmd, /ORIGINS='\*'/, "never every website");

  const html = fn.ollamaSetupHtml({ model: "llama3.1:8b", os: "linux", steps: ["install", "pull", "serve"] });
  assert.match(html, /class="ollama-os active" data-os="linux"/);
  assert.match(html, /Install Ollama \(skip if you have it\)[\s\S]*Download llama3\.1:8b \(once\)[\s\S]*data-cmd="ollama pull llama3\.1:8b"[\s\S]*Start Ollama for the extension/);
  assert.doesNotMatch(fn.ollamaSetupHtml({ model: "m", os: "mac", steps: ["serve"] }), /ollama pull|brew install/, "only the steps asked for");
  assert.equal(fn.DEFAULT_OLLAMA_MODEL, "llama3.1:8b");
});

test("the chat's Ollama help shows the steps for the model in use; blocked-by-origin shows only the restart", () => {
  const { fn, run, el } = loadPanel();
  run(`ollamaModel = "qwen2.5-coder:7b"`);
  const made = [];
  run("document").createElement = () => { const e = { className: "", innerHTML: "", listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } }; made.push(e); return e; };
  el("chat-history").appendChild = (c) => c;
  fn.showOllamaGuide("OLLAMA_NOT_RUNNING", "hi");
  assert.match(made[0].innerHTML, /Ollama isn't running[\s\S]*ollama pull qwen2\.5-coder:7b[\s\S]*ollama serve/);
  fn.showOllamaGuide("OLLAMA_CORS", "");
  assert.match(made[1].innerHTML, /blocking the extension[\s\S]*ollama serve/);
  assert.doesNotMatch(made[1].innerHTML, /ollama pull/);
});

// ── Choosing a model ─────────────────────────────────────────────────────────
test("each provider has a default model and a short list, Kimi K2 among Groq's", () => {
  const { fn, run } = loadPanel();
  assert.equal(fn.modelFor("groq"), "llama-3.3-70b-versatile");
  assert.equal(fn.modelFor("anthropic"), "claude-haiku-4-5-20251001");
  assert.equal(fn.modelFor("ollama"), "llama3.1:8b");
  assert.ok(run("MODEL_CHOICES.groq").some(m => m.id === "moonshotai/kimi-k2-instruct" && m.label === "Kimi K2"));
  assert.equal(fn.modelLabel("groq", "moonshotai/kimi-k2-instruct"), "Kimi K2");
  assert.equal(fn.modelLabel("groq", "some/new-model"), "some/new-model", "an ID not in the list shows as itself");
});

test("the chosen model is what every provider is asked for", async () => {
  const { fn, run } = loadPanel();
  run(`aiModels = { groq: "moonshotai/kimi-k2-instruct", openai: "gpt-4.1-mini", anthropic: "claude-sonnet-5" }; ollamaModel = "qwen2.5-coder:7b"`);
  assert.equal(fn.providerBody("groq", contents, {}).model, "moonshotai/kimi-k2-instruct");
  assert.equal(fn.providerBody("openai", contents, {}).model, "gpt-4.1-mini");
  assert.equal(fn.providerBody("anthropic", contents, {}).model, "claude-sonnet-5");
  assert.equal(fn.providerBody("ollama", contents, {}).model, "qwen2.5-coder:7b");

  let url = "";
  const gem = loadPanel({ fetch: async (u) => { url = u; return new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'); } });
  gem.run(`aiProvider = "gemini"; aiApiKey = "AIza-test"; aiModels = { gemini: "gemini-2.5-pro" }`);
  await gem.fn.callAIStreaming(contents, () => {}, {});
  assert.match(url, /\/models\/gemini-2\.5-pro:streamGenerateContent/);
});

test("Settings: pick a model from the list or any ID, and changing only the model keeps the saved key", async () => {
  const panel = loadPanel({ fetch: async () => new Response("{}") });
  panel.run(`aiProvider = "groq"; aiApiKey = "gsk_saved"`);
  panel.fn.initSettingsTab();
  const select = panel.el("sp-model");
  assert.match(select.innerHTML, /<option value="llama-3\.3-70b-versatile">Llama 3\.3 70B \(default\)<\/option>[\s\S]*value="moonshotai\/kimi-k2-instruct">Kimi K2<[\s\S]*value="__other">Other…/);
  assert.equal(select.value, "llama-3.3-70b-versatile");
  assert.equal(panel.el("sp-model-custom").hidden, true);

  select.value = "moonshotai/kimi-k2-instruct";
  select.dispatch("change", { target: select });
  assert.match(panel.el("sp-model-note").textContent, /strong at code/);
  panel.el("sp-api-key").value = ""; // not re-typed
  await panel.el("sp-save-btn").listeners.click[0]();
  assert.equal(panel.chrome.storage.local.data.aiModels.groq, "moonshotai/kimi-k2-instruct");
  assert.equal(panel.chrome.storage.local.data.aiApiKey, "gsk_saved", "the saved key is kept");
  assert.match(panel.el("sp-active-badge").textContent, /Active: Groq — Kimi K2/);

  select.value = "__other";
  select.dispatch("change", { target: select });
  assert.equal(panel.el("sp-model-custom").hidden, false);
  panel.el("sp-model-custom").value = "deepseek-r1-distill-llama-70b";
  await panel.el("sp-save-btn").listeners.click[0]();
  assert.equal(panel.run("modelFor('groq')"), "deepseek-r1-distill-llama-70b");
});
