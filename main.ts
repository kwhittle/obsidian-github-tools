import {
  App,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
} from "obsidian";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const VIEW_TYPE = "github-wiki-sidebar";

// ── Settings ────────────────────────────────────────────────────────────────

interface Settings {
  repoPath: string;
  githubToken: string;
  repoOwner: string;
  repoName: string;
  githubUsername: string;
  pollIntervalMinutes: number;
  // PR number → last-seen updatedAt timestamp (ISO string)
  seenPRActivity: Record<number, string>;
}

const DEFAULT_SETTINGS: Settings = {
  repoPath: "",
  githubToken: "",
  repoOwner: "",
  repoName: "",
  githubUsername: "",
  pollIntervalMinutes: 15,
  seenPRActivity: {},
};

// ── Git service ──────────────────────────────────────────────────────────────

interface GitStatus {
  branch: string;
  hasUncommittedChanges: boolean;
  commitsBehind: number;
}

async function gitExec(repoPath: string, args: string): Promise<string> {
  const { stdout } = await execAsync(`git -C "${repoPath}" ${args}`);
  return stdout.trim();
}

async function fetchGitStatus(repoPath: string): Promise<GitStatus> {
  await gitExec(repoPath, "fetch origin");

  const branch = await gitExec(repoPath, "branch --show-current");
  const porcelain = await gitExec(repoPath, "status --porcelain");
  const hasUncommittedChanges = porcelain.length > 0;

  const behindStr = await gitExec(
    repoPath,
    `rev-list --count HEAD..origin/${branch}`
  );
  const commitsBehind = parseInt(behindStr, 10) || 0;

  return { branch, hasUncommittedChanges, commitsBehind };
}

async function runGitPull(repoPath: string): Promise<void> {
  await gitExec(repoPath, "pull");
}

// ── GitHub service ───────────────────────────────────────────────────────────

interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  updatedAt: string;
  draft: boolean;
}

async function fetchOpenPRs(
  owner: string,
  repo: string,
  token: string
): Promise<PullRequest[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data: any[] = await response.json();

  return data.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user.login,
    updatedAt: pr.updated_at,
    draft: pr.draft ?? false,
  }));
}

// ── Sidebar view ─────────────────────────────────────────────────────────────

