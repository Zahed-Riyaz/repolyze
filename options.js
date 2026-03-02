const PROVIDER_META = {
  groq: {
    label: "Groq API Key",
    placeholder: "gsk_xxxxxxxxxxxxxxxxxxxx",
    helpHtml: 'Get a free key at <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>. ' +
              'Uses <strong>Llama 3.3 70B</strong> — 14,400 req/day free.',
  },
  gemini: {
    label: "Gemini API Key",
    placeholder: "AIzaSy...",
    helpHtml: 'Get a free key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com</a>. ' +
              'Free tier: 15 req/min, 1,500 req/day.',
  },
  ollama: {
    label: null,
    placeholder: null,
    helpHtml: 'Download Ollama at <a href="https://ollama.com" target="_blank">ollama.com</a>. ' +
              'Run <code style="background:#0d1117;padding:1px 4px;border-radius:3px">ollama serve</code> and pull any model.',
  },
};

let selectedProvider = "groq";

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get(["aiProvider", "aiApiKey", "ollamaModel", "githubToken"]);

  selectedProvider = stored.aiProvider || "groq";
  const savedKey = stored.aiApiKey || "";
  const savedModel = stored.ollamaModel || "";

  // Apply saved provider
  selectProvider(selectedProvider, false);

  // Populate masked key
  if (savedKey) {
    document.getElementById("ai-key").placeholder = maskKey(savedKey);
  }

  // Populate ollama model
  if (savedModel) {
    document.getElementById("ollama-model").value = savedModel;
  }

  // Populate GitHub token
  if (stored.githubToken) {
    document.getElementById("gh-token").placeholder = maskKey(stored.githubToken);
  }

  // Update badge
  updateBadge(selectedProvider, savedKey);

  // Provider card clicks
  document.querySelectorAll(".provider-card").forEach(card => {
    card.addEventListener("click", () => {
      selectedProvider = card.dataset.provider;
      selectProvider(selectedProvider, true);
    });
  });

  // Show/Hide toggles
  document.querySelectorAll(".toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.target);
      if (input.type === "password") {
        input.type = "text";
        btn.textContent = "Hide";
      } else {
        input.type = "password";
        btn.textContent = "Show";
      }
    });
  });

  // Save AI settings
  document.getElementById("save-btn").addEventListener("click", async () => {
    const toSave = { aiProvider: selectedProvider };

    if (selectedProvider === "ollama") {
      const model = document.getElementById("ollama-model").value.trim() || "llama3.2";
      toSave.ollamaModel = model;
      toSave.aiApiKey = "";
    } else {
      const key = document.getElementById("ai-key").value.trim();
      if (!key) {
        showStatus("status-msg", "Enter an API key to save.", true);
        return;
      }
      toSave.aiApiKey = key;
      document.getElementById("ai-key").value = "";
      document.getElementById("ai-key").placeholder = maskKey(key);
    }

    await chrome.storage.local.set(toSave);
    updateBadge(selectedProvider, toSave.aiApiKey);
    showStatus("status-msg", "Settings saved!");
  });

  // Clear AI settings
  document.getElementById("clear-ai-btn").addEventListener("click", async () => {
    await chrome.storage.local.remove(["aiProvider", "aiApiKey", "ollamaModel"]);
    document.getElementById("ai-key").value = "";
    document.getElementById("ai-key").placeholder = PROVIDER_META[selectedProvider]?.placeholder || "";
    document.getElementById("ollama-model").value = "";
    selectedProvider = "groq";
    selectProvider("groq", false);
    updateBadge("groq", "");
    showStatus("status-msg", "AI settings cleared.");
  });

  // Save GitHub token
  document.getElementById("save-gh-btn").addEventListener("click", async () => {
    const token = document.getElementById("gh-token").value.trim();
    if (!token) { showStatus("gh-status-msg", "Enter a token to save.", true); return; }
    await chrome.storage.local.set({ githubToken: token });
    document.getElementById("gh-token").value = "";
    document.getElementById("gh-token").placeholder = maskKey(token);
    showStatus("gh-status-msg", "Token saved!");
  });

  // Clear GitHub token
  document.getElementById("clear-gh-btn").addEventListener("click", async () => {
    await chrome.storage.local.remove(["githubToken"]);
    document.getElementById("gh-token").value = "";
    document.getElementById("gh-token").placeholder = "ghp_xxxxxxxxxxxxxxxxxxxx";
    showStatus("gh-status-msg", "Token cleared.");
  });
});

function selectProvider(provider, clearKey) {
  // Update card active state
  document.querySelectorAll(".provider-card").forEach(c => {
    c.classList.toggle("active", c.dataset.provider === provider);
  });

  const meta = PROVIDER_META[provider];
  const keySection = document.getElementById("key-section");
  const ollamaSection = document.getElementById("ollama-section");
  const helpLinks = document.getElementById("help-links");

  if (provider === "ollama") {
    keySection.style.display = "none";
    ollamaSection.style.display = "block";
  } else {
    keySection.style.display = "block";
    ollamaSection.style.display = "none";
    document.getElementById("key-label").textContent = meta.label;
    if (clearKey) {
      document.getElementById("ai-key").value = "";
      document.getElementById("ai-key").placeholder = meta.placeholder;
    } else {
      // Only update placeholder if field is empty (don't overwrite masked key)
      if (!document.getElementById("ai-key").value) {
        document.getElementById("ai-key").placeholder = meta.placeholder;
      }
    }
  }

  helpLinks.innerHTML = meta.helpHtml;
}

function updateBadge(provider, key) {
  const badge = document.getElementById("current-provider-badge");
  const labels = { groq: "Groq (Llama 3.3)", gemini: "Gemini 1.5 Flash", ollama: "Ollama (local)" };
  const hasKey = provider === "ollama" || !!key;
  if (hasKey) {
    badge.textContent = `Active: ${labels[provider] || provider}`;
    badge.style.color = "#3fb950";
  } else {
    badge.textContent = "Not configured — select a provider and save a key.";
    badge.style.color = "#f0883e";
  }
}

function maskKey(key) {
  if (!key || key.length < 8) return "****";
  return key.substring(0, 6) + "****" + key.substring(key.length - 2);
}

function showStatus(elementId, msg, isError = false) {
  const el = document.getElementById(elementId);
  el.textContent = msg;
  el.className = isError ? "error" : "";
  setTimeout(() => { el.textContent = ""; }, 3000);
}
