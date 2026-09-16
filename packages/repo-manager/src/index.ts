import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CommandRunner } from '@llmbugfix/validator';
import { mirrorProjectName } from './gitlab.js';
import { KeyedAsyncMutex } from './mutex.js';

export { GitLabPushTarget, mirrorProjectName } from './gitlab.js';
export type { GitLabPushTargetOptions } from './gitlab.js';

/** Creates/looks up the own-account private mirror project for a source remote. */
export interface OwnPushTarget { ensureProject(name: string): Promise<string>; }

export interface RepoManagerOptions { worktreesRoot?: string; worktreeRoot?: string; repositoryRoot?: string; repositoryRoots?: string[]; /** Root used for remote repositories cloned from confirmed intake. */ cloneRoot?: string; allowedRemoteHost?: string; allowedRemoteHosts?: string[]; protectedBranches?: string[]; commandRunner?: CommandRunner; /** When set, ai/* branches are pushed to an own-account private mirror instead of origin. */ ownPushTarget?: OwnPushTarget; }
export interface GitOperationResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean; }
const within = (root: string, value: string) => value === root || value.startsWith(`${root}${path.sep}`);
const BUG = /^BUG-[0-9]{6,}$/;

// These registries are module-wide deliberately.  A process can construct
// more than one RepoManager (for example, an API and a worker), but Git's
// index/worktree metadata is shared by all of them.
const cloneMutex = new KeyedAsyncMutex();
const repositoryMutex = new KeyedAsyncMutex();

