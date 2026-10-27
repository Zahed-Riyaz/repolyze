# Repolyze — contributor guide for GitHub

A Chrome side panel for contributing to a repository you've never seen: find an issue that's actually free, see where to start and who to ask, follow pull requests, and ask questions answered from the repo's own code, with `path:line` citations.

No server and no account needed. It uses the GitHub API and, for questions, your own AI key.

## What it does

- **Contribute.** Open issues and pull requests, with **Good first** and **Help wanted** across the whole repo. Each issue gets a brief:
  - is it free (assigned, open PR, claimed in the comments…)?
  - the files to start with and who owns them;
  - how to set up, what CI runs, and a PR in the repo's own format.

  Each pull request gets its status and what's still open. None of this uses AI.
- **Repo.** A contributor-friendliness score with the evidence behind it, active maintainers, languages and tools.
- **Ask.** Questions about the repo, or about one issue or PR, answered from the files it reads. Every citation links to the line on GitHub and is checked against what was actually read.
- **On GitHub.** A small card on issue pages shows the same verdict, files and owners.

## Install

From source, until it's on the Chrome Web Store:

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Open any GitHub repository and click the Repolyze icon.

## Set up

- **GitHub (optional).** Use **Sign in with GitHub** in Settings (no permissions asked). This raises the limit from 60 to 5,000 requests an hour and lets briefs search the code. Everything except Ask works signed out.
- **AI (for Ask).** Pick a provider and paste a key:

| Provider | Key | Notes |
|---|---|---|
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | Free tier; a good place to start |
| Gemini | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) | Free tier |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | Paid |
| Anthropic | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | Paid |
| Ollama | none | Runs on your computer; Settings shows the setup commands for your OS |

## Privacy

Keys, chat history and cached GitHub data stay in your browser. Repo content goes only to the AI provider you choose, and only when you ask a question. See [PRIVACY.md](PRIVACY.md).

## Development

Plain JavaScript, no build step. Reload the extension after editing.

```bash
npm test        # the test suite (Node 22+), also run in CI
npm run check   # syntax check
npm run eval    # retrieval eval: does Ask find the code an issue needs?
```

How it's built (architecture, API budgets, retrieval, conventions) is in [CLAUDE.md](CLAUDE.md).
