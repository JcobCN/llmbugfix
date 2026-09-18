import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitLabPushTarget, RepoManager } from '../packages/repo-manager/src/index.js';

describe('Git remote safety integration contract', () => {
  it('rejects a GitLab push when no credential or explicit password exists', async () => {
    const target = new GitLabPushTarget({ baseUrl: 'http://git.example.invalid', account: 'llm-bot' });
    await expect(target.ensureProject('project')).rejects.toThrow(/no password configured|no pat/i);
  });

  it('enforces the configured allow-list for remote Git hosts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-worktrees-'));
    try {
      const manager = new RepoManager({ worktreesRoot: root, allowedRemoteHosts: ['git.example.test'] });
      expect(() => manager.validateRepoUrl('https://outside.example.test/team/repo.git')).toThrow(/not allowed/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
