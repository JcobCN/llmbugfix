import { describe, expect, it } from 'vitest';
import { newId } from '@llmbugfix/shared';
import { V1Routes } from './v1-routes.js';
import { publicTaskStage, publicTaskStatus } from './task-service.js';

const taskId = newId();
const bug = {
  id: taskId,
  bugKey: 'BUG-000123',
  taskType: 'bugfix',
  title: 'Broken login',
  executionTarget: 'frontend',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function routes(allowedRepositoryHosts?: string[]) {
  const repo = {
    getBug: () => bug,
    listBugs: () => [bug],
    createExternalTask: () => ({ taskId }),
    listTaskEvents: (_taskId: string, options: { after?: number; limit?: number }) => Array.from({ length: options.limit ?? 0 }, (_, index) => ({
      eventId: newId(), sequence: (options.after ?? 0) + index + 1, taskId: _taskId, type: 'task.stage_changed', status: 'queued', stage: 'queued', occurredAt: '2026-01-01T00:00:00.000Z', data: {},
    })),
  } as never;
  return new V1Routes({ repo, allowedRepositoryHosts });
}

const request = (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, pathname, query: new URLSearchParams(), headers, body });

describe('external REST API v1 routes', () => {
  it('maps candidate and environment failures to terminal public failure', () => {
    expect(publicTaskStatus('FIX_CANDIDATE')).toBe('failed');
    expect(publicTaskStage('FIX_CANDIDATE')).toBe('failed');
    expect(publicTaskStatus('ENVIRONMENT_FAILED')).toBe('failed');
    expect(publicTaskStage('ENVIRONMENT_FAILED')).toBe('failed');
  });

  it('requires idempotency and returns an accepted task with links', async () => {
    const result = await routes().handle(request('POST', '/api/v1/tasks', { taskType: 'bugfix' }));
    expect(result?.status).toBe(400);
    expect((result?.body as { error: { code: string } }).error.code).toBe('MISSING_IDEMPOTENCY_KEY');

    const accepted = await routes().handle(request('POST', '/api/v1/tasks', {
      taskType: 'bugfix', title: 'Broken login', executionTarget: 'frontend', repository: { cloneUrl: 'https://git.example.test/team/project.git' },
      dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200',
      actualBehavior: 'No response', expectedBehavior: 'Go home', reproductionSteps: ['Click login'],
    }, { 'Idempotency-Key': 'create-1' }));
    expect(accepted?.status).toBe(202);
    expect((accepted?.body as { taskId: string; idempotent: boolean }).taskId).toBe(taskId);
    expect((accepted?.body as { idempotent: boolean }).idempotent).toBe(false);
    expect(accepted?.headers?.location).toBe(`/api/v1/tasks/${taskId}`);
  });

  it('extracts the real host for every supported remote form', async () => {
    const api = routes(['git.example.test']);
    const remotes = [
      'https://git.example.test/team/project.git',
      'http://git.example.test/team/project.git',
      'ssh://git@git.example.test/team/project.git',
      'git@git.example.test:team/project.git',
    ];
    for (const [index, cloneUrl] of remotes.entries()) {
      const response = await api.handle(request('POST', '/api/v1/tasks', {
        taskType: 'bugfix', title: 'Broken login', executionTarget: 'frontend', repository: { cloneUrl },
        dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200',
        actualBehavior: 'No response', expectedBehavior: 'Go home', reproductionSteps: ['Click login'],
      }, { 'Idempotency-Key': `host-allowed-${index}` }));
      expect(response?.status).toBe(202);
    }

    const rejectedRemotes = [
      'https://other.example.test/team/project.git',
      'http://other.example.test/team/project.git',
      'ssh://git@other.example.test/team/project.git',
      'git@other.example.test:team/project.git',
    ];
    for (const [index, cloneUrl] of rejectedRemotes.entries()) {
      const response = await api.handle(request('POST', '/api/v1/tasks', {
        taskType: 'bugfix', title: 'Broken login', executionTarget: 'frontend', repository: { cloneUrl },
        dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200',
        actualBehavior: 'No response', expectedBehavior: 'Go home', reproductionSteps: ['Click login'],
      }, { 'Idempotency-Key': `host-rejected-${index}` }));
      expect(response?.status).toBe(400);
      expect((response?.body as { error: { code: string } }).error.code).toBe('REPOSITORY_HOST_NOT_ALLOWED');
    }
  });

  it('returns INVALID_BASE_BRANCH for Git-invalid branch names', async () => {
    const invalidBranches = ['a..b', 'a@{b', 'feature.lock', '/main', 'main/', 'a//b', '@', 'main.', '-main', '.hidden', 'feature/.hidden', ' main', 'main ', '\u0001main', 'main\u007f'];
    for (const [index, baseBranch] of invalidBranches.entries()) {
      const response = await routes().handle(request('POST', '/api/v1/tasks', {
        taskType: 'bugfix', title: 'Broken login', executionTarget: 'frontend', repository: {
          cloneUrl: 'https://git.example.test/team/project.git', baseBranch,
        },
        dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200',
        actualBehavior: 'No response', expectedBehavior: 'Go home', reproductionSteps: ['Click login'],
      }, { 'Idempotency-Key': `branch-invalid-${index}` }));
      expect(response?.status).toBe(400);
      expect((response?.body as { error: { code: string } }).error.code).toBe('INVALID_BASE_BRANCH');
    }
  });

  it('supports task lookup, opaque list cursors, and event/result endpoints', async () => {
    const api = routes();
    const task = await api.handle(request('GET', `/api/v1/tasks/${taskId}`));
    expect(task?.status).toBe(200);
    expect((task?.body as { status: string }).status).toBe('queued');
    const list = await api.handle({ ...request('GET', '/api/v1/tasks'), query: new URLSearchParams('limit=20') });
    expect(list?.status).toBe(200);
    expect((list?.body as { data: unknown[]; nextCursor: string | null }).data).toHaveLength(1);
    const result = await api.handle(request('GET', `/api/v1/tasks/${taskId}/result`));
    expect(result?.status).toBe(202);
  });

  it('uses a lookahead event row for a full 100-item page', async () => {
    const query = new URLSearchParams('after=0&limit=100');
    const result = await routes().handle({ ...request('GET', `/api/v1/tasks/${taskId}/events`), query });
    expect(result?.status).toBe(200);
    const page = result?.body as { data: unknown[]; nextAfter: number | null; hasMore: boolean };
    expect(page.data).toHaveLength(100);
    expect(page.nextAfter).toBe(100);
    expect(page.hasMore).toBe(true);
  });
});
