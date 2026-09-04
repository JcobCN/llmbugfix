import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CommandRunner } from '@llmbugfix/validator';

export interface RepoManagerOptions { worktreesRoot?: string; worktreeRoot?: string; repositoryRoot?: string; repositoryRoots?: string[]; /** Root used for remote repositories cloned from confirmed intake. */ cloneRoot?: string; allowedRemoteHost?: string; allowedRemoteHosts?: string[]; protectedBranches?: string[]; commandRunner?: CommandRunner; }
export interface GitOperationResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; }
const within = (root: string, value: string) => value === root || value.startsWith(`${root}${path.sep}`);
const BUG = /^BUG-[0-9]{6,}$/;

export class RepoManager {
  private readonly worktreesRoot: string;
  private readonly repositoryRoots: string[];
  private readonly cloneRoot?: string;
  private readonly allowedRemoteHosts: string[];
  private readonly protectedBranches: string[];
  private readonly runner: CommandRunner;
  constructor(worktreesRootOrOptions: string | RepoManagerOptions, allowedHosts: string[] = []) {
    const options: RepoManagerOptions = typeof worktreesRootOrOptions === 'string' ? { worktreesRoot: worktreesRootOrOptions, allowedRemoteHosts: allowedHosts } : worktreesRootOrOptions;
    this.worktreesRoot = path.resolve(options.worktreesRoot ?? options.worktreeRoot ?? path.join(process.cwd(), 'data/worktrees')); fs.mkdirSync(this.worktreesRoot, { recursive: true });
    this.cloneRoot = options.cloneRoot ? path.resolve(options.cloneRoot) : undefined;
    if (this.cloneRoot) fs.mkdirSync(this.cloneRoot, { recursive: true });
    this.repositoryRoots = [...(options.repositoryRoots ?? (options.repositoryRoot ? [options.repositoryRoot] : [])), ...(this.cloneRoot ? [this.cloneRoot] : [])].map((root) => { const resolved = path.resolve(root); return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved; });
    this.allowedRemoteHosts = options.allowedRemoteHosts ?? (options.allowedRemoteHost ? [options.allowedRemoteHost] : []);
    this.protectedBranches = options.protectedBranches ?? ['main', 'master', 'develop', 'release'];
    this.runner = options.commandRunner ?? new CommandRunner({ allowedCwdRoots: this.repositoryRoots.length ? [this.worktreesRoot, ...this.repositoryRoots] : [] });
  }
  private repoPath(repo: string): string { const resolved = path.resolve(repo); if (!fs.existsSync(resolved)) throw new Error(`Repository does not exist: ${repo}`); const real = fs.realpathSync.native(resolved); if (!fs.statSync(real).isDirectory() || !fs.existsSync(path.join(real, '.git'))) throw new Error(`Not a git repository: ${repo}`); if (this.repositoryRoots.length && !this.repositoryRoots.some((root) => within(root, real))) throw new Error(`Repository is outside configured roots: ${repo}`); return real; }
  private worktreePath(bugKey: string): string { if (!BUG.test(bugKey)) throw new Error(`Invalid bug key: ${bugKey}`); const target = path.resolve(this.worktreesRoot, bugKey); if (!within(this.worktreesRoot, target)) throw new Error('Worktree escapes configured root'); return target; }
  public validateRepoUrl(repoUrl: string): void { if (path.isAbsolute(repoUrl) || fs.existsSync(repoUrl)) { this.repoPath(repoUrl); return; } const parsed = this.remoteHost(repoUrl); if (this.allowedRemoteHosts.length && !this.allowedRemoteHosts.includes(parsed)) throw new Error(`Remote host is not allowed: ${parsed}`); }
  /**
   * Clone a tester-provided remote into the dedicated local checkout root.
   * The URL is always passed as one git argv item; no shell is involved.
   * Existing directories are never overwritten, which makes retries safe.
   */
  async cloneRemoteRepository(repoUrl: string, checkoutId: string): Promise<string> {
    if (!this.cloneRoot) throw new Error('Remote clone root is not configured');
    if (!/^[a-z][a-z0-9-]{2,80}$/u.test(checkoutId)) throw new Error(`Unsafe checkout id: ${checkoutId}`);
    if (/\0|[\r\n]/u.test(repoUrl)) throw new Error('Remote URL contains an invalid control character');
    // A clone source is deliberately allowed to be a Git remote outside the
    // existing local checkout roots. `file://` remains useful for offline E2E
    // tests; HTTP(S) and SSH sources still honor an explicit host allow-list.
    if (!repoUrl.startsWith('file://')) {
      const host = this.remoteHost(repoUrl);
      if (this.allowedRemoteHosts.length && !this.allowedRemoteHosts.includes(host)) throw new Error(`Remote host is not allowed: ${host}`);
    }
    const target = path.resolve(this.cloneRoot, checkoutId);
    if (!within(this.cloneRoot, target)) throw new Error('Repository clone escapes configured root');
    if (fs.existsSync(target)) {
      let repository: string | undefined;
      try { repository = this.repoPath(target); }
      catch { /* a failed clone can leave a non-repository directory */ }
      if (repository) {
        const origin = await this.git(repository, ['remote', 'get-url', 'origin']);
        if (origin.exitCode === 0) {
          if (origin.stdout.trim() !== repoUrl.trim()) throw new Error(`Existing checkout belongs to a different remote: ${target}`);
          return repository;
        }
      }
      // A failed `git clone` can leave a partial non-repository directory or
      // an incomplete Git directory with no origin. This target is a
      // server-generated id directly below cloneRoot, so it is safe to remove
      // only that incomplete checkout before retrying.
      fs.rmSync(target, { recursive: true, force: true });
    }
    const result = await this.git(this.cloneRoot, ['clone', '--origin', 'origin', '--', repoUrl, target], 300_000);
    if (result.exitCode !== 0) {
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
    }
    return this.repoPath(target);
  }
  public createBranchName(bugKey: string, title: string): string {
    if (!BUG.test(bugKey)) throw new Error(`Invalid bug key: ${bugKey}`);
    const slug = title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
    // A title made entirely of non-Latin characters must still identify the
    // bug. A short deterministic digest keeps refs ASCII and avoids the old
    // unhelpful `...-fix` collision.
    const suffix = slug || `title-${createHash('sha256').update(title).digest('hex').slice(0, 10)}`;
    return `ai/${bugKey}-${suffix}`;
  }
  private async git(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitOperationResult> { const result = await this.runner.run('git', args, { cwd, timeoutMs }); return result; }
  async fetch(repoDir: string, baseBranch = 'main'): Promise<GitOperationResult> { const repo = this.repoPath(repoDir); return this.git(repo, ['fetch', 'origin', baseBranch]); }
  async setupWorktree(bugKey: string, repoDirOrUrl: string, branchName = this.createBranchName(bugKey, 'fix'), baseBranch = 'main'): Promise<string> {
    const repo = this.repoPath(repoDirOrUrl); const expectedBranch = new RegExp(`^ai/${bugKey}-[a-z0-9]+(?:-[a-z0-9]+)*$`); if (!expectedBranch.test(branchName)) throw new Error(`Unsafe branch name: ${branchName}`);
    const target = this.worktreePath(bugKey);
    // Always ask Git to clear the exact validated target. The directory can
    // already be gone while Git still has a worktree registration or branch
    // from a failed prior attempt; checking fs.existsSync alone misses that.
    await this.cleanup(target, repo, branchName);
    let base = `origin/${baseBranch}`; const hasOrigin = await this.git(repo, ['remote', 'get-url', 'origin']); if (hasOrigin.exitCode === 0) { const fetched = await this.fetch(repo, baseBranch); if (fetched.exitCode !== 0) throw new Error(`git fetch failed: ${fetched.stderr}`); } else base = 'HEAD';
    // A previous cleanup can leave the AI branch after its worktree directory
    // disappeared. It is safe to recycle only this validated bug branch.
    const existingBranch = await this.git(repo, ['show-ref', '--verify', `refs/heads/${branchName}`]);
    if (existingBranch.exitCode === 0) {
      const removed = await this.git(repo, ['branch', '-D', '--', branchName]);
      if (removed.exitCode !== 0) throw new Error(`Existing AI branch cannot be recycled: ${removed.stderr}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); const result = await this.git(repo, ['worktree', 'add', '-b', branchName, target, base]); if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr}`); return target;
  }
  async createWorktree(bugKey: string, repoDirOrUrl: string, branchName?: string, baseBranch = 'main'): Promise<string> { return this.setupWorktree(bugKey, repoDirOrUrl, branchName ?? this.createBranchName(bugKey, 'fix'), baseBranch); }
  async diff(worktreePath: string): Promise<string> { const result = await this.git(this.checkedWorktree(worktreePath), ['diff', '--binary', 'HEAD']); if (result.exitCode !== 0) throw new Error(result.stderr); return result.stdout; }
  private checkedWorktree(value: string): string { const resolved = path.resolve(value); if (!within(this.worktreesRoot, resolved)) throw new Error(`Worktree is outside configured root: ${value}`); if (!fs.existsSync(resolved)) throw new Error(`Worktree does not exist: ${value}`); return fs.realpathSync.native(resolved); }
  private remoteHost(remote: string): string { try { const normalized = remote.startsWith('git@') ? `ssh://${remote.replace(':', '/')}` : remote; const parsed = new URL(normalized); if (!parsed.hostname) throw new Error('missing host'); return parsed.hostname.toLowerCase(); } catch { throw new Error(`Invalid remote URL: ${remote}`); } }
  private async assertPushSafe(worktreePath: string, branchName: string): Promise<void> { if (!/^ai\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName) || branchName.includes('..') || branchName.includes('//')) throw new Error(`Only safe ai/* branches may be pushed: ${branchName}`); const leaf = branchName.slice(3); if (this.protectedBranches.some((item) => leaf === item || leaf.startsWith(`${item}/`)) || ['main', 'master', 'develop'].includes(branchName)) throw new Error(`Protected branch cannot be pushed: ${branchName}`); const current = await this.git(worktreePath, ['branch', '--show-current']); if (current.exitCode !== 0 || current.stdout.trim() !== branchName) throw new Error('Current branch does not match requested branch'); const remote = await this.git(worktreePath, ['remote', 'get-url', 'origin']); if (remote.exitCode !== 0) throw new Error('origin remote is required'); const host = this.remoteHost(remote.stdout.trim()); if (!this.allowedRemoteHosts.length || !this.allowedRemoteHosts.includes(host)) throw new Error(`Remote host is not allowed: ${host}`); }
  async commit(worktreePath: string, message: string): Promise<string> { const cwd = this.checkedWorktree(worktreePath); const add = await this.git(cwd, ['add', '--all']); if (add.exitCode !== 0) throw new Error(add.stderr); const commit = await this.git(cwd, ['commit', '-m', message]); if (commit.exitCode !== 0) throw new Error(commit.stderr); const rev = await this.git(cwd, ['rev-parse', 'HEAD']); if (rev.exitCode !== 0) throw new Error(rev.stderr); return rev.stdout.trim(); }
  async push(worktreePath: string, branchName: string): Promise<void> { const cwd = this.checkedWorktree(worktreePath); await this.assertPushSafe(cwd, branchName); const result = await this.git(cwd, ['push', '--set-upstream', 'origin', branchName]); if (result.exitCode !== 0) throw new Error(result.stderr); }
  async commitAndPush(worktreePath: string, branchName: string, message: string, dryRun = false): Promise<{ commitSha: string | null; pushed: boolean }> { const cwd = this.checkedWorktree(worktreePath); if (dryRun) { const rev = await this.git(cwd, ['rev-parse', 'HEAD']); return { commitSha: rev.exitCode === 0 ? rev.stdout.trim() : null, pushed: false }; } await this.assertPushSafe(cwd, branchName); const sha = await this.commit(cwd, message); await this.push(cwd, branchName); return { commitSha: sha, pushed: true }; }
  private looseWorktreePath(value: string): string {
    const resolved = path.resolve(value); if (!within(this.worktreesRoot, resolved)) throw new Error(`Worktree is outside configured root: ${value}`); return resolved;
  }
  private async repositoryForCleanup(target: string, repositoryRoot?: string): Promise<string | null> {
    if (repositoryRoot) return this.repoPath(repositoryRoot);
    for (const root of this.repositoryRoots) {
      if (!fs.existsSync(root)) continue;
      const result = await this.git(root, ['worktree', 'list', '--porcelain']);
      if (result.exitCode === 0 && result.stdout.includes(target)) return root;
    }
    return null;
  }
  /** Remove a registered worktree via its main repository, then only clean a
   * residual directory once Git confirms it is no longer registered. */
  async cleanup(worktreePath: string, repositoryRoot?: string, branchName?: string): Promise<void> {
    const target = this.looseWorktreePath(worktreePath); const repo = await this.repositoryForCleanup(target, repositoryRoot);
    if (!repo) { if (!fs.existsSync(target)) return; throw new Error(`Cannot identify the Git repository for worktree: ${target}`); }
    const result = await this.git(repo, ['worktree', 'remove', '--force', target]);
    if (result.exitCode !== 0) {
      const listed = await this.git(repo, ['worktree', 'list', '--porcelain']);
      if (listed.exitCode !== 0 || listed.stdout.includes(target)) throw new Error(result.stderr || `git worktree remove failed: ${target}`);
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    if (branchName && expectedAiBranch(branchName)) {
      const branch = await this.git(repo, ['branch', '-D', '--', branchName]);
      if (branch.exitCode !== 0 && !/not found|not exist/i.test(branch.stderr)) throw new Error(branch.stderr);
    }
  }
  async cleanupWorktree(bugKey: string, repositoryRoot?: string, branchName?: string): Promise<void> { await this.cleanup(this.worktreePath(bugKey), repositoryRoot, branchName); }
}

const expectedAiBranch = (branch: string): boolean => /^ai\/BUG-[0-9]{6,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch);
