import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  requestUrl,
  setIcon,
} from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const VIEW_TYPE = "github-repo-sidebar";

// ── Settings ────────────────────────────────────────────────────────────────

interface Settings {
  repoPath: string;
  githubToken: string;
  repoOwner: string;
  repoName: string;
  githubUsername: string;
  enableStalenessCheck: boolean;
  enablePRDashboard: boolean;
  enablePRActivityAlerts: boolean;
  enableReviewRequests: boolean;
  showStatusBar: boolean;
  autoOpenSidebar: boolean;
  showDraftPRs: boolean;
  pollIntervalMinutes: number;
  trackBranch: string;
  seenPRActivity: Record<number, string>;
}

const DEFAULT_SETTINGS: Settings = {
  repoPath: "",
  githubToken: "",
  repoOwner: "",
  repoName: "",
  githubUsername: "",
  enableStalenessCheck: true,
  enablePRDashboard: true,
  enablePRActivityAlerts: true,
  enableReviewRequests: true,
  showStatusBar: true,
  autoOpenSidebar: true,
  showDraftPRs: true,
  pollIntervalMinutes: 15,
  trackBranch: "",
  seenPRActivity: {},
};

// ── Git service ──────────────────────────────────────────────────────────────

interface ChangedFile {
  status: string;
  path: string;
}

interface GitStatus {
  branch: string;
  localBranches: string[];
  hasUncommittedChanges: boolean;
  changedFiles: ChangedFile[];
  commitsBehind: number;
  comparingTo: string;
  incomingFiles: string[];
}

// ── GitHub API types ─────────────────────────────────────────────────────────

interface GitHubUser {
  login: string;
}

interface GitHubPRItem {
  number: number;
  title: string;
  html_url: string;
  user: GitHubUser;
  updated_at: string;
  draft: boolean;
  requested_reviewers: GitHubUser[];
}

interface GitHubNewPR {
  html_url: string;
}

interface GitHubApiError {
  message?: string;
}

// ── Electron types ───────────────────────────────────────────────────────────

interface ElectronOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface ElectronDialog {
  showOpenDialog(options: { properties: string[] }): Promise<ElectronOpenDialogResult>;
}

interface ElectronModule {
  remote?: { dialog: ElectronDialog };
}

// ── Error helper ─────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Git helpers ──────────────────────────────────────────────────────────────

async function gitExec(repoPath: string, args: string): Promise<string> {
  const { stdout } = await execAsync(`git -C "${repoPath}" ${args}`);
  return stdout.trimEnd();
}

function parseChangedFiles(porcelain: string): ChangedFile[] {
  if (!porcelain) return [];
  return porcelain
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({
      status: l.substring(0, 2).trim() || "?",
      path: l.substring(3),
    }));
}

