import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RepoManager } from './index.js';

class FakeRunner { calls: string[][] = []; cwds: string[] = []; async run(command: string, args: string[], options: any): Promise<any> { this.calls.push([command, ...args]); this.cwds.push(options.cwd); const text = args.join(' '); if (text.includes('branch --show-current')) return { command, args, exitCode: 0, stdout: 'ai/BUG-000001-fix\n', stderr: '', timedOut: false }; if (text.includes('remote get-url origin')) return { command, args, exitCode: 0, stdout: 'https://localhost/example.git\n', stderr: '', timedOut: false }; if (args[0] === 'rev-parse') return { command, args, exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false }; return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false }; } }
describe('RepoManager', () => {
  it('uses safe slug and rejects push on a protected/non-ai branch', async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const repo = path.join(root, 'repo'); const wtRoot = path.join(root, 'worktrees'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(wtRoot); const wt = path.join(wtRoot, 'BUG-000001'); fs.mkdirSync(wt); const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [root], allowedRemoteHost: 'localhost', commandRunner: fake as any }); expect(manager.createBranchName('BUG-000001', '../../ Unsafe title!')).toBe('ai/BUG-000001-unsafe-title'); await expect(manager.commitAndPush(wt, 'main', 'bad')).rejects.toThrow(/ai|protected/); });
  it('checks branch and remote before push', async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-repo-')); const wtRoot = path.join(root, 'worktrees'); const wt = path.join(wtRoot, 'BUG-000001'); fs.mkdirSync(path.join(wt, '.git'), { recursive: true }); const fake = new FakeRunner(); const manager = new RepoManager({ worktreesRoot: wtRoot, repositoryRoots: [root], allowedRemoteHost: 'localhost', commandRunner: fake as any }); await manager.push(wt, 'ai/BUG-000001-fix'); expect(fake.calls.some((x) => x.includes('push'))).toBe(true); });
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
  it('does not overwrite a completed generated checkout for another remote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-clone-')); const clones = path.join(root, 'repositories'); const target = path.join(clones, 'remote-1234567890abcdef');
    fs.mkdirSync(path.join(target, '.git'), { recursive: true });
    const runner = { async run(command: string, args: string[]): Promise<any> { return { command, args, exitCode: 0, stdout: 'https://git.example.test/other/project.git\n', stderr: '', timedOut: false }; } };
    const manager = new RepoManager({ worktreesRoot: path.join(root, 'worktrees'), cloneRoot: clones, commandRunner: runner as any });
    await expect(manager.cloneRemoteRepository('https://git.example.test/team/storefront.git', 'remote-1234567890abcdef')).rejects.toThrow(/different remote/);
    expect(fs.existsSync(target)).toBe(true);
  });
});