export class RepoManager {
  private readonly worktreesRoot: string;
  private readonly repositoryRoots: string[];
  private readonly cloneRoot?: string;
  private readonly allowedRemoteHosts: string[];
  private readonly protectedBranches: string[];
  private readonly ownPushTarget?: OwnPushTarget;
  private readonly runner: CommandRunner;
  constructor(worktreesRootOrOptions: string | RepoManagerOptions, allowedHosts: string[] = []) {
    const options: RepoManagerOptions = typeof worktreesRootOrOptions === 'string' ? { worktreesRoot: worktreesRootOrOptions, allowedRemoteHosts: allowedHosts } : worktreesRootOrOptions;
    this.worktreesRoot = path.resolve(options.worktreesRoot ?? options.worktreeRoot ?? path.join(process.cwd(), 'data/worktrees')); fs.mkdirSync(this.worktreesRoot, { recursive: true });
    this.cloneRoot = options.cloneRoot ? path.resolve(options.cloneRoot) : undefined;
    if (this.cloneRoot) fs.mkdirSync(this.cloneRoot, { recursive: true });
    this.repositoryRoots = [...(options.repositoryRoots ?? (options.repositoryRoot ? [options.repositoryRoot] : [])), ...(this.cloneRoot ? [this.cloneRoot] : [])].map((root) => { const resolved = path.resolve(root); return fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved; });
    this.allowedRemoteHosts = options.allowedRemoteHosts ?? (options.allowedRemoteHost ? [options.allowedRemoteHost] : []);
    this.protectedBranches = options.protectedBranches ?? ['main', 'master', 'develop', 'release'];
    this.ownPushTarget = options.ownPushTarget;
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
    const cloneRoot = this.cloneRoot;
    if (!cloneRoot) throw new Error('Remote clone root is not configured');
    if (!/^[a-z][a-z0-9-]{2,80}$/u.test(checkoutId)) throw new Error(`Unsafe checkout id: ${checkoutId}`);
    if (/\0|[\r\n]/u.test(repoUrl)) throw new Error('Remote URL contains an invalid control character');
    // A clone source is deliberately allowed to be a Git remote outside the
    // existing local checkout roots. `file://` remains useful for offline E2E
    // tests; HTTP(S) and SSH sources still honor an explicit host allow-list.
    if (!repoUrl.startsWith('file://')) {
      const host = this.remoteHost(repoUrl);
      if (this.allowedRemoteHosts.length && !this.allowedRemoteHosts.includes(host)) throw new Error(`Remote host is not allowed: ${host}`);
    }
    const target = path.resolve(cloneRoot, checkoutId);
    if (!within(cloneRoot, target)) throw new Error('Repository clone escapes configured root');
    return cloneMutex.runExclusive(target, async () => {
      // The complete check/clone/cleanup sequence is serialized.  In
      // particular, two callers must not both observe a missing directory and
      // race to create a checkout with the same generated id.
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
      const result = await this.git(cloneRoot, ['clone', '--origin', 'origin', '--', repoUrl, target], 300_000);
      if (result.exitCode !== 0) {
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        throw new Error(`git clone failed: ${result.stderr || result.stdout}`);
      }
      return this.repoPath(target);
    });
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
  private async fetchUnlocked(repo: string, baseBranch: string): Promise<GitOperationResult> { return this.git(repo, ['fetch', 'origin', baseBranch]); }
  async fetch(repoDir: string, baseBranch = 'main'): Promise<GitOperationResult> {
    const repo = this.repoPath(repoDir);
    return repositoryMutex.runExclusive(repo, () => this.fetchUnlocked(repo, baseBranch));
  }
  private async setupWorktreeFromBase(bugKey: string, repo: string, branchName: string, base: string): Promise<string> {
    const expectedBranch = new RegExp(`^ai/${bugKey}-[a-z0-9]+(?:-[a-z0-9]+)*$`); if (!expectedBranch.test(branchName)) throw new Error(`Unsafe branch name: ${branchName}`);
    const target = this.worktreePath(bugKey);
    // The caller holds the repository mutex for this entire Git metadata
    // operation.  Calling the public cleanup method here would try to acquire
    // the same non-reentrant lock again.
    await this.cleanupUnlocked(target, repo, branchName);
    const existingBranch = await this.git(repo, ['show-ref', '--verify', `refs/heads/${branchName}`]);
    if (existingBranch.exitCode === 0) {
      const removed = await this.git(repo, ['branch', '-D', '--', branchName]);
      if (removed.exitCode !== 0) throw new Error(`Existing AI branch cannot be recycled: ${removed.stderr}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true }); const result = await this.git(repo, ['worktree', 'add', '-b', branchName, target, base]); if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr}`); return target;
  }
  async setupWorktree(bugKey: string, repoDirOrUrl: string, branchName = this.createBranchName(bugKey, 'fix'), baseBranch = 'main'): Promise<string> {
    const repo = this.repoPath(repoDirOrUrl);
    return repositoryMutex.runExclusive(repo, async () => {
      let base = `origin/${baseBranch}`;
      const hasOrigin = await this.git(repo, ['remote', 'get-url', 'origin']);
      if (hasOrigin.exitCode === 0) {
        const fetched = await this.fetchUnlocked(repo, baseBranch);
        if (fetched.exitCode !== 0) throw new Error(`git fetch failed: ${fetched.stderr}`);
      } else base = 'HEAD';
      return this.setupWorktreeFromBase(bugKey, repo, branchName, base);
    });
  }
  /** Recreate a candidate against the exact immutable commit that produced it. */
  async setupWorktreeAtCommit(bugKey: string, repoDirOrUrl: string, branchName: string, baseCommit: string): Promise<string> {
    const repo = this.repoPath(repoDirOrUrl);
    if (!/^[a-f0-9]{7,64}$/i.test(baseCommit)) throw new Error('Candidate base commit is invalid');
    return repositoryMutex.runExclusive(repo, async () => {
      const present = await this.git(repo, ['cat-file', '-e', `${baseCommit}^{commit}`]);
      if (present.exitCode !== 0) throw new Error(`Candidate base commit is unavailable: ${baseCommit}`);
      return this.setupWorktreeFromBase(bugKey, repo, branchName, baseCommit);
    });
  }
  async createWorktree(bugKey: string, repoDirOrUrl: string, branchName?: string, baseBranch = 'main'): Promise<string> { return this.setupWorktree(bugKey, repoDirOrUrl, branchName ?? this.createBranchName(bugKey, 'fix'), baseBranch); }
  /**
   * Run a read-only diff while making untracked files visible to Git. Git's
   * normal `diff HEAD` omits files created by the fixer (including new
   * regression tests), so temporarily add intent-to-add entries for exactly
   * the current untracked paths. Only those empty index entries are removed in
   * the finally block; file contents are never staged and existing staged
   * changes are left untouched.
   */
  private async withUntrackedIntent<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const listed = await this.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (listed.exitCode !== 0) throw new Error(listed.stderr || 'Unable to list untracked files');
    const files = listed.stdout.split('\0').filter(Boolean);
    if (!files.length) return operation();
    const intent = await this.git(cwd, ['add', '-N', '--', ...files]);
    if (intent.exitCode !== 0) throw new Error(intent.stderr || 'Unable to snapshot untracked files');
    try {
      return await operation();
    } finally {
      const restored = await this.git(cwd, ['reset', '--quiet', '--', ...files]);
      if (restored.exitCode !== 0) throw new Error(restored.stderr || 'Unable to restore untracked file index state');
    }
  }
  async diff(worktreePath: string): Promise<string> {
    const cwd = this.checkedWorktree(worktreePath);
    return this.withUntrackedIntent(cwd, async () => {
      const result = await this.git(cwd, ['diff', '--binary', 'HEAD']); if (result.exitCode !== 0) throw new Error(result.stderr); return result.stdout;
    });
  }
  /** Return the exact base commit used by a worktree. */
  async headCommit(worktreePath: string): Promise<string> { const result = await this.git(this.checkedWorktree(worktreePath), ['rev-parse', 'HEAD']); if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to resolve worktree base commit'); const commit = result.stdout.trim(); if (!commit || commit.length > 128 || /[\0\r\n]/u.test(commit)) throw new Error('Worktree base commit is invalid'); return commit; }
  /** Derive changed paths from Git; model-reported filesChanged is never authoritative. */
  async filesChanged(worktreePath: string): Promise<string[]> {
    const cwd = this.checkedWorktree(worktreePath);
    return this.withUntrackedIntent(cwd, async () => {
      const result = await this.git(cwd, ['diff', '--name-only', '-z', 'HEAD']); if (result.exitCode !== 0) throw new Error(result.stderr || 'Unable to list changed files'); return result.stdout.split('\0').filter(Boolean);
    });
  }
  /**
   * Apply a preserved candidate patch with Git's binary-aware checker. The
   * patch is written to a server-generated temporary file and passed as one
   * argv item; no shell redirection or command interpolation is involved.
   */
  async applyPatch(worktreePath: string, patch: string, expectedBaseCommit?: string): Promise<void> {
    const cwd = this.checkedWorktree(worktreePath);
    const bytes = Buffer.byteLength(patch, 'utf8');
    if (!bytes || bytes > 10_000_000) throw new Error('Candidate patch size is invalid');
    const base = await this.headCommit(cwd);
    if (expectedBaseCommit && base.toLowerCase() !== expectedBaseCommit.toLowerCase()) throw new Error(`Candidate base commit mismatch: expected ${expectedBaseCommit}, got ${base}`);
    const digest = createHash('sha256').update(patch).digest('hex').slice(0, 24);
    const temporary = path.join(this.worktreesRoot, `.candidate-${digest}.patch`);
    fs.writeFileSync(temporary, patch, { encoding: 'utf8', mode: 0o600 });
    try {
      const checked = await this.git(cwd, ['apply', '--check', '--binary', '--whitespace=nowarn', '--', temporary]);
      if (checked.exitCode !== 0) throw new Error(`Candidate patch check failed: ${checked.stderr || checked.stdout}`);
      const applied = await this.git(cwd, ['apply', '--binary', '--whitespace=nowarn', '--', temporary]);
      if (applied.exitCode !== 0) throw new Error(`Candidate patch apply failed: ${applied.stderr || applied.stdout}`);
    } finally { try { fs.unlinkSync(temporary); } catch { /* best effort cleanup of exact temp file */ } }
  }
  private checkedWorktree(value: string): string { const resolved = path.resolve(value); if (!within(this.worktreesRoot, resolved)) throw new Error(`Worktree is outside configured root: ${value}`); if (!fs.existsSync(resolved)) throw new Error(`Worktree does not exist: ${value}`); return fs.realpathSync.native(resolved); }
  /** Resolve the main repository whose Git metadata is shared by a worktree. */
  private repositoryForWorktree(worktree: string): string {
    const gitEntry = path.join(worktree, '.git');
    try {
      if (fs.statSync(gitEntry).isFile()) {
        const contents = fs.readFileSync(gitEntry, 'utf8');
        const match = /^gitdir:\s*(.+)\s*$/imu.exec(contents);
        if (match?.[1]) {
          const gitDir = path.resolve(worktree, match[1].trim());
          const commonDirFile = path.join(gitDir, 'commondir');
          const commonDir = fs.existsSync(commonDirFile)
            ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
            : path.dirname(path.dirname(gitDir));
          const repository = path.dirname(commonDir);
          return this.repoPath(repository);
        }
      }
    } catch { /* repoPath below provides the stable, safe error */ }
    // A normal checkout has a directory `.git` and is its own repository.
    return this.repoPath(worktree);
  }
  private remoteHost(remote: string): string { try { const normalized = remote.startsWith('git@') ? `ssh://${remote.replace(':', '/')}` : remote; const parsed = new URL(normalized); if (!parsed.hostname) throw new Error('missing host'); return parsed.hostname.toLowerCase(); } catch { throw new Error(`Invalid remote URL: ${remote}`); } }
  private assertBranchNameSafe(branchName: string): void { if (!/^ai\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branchName) || branchName.includes('..') || branchName.includes('//')) throw new Error(`Only safe ai/* branches may be pushed: ${branchName}`); const leaf = branchName.slice(3); if (this.protectedBranches.some((item) => leaf === item || leaf.startsWith(`${item}/`)) || ['main', 'master', 'develop'].includes(branchName)) throw new Error(`Protected branch cannot be pushed: ${branchName}`); }
  private async assertPushSafe(worktreePath: string, branchName: string): Promise<void> { this.assertBranchNameSafe(branchName); const current = await this.git(worktreePath, ['branch', '--show-current']); if (current.exitCode !== 0 || current.stdout.trim() !== branchName) throw new Error('Current branch does not match requested branch'); const remote = await this.git(worktreePath, ['remote', 'get-url', 'origin']); if (remote.exitCode !== 0) throw new Error('origin remote is required'); const host = this.remoteHost(remote.stdout.trim()); if (this.allowedRemoteHosts.length && !this.allowedRemoteHosts.includes(host)) throw new Error(`Remote host is not allowed: ${host}`); }
  private async commitUnlocked(cwd: string, message: string): Promise<string> { const add = await this.git(cwd, ['add', '--all']); if (add.exitCode !== 0) throw new Error(add.stderr); const commit = await this.git(cwd, ['commit', '-m', message]); if (commit.exitCode !== 0) throw new Error(commit.stderr); const rev = await this.git(cwd, ['rev-parse', 'HEAD']); if (rev.exitCode !== 0) throw new Error(rev.stderr); return rev.stdout.trim(); }
  async commit(worktreePath: string, message: string): Promise<string> {
    const cwd = this.checkedWorktree(worktreePath);
    const repo = this.repositoryForWorktree(cwd);
    return repositoryMutex.runExclusive(repo, () => this.commitUnlocked(cwd, message));
  }
  /**
   * Ensure a remote named `own` points at the private mirror of the source
   * repository under the configured own account, creating the GitLab project
   * when it does not exist yet (see docs/gitlab-private-repo-api.md).
   */
  private async ensureOwnRemote(cwd: string): Promise<string> {
    const origin = await this.git(cwd, ['remote', 'get-url', 'origin']);
    if (origin.exitCode !== 0) throw new Error('origin remote is required');
    const url = await this.ownPushTarget!.ensureProject(mirrorProjectName(origin.stdout.trim()));
    const existing = await this.git(cwd, ['remote', 'get-url', 'own']);
    if (existing.exitCode === 0) {
      if (existing.stdout.trim() === url) return 'own';
      const updated = await this.git(cwd, ['remote', 'set-url', 'own', url]);
      if (updated.exitCode !== 0) throw new Error(updated.stderr || 'Unable to repoint the own-account push remote');
      return 'own';
    }
    const added = await this.git(cwd, ['remote', 'add', 'own', url]);
    if (added.exitCode !== 0) {
      // a concurrent push on the same clone may have added it first
      const retry = await this.git(cwd, ['remote', 'get-url', 'own']);
      if (retry.exitCode !== 0 || retry.stdout.trim() !== url) throw new Error(added.stderr || 'Unable to add the own-account push remote');
    }
    return 'own';
  }
  private async pushUnlocked(cwd: string, branchName: string): Promise<void> {
    await this.assertPushSafe(cwd, branchName);
    if (!this.ownPushTarget) {
      const result = await this.git(cwd, ['push', '--set-upstream', 'origin', branchName]);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return;
    }
    const remote = await this.ensureOwnRemote(cwd);
    // credential.helper=store keeps the push passwordless even when the global
    // git config has no helper configured; the PAT lives in ~/.git-credentials.
    const result = await this.git(cwd, ['-c', 'credential.helper=store', 'push', remote, `refs/heads/${branchName}:refs/heads/${branchName}`]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  async push(worktreePath: string, branchName: string): Promise<void> {
    const cwd = this.checkedWorktree(worktreePath);
    this.assertBranchNameSafe(branchName);
    const repo = this.repositoryForWorktree(cwd);
    await repositoryMutex.runExclusive(repo, () => this.pushUnlocked(cwd, branchName));
  }
  async commitAndPush(worktreePath: string, branchName: string, message: string, dryRun = false): Promise<{ commitSha: string | null; pushed: boolean }> {
    const cwd = this.checkedWorktree(worktreePath);
    if (dryRun) {
      const rev = await this.git(cwd, ['rev-parse', 'HEAD']);
      return { commitSha: rev.exitCode === 0 ? rev.stdout.trim() : null, pushed: false };
    }
    // Keep branch safety as the first gate.  In particular, a protected
    // branch must be rejected even if the caller's worktree metadata is
    // incomplete and cannot yet be mapped to its main repository.
    this.assertBranchNameSafe(branchName);
    const repo = this.repositoryForWorktree(cwd);
    return repositoryMutex.runExclusive(repo, async () => {
      await this.assertPushSafe(cwd, branchName);
      const sha = await this.commitUnlocked(cwd, message);
      await this.pushUnlocked(cwd, branchName);
      return { commitSha: sha, pushed: true };
    });
  }
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
  private async cleanupUnlocked(target: string, repo: string, branchName?: string): Promise<void> {
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
  async cleanup(worktreePath: string, repositoryRoot?: string, branchName?: string): Promise<void> {
    const target = this.looseWorktreePath(worktreePath); const repo = await this.repositoryForCleanup(target, repositoryRoot);
    if (!repo) { if (!fs.existsSync(target)) return; throw new Error(`Cannot identify the Git repository for worktree: ${target}`); }
    await repositoryMutex.runExclusive(repo, () => this.cleanupUnlocked(target, repo, branchName));
  }
  async cleanupWorktree(bugKey: string, repositoryRoot?: string, branchName?: string): Promise<void> { await this.cleanup(this.worktreePath(bugKey), repositoryRoot, branchName); }
}

const expectedAiBranch = (branch: string): boolean => /^ai\/BUG-[0-9]{6,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch);