function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const ssh = url.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = url.match(/https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

async function detectRepoIdentity(repoPath: string): Promise<{ owner: string; repo: string } | null> {
  const url = await gitExec(repoPath, "remote get-url origin");
  return parseGitHubRemote(url);
}

async function fetchGitStatus(repoPath: string, trackBranch: string): Promise<GitStatus> {
  try { await gitExec(repoPath, "fetch origin"); } catch { /* non-fatal */ }

  const branch = await gitExec(repoPath, "branch --show-current");
  const comparingTo = trackBranch || branch;

  const [porcelain, branchesRaw] = await Promise.all([
    gitExec(repoPath, "status --porcelain"),
    gitExec(repoPath, "branch"),
  ]);

  const changedFiles = parseChangedFiles(porcelain);
  const localBranches = branchesRaw
    .split("\n")
    .map((b) => b.replace(/^\*\s*/, "").trim())
    .filter(Boolean);

  let commitsBehind = 0;
  let incomingFiles: string[] = [];
  try {
    const [behindStr, incomingRaw] = await Promise.all([
      gitExec(repoPath, `rev-list --count HEAD..origin/${comparingTo}`),
      gitExec(repoPath, `diff --name-only HEAD..origin/${comparingTo}`),
    ]);
    commitsBehind = parseInt(behindStr, 10) || 0;
    incomingFiles = incomingRaw.split("\n").map((f) => f.trim()).filter(Boolean);
  } catch { /* non-fatal */ }

  return {
    branch,
    localBranches,
    hasUncommittedChanges: changedFiles.length > 0,
    changedFiles,
    commitsBehind,
    comparingTo,
    incomingFiles,
  };
}

async function runGitPull(repoPath: string): Promise<void> {
  await gitExec(repoPath, "pull");
}

async function runGitStash(repoPath: string): Promise<boolean> {
  const out = await gitExec(repoPath, "stash push -u -m 'obsidian-github-tools: auto-stash'");
  return !out.includes("No local changes to save");
}

async function runGitStashPop(repoPath: string): Promise<void> {
  await gitExec(repoPath, "stash pop");
}

async function runGitCheckout(repoPath: string, branch: string): Promise<void> {
  await gitExec(repoPath, `checkout "${branch}"`);
}

async function runGitCreateBranch(repoPath: string, name: string, from: string | null): Promise<void> {
  const args = from ? `checkout -b "${name}" "${from}"` : `checkout -b "${name}"`;
  await gitExec(repoPath, args);
}

function detectDefaultBranch(branches: string[]): string {
  return branches.find((b) => b === "main")
    ?? branches.find((b) => b === "master")
    ?? branches[0]
    ?? "main";
}

async function runGitAdd(repoPath: string, files: string[]): Promise<void> {
  const quoted = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
  await gitExec(repoPath, `add -- ${quoted}`);
}

async function runGitCommit(repoPath: string, message: string): Promise<void> {
  const escaped = message.replace(/'/g, "'\\''");
  await gitExec(repoPath, `commit -m '${escaped}'`);
}

async function runGitPush(repoPath: string, branch: string, setUpstream: boolean): Promise<void> {
  await gitExec(repoPath, setUpstream ? `push -u origin "${branch}"` : `push`);
}

async function isBranchPushed(repoPath: string, branch: string): Promise<boolean> {
  try {
    await gitExec(repoPath, `rev-parse --verify "origin/${branch}"`);
    return true;
  } catch {
    return false;
  }
}

function branchToPRTitle(branch: string): string {
  return branch
    .replace(/^(feature|fix|chore|docs|test|refactor|style|perf)\//i, "")
    .replace(/[-_/]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ── GitHub service ───────────────────────────────────────────────────────────

interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  draft: boolean;
  requestedReviewers: string[];
}

async function ghFetch<T>(url: string, token: string): Promise<T> {
  const res = await requestUrl({
    url,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  return res.json as T;
}

async function detectGitHubUsername(token: string): Promise<string> {
  const data = await ghFetch<GitHubUser>("https://api.github.com/user", token);
  return data.login;
}

async function fetchOpenPRs(owner: string, repo: string, token: string): Promise<PullRequest[]> {
  const data = await ghFetch<GitHubPRItem[]>(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50`,
    token
  );
  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user.login,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
    requestedReviewers: (pr.requested_reviewers ?? []).map((r) => r.login),
  }));
}

async function createGitHubPR(
  owner: string, repo: string, token: string,
  head: string, base: string, title: string, body: string
): Promise<string> {
  const res = await requestUrl({
    url: `https://api.github.com/repos/${owner}/${repo}/pulls`,
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, head, base }),
    throw: false,
  });
  if (res.status < 200 || res.status >= 300) {
    const err = res.json as GitHubApiError;
    throw new Error(err.message ?? `GitHub API error: ${res.status}`);
  }
  const data = res.json as GitHubNewPR;
  return data.html_url;
}

// ── Electron folder picker ───────────────────────────────────────────────────

async function showFolderPicker(): Promise<string | null> {
  try {
    const requireFn = (window as Window & { require?: (m: string) => ElectronModule }).require;
    if (!requireFn) return null;
    const electron = requireFn("electron");
    const dialog = electron.remote?.dialog;
    if (!dialog) return null;
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  } catch (e) {
    console.error("Folder picker unavailable:", e);
  }
  return null;
}

// ── Sidebar view ─────────────────────────────────────────────────────────────

class GitHubRepoView extends ItemView {
  plugin: GitHubWikiPlugin;
  gitStatus: GitStatus | null = null;
  prs: PullRequest[] = [];
  private loading = false;
  private errorMsg: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHubWikiPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "GitHub Repo"; }
  getIcon(): string { return "github"; }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.errorMsg = null;
    this.render();

    try {
      const s = this.plugin.settings;

      if (s.enableStalenessCheck && s.repoPath) {
        this.gitStatus = await fetchGitStatus(s.repoPath, s.trackBranch);
      } else {
        this.gitStatus = null;
      }

      if (s.enablePRDashboard && s.githubToken && s.repoOwner && s.repoName) {
        this.prs = await fetchOpenPRs(s.repoOwner, s.repoName, s.githubToken);
        if (s.enablePRActivityAlerts) this.plugin.initSeenActivity(this.prs);
      } else {
        this.prs = [];
      }
    } catch (e: unknown) {
      this.errorMsg = errorMessage(e);
    } finally {
      this.loading = false;
      this.render();
      this.plugin.updateStatusBar(this.gitStatus, this.prs);
      this.plugin.updateRibbonIcon(this.gitStatus?.commitsBehind ?? 0);
    }
  }

  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("gwt-sidebar");

    const header = root.createDiv("gwt-header");
    header.createEl("h4", { text: "GitHub Repo" });
    const refreshBtn = header.createEl("button", { cls: "gwt-btn-icon", text: "↻" });
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => { void this.refresh(); });

    if (this.loading) {
      root.createDiv("gwt-muted").setText("Loading…");
      return;
    }

    if (this.errorMsg) {
      root.createDiv("gwt-error").setText(this.errorMsg);
    }

    const s = this.plugin.settings;
    if (s.enableStalenessCheck) this.renderGitStatus(root);
    if (s.enablePRDashboard) this.renderPRs(root);
  }

  private renderGitStatus(root: HTMLElement): void {
    if (!this.gitStatus) {
      if (!this.plugin.settings.repoPath) {
        root.createDiv("gwt-muted").setText("Set repo path in settings.");
      }
      return;
    }

    const { branch, localBranches, hasUncommittedChanges, changedFiles, commitsBehind, comparingTo } =
      this.gitStatus;

    const section = root.createDiv("gwt-section");
    section.createEl("h5", { text: "Local Repo" });

    const actionBar = section.createDiv("gwt-action-bar");
    const actions: Array<{ icon: string; label: string; handler: () => void }> = [
      { icon: "rotate-cw",        label: "Fetch",      handler: () => { void this.handleFetch(); } },
      { icon: "download",         label: "Pull",       handler: () => { void this.handlePull(); } },
      { icon: "upload",           label: "Push",       handler: () => { void this.handlePush(); } },
      { icon: "git-pull-request", label: "Create PR",  handler: () => { void this.handleCreatePR(); } },
    ];
    for (const a of actions) {
      const btn = actionBar.createEl("button", { cls: "gwt-action-btn" });
      setIcon(btn, a.icon);
      btn.setAttribute("aria-label", a.label);
      btn.createSpan({ cls: "gwt-action-label", text: a.label });
      btn.addEventListener("click", a.handler);
    }

    const branchRow = section.createDiv("gwt-branch-row");
    branchRow.createSpan({ cls: "gwt-label", text: "Branch" });
    const select = branchRow.createEl("select", { cls: "gwt-branch-select" });
    localBranches.forEach((b) => {
      const opt = select.createEl("option", { text: b, value: b });
      if (b === branch) opt.selected = true;
    });
    select.addEventListener("change", () => { void this.handleBranchSwitch(select.value, select, branch); });

    const newBranchRow = section.createDiv("gwt-new-branch-row");
    const newBtn = newBranchRow.createEl("button", { cls: "gwt-btn gwt-btn-sm", text: "+ New branch" });
    newBtn.addEventListener("click", () => {
      new NewBranchModal(this.app, branch, null, localBranches, async (name, from) => {
        await this.handleCreateBranch(name, from);
      }).open();
    });
    const fromBtn = newBranchRow.createEl("button", { cls: "gwt-btn gwt-btn-sm", text: "+ New branch from…" });
    fromBtn.addEventListener("click", () => {
      const defaultSource = detectDefaultBranch(localBranches);
      new NewBranchModal(this.app, branch, defaultSource, localBranches, async (name, from) => {
        await this.handleCreateBranch(name, from);
      }).open();
    });

    if (hasUncommittedChanges) {
      const details = section.createEl("details", { cls: "gwt-files-details" });
      const summary = details.createEl("summary", { cls: "gwt-files-summary gwt-warning" });
      summary.createSpan({ text: `⚠ ${changedFiles.length} uncommitted change${changedFiles.length !== 1 ? "s" : ""}` });
      const commitBtn = summary.createEl("button", { cls: "gwt-btn gwt-btn-sm gwt-commit-inline-btn", text: "Commit…" });
      commitBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.handleCommit(changedFiles);
      });

      const list = details.createDiv("gwt-files-list");
      changedFiles.forEach((f) => {
        const row = list.createDiv("gwt-file-row");
        row.createSpan({ cls: `gwt-file-status gwt-status-${f.status.replace("?", "untracked")}`, text: f.status });
        row.createSpan({ cls: "gwt-file-path", text: f.path });
      });
    }

    if (commitsBehind > 0) {
      const behindRow = section.createDiv("gwt-behind-row");
      behindRow.createSpan({
        cls: "gwt-behind-label",
        text: `⬇ ${commitsBehind} commit${commitsBehind !== 1 ? "s" : ""} behind origin/${comparingTo}`,
      });
      const pullBtn = behindRow.createEl("button", { cls: "gwt-btn gwt-btn-pull", text: "Pull" });
      pullBtn.addEventListener("click", () => { void this.handlePull(); });
    } else {
      section.createDiv("gwt-row gwt-ok").setText(`✓ Up to date with origin/${comparingTo}`);
    }
  }

  private async handleBranchSwitch(
    newBranch: string,
    select: HTMLSelectElement,
    prevBranch: string
  ): Promise<void> {
    if (newBranch === prevBranch) return;
    const { repoPath } = this.plugin.settings;

    const stashed = this.gitStatus?.hasUncommittedChanges
      ? await runGitStash(repoPath)
      : false;

    try {
      await runGitCheckout(repoPath, newBranch);
    } catch (e: unknown) {
      if (stashed) {
        try { await runGitStashPop(repoPath); } catch { /* best-effort */ }
      }
      new Notice(`Could not switch branch: ${errorMessage(e)}`, 8000);
      Array.from(select.options).forEach((opt) => {
        opt.selected = opt.value === prevBranch;
      });
      return;
    }

    if (stashed) {
      try {
        await runGitStashPop(repoPath);
        new Notice(`Switched to ${newBranch} and re-applied local changes.`);
      } catch (e: unknown) {
        new Notice(
          `Switched to ${newBranch}. Local changes are in the stash — resolve conflicts and run \`git stash pop\` manually.`,
          12000
        );
      }
    } else {
      new Notice(`Switched to branch: ${newBranch}`);
    }

    await this.refresh();
  }

  private async handleCreateBranch(name: string, from: string | null): Promise<void> {
    try {
      await runGitCreateBranch(this.plugin.settings.repoPath, name, from);
      new Notice(`Created and switched to branch: ${name}`);
      await this.refresh();
    } catch (e: unknown) {
      new Notice(`Failed to create branch: ${errorMessage(e)}`, 8000);
    }
  }

  private async handleFetch(): Promise<void> {
    try {
      await gitExec(this.plugin.settings.repoPath, "fetch origin");
      new Notice("Fetched.");
      await this.refresh();
    } catch (e: unknown) {
      new Notice(`Fetch failed: ${errorMessage(e)}`, 6000);
    }
  }

  private async handlePush(): Promise<void> {
    const { repoPath } = this.plugin.settings;
    const branch = this.gitStatus?.branch;
    if (!branch) return;
    try {
      const pushed = await isBranchPushed(repoPath, branch);
      await runGitPush(repoPath, branch, !pushed);
      new Notice("Pushed.");
      await this.refresh();
    } catch (e: unknown) {
      new Notice(`Push failed: ${errorMessage(e)}`, 8000);
    }
  }

  private handleCommit(changedFiles: ChangedFile[]): void {
    const { repoPath } = this.plugin.settings;
    const branch = this.gitStatus?.branch ?? "";
    new CommitModal(this.app, changedFiles, async (files, message, push) => {
      try {
        await runGitAdd(repoPath, files);
        await runGitCommit(repoPath, message);
        if (push) {
          const pushed = await isBranchPushed(repoPath, branch);
          await runGitPush(repoPath, branch, !pushed);
          new Notice("Committed and pushed.");
        } else {
          new Notice("Committed.");
        }
        await this.refresh();
      } catch (e: unknown) {
        new Notice(`Commit failed: ${errorMessage(e)}`, 8000);
      }
    }).open();
  }

  private async handleCreatePR(): Promise<void> {
    const { repoPath, repoOwner, repoName, githubToken } = this.plugin.settings;
    const branch = this.gitStatus?.branch;
    const localBranches = this.gitStatus?.localBranches ?? [];

    if (!branch || !repoOwner || !repoName || !githubToken) {
      new Notice("Configure GitHub settings to create a PR.", 5000);
      return;
    }

    if (this.gitStatus?.hasUncommittedChanges) {
      new CommitModal(this.app, this.gitStatus.changedFiles, async (files, message, push) => {
        try {
          await runGitAdd(repoPath, files);
          await runGitCommit(repoPath, message);
          if (push) {
            const pushed = await isBranchPushed(repoPath, branch);
            await runGitPush(repoPath, branch, !pushed);
          }
          await this.refresh();
          await this.proceedWithPR(branch, localBranches);
        } catch (e: unknown) {
          new Notice(`Commit failed: ${errorMessage(e)}`, 8000);
        }
      }).open();
      return;
    }

    await this.proceedWithPR(branch, localBranches);
  }

  private async proceedWithPR(branch: string, localBranches: string[]): Promise<void> {
    const { repoPath, repoOwner, repoName, githubToken } = this.plugin.settings;

    const pushed = await isBranchPushed(repoPath, branch);
    if (!pushed) {
      try {
        new Notice("Branch not yet on remote. Pushing…");
        await runGitPush(repoPath, branch, true);
        new Notice("Pushed.");
      } catch (e: unknown) {
        new Notice(`Push failed: ${errorMessage(e)}`, 8000);
        return;
      }
    }

    new CreatePRModal(this.app, branch, localBranches, async (title, body, base) => {
      try {
        const url = await createGitHubPR(repoOwner, repoName, githubToken, branch, base, title, body);
        window.open(url, "_blank");
        new Notice("PR created.");
        await this.refresh();
      } catch (e: unknown) {
        new Notice(`Failed to create PR: ${errorMessage(e)}`, 8000);
      }
    }).open();
  }

  private renderPRs(root: HTMLElement): void {
    const s = this.plugin.settings;
    if (!s.githubToken || !s.repoOwner || !s.repoName) {
      root.createDiv("gwt-muted").setText("Add a GitHub token in settings to see PRs.");
      return;
    }

    const visible = s.showDraftPRs ? this.prs : this.prs.filter((pr) => !pr.draft);
    const myPRs = visible.filter((pr) => pr.author === s.githubUsername);
    const reviewRequests = s.enableReviewRequests
      ? visible.filter(
          (pr) =>
            pr.author !== s.githubUsername &&
            pr.requestedReviewers.includes(s.githubUsername)
        )
      : [];
    const otherPRs = visible.filter(
      (pr) =>
        pr.author !== s.githubUsername &&
        !pr.requestedReviewers.includes(s.githubUsername)
    );

    this.renderPRSection(root, `My PRs (${myPRs.length})`, myPRs, "No open PRs");
    if (s.enableReviewRequests) {
      this.renderPRSection(root, `Awaiting My Review (${reviewRequests.length})`, reviewRequests, "None");
    }
    this.renderPRSectionCollapsible(root, `All Open PRs (${otherPRs.length})`, otherPRs, "No other open PRs");
  }

  private renderPRSection(root: HTMLElement, title: string, prs: PullRequest[], emptyText: string): void {
    const section = root.createDiv("gwt-section");
    section.createEl("h5", { text: title });
    if (prs.length === 0) {
      section.createDiv("gwt-empty").setText(emptyText);
    } else {
      prs.forEach((pr) => this.renderPR(section, pr));
    }
  }

  private renderPRSectionCollapsible(root: HTMLElement, title: string, prs: PullRequest[], emptyText: string): void {
    const details = root.createEl("details", { cls: "gwt-section gwt-pr-collapsible" });
    const summary = details.createEl("summary", { cls: "gwt-pr-collapsible-summary" });
    summary.createEl("h5", { text: title });
    if (prs.length === 0) {
      details.createDiv("gwt-empty").setText(emptyText);
    } else {
      prs.forEach((pr) => this.renderPR(details, pr));
    }
  }

  private renderPR(container: HTMLElement, pr: PullRequest): void {
    const s = this.plugin.settings;
    const hasNew = s.enablePRActivityAlerts && this.plugin.hasNewActivity(pr);
    const row = container.createDiv(hasNew ? "gwt-pr gwt-pr-new" : "gwt-pr");

    const link = row.createEl("a", {
      cls: "gwt-pr-link",
      href: pr.url,
      text: `#${pr.number} ${pr.title}`,
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(pr.url, "_blank");
      if (s.enablePRActivityAlerts) {
        this.plugin.markSeen(pr);
        row.removeClass("gwt-pr-new");
        row.querySelector(".gwt-new-badge")?.remove();
      }
    });

    const meta = row.createDiv("gwt-pr-meta");
    meta.createSpan({ text: `@${pr.author}` });
    if (pr.draft) meta.createSpan({ cls: "gwt-draft", text: " · Draft" });
    if (hasNew) meta.createSpan({ cls: "gwt-new-badge", text: " · New activity" });
  }

  private async handlePull(): Promise<void> {
    if (!this.gitStatus) return;
    const { repoPath } = this.plugin.settings;

    const stashed = this.gitStatus.hasUncommittedChanges
      ? await runGitStash(repoPath)
      : false;

    try {
      await runGitPull(repoPath);
    } catch (e: unknown) {
      if (stashed) {
        try { await runGitStashPop(repoPath); } catch { /* best-effort */ }
      }
      new Notice(`Pull failed: ${errorMessage(e)}`, 8000);
      return;
    }

    if (stashed) {
      try {
        await runGitStashPop(repoPath);
        new Notice("Pulled and re-applied local changes.");
      } catch (e: unknown) {
        new Notice(
          `Pulled successfully. Local changes are in the stash — resolve conflicts and run \`git stash pop\` manually.`,
          12000
        );
      }
    } else {
      new Notice("Pull successful.");
    }

    await this.refresh();
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default class GitHubWikiPlugin extends Plugin {
  settings: Settings;
  private pollTimer: number | null = null;
  private fetchTimer: number | null = null;
  private statusBarItem: HTMLElement | null = null;
  private ribbonIcon: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new GitHubRepoView(leaf, this));

    this.ribbonIcon = this.addRibbonIcon("github", "GitHub Repo", () => { void this.activateView(); });

    this.addSettingTab(new GitHubRepoSettingTab(this.app, this));

    if (this.settings.showStatusBar) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.addClass("gwt-status-bar");
      this.statusBarItem.setText("GH ···");
      this.statusBarItem.addEventListener("click", () => { void this.activateView(); });
    }

    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        await this.detectAndCacheIdentity();
        if (this.settings.autoOpenSidebar) await this.activateView();
        this.startPolling();
      })();
    });
  }

  onunload(): void {
    this.stopPolling();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<Settings>);
    if (!this.settings.seenPRActivity) this.settings.seenPRActivity = {};
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async detectAndCacheIdentity(): Promise<void> {
    let changed = false;

    if (this.settings.repoPath && (!this.settings.repoOwner || !this.settings.repoName)) {
      try {
        const identity = await detectRepoIdentity(this.settings.repoPath);
        if (identity) {
          this.settings.repoOwner = identity.owner;
          this.settings.repoName = identity.repo;
          changed = true;
        }
      } catch { /* non-fatal */ }
    }

    if (this.settings.githubToken && !this.settings.githubUsername) {
      try {
        this.settings.githubUsername = await detectGitHubUsername(this.settings.githubToken);
        changed = true;
      } catch { /* non-fatal */ }
    }

    if (changed) await this.saveSettings();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  updateRibbonIcon(commitsBehind: number): void {
    if (!this.ribbonIcon) return;
    if (commitsBehind > 0) {
      this.ribbonIcon.addClass("gwt-ribbon-alert");
      this.ribbonIcon.setAttribute("aria-label", `GitHub Repo — ${commitsBehind} commit${commitsBehind !== 1 ? "s" : ""} behind`);
    } else {
      this.ribbonIcon.removeClass("gwt-ribbon-alert");
      this.ribbonIcon.setAttribute("aria-label", "GitHub Repo");
    }
  }

  updateStatusBar(gitStatus: GitStatus | null, prs: PullRequest[]): void {
    if (!this.statusBarItem) return;

    const parts: string[] = [];

    if (this.settings.enableStalenessCheck && gitStatus) {
      parts.push(gitStatus.commitsBehind > 0 ? `⬇${gitStatus.commitsBehind}` : "✓");
      if (gitStatus.hasUncommittedChanges) parts.push(`~${gitStatus.changedFiles.length}`);
    }

    if (this.settings.enablePRDashboard) {
      const myPRs = prs.filter((pr) => pr.author === this.settings.githubUsername).length;
      const reviewReqs = prs.filter(
        (pr) =>
          pr.author !== this.settings.githubUsername &&
          pr.requestedReviewers.includes(this.settings.githubUsername)
      ).length;
      const unread = prs.filter((pr) => this.hasNewActivity(pr)).length;
      if (myPRs > 0) parts.push(`PR:${myPRs}`);
      if (reviewReqs > 0) parts.push(`Rev:${reviewReqs}`);
      if (unread > 0) parts.push(`New:${unread}`);
    }

    this.statusBarItem.setText(parts.length > 0 ? `GH ${parts.join(" · ")}` : "GH ✓");
  }

  restartPolling(): void {
    this.stopPolling();
    this.startPolling();
  }

  private startPolling(): void {
    const intervalMs = (this.settings.pollIntervalMinutes || 15) * 60 * 1000;
    this.pollTimer = window.setInterval(() => { void this.refreshView(); }, intervalMs);
    this.fetchTimer = window.setInterval(() => { void this.silentFetchView(); }, 30_000);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.fetchTimer !== null) {
      window.clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  private async refreshView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      await (leaf.view as GitHubRepoView).refresh();
    }
  }

  private async silentFetchView(): Promise<void> {
    const s = this.settings;
    if (!s.enableStalenessCheck || !s.repoPath) return;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view as GitHubRepoView;
      try {
        view.gitStatus = await fetchGitStatus(s.repoPath, s.trackBranch);
        view.render();
        this.updateStatusBar(view.gitStatus, view.prs);
        this.updateRibbonIcon(view.gitStatus?.commitsBehind ?? 0);
      } catch { /* non-fatal background fetch */ }
    }
  }

  initSeenActivity(prs: PullRequest[]): void {
    let changed = false;
    for (const pr of prs) {
      if (pr.author !== this.settings.githubUsername) continue;
      if (!(pr.number in this.settings.seenPRActivity)) {
        this.settings.seenPRActivity[pr.number] = pr.updatedAt;
        changed = true;
      }
    }
    if (changed) void this.saveSettings();
  }

  hasNewActivity(pr: PullRequest): boolean {
    if (pr.author !== this.settings.githubUsername) return false;
    const lastSeen = this.settings.seenPRActivity[pr.number];
    if (!lastSeen) return false;
    return pr.updatedAt > lastSeen;
  }

  markSeen(pr: PullRequest): void {
    this.settings.seenPRActivity[pr.number] = pr.updatedAt;
    void this.saveSettings();
  }
}

