import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RepoManager, type OwnPushTarget } from './index.js';

class FakeRunner { calls: string[][] = []; cwds: string[] = []; environments: Array<NodeJS.ProcessEnv | undefined> = []; async run(command: string, args: string[], options: any): Promise<any> { this.calls.push([command, ...args]); this.cwds.push(options.cwd); this.environments.push(options.env); const text = args.join(' '); if (text.includes('branch --show-current')) return { command, args, exitCode: 0, stdout: 'ai/BUG-000001-fix\n', stderr: '', timedOut: false }; if (text.includes('remote get-url origin')) return { command, args, exitCode: 0, stdout: 'https://localhost/example.git\n', stderr: '', timedOut: false }; if (args[0] === 'rev-parse') return { command, args, exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false }; return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false }; } }
class UntrackedRunner extends FakeRunner {
  intentAdded = false;
  override async run(command: string, args: string[], options: any): Promise<any> {
    this.calls.push([command, ...args]); this.cwds.push(options.cwd);
    if (args[0] === 'ls-files') return { command, args, exitCode: 0, stdout: 'new-regression.test.ts\0', stderr: '', timedOut: false };
    if (args[0] === 'add' && args[1] === '-N') { this.intentAdded = true; return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false }; }
    if (args[0] === 'reset') { this.intentAdded = false; return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false }; }
    if (args[0] === 'diff' && args.includes('--name-only')) return { command, args, exitCode: 0, stdout: 'new-regression.test.ts\0', stderr: '', timedOut: false };
    if (args[0] === 'diff') return { command, args, exitCode: 0, stdout: 'diff --git a/new-regression.test.ts b/new-regression.test.ts\n+test\n', stderr: '', timedOut: false };
    return super.run(command, args, options);
  }
}
describe('RepoManager', () => {
  it('uses safe slug and rejects push on a protected/non-ai branch', async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(wtRoot); const wt = path.join(wtRoot, 'BUG-000001'); fs.mkdirSync(wt); const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [root], allowedRemoteHost: 'localhost', commandRunner: fake as any }); expect(manager.createBranchName('BUG-000001', '../../ Unsafe title!')).toBe('ai/BUG-000001-unsafe-title'); await expect(manager.commitAndPush(wt, 'main', 'bad')).rejects.toThrow(/ai|protected/); });
  it('checks branch and remote before push', async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const wtRoot = path.join(root, 'worktrees'); const wt = path.join(wtRoot, 'BUG-000001'); fs.mkdirSync(path.join(wt, '.git'), { recursive: true }); const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [root], allowedRemoteHost: 'localhost', commandRunner: fake as any }); await manager.push(wt, 'ai/BUG-000001-fix'); expect(fake.calls.some((x) => x.includes('push'))).toBe(true); });
  it('pushes ai/* branches to the own-account private mirror instead of origin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const wtRoot = path.join(root, 'worktrees'); const wt = path.join(wtRoot, 'BUG-000001'); fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
    const mirror = 'http://172.29.100.126/codigger-llm/example.git';
    const requested: string[] = [];
    const own: OwnPushTarget = { ensureProject: async (name) => { requested.push(name); return mirror; } };
    let ownKnown = false;
    const fake = new FakeRunner();
    const runner = { async run(command: string, args: any[], options: any): Promise<any> {
      const result = await fake.run(command, args, options);
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'own') return { command, args, exitCode: ownKnown ? 0 : 2, stdout: ownKnown ? `${mirror}\n` : '', stderr: ownKnown ? '' : "error: No such remote 'own'\n", timedOut: false };
      return result;
    } };
    let credentialCalls = 0;
    const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [root], allowedRemoteHost: 'localhost', commandRunner: runner as any, ownPushTarget: own, gitCredentialProvider: { async gitCredentialEnvironment() { credentialCalls += 1; return { LLMBUGFIX_GIT_TOKEN: 'pat-in-memory' }; } } });
    await manager.push(wt, 'ai/BUG-000001-fix');
    expect(requested).toEqual(['example']);
    expect(fake.calls.some((call) => call.join(' ') === `git remote add own ${mirror}`)).toBe(true);
    const pushed = fake.calls.filter((call) => call[1] === 'push');
    expect(pushed.at(-1)).toEqual(['git', 'push', 'own', 'refs/heads/ai/BUG-000001-fix:refs/heads/ai/BUG-000001-fix']);
    expect(credentialCalls).toBe(1);
    expect(fake.calls.some((call) => call.includes('origin') && call[1] === 'push')).toBe(false);
    // a second push reuses the existing remote without re-adding it
    ownKnown = true;
    await manager.push(wt, 'ai/BUG-000001-fix');
    expect(fake.calls.filter((call) => call.join(' ').startsWith('git remote add'))).toHaveLength(1);
    expect(credentialCalls).toBe(2);
  });
  it('keeps Chinese titles identifiable with an ASCII-safe branch name', () => {
    const manager = new RepoManager(fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-worktrees-')));
    const branch = manager.createBranchName('BUG-000001', '登录按钮点击无响应');
    expect(branch).toMatch(/^ai\/BUG-000001-title-[a-f0-9]{10}$/);
    expect(branch).not.toBe('ai/BUG-000001-fix');
  });
  it('removes a registered worktree from the associated repository, never worktreesRoot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(wtRoot); const target = path.join(wtRoot, 'BUG-000001'); fs.mkdirSync(target);
    const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [repo], commandRunner: fake as any });
    await manager.cleanupWorktree('BUG-000001', repo, 'ai/BUG-000001-title-abcdef1234');
    expect(fake.calls.some((call) => call.slice(0, 4).join(' ') === 'git worktree remove --force')).toBe(true);
    expect(fake.cwds).toContain(fs.realpathSync(repo)); expect(fake.cwds).not.toContain(fs.realpathSync(wtRoot)); expect(fs.existsSync(target)).toBe(false);
  });
  it('cleans the exact bug worktree before every setup, including a missing-directory retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(wtRoot);
    const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [repo], commandRunner: fake as any });
    await manager.setupWorktree('BUG-000001', repo, 'ai/BUG-000001-retry', 'main');
    expect(fake.calls.some((call) => call.join(' ') === `git worktree remove --force ${path.join(wtRoot, 'BUG-000001')}`)).toBe(true);
    expect(fake.cwds).toContain(fs.realpathSync(repo));
  });
  it('clones a confirmed Git remote into its dedicated local checkout root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-clone-')); const clones = path.join(root, 'repositories'); const remote = 'https://git.example.test/team/storefront.git';
    const calls: string[][] = []; const runner = { async run(command: string, args: string[]): Promise<any> { calls.push([command, ...args]); if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1)!, '.git'), { recursive: true }); if (args[0] === 'remote') return { command, args, exitCode: 0, stdout: `${remote}\n`, stderr: '', timedOut: false }; return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false }; } };
    const manager = new RepoManager({ worktreesRoot: path.join(root, 'worktrees'), cloneRoot: clones, commandRunner: runner as any });
    const cloned = await manager.cloneRemoteRepository(remote, 'remote-1234567890abcdef');
    expect(fs.existsSync(path.join(cloned, '.git'))).toBe(true);
    await expect(manager.cloneRemoteRepository(remote, 'remote-1234567890abcdef')).resolves.toBe(cloned);
    expect(calls.filter((call) => call.includes('clone'))).toHaveLength(1);
  });

  it('serializes concurrent clone attempts for the same checkout target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-clone-'));
    const clones = path.join(root, 'repositories');
    const remote = 'https://git.example.test/team/storefront.git';
    let cloneCount = 0;
    let activeClones = 0;
    let maxActiveClones = 0;
    const runner = {
      async run(command: string, args: string[]): Promise<any> {
        if (args[0] === 'clone') {
          cloneCount += 1;
          activeClones += 1;
          maxActiveClones = Math.max(maxActiveClones, activeClones);
          await new Promise((resolve) => setTimeout(resolve, 5));
          fs.mkdirSync(path.join(args.at(-1)!, '.git'), { recursive: true });
          activeClones -= 1;
        }
        if (args[0] === 'remote') return { command, args, exitCode: 0, stdout: `${remote}\n`, stderr: '', timedOut: false };
        return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const manager = new RepoManager({ worktreesRoot: path.join(root, 'worktrees'), cloneRoot: clones, commandRunner: runner as any });
    const checkouts = await Promise.all([
      manager.cloneRemoteRepository(remote, 'remote-concurrent'),
      manager.cloneRemoteRepository(remote, 'remote-concurrent'),
      manager.cloneRemoteRepository(remote, 'remote-concurrent'),
    ]);
    expect(new Set(checkouts).size).toBe(1);
    expect(cloneCount).toBe(1);
    expect(maxActiveClones).toBe(1);
  });

  it('serializes remote setup and own-remote changes for worktrees of one repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-lock-'));
    const repo = path.join(root, 'repo');
    const wtRoot = path.join(root, 'worktrees');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees'), { recursive: true });
    fs.mkdirSync(wtRoot);
    const worktrees = ['BUG-000001', 'BUG-000002'].map((bug, index) => {
      const worktree = path.join(wtRoot, bug);
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', `wt-${index}`)}\n`);
      return worktree;
    });
    let ownKnown = false;
    let activeGitOperations = 0;
    let maxActiveGitOperations = 0;
    let remoteAdds = 0;
    const mirror = 'http://git.example.test/own/storefront.git';
    const runner = {
      async run(command: string, args: string[], options: { cwd: string }): Promise<any> {
        activeGitOperations += 1;
        maxActiveGitOperations = Math.max(maxActiveGitOperations, activeGitOperations);
        await new Promise((resolve) => setTimeout(resolve, 2));
        activeGitOperations -= 1;
        if (args[0] === 'branch' && args[1] === '--show-current') return { command, args, exitCode: 0, stdout: `${path.basename(options.cwd) === 'BUG-000001' ? 'ai/BUG-000001-fix' : 'ai/BUG-000002-fix'}\n`, stderr: '', timedOut: false };
        if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') return { command, args, exitCode: 0, stdout: 'https://git.example.test/team/storefront.git\n', stderr: '', timedOut: false };
        if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'own') return { command, args, exitCode: ownKnown ? 0 : 2, stdout: ownKnown ? `${mirror}\n` : '', stderr: ownKnown ? '' : 'missing', timedOut: false };
        if (args[0] === 'remote' && args[1] === 'add') { remoteAdds += 1; ownKnown = true; }
        if (args[0] === '-c') return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false };
        return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    const ensureCalls: string[] = [];
    const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [repo], allowedRemoteHost: 'git.example.test', commandRunner: runner as any, ownPushTarget: { ensureProject: async (name) => { ensureCalls.push(name); await new Promise((resolve) => setTimeout(resolve, 2)); return mirror; } } });
    await Promise.all(worktrees.map((worktree, index) => manager.push(worktree, `ai/BUG-00000${index + 1}-fix`)));
    expect(maxActiveGitOperations).toBe(1);
    expect(remoteAdds).toBe(1);
    expect(ensureCalls).toEqual(['storefront', 'storefront']);
  });
  it('checks a candidate patch against the exact base and removes its temporary file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-candidate-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees'); const wt = path.join(wtRoot, 'BUG-000001');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
    const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [repo], commandRunner: fake as any }); const patch = 'diff --git a/file.txt b/file.txt\n';
    await manager.applyPatch(wt, patch, 'abc123');
    const applyCalls = fake.calls.filter((call) => call[1] === 'apply');
    expect(applyCalls).toHaveLength(2); expect(applyCalls[0][2]).toBe('--check'); expect(applyCalls[0][3]).toBe('--binary'); expect(applyCalls[0].at(-1)).toBe(applyCalls[1].at(-1));
    const temporary = applyCalls[0].at(-1)!; expect(temporary).toMatch(/\.candidate-[a-f0-9]{24}\.patch$/u); expect(fs.existsSync(temporary)).toBe(false);
  });
  it('fails closed when a candidate patch base does not match', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-candidate-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees'); const wt = path.join(wtRoot, 'BUG-000001');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
    const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [repo], commandRunner: fake as any });
    await expect(manager.applyPatch(wt, 'candidate', 'different-base')).rejects.toThrow(/base commit mismatch/);
    expect(fake.calls.some((call) => call[1] === 'apply')).toBe(false);
  });
  it('includes untracked fixer files in snapshots without leaving index intent entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-untracked-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees'); const wt = path.join(wtRoot, 'BUG-000001');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(path.join(wt, '.git'), { recursive: true });
    const fake = new UntrackedRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [repo], commandRunner: fake as any });
    await expect(manager.diff(wt)).resolves.toContain('new-regression.test.ts'); await expect(manager.filesChanged(wt)).resolves.toEqual(['new-regression.test.ts']);
    expect(fake.intentAdded).toBe(false); expect(fake.calls.filter((call) => call[1] === 'add' && call[2] === '-N')).toHaveLength(2); expect(fake.calls.filter((call) => call[1] === 'reset')).toHaveLength(2);
  });
  it('does not overwrite a completed generated checkout for another remote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-clone-')); const clones = path.join(root, 'repositories'); const target = path.join(clones, 'remote-1234567890abcdef');
    fs.mkdirSync(path.join(target, '.git'), { recursive: true });
    const runner = { async run(command: string, args: string[]): Promise<any> { return { command, args, exitCode: 0, stdout: 'https://git.example.test/other/project.git\n', stderr: '', timedOut: false }; } };
    const manager = new RepoManager({ worktreesRoot: path.join(root, 'worktrees'), cloneRoot: clones, commandRunner: runner as any });
    await expect(manager.cloneRemoteRepository('https://git.example.test/team/storefront.git', 'remote-1234567890abcdef')).rejects.toThrow(/different remote/);
    expect(fs.existsSync(target)).toBe(true);
  });
});
