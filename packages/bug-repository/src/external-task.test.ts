import { describe, expect, it } from 'vitest';
import { ExternalTaskCreateRequestSchema } from '@llmbugfix/api-contract';
import { openDatabase, SQLiteBugRepository, IdempotencyConflictError } from './index.js';

const request = ExternalTaskCreateRequestSchema.parse({
  taskType: 'bugfix', title: 'Fix login', executionTarget: 'frontend', repository: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'main' },
  dev_env_snapshot: 'r35.1', dev_env_special: ['raw-spofer-pel v2.0.200', 'another-module v1.2.3'],
  actualBehavior: 'The button does nothing', expectedBehavior: 'The home page opens', reproductionSteps: ['Open login', 'Click login'], routing: { priority: 'high', capabilityHints: ['typescript', 'react'], quality: 'high' },
});

describe('external task transaction', () => {
  it('creates all records once and makes the operation idempotent', () => {
    const database = openDatabase(':memory:'); const repository = new SQLiteBugRepository(database);
    const first = repository.createExternalTask(request, 'external-key'); const second = repository.createExternalTask(request, 'external-key');
    expect(second.taskId).toBe(first.taskId); expect(second.jobId).toBe(first.jobId); expect(second.idempotent).toBe(true);
    expect(repository.getBug(first.taskId)).toMatchObject({ dev_env_snapshot: request.dev_env_snapshot, dev_env_special: request.dev_env_special });
    expect(database.prepare('SELECT COUNT(*) AS count FROM bug_reports').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM task_repositories').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM idempotency_keys').get()).toEqual({ count: 1 });
    expect(repository.listTaskEvents(first.taskId)).toHaveLength(2);
    database.close();
  });
  it('normalizes legacy persisted special-version strings to arrays', () => {
    const database = openDatabase(':memory:'); const repository = new SQLiteBugRepository(database);
    const created = repository.createExternalTask(request, 'legacy-special-key');
    const row = database.prepare('SELECT report FROM bug_reports WHERE id = ?').get(created.taskId) as { report: string };
    const legacyReport = JSON.parse(row.report) as Record<string, unknown>;
    legacyReport.dev_env_special = 'legacy-module v0.9.0';
    database.prepare('UPDATE bug_reports SET report = ? WHERE id = ?').run(JSON.stringify(legacyReport), created.taskId);
    expect(repository.getBug(created.taskId)?.dev_env_special).toEqual(['legacy-module v0.9.0']);
    database.close();
  });
  it('rejects reuse of a key with a different request body', () => {
    const database = openDatabase(':memory:'); const repository = new SQLiteBugRepository(database);
    repository.createExternalTask(request, 'external-key');
    expect(() => repository.createExternalTask({ ...request, title: 'Different' }, 'external-key')).toThrow(IdempotencyConflictError);
    expect(database.prepare('SELECT COUNT(*) AS count FROM bug_reports').get()).toEqual({ count: 1 });
    database.close();
  });
  it('allows one internal lookahead row while rejecting larger event pages', () => {
    const database = openDatabase(':memory:'); const repository = new SQLiteBugRepository(database);
    const task = repository.createExternalTask(request, 'lookahead-key');
    for (let index = 0; index < 101; index += 1) repository.appendTaskEvent(task.taskId, { type: 'task.stage_changed', status: 'running', stage: 'fixing', data: { index } });
    expect(repository.listTaskEvents(task.taskId, { limit: 101 })).toHaveLength(101);
    expect(() => repository.listTaskEvents(task.taskId, { limit: 102 })).toThrow(/limit/);
    database.close();
  });
  it('maps terminal stages and retry transitions to public event states', () => {
    const database = openDatabase(':memory:'); const repository = new SQLiteBugRepository(database);
    const failed = repository.createExternalTask(request, 'status-map-failed');
    repository.changeBugStatus(failed.taskId, 'PREPARING_ENV');
    repository.changeBugStatus(failed.taskId, 'FIXING');
    repository.changeBugStatus(failed.taskId, 'FIX_CANDIDATE');
    let events = repository.listTaskEvents(failed.taskId);
    expect(events.at(-1)).toMatchObject({ type: 'task.failed', status: 'failed', stage: 'failed' });
    repository.changeBugStatus(failed.taskId, 'QUEUED', 'external_retry');
    events = repository.listTaskEvents(failed.taskId);
    expect(events.at(-1)).toMatchObject({ type: 'task.retry_requested', status: 'queued', stage: 'queued' });

    const ready = repository.createExternalTask(request, 'status-map-ready');
    for (const status of ['PREPARING_ENV', 'FIXING', 'VALIDATING', 'REVIEWING', 'FIX_READY', 'PUSHING', 'READY_FOR_HUMAN_REVIEW'] as const) repository.changeBugStatus(ready.taskId, status);
    events = repository.listTaskEvents(ready.taskId);
    expect(events.at(-1)).toMatchObject({ type: 'task.completed', status: 'succeeded', stage: 'human_review' });
    database.close();
  });
});