// ── Commit modal ─────────────────────────────────────────────────────────────

class CommitModal extends Modal {
  private changedFiles: ChangedFile[];
  private onSubmit: (files: string[], message: string, push: boolean) => Promise<void>;

  constructor(
    app: App,
    changedFiles: ChangedFile[],
    onSubmit: (files: string[], message: string, push: boolean) => Promise<void>
  ) {
    super(app);
    this.changedFiles = changedFiles;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gwt-modal");

    contentEl.createEl("h3", { text: "Commit changes" });

    contentEl.createEl("label", { cls: "gwt-modal-label", text: "Stage files" });
    const selectRow = contentEl.createDiv("gwt-modal-select-all");
    const selectAll = selectRow.createEl("a", { text: "Select all" });
    const deselectAll = selectRow.createEl("a", { text: "Deselect all" });

    const fileList = contentEl.createDiv("gwt-modal-file-list");
    const checkboxes: HTMLInputElement[] = [];

    this.changedFiles.forEach((f) => {
      const item = fileList.createDiv("gwt-modal-file-item");
      const cb = item.createEl("input", { type: "checkbox" });
      cb.checked = true;
      checkboxes.push(cb);
      item.createSpan({ cls: `gwt-file-status gwt-status-${f.status.replace("?", "untracked")}`, text: f.status });
      item.createSpan({ cls: "gwt-file-path", text: f.path });
      item.addEventListener("click", (e) => { if (e.target !== cb) cb.checked = !cb.checked; });
    });

    selectAll.addEventListener("click", () => checkboxes.forEach((cb) => (cb.checked = true)));
    deselectAll.addEventListener("click", () => checkboxes.forEach((cb) => (cb.checked = false)));

    contentEl.createEl("label", { cls: "gwt-modal-label", text: "Commit message" });
    const textarea = contentEl.createEl("textarea", { cls: "gwt-modal-textarea" });
    textarea.rows = 3;
    textarea.placeholder = "feat: describe your changes";

    const btnRow = contentEl.createDiv("gwt-modal-btns");
    const commitBtn = btnRow.createEl("button", { cls: "mod-cta", text: "Commit" });
    const commitPushBtn = btnRow.createEl("button", { text: "Commit & Push" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });

    const submit = async (push: boolean) => {
      const selected = this.changedFiles
        .filter((_, i) => checkboxes[i].checked)
        .map((f) => f.path);
      const message = textarea.value.trim();
      if (selected.length === 0) { new Notice("Select at least one file."); return; }
      if (!message) { textarea.focus(); new Notice("Enter a commit message."); return; }
      commitBtn.disabled = true;
      commitPushBtn.disabled = true;
      this.close();
      await this.onSubmit(selected, message, push);
    };

    commitBtn.addEventListener("click", () => { void submit(false); });
    commitPushBtn.addEventListener("click", () => { void submit(true); });
    cancelBtn.addEventListener("click", () => this.close());

    window.setTimeout(() => textarea.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── Create PR modal ───────────────────────────────────────────────────────────

class CreatePRModal extends Modal {
  private currentBranch: string;
  private availableBranches: string[];
  private onSubmit: (title: string, body: string, base: string) => Promise<void>;

  constructor(
    app: App,
    currentBranch: string,
    availableBranches: string[],
    onSubmit: (title: string, body: string, base: string) => Promise<void>
  ) {
    super(app);
    this.currentBranch = currentBranch;
    this.availableBranches = availableBranches;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gwt-modal");

    contentEl.createEl("h3", { text: "Create pull request" });

    const baseRow = contentEl.createDiv("gwt-modal-row");
    baseRow.createEl("label", { cls: "gwt-modal-label", text: "Base branch" });
    const baseSelect = baseRow.createEl("select", { cls: "gwt-modal-select" });
    const defaultBase = detectDefaultBranch(
      this.availableBranches.filter((b) => b !== this.currentBranch)
    );
    this.availableBranches
      .filter((b) => b !== this.currentBranch)
      .forEach((b) => {
        const opt = baseSelect.createEl("option", { text: b, value: b });
        if (b === defaultBase) opt.selected = true;
      });

    const hint = contentEl.createEl("p", { cls: "gwt-modal-from-hint" });
    const updateHint = () => {
      hint.setText(`${this.currentBranch}  →  ${baseSelect.value}`);
    };
    updateHint();
    baseSelect.addEventListener("change", updateHint);

    const titleRow = contentEl.createDiv("gwt-modal-row");
    titleRow.createEl("label", { cls: "gwt-modal-label", text: "Title" });
    const titleInput = titleRow.createEl("input", { cls: "gwt-modal-input", type: "text" });
    titleInput.value = branchToPRTitle(this.currentBranch);

    const bodyRow = contentEl.createDiv("gwt-modal-row");
    bodyRow.createEl("label", { cls: "gwt-modal-label", text: "Description (optional)" });
    const bodyTextarea = bodyRow.createEl("textarea", { cls: "gwt-modal-textarea" });
    bodyTextarea.rows = 4;
    bodyTextarea.placeholder = "Describe your changes…";

    const btnRow = contentEl.createDiv("gwt-modal-btns");
    const createBtn = btnRow.createEl("button", { cls: "mod-cta", text: "Create PR" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });

    const submit = async () => {
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      createBtn.disabled = true;
      createBtn.setText("Creating…");
      this.close();
      await this.onSubmit(title, bodyTextarea.value.trim(), baseSelect.value);
    };

    createBtn.addEventListener("click", () => { void submit(); });
    cancelBtn.addEventListener("click", () => this.close());
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });

    window.setTimeout(() => titleInput.focus(), 50);
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── New branch modal ─────────────────────────────────────────────────────────

class NewBranchModal extends Modal {
  private currentBranch: string;
  private sourceBranch: string | null;
  private availableBranches: string[];
  private onSubmit: (name: string, from: string | null) => Promise<void>;

  constructor(
    app: App,
    currentBranch: string,
    sourceBranch: string | null,
    availableBranches: string[],
    onSubmit: (name: string, from: string | null) => Promise<void>
  ) {
    super(app);
    this.currentBranch = currentBranch;
    this.sourceBranch = sourceBranch;
    this.availableBranches = availableBranches;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gwt-modal");

    const fromPicker = this.sourceBranch !== null;

    contentEl.createEl("h3", {
      text: fromPicker ? "Create new branch from…" : "Create new branch",
    });

    if (fromPicker) {
      const row = contentEl.createDiv("gwt-modal-row");
      row.createEl("label", { cls: "gwt-modal-label", text: "Source branch" });
      const select = row.createEl("select", { cls: "gwt-modal-select" });
      this.availableBranches.forEach((b) => {
        const opt = select.createEl("option", { text: b, value: b });
        if (b === this.sourceBranch) opt.selected = true;
      });
      select.addEventListener("change", () => { this.sourceBranch = select.value; });
    } else {
      contentEl.createEl("p", {
        cls: "gwt-modal-hint",
        text: `From: ${this.currentBranch}`,
      });
    }

    const nameRow = contentEl.createDiv("gwt-modal-row");
    nameRow.createEl("label", { cls: "gwt-modal-label", text: "Branch name" });
    const input = nameRow.createEl("input", { cls: "gwt-modal-input", type: "text" });
    input.placeholder = "feature/my-branch";

    const btnRow = contentEl.createDiv("gwt-modal-btns");
    const createBtn = btnRow.createEl("button", { cls: "mod-cta", text: "Create branch" });
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });

    const submit = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      createBtn.disabled = true;
      createBtn.setText("Creating…");
      this.close();
      await this.onSubmit(name, this.sourceBranch);
    };

    createBtn.addEventListener("click", () => { void submit(); });
    cancelBtn.addEventListener("click", () => this.close());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
      if (e.key === "Escape") this.close();
    });

    window.setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ── Settings tab ─────────────────────────────────────────────────────────────