class WikiSidebarView extends ItemView {
  private plugin: GitHubWikiPlugin;
  private gitStatus: GitStatus | null = null;
  private prs: PullRequest[] = [];
  private loading = false;
  private errorMsg: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHubWikiPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "GitHub Wiki"; }
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

      if (s.repoPath) {
        this.gitStatus = await fetchGitStatus(s.repoPath);
      }

      if (s.githubToken && s.repoOwner && s.repoName) {
        this.prs = await fetchOpenPRs(s.repoOwner, s.repoName, s.githubToken);
        this.plugin.initSeenActivity(this.prs);
      }
    } catch (e: any) {
      this.errorMsg = e.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("gwt-sidebar");

    const header = root.createDiv("gwt-header");
    header.createEl("h4", { text: "GitHub Wiki" });
    const refreshBtn = header.createEl("button", { cls: "gwt-btn-icon", text: "↻" });
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => this.refresh());

    if (this.loading) {
      root.createDiv("gwt-muted").setText("Loading…");
      return;
    }

    if (this.errorMsg) {
      root.createDiv("gwt-error").setText(this.errorMsg);
    }

    this.renderGitStatus(root);
    this.renderPRs(root);
  }

  private renderGitStatus(root: HTMLElement): void {
    const s = this.gitStatus;
    if (!s) {
      if (!this.plugin.settings.repoPath) {
        root.createDiv("gwt-muted").setText("Set repo path in settings to see git status.");
      }
      return;
    }

    const section = root.createDiv("gwt-section");
    section.createEl("h5", { text: "Local Repo" });

    const branchRow = section.createDiv("gwt-row");
    branchRow.createSpan({ cls: "gwt-label", text: "Branch: " });
    branchRow.createSpan({ text: s.branch });

    if (s.hasUncommittedChanges) {
      section.createDiv("gwt-row gwt-warning").setText("⚠ Uncommitted changes");
    }

    if (s.commitsBehind > 0) {
      const behindRow = section.createDiv("gwt-row gwt-behind");
      behindRow.createSpan({
        text: `⬇ ${s.commitsBehind} commit${s.commitsBehind !== 1 ? "s" : ""} behind origin/${s.branch}`,
      });
      const pullBtn = behindRow.createEl("button", { cls: "gwt-btn", text: "Pull" });
      pullBtn.addEventListener("click", () => this.handlePull());
    } else {
      section.createDiv("gwt-row gwt-ok").setText("✓ Up to date");
    }
  }

  private renderPRs(root: HTMLElement): void {
    const s = this.plugin.settings;
    if (!s.githubToken || !s.repoOwner || !s.repoName) {
      root.createDiv("gwt-muted").setText("Configure GitHub settings to see PRs.");
      return;
    }

    const myPRs = this.prs.filter((pr) => pr.author === s.githubUsername);
    const otherPRs = this.prs.filter((pr) => pr.author !== s.githubUsername);

    const mySection = root.createDiv("gwt-section");
    mySection.createEl("h5", { text: `My PRs (${myPRs.length})` });
    if (myPRs.length === 0) {
      mySection.createDiv("gwt-empty").setText("No open PRs");
    } else {
      myPRs.forEach((pr) => this.renderPR(mySection, pr));
    }

    const allSection = root.createDiv("gwt-section");
    allSection.createEl("h5", { text: `All Open PRs (${otherPRs.length})` });
    if (otherPRs.length === 0) {
      allSection.createDiv("gwt-empty").setText("No other open PRs");
    } else {
      otherPRs.forEach((pr) => this.renderPR(allSection, pr));
    }
  }

  private renderPR(container: HTMLElement, pr: PullRequest): void {
    const hasNew = this.plugin.hasNewActivity(pr);
    const row = container.createDiv(hasNew ? "gwt-pr gwt-pr-new" : "gwt-pr");

    const link = row.createEl("a", {
      cls: "gwt-pr-link",
      href: pr.url,
      text: `#${pr.number} ${pr.title}`,
    });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(pr.url, "_blank");
      this.plugin.markSeen(pr);
      row.removeClass("gwt-pr-new");
      row.querySelector(".gwt-new-badge")?.remove();
    });

    const meta = row.createDiv("gwt-pr-meta");
    meta.createSpan({ text: `@${pr.author}` });
    if (pr.draft) meta.createSpan({ cls: "gwt-draft", text: " · Draft" });
    if (hasNew) meta.createSpan({ cls: "gwt-new-badge", text: " · New activity" });
  }

  private async handlePull(): Promise<void> {
    const { gitStatus } = this;
    if (!gitStatus) return;

    if (gitStatus.hasUncommittedChanges) {
      new Notice(
        "Cannot pull: you have uncommitted changes. Commit or stash them first.",
        8000
      );
      return;
    }

    try {
      await runGitPull(this.plugin.settings.repoPath);
      new Notice("Pull successful.");
      await this.refresh();
    } catch (e: any) {
      new Notice(`Pull failed: ${e.message}`, 8000);
    }
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default class GitHubWikiPlugin extends Plugin {
  settings: Settings;
  private pollTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new WikiSidebarView(leaf, this));

    this.addRibbonIcon("github", "GitHub Wiki", () => this.activateView());

    this.addSettingTab(new GitHubWikiSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.activateView();
      this.startPolling();
    });
  }

  onunload(): void {
    this.stopPolling();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.seenPRActivity) this.settings.seenPRActivity = {};
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  restartPolling(): void {
    this.stopPolling();
    this.startPolling();
  }

  private startPolling(): void {
    const intervalMs = (this.settings.pollIntervalMinutes || 15) * 60 * 1000;
    this.pollTimer = window.setInterval(() => this.refreshView(), intervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshView(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      await (leaf.view as WikiSidebarView).refresh();
    }
  }

  // Record updatedAt for PRs we haven't seen before so first load doesn't
  // flag everything as new.
  initSeenActivity(prs: PullRequest[]): void {
    let changed = false;
    for (const pr of prs) {
      if (pr.author !== this.settings.githubUsername) continue;
      if (!(pr.number in this.settings.seenPRActivity)) {
        this.settings.seenPRActivity[pr.number] = pr.updatedAt;
        changed = true;
      }
    }
    if (changed) this.saveSettings();
  }

  hasNewActivity(pr: PullRequest): boolean {
    if (pr.author !== this.settings.githubUsername) return false;
    const lastSeen = this.settings.seenPRActivity[pr.number];
    if (!lastSeen) return false;
    return pr.updatedAt > lastSeen;
  }

  markSeen(pr: PullRequest): void {
    this.settings.seenPRActivity[pr.number] = pr.updatedAt;
    this.saveSettings();
  }
}

// ── Settings tab ─────────────────────────────────────────────────────────────

class GitHubWikiSettingTab extends PluginSettingTab {
  plugin: GitHubWikiPlugin;

  constructor(app: App, plugin: GitHubWikiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GitHub Wiki Tools" });

    new Setting(containerEl)
      .setName("Local repo path")
      .setDesc("Absolute path to your local clone of the wiki repo")
      .addText((t) =>
        t
          .setPlaceholder("/Users/you/wiki-repo")
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (v) => {
            this.plugin.settings.repoPath = v;
            await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("GitHub username")
      .setDesc("Your GitHub username — used to identify your PRs")
      .addText((t) =>
        t
          .setPlaceholder("your-username")
          .setValue(this.plugin.settings.githubUsername)
          .onChange(async (v) => {
            this.plugin.settings.githubUsername = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Repo owner")
      .setDesc("GitHub org or user that owns the wiki repo")
      .addText((t) =>
        t
          .setPlaceholder("org-name")
          .setValue(this.plugin.settings.repoOwner)
          .onChange(async (v) => {
            this.plugin.settings.repoOwner = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Repo name")
      .setDesc("Name of the wiki repo on GitHub")
      .addText((t) =>
        t
          .setPlaceholder("wiki-repo")
          .setValue(this.plugin.settings.repoName)
          .onChange(async (v) => {
            this.plugin.settings.repoName = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Poll interval (minutes)")
      .setDesc("How often to check for updates (default: 15)")
      .addText((t) =>
        t
          .setPlaceholder("15")
          .setValue(String(this.plugin.settings.pollIntervalMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.pollIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.restartPolling();
            }
          })
      );
  }
}
