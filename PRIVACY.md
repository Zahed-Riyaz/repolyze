# Repolyze privacy policy

_Last updated: 27 October 2026_

Repolyze is a Chrome extension that helps you contribute to GitHub repositories. It has **no server of its own**: everything runs in your browser. The developer collects nothing. There are no accounts, analytics, telemetry, ads or tracking, and your data is never sold or shared.

## What stays on your computer

These are kept in Chrome's local extension storage (`chrome.storage.local`) on your device. They are not synced to your Google account and never reach the developer.

| Data | Why | How long |
|---|---|---|
| Your GitHub token (from **Sign in with GitHub** or pasted) and your GitHub username and avatar | Higher GitHub rate limits; code search | Until you sign out or uninstall |
| Your AI provider, model and API key | Answering questions in **Ask** | Until you change or remove it, or uninstall |
| Chat history, per repository (up to 50 messages) | Showing past answers | Until you click **Clear** or uninstall |
| Your stack profile (languages and topics from your own public repositories and bio) and any edits you make to it | Showing which issues fit your skills | Refreshed daily while signed in; deleted on sign-out (your edits are kept) |
| Copies of GitHub API responses | Saving your GitHub quota | Up to 3 days, size-capped; those read with your token are deleted on sign-out |
| Settings, such as whether the guide card shows on issue pages | Remembering your choices | Until you change them or uninstall |

Uninstalling the extension deletes all of it.

## What is sent, and to whom

Repolyze sends data only to the services it needs, and only when you use them.

- **GitHub** (`api.github.com`, `raw.githubusercontent.com`, `github.com`, `avatars.githubusercontent.com`). Repolyze reads public information about the repository you're viewing: issues, pull requests, files and contributors. Your GitHub token is sent **only** to `api.github.com`, and only so GitHub knows the request is yours. Sign-in uses GitHub's device flow and asks for **no permissions (scopes)**. GitHub's own [privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement) applies to these requests.
- **The AI provider you choose** (Groq, Google Gemini, OpenAI or Anthropic). This happens only when you ask a question in **Ask**. What is sent:
  - your question and recent messages in that chat;
  - excerpts of the repository's files;
  - the text of the issue or pull request you're asking about, if any.

  The request goes straight from your browser to the provider, using your own API key, and that provider's privacy policy applies. Nothing goes to an AI provider when you browse, open an issue or pull request brief, or view the guide card.
- **Ollama** (`localhost:11434`). If you choose Ollama, questions go to a model on your own computer and never leave it.

Repolyze does **not** read your browsing history. It looks at the address of the active tab only to tell which GitHub repository, issue or pull request you're on. On GitHub issue pages it adds a small guide card. It reads the page's address to do that, never your activity on the page, and it never posts, clicks or changes anything on GitHub.

## Private repositories

If your GitHub token can access a private repository, Repolyze can read it the same way as a public one. Its contents are cached locally (deleted on sign-out). They are sent to your AI provider only if you ask about that repository in **Ask**. Choose Ollama if that code must stay on your machine.

## Your control

- **Sign out** in Settings removes your token, your profile and everything read with your token. To revoke the app's access on GitHub, go to GitHub → Settings → Applications → Authorized OAuth Apps.
- **Clear** in Ask deletes a repository's chat history.
- Turn off the guide card on issue pages in Settings.
- Uninstall the extension to delete everything it stored.

## Limited use

Repolyze's use of information follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements. Data is used only to provide the features described above. It is not transferred to anyone except as described here, and it is not used for advertising, for credit decisions or to train AI models by the developer.

## Children

Repolyze is not directed at children under 13.

## Changes

Changes to this policy are published at this address, with a new date at the top. The full history is in the repository's commit log.

## Contact

Questions or concerns: [open an issue](https://github.com/Zahed-Riyaz/repolyze/issues) on the project's GitHub repository.
