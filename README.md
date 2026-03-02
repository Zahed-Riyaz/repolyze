# GitHub Repo Analyzer & RAG Chat

A Chrome extension that helps you analyze GitHub repositories and chat with them using Gemini AI.

## Features

- **Unassigned Issues**: Lists popular issues that are not yet assigned, helping you find contribution opportunities.
- **Tech Stack**: Automatically identifies the languages and technologies used in the repo.
- **Maintainers**: Lists the top contributors and likely maintainers of the project.
- **RAG-powered Chat**: Ask questions about the repository. The bot uses the repo's README and file tree as context (RAG) to provide accurate answers.

## Installation

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable "Developer mode" in the top right corner.
3. Click "Load unpacked".
4. Select the `github-repo-analyzer` directory.

## Setup

1. Open the side panel by clicking the extension icon while on a GitHub repository page.
2. Enter your **GitHub Personal Access Token** (optional but recommended to avoid rate limits).
3. Enter your **Gemini API Key** (required for the chatbot).
4. Save the keys and you're ready to go!

## Tech Stack

- **Manifest V3**
- **Chrome Side Panel API**
- **GitHub REST API**
- **Gemini 1.5 Flash API**
