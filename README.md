# GitHub Repo Tools

An Obsidian plugin that puts a GitHub repository panel in your sidebar — monitor staleness, manage branches, stage and commit files, and track pull requests without leaving Obsidian.

> **Desktop only.** Requires git to be installed and a local clone of the repository you want to monitor.

---

## Features

### Local repo status
- Shows your current branch and a dropdown to switch branches
- Detects uncommitted changes with an expandable file list
- Shows how many commits you are behind the remote with a one-click Pull button
- Ribbon icon badge turns red when your local repo is behind

### Git operations
Fetch, Pull, Push, and Create Branch from the action bar. All operations run against the local clone you configure.

### Commit modal
Stage individual files by checkbox, write a commit message, and commit (or commit + push) in one step.

### PR dashboard
- **My PRs** — open PRs you authored
- **Awaiting My Review** — PRs where you are a requested reviewer
- **All Open PRs** — collapsible list of everyone else's PRs
- New activity badge on PRs that have been updated since you last opened them
- One-click to open any PR in the browser

### Create PR workflow
Smart PR creation from the sidebar:
1. If you have uncommitted changes, prompts you to commit first
2. Pushes the branch if it hasn't been pushed yet
3. Opens a modal pre-filled with a title derived from your branch name

### Status bar
Compact summary in the Obsidian status bar: sync status, uncommitted file count, open PR counts, and review request count.

---

## Setup

1. Install the plugin and enable it.
2. Open **Settings → GitHub Repo Tools**.
3. Set **Local repo path** — the absolute path to your local git clone (or use the Browse button).
4. Set your **GitHub personal access token** — a classic PAT with `repo` scope is sufficient. The plugin will auto-detect the repo owner/name and your GitHub username from the token and remote URL.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| Local repo path | — | Absolute path to your local git clone |
| GitHub personal access token | — | Classic PAT with `repo` scope |
| Staleness check | On | Check if local repo is behind remote |
| PR dashboard | On | Show open PRs in the sidebar |
| PR activity alerts | On | Highlight PRs with new activity |
| Review requests | On | Show PRs where you are a requested reviewer |
| Status bar item | On | Show compact summary in the status bar |
| Auto-open sidebar on startup | On | Open the panel when Obsidian launches |
| Show draft PRs | On | Include draft PRs in the list |
| Poll interval | 15 min | How often to refresh automatically |
| Track branch | (current branch) | Remote branch to compare against for staleness |

---

## Requirements

- Obsidian 0.15.0 or later
- macOS, Windows, or Linux desktop (not mobile)
- git installed and available on the system PATH
- A GitHub personal access token with `repo` scope

---

## License

MIT
