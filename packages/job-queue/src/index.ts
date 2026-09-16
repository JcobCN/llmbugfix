import fs from 'node:fs';
import path from 'node:path';
import { newId, now, sanitizeDiagnostic } from '@llmbugfix/shared';
import { initializeDatabase, type SQLiteBugRepository, type SqliteDatabase } from '@llmbugfix/bug-repository';
import type { RoutingRequirements } from '@llmbugfix/api-contract';

export type QueueJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export interface QueueJob {
  id: string;
  bugId: string;
  status: QueueJobStatus;
  priority: number;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  error: string | null;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  claimedAt: string | null;
  routingRequirements: RoutingRequirements | null;
  failureClass: string | null;
  lastFailureBackendId: string | null;
}
export interface JobQueueOptions {
  lockFileName?: string;
  autoAcquireLock?: boolean;
  /** How long to wait for a live holder to release the process lock. */
  lockAcquireTimeoutMs?: number;
  /** Duration of a worker lease. Defaults to five minutes. */
  leaseTimeoutMs?: number;
}

export class LeaseFencedError extends Error {
  readonly code = 'LEASE_FENCED';
  constructor(jobId: string) {
    super(`Job ${jobId} is no longer owned by this worker lease`);
    this.name = 'LeaseFencedError';
  }
}

/**
 * SQLite-backed queue. Every ownership transition is fenced by a random lease
 * token in addition to worker id. Multiple jobs can consequently be RUNNING
 * at once, while a late worker can never write a reclaimed job's terminal
 * state.
 */
export class JobQueue {
  private readonly database: SqliteDatabase;
  private readonly lockFilePath: string;
  private lockFd: number | null = null;
  private readonly workerPid = process.pid;
  private readonly lockAcquireTimeoutMs: number;
  private readonly leaseTimeoutMs: number;

  constructor(repo: SQLiteBugRepository, private readonly dataDir: string, options: JobQueueOptions = {}) {
    this.database = repo.database;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.lockFilePath = path.join(this.dataDir, options.lockFileName ?? 'orchestrator.lock');
    this.lockAcquireTimeoutMs = Math.max(0, options.lockAcquireTimeoutMs ?? 5_000);
    this.leaseTimeoutMs = Math.max(1_000, options.leaseTimeoutMs ?? 300_000);
    // Re-opened/legacy databases are brought through the same versioned
    // migrations as the repository. No queue-specific index is synthesized.
    initializeDatabase(this.database);
    if (options.autoAcquireLock) this.acquireProcessLock();
  }