class GitHubRepoSettingTab extends PluginSettingTab {
  plugin: GitHubWikiPlugin;
  private detectedRepoEl: HTMLElement | null = null;
  private detectedUserEl: HTMLElement | null = null;

  constructor(app: App, plugin: GitHubWikiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Local repo path")
      .setDesc("Absolute path to your local clone of the repo")
      .addText((t) =>
        t
          .setPlaceholder("/Users/you/my-repo")
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (v) => {
            this.plugin.settings.repoPath = v;
            this.plugin.settings.repoOwner = "";
            this.plugin.settings.repoName = "";
            await this.plugin.saveSettings();
            await this.plugin.detectAndCacheIdentity();
            this.updateDetectedInfo();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Browse…").onClick(async () => {
          const folder = await showFolderPicker();
          if (!folder) return;
          this.plugin.settings.repoPath = folder;
          this.plugin.settings.repoOwner = "";
          this.plugin.settings.repoName = "";
          await this.plugin.saveSettings();
          await this.plugin.detectAndCacheIdentity();
          this.updateDetectedInfo();
        })
      );

    new Setting(containerEl)
      .setName("GitHub personal access token")
      .setDesc("Classic PAT with repo scope")
      .addText((t) => {
        t
          .setPlaceholder("ghp_…")
          .setValue(this.plugin.settings.githubToken)
          .onChange(async (v) => {
            this.plugin.settings.githubToken = v;
            this.plugin.settings.githubUsername = "";
            await this.plugin.saveSettings();
            await this.plugin.detectAndCacheIdentity();
            this.updateDetectedInfo();
          });
        t.inputEl.type = "password";
      });

