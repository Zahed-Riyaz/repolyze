// ── Ollama setup commands (shared by the side panel and the options page) ────
// The terminal steps to run a local model for the extension, for the model the
// user picked and their OS:
//   1. install Ollama            (skip if you have it)
//   2. download the model        ollama pull <model>
//   3. start it for the extension  OLLAMA_ORIGINS='chrome-extension://*' ollama serve
// Only Chrome extensions are allowed as origins — "*" would let any website you
// visit use your local model. No DOM or panel globals here: the caller wires
// the Copy buttons and OS tabs (data-cmd, data-os).

const OLLAMA_ORIGINS = "chrome-extension://*";
const OLLAMA_OS_NAMES = { mac: "macOS", linux: "Linux", windows: "Windows" };

// The OS this browser runs on → "mac" | "windows" | "linux"
function detectOS() {
  const p = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "").toLowerCase();
  return p.includes("win") ? "windows" : p.includes("mac") ? "mac" : "linux";
}

// The steps for a model on an OS → { install, pull, serve, list }, each { title, cmd, note? }
function ollamaSteps(model, os = detectOS()) {
  const install = {
    mac: { cmd: "brew install ollama", note: "Or download the app from ollama.com." },
    linux: { cmd: "curl -fsSL https://ollama.com/install.sh | sh" },
    windows: { cmd: "winget install Ollama.Ollama", note: "Or download the installer from ollama.com." },
  }[os];
  const serve = os === "windows"
    ? { cmd: `$env:OLLAMA_ORIGINS='${OLLAMA_ORIGINS}'; ollama serve`, note: "If Ollama is already running in the system tray, quit it first. Keep this window open while you use the extension." }
    : { cmd: `OLLAMA_ORIGINS='${OLLAMA_ORIGINS}' ollama serve`, note: `${os === "mac" ? "If the Ollama app is running, quit it from the menu bar first. " : ""}Keep this terminal open while you use the extension.` };
  return {
    install: { title: "Install Ollama (skip if you have it)", ...install },
    pull: { title: `Download ${model} (once)`, cmd: `ollama pull ${model}` },
    serve: { title: "Start Ollama for the extension", ...serve },
    list: { title: "Check which models you have", cmd: "ollama list" },
  };
}

const ollamaEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The steps as HTML: OS tabs, then numbered steps with a Copy button each
function ollamaSetupHtml({ model, os = detectOS(), steps = ["install", "pull", "serve"] }) {
  const all = ollamaSteps(model, os);
  const tabs = Object.entries(OLLAMA_OS_NAMES).map(([key, name]) =>
    `<button type="button" class="ollama-os${key === os ? " active" : ""}" data-os="${key}" aria-pressed="${key === os}">${name}</button>`).join("");
  return `
    <div class="ollama-setup">
      <div class="ollama-os-tabs" role="group" aria-label="Operating system">${tabs}</div>
      <ol class="ollama-steps">${steps.map(k => all[k]).map(step => `
        <li>
          <span class="ollama-step-title">${ollamaEsc(step.title)}</span>
          <span class="ollama-cmd"><code>${ollamaEsc(step.cmd)}</code><button type="button" class="copy-btn" data-cmd="${ollamaEsc(step.cmd)}">Copy</button></span>
          ${step.note ? `<span class="ollama-step-note">${ollamaEsc(step.note)}</span>` : ""}
        </li>`).join("")}
      </ol>
    </div>`;
}

// Click handling for a container of ollamaSetupHtml: Copy buttons, and OS tabs
// (calls rerender(os) so the caller redraws with its current model)
function handleOllamaSetupClick(e, rerender) {
  const copy = e.target.closest?.(".copy-btn[data-cmd]");
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.cmd).then(() => {
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });
    return true;
  }
  const tab = e.target.closest?.(".ollama-os[data-os]");
  if (tab) { rerender(tab.dataset.os); return true; }
  return false;
}