  public acquireProcessLock(): void {
    if (this.lockFd !== null) return;
    const deadline = Date.now() + this.lockAcquireTimeoutMs;
    for (;;) {
      let fd: number;
      try {
        fd = fs.openSync(this.lockFilePath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (this.removeDeadLock()) continue;
        if (Date.now() >= deadline) throw new Error(`Worker process lock is held: ${this.lockFilePath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
        continue;
      }
      fs.writeFileSync(fd, JSON.stringify({ pid: this.workerPid, startedAt: now() }), { encoding: 'utf8' });
      this.lockFd = fd;
      return;
    }
  }
  public acquireLock(): void { this.acquireProcessLock(); }

  private removeDeadLock(): boolean {
    try {
      const raw = fs.readFileSync(this.lockFilePath, 'utf8');
      let pid: number | undefined;
      try { pid = (JSON.parse(raw) as { pid?: number }).pid; } catch { pid = undefined; }
      if (typeof pid === 'number') {
        try { process.kill(pid, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
      }
      fs.unlinkSync(this.lockFilePath);
      return true;
    } catch { return false; }
  }
  public releaseProcessLock(): void {
    if (this.lockFd === null) return;
    try { fs.closeSync(this.lockFd); }
    finally { this.lockFd = null; try { fs.unlinkSync(this.lockFilePath); } catch { /* already released */ } }
  }
  public releaseLock(): void { this.releaseProcessLock(); }
  public close(): void { this.releaseProcessLock(); }

  private row(row: Record<string, unknown>): QueueJob {
    let routingRequirements: RoutingRequirements | null = null;
    if (row.routing_requirements != null) {
      try { routingRequirements = JSON.parse(String(row.routing_requirements)) as RoutingRequirements; } catch { routingRequirements = null; }
    }
    return {
      id: String(row.id), bugId: String(row.bug_id), status: String(row.status) as QueueJobStatus, priority: Number(row.priority), attempt: Number(row.attempt), createdAt: String(row.created_at),
      startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at), heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at), error: row.error == null ? null : String(row.error), workerId: row.worker_id == null ? null : String(row.worker_id), leaseToken: row.lease_token == null ? null : String(row.lease_token), leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at), claimedAt: row.claimed_at == null ? null : String(row.claimed_at), routingRequirements, failureClass: row.failure_class == null ? null : String(row.failure_class), lastFailureBackendId: row.last_failure_backend_id == null ? null : String(row.last_failure_backend_id),
    };
  }
  private get(id: string): QueueJob {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Job not found: ${id}`);
    return this.row(row);
  }
  public getJob(id: string): QueueJob { return this.get(id); }
  public listJobs(): QueueJob[] { return (this.database.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as Record<string, unknown>[]).map((row) => this.row(row)); }

  public enqueueJob(bugId: string, _bugKey?: string, priority = 10, routingRequirements?: RoutingRequirements): QueueJob {
    const transaction = this.database.transaction(() => {
      const bug = this.database.prepare('SELECT id FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { id: string } | undefined;
      if (!bug) throw new Error(`Bug report not found: ${bugId}`);
      const existing = this.database.prepare("SELECT * FROM jobs WHERE bug_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at ASC LIMIT 1").get(bug.id) as Record<string, unknown> | undefined;
      if (existing) return this.row(existing);
      const createdAt = now(); const id = newId();
      this.database.prepare('INSERT INTO jobs (id, bug_id, status, priority, attempt, created_at, routing_requirements) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, bug.id, 'QUEUED', priority, 0, createdAt, routingRequirements == null ? null : JSON.stringify(routingRequirements));
      return this.get(id);
    });
    try { return transaction(); }
    catch (error) {
      // A concurrent enqueue may win the partial unique index race. Return the
      // winning active job, preserving the one-active-job invariant.
      if ((error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const bug = this.database.prepare('SELECT id FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { id: string } | undefined;
        const existing = bug ? this.database.prepare("SELECT * FROM jobs WHERE bug_id = ? AND status IN ('QUEUED', 'RUNNING') ORDER BY created_at ASC LIMIT 1").get(bug.id) as Record<string, unknown> | undefined : undefined;
        if (existing) return this.row(existing);
      }
      throw error;
    }
  }
  public enqueue(bugId: string, priority = 10): QueueJob { return this.enqueueJob(bugId, undefined, priority); }

  public claimNextJob(workerId: string): QueueJob | null {
    this.acquireProcessLock();
    const transaction = this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY priority ASC, created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const claimedAt = now(); const leaseToken = newId(); const leaseExpiresAt = new Date(Date.now() + this.leaseTimeoutMs).toISOString();
      const updated = this.database.prepare("UPDATE jobs SET status = 'RUNNING', attempt = attempt + 1, started_at = ?, claimed_at = ?, heartbeat_at = ?, worker_id = ?, lease_token = ?, lease_expires_at = ?, error = NULL WHERE id = ? AND status = 'QUEUED'").run(claimedAt, claimedAt, claimedAt, workerId, leaseToken, leaseExpiresAt, row.id);
      if (updated.changes !== 1) return null;
      return this.get(String(row.id));
    });
    try { return transaction(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') return null; throw error; }
  }
  public claim(workerId: string): QueueJob | null { return this.claimNextJob(workerId); }

  private assertRowExists(id: string): Record<string, unknown> {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Job not found: ${id}`);
    return row;
  }
  private expireIfNeeded(row: Record<string, unknown>): boolean {
    if (row.status !== 'RUNNING' || row.lease_expires_at == null || Date.parse(String(row.lease_expires_at)) > Date.now()) return false;
    const changed = this.database.prepare("UPDATE jobs SET status = 'INTERRUPTED', finished_at = ?, error = ?, failure_class = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'RUNNING' AND lease_token = ?").run(now(), 'Worker lease expired; manual retry required', 'unknown', row.id, row.lease_token);
    return changed.changes === 1;
  }
  private leaseUpdate(id: string, status: 'COMPLETED' | 'FAILED', workerId: string, leaseToken: string, error?: string, failureClass?: string): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.assertRowExists(id);
      const updated = this.database.prepare(`UPDATE jobs SET status = ?, error = ?, failure_class = ?, finished_at = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'RUNNING' AND worker_id = ? AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)`).run(status, error == null ? null : sanitizeDiagnostic(error, 2048), failureClass ?? null, now(), id, workerId, leaseToken, now());
      if (updated.changes !== 1) {
        this.expireIfNeeded(row);
        throw new LeaseFencedError(id);
      }
      return this.get(id);
    });
    return transaction();
  }
  private heartbeatUpdate(id: string, workerId: string, leaseToken: string): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.assertRowExists(id);
      const heartbeat = now(); const expires = new Date(Date.now() + this.leaseTimeoutMs).toISOString();
      const updated = this.database.prepare("UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ? AND status = 'RUNNING' AND worker_id = ? AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)").run(heartbeat, expires, id, workerId, leaseToken, heartbeat);
      if (updated.changes !== 1) { this.expireIfNeeded(row); throw new LeaseFencedError(id); }
      return this.get(id);
    });
    return transaction();
  }

  public heartbeat(jobId: string, workerId: string, leaseToken: string): QueueJob { return this.heartbeatUpdate(jobId, workerId, leaseToken); }
  public heartbeatJob(jobId: string, workerId: string, leaseToken: string): QueueJob { return this.heartbeat(jobId, workerId, leaseToken); }
  public completeJob(jobId: string, workerId: string, leaseToken: string): QueueJob { return this.leaseUpdate(jobId, 'COMPLETED', workerId, leaseToken); }
  public failJob(jobId: string, error: string, workerId: string, leaseToken: string, failureClass?: string): QueueJob { return this.leaseUpdate(jobId, 'FAILED', workerId, leaseToken, error, failureClass); }
  public complete(jobId: string, workerId: string, leaseToken: string): QueueJob { return this.completeJob(jobId, workerId, leaseToken); }
  public fail(jobId: string, error: string, workerId: string, leaseToken: string, failureClass?: string): QueueJob { return this.failJob(jobId, error, workerId, leaseToken, failureClass); }

  /** Administrative cancellation does not need a worker lease. If ownership
   * is supplied, it is still fenced exactly like a worker update. */
  public cancelJob(jobId: string, workerId?: string, leaseToken?: string): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.assertRowExists(jobId);
      if (workerId !== undefined) {
        const changed = leaseToken ? this.database.prepare("UPDATE jobs SET status = 'CANCELLED', finished_at = ?, error = NULL, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('QUEUED', 'RUNNING') AND worker_id = ? AND lease_token = ?").run(now(), jobId, workerId, leaseToken) : { changes: 0 };
        if (changed.changes !== 1) { this.expireIfNeeded(row); throw new LeaseFencedError(jobId); }
      } else {
        const changed = this.database.prepare("UPDATE jobs SET status = 'CANCELLED', finished_at = ?, error = NULL, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status IN ('QUEUED', 'RUNNING')").run(now(), jobId);
        if (changed.changes !== 1) throw new Error(`Cannot cancel job ${jobId} from ${String(row.status)}`);
      }
      return this.get(jobId);
    });
    return transaction();
  }
  public cancel(jobId: string, workerId?: string, leaseToken?: string): QueueJob { return this.cancelJob(jobId, workerId, leaseToken); }

  /** Marks stale work interrupted. It intentionally does not enqueue it again. */
  public recoverStaleJobs(staleTimeoutMs = 60_000): QueueJob[] {
    this.acquireProcessLock(); const cutoff = Date.now() - staleTimeoutMs;
    const transaction = this.database.transaction(() => {
      const rows = this.database.prepare("SELECT * FROM jobs WHERE status = 'RUNNING'").all() as Record<string, unknown>[]; const recovered: QueueJob[] = [];
      for (const row of rows) {
        const heartbeat = row.heartbeat_at ?? row.started_at ?? row.created_at; const heartbeatStale = Date.parse(String(heartbeat)) < cutoff; const leaseStale = row.lease_expires_at != null && Date.parse(String(row.lease_expires_at)) <= Date.now();
        if (heartbeatStale || leaseStale) {
          this.database.prepare("UPDATE jobs SET status = 'INTERRUPTED', finished_at = ?, error = ?, failure_class = ?, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'RUNNING'").run(now(), 'Stale RUNNING job interrupted; manual retry required', 'unknown', row.id);
          recovered.push(this.get(String(row.id)));
        }
      }
      return recovered;
    });
    return transaction();
  }
  public recoverStale(staleTimeoutMs = 60_000): QueueJob[] { return this.recoverStaleJobs(staleTimeoutMs); }

  /** Manual retry preserves cumulative attempt and routing metadata. */
  public retryJob(jobId: string): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.assertRowExists(jobId);
      if (row.status !== 'FAILED' && row.status !== 'INTERRUPTED') throw new Error(`Only FAILED or INTERRUPTED jobs can be retried: ${jobId}`);
      this.database.prepare("UPDATE jobs SET status = 'QUEUED', started_at = NULL, finished_at = NULL, heartbeat_at = NULL, error = NULL, failure_class = NULL, last_failure_backend_id = NULL, worker_id = NULL, lease_token = NULL, lease_expires_at = NULL, claimed_at = NULL, created_at = ? WHERE id = ? AND status IN ('FAILED', 'INTERRUPTED')").run(now(), jobId);
      return this.get(jobId);
    });
    return transaction();
  }
  public retry(jobId: string): QueueJob { return this.retryJob(jobId); }
}