    const s = this.plugin.settings;
    this.detectedRepoEl = containerEl.createEl("p", {
      cls: "setting-item-description",
      text: s.repoOwner && s.repoName ? `Detected repo: ${s.repoOwner}/${s.repoName}` : "",
    });
    this.detectedUserEl = containerEl.createEl("p", {
      cls: "setting-item-description",
      text: s.githubUsername ? `Detected GitHub user: @${s.githubUsername}` : "",
    });

    new Setting(containerEl).setName("Features").setHeading();

    new Setting(containerEl)
      .setName("Staleness check")
      .setDesc("Check if your local repo is behind the remote and offer to pull")
      .addToggle((t) => t.setValue(s.enableStalenessCheck).onChange(async (v) => { this.plugin.settings.enableStalenessCheck = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("PR dashboard")
      .setDesc("Show open pull requests in the sidebar")
      .addToggle((t) => t.setValue(s.enablePRDashboard).onChange(async (v) => { this.plugin.settings.enablePRDashboard = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("PR activity alerts")
      .setDesc("Highlight your PRs that have new comments or reviews since you last opened them")
      .addToggle((t) => t.setValue(s.enablePRActivityAlerts).onChange(async (v) => { this.plugin.settings.enablePRActivityAlerts = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Review requests")
      .setDesc("Show a section for PRs where you are a requested reviewer")
      .addToggle((t) => t.setValue(s.enableReviewRequests).onChange(async (v) => { this.plugin.settings.enableReviewRequests = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Display").setHeading();

    new Setting(containerEl)
      .setName("Status bar item")
      .setDesc("Show a compact summary in the Obsidian status bar (restart plugin to apply)")
      .addToggle((t) => t.setValue(s.showStatusBar).onChange(async (v) => { this.plugin.settings.showStatusBar = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Auto-open sidebar on startup")
      .setDesc("Open the GitHub Repo panel automatically when Obsidian launches")
      .addToggle((t) => t.setValue(s.autoOpenSidebar).onChange(async (v) => { this.plugin.settings.autoOpenSidebar = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Show draft PRs")
      .setDesc("Include draft pull requests in the PR list")
      .addToggle((t) => t.setValue(s.showDraftPRs).onChange(async (v) => { this.plugin.settings.showDraftPRs = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Poll interval (minutes)")
      .setDesc("How often to check for updates (default: 15)")
      .addText((t) =>
        t
          .setPlaceholder("15")
          .setValue(String(s.pollIntervalMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.pollIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.restartPolling();
            }
          })
      );

    new Setting(containerEl)
      .setName("Track branch")
      .setDesc("Remote branch to compare against (e.g. main). Leave empty to use your current branch.")
      .addText((t) =>
        t
          .setPlaceholder("main")
          .setValue(s.trackBranch)
          .onChange(async (v) => {
            this.plugin.settings.trackBranch = v.trim();
            await this.plugin.saveSettings();
          })
      );
  }

  private updateDetectedInfo(): void {
    const s = this.plugin.settings;
    if (this.detectedRepoEl) {
      this.detectedRepoEl.setText(
        s.repoOwner && s.repoName ? `Detected repo: ${s.repoOwner}/${s.repoName}` : ""
      );
    }
    if (this.detectedUserEl) {
      this.detectedUserEl.setText(
        s.githubUsername ? `Detected GitHub user: @${s.githubUsername}` : ""
      );
    }
  }
}
