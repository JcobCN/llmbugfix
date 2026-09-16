import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '@llmbugfix/bug-repository';
import { JobQueue, LeaseFencedError } from '@llmbugfix/job-queue';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BUG_ONE = '22222222-2222-4222-8222-222222222222';
const BUG_TWO = '33333333-3333-4333-8333-333333333333';
const setup = () => {
  const database = openDatabase(':memory:');
  const timestamp = new Date().toISOString();
  database.prepare('INSERT INTO users (id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(USER_ID, 'u', null, timestamp, timestamp);
  for (const [id, key] of [[BUG_ONE, 'BUG-000001'], [BUG_TWO, 'BUG-000002']] as const) database.prepare('INSERT INTO bug_reports (id, bug_key, reporter_id, status, report, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, key, USER_ID, 'QUEUED', '{}', timestamp, timestamp);
  return database;
};
const queueFor = (database: ReturnType<typeof openDatabase>) => new JobQueue({ database } as never, fs.mkdtempSync(path.join(os.tmpdir(), 'queue-')));

describe('JobQueue', () => {
  it('claims by priority and permits multiple independent running jobs', () => {
    const db = setup(); const queue = queueFor(db);
    const low = queue.enqueueJob(BUG_ONE, undefined, 20); const high = queue.enqueueJob(BUG_TWO, undefined, 1);
    const claimedHigh = queue.claimNextJob('worker-a');
    expect(claimedHigh?.id).toBe(high.id); expect(claimedHigh?.leaseToken).toBeTruthy();
    const claimedLow = queue.claimNextJob('worker-b');
    expect(claimedLow?.id).toBe(low.id); expect(queue.listJobs().filter((job) => job.status === 'RUNNING')).toHaveLength(2);
    queue.completeJob(high.id, 'worker-a', claimedHigh!.leaseToken!);
    queue.completeJob(low.id, 'worker-b', claimedLow!.leaseToken!);
    queue.close();
  });
  it('fences stale workers and recovers expired work without retrying', () => {
    const db = setup(); const queue = new JobQueue({ database: db } as never, fs.mkdtempSync(path.join(os.tmpdir(), 'queue-')), { leaseTimeoutMs: 1_000 });
    const job = queue.enqueueJob(BUG_ONE); const claimed = queue.claimNextJob('worker-a')!;
    db.prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00.000Z', heartbeat_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(job.id);
    expect(queue.recoverStaleJobs(1)[0]?.status).toBe('INTERRUPTED');
    expect(() => queue.completeJob(job.id, 'worker-a', claimed.leaseToken!)).toThrow(LeaseFencedError);
    expect(queue.claimNextJob('worker-b')).toBeNull(); expect(queue.retryJob(job.id).status).toBe('QUEUED');
    queue.close();
  });
  it('does not recreate the old global running index and enforces one active job per bug', () => {
    const db = setup(); const queue = queueFor(db);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'jobs_one_running_idx'").get()).toBeUndefined();
    const first = queue.enqueueJob(BUG_ONE); const second = queue.enqueueJob(BUG_ONE);
    expect(second.id).toBe(first.id); expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'jobs_active_bug_uidx'").get()).toBeTruthy();
    queue.close();
  });
  it('preserves attempt and routing metadata through manual retry', () => {
    const db = setup(); const queue = queueFor(db); const routing = { priority: 'high' as const, capabilityHints: ['typescript'], quality: 'high' as const };
    const job = queue.enqueueJob(BUG_ONE, undefined, 0, routing); const claimed = queue.claimNextJob('worker-a')!;
    queue.failJob(job.id, 'backend timeout', 'worker-a', claimed.leaseToken!, 'timeout');
    const retried = queue.retryJob(job.id);
    expect(retried.status).toBe('QUEUED'); expect(retried.attempt).toBe(1); expect(retried.routingRequirements).toEqual(routing); expect(retried.leaseToken).toBeNull();
    queue.close();
  });
  it('enforces an exclusive process lock and releases it', () => {
    const db = setup(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-')); const first = new JobQueue({ database: db } as never, dir); first.acquireProcessLock();
    const second = new JobQueue({ database: db } as never, dir, { lockAcquireTimeoutMs: 0 }); expect(() => second.acquireProcessLock()).toThrow(/process lock/); first.close(); expect(() => second.acquireProcessLock()).not.toThrow(); second.close();
  });
  it('takes over an empty or corrupt lock file left by a crashed holder', () => {
    const db = setup(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-')); fs.writeFileSync(path.join(dir, 'orchestrator.lock'), '');
    const queue = new JobQueue({ database: db } as never, dir, { lockAcquireTimeoutMs: 0 }); expect(() => queue.acquireProcessLock()).not.toThrow(); queue.close();
  });
  it('takes over a lock file whose holder pid no longer exists', () => {
    const db = setup(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-')); fs.writeFileSync(path.join(dir, 'orchestrator.lock'), JSON.stringify({ pid: 999_999_999 }));
    const queue = new JobQueue({ database: db } as never, dir, { lockAcquireTimeoutMs: 0 }); expect(() => queue.acquireProcessLock()).not.toThrow(); queue.close();
  });
});
