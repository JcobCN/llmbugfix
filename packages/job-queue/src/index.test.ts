import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@llmbugfix/bug-repository';
import { JobQueue } from '@llmbugfix/job-queue';

const setup = () => {
  const database = openDatabase(':memory:'); const user = database.prepare('INSERT INTO users (id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('11111111-1111-4111-8111-111111111111', 'u', null, new Date().toISOString(), new Date().toISOString()); void user;
  database.prepare('INSERT INTO bug_reports (id, bug_key, reporter_id, status, report, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('22222222-2222-4222-8222-222222222222', 'BUG-000001', '11111111-1111-4111-8111-111111111111', 'QUEUED', '{}', new Date().toISOString(), new Date().toISOString());
  return database;
};

describe('JobQueue', () => {
  it('claims by priority and permits only one running job', () => { const db = setup(); const queue = new JobQueue({ database: db } as never, fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'))); const low = queue.enqueueJob('22222222-2222-4222-8222-222222222222', undefined, 20); const high = queue.enqueueJob(low.bugId, undefined, 1); expect(queue.claimNextJob('a')?.id).toBe(high.id); expect(queue.claimNextJob('b')).toBeNull(); queue.completeJob(high.id, 'a'); expect(queue.claimNextJob('b')?.id).toBe(low.id); queue.close(); });
  it('recovers stale work as INTERRUPTED and retries only manually', () => { const db = setup(); const queue = new JobQueue({ database: db } as never, fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'))); const job = queue.enqueueJob('22222222-2222-4222-8222-222222222222'); expect(queue.claimNextJob('a')?.id).toBe(job.id); db.prepare("UPDATE jobs SET heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(job.id); expect(queue.recoverStaleJobs(1)[0]?.status).toBe('INTERRUPTED'); expect(queue.claimNextJob('b')).toBeNull(); expect(queue.retryJob(job.id).status).toBe('QUEUED'); queue.close(); });
  it('enforces an exclusive process lock and releases it', () => { const db = setup(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-')); const first = new JobQueue({ database: db } as never, dir); first.acquireProcessLock(); const second = new JobQueue({ database: db } as never, dir); expect(() => second.acquireProcessLock()).toThrow(/process lock/); first.close(); expect(() => second.acquireProcessLock()).not.toThrow(); second.close(); });
});
