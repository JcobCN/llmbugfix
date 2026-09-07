import fs from 'node:fs';
import path from 'node:path';
import { newId, now } from '@llmbugfix/shared';
import type { SQLiteBugRepository, SqliteDatabase } from '@llmbugfix/bug-repository';

export type QueueJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export interface QueueJob {
  id: string; bugId: string; status: QueueJobStatus; priority: number; attempt: number; createdAt: string;
  startedAt: string | null; finishedAt: string | null; heartbeatAt: string | null; error: string | null; workerId?: string | null;
}
export interface JobQueueOptions { lockFileName?: string; autoAcquireLock?: boolean; /** How long to wait for a live holder to release the lock before failing. */
  lockAcquireTimeoutMs?: number; }

/**
 * SQLite-backed single-task queue. Every state transition is one transaction;
 * worker ownership prevents a late worker from completing a recovered job.
 */
export class JobQueue {
  private readonly database: SqliteDatabase;
  private readonly lockFilePath: string;
  private lockFd: number | null = null;
  private readonly workerPid = process.pid;
  private readonly lockAcquireTimeoutMs: number;

  constructor(repo: SQLiteBugRepository, private readonly dataDir: string, options: JobQueueOptions = {}) {
    this.database = repo.database;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.lockFilePath = path.join(this.dataDir, options.lockFileName ?? 'orchestrator.lock');
    this.lockAcquireTimeoutMs = Math.max(0, options.lockAcquireTimeoutMs ?? 5_000);
    this.ensureQueueSchema();
    if (options.autoAcquireLock) this.acquireProcessLock();
  }

  private ensureQueueSchema(): void {
    // Existing repositories predate worker ownership and INTERRUPTED. SQLite
    // migrations here remain additive and do not require changing WP02 files.
    this.database.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, heartbeat_at TEXT, error TEXT)');
    const columns = this.database.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'worker_id')) this.database.exec('ALTER TABLE jobs ADD COLUMN worker_id TEXT');
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_idx ON jobs(status) WHERE status = 'RUNNING'");
  }

  public acquireProcessLock(): void {
    if (this.lockFd !== null) return;
    // A live holder may still be shutting down (dev restarts race the graceful
    // close path), so retry briefly before declaring the lock unavailable.
    const deadline = Date.now() + this.lockAcquireTimeoutMs;
    for (;;) {
      let fd: number;
      try { fd = fs.openSync(this.lockFilePath, 'wx', 0o600); }
      catch (error) {
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
      // An empty or corrupt file means a holder crashed between creating the
      // lock and writing its pid; the lock is stale and safe to take over.
      let pid: number | undefined;
      try { pid = (JSON.parse(raw) as { pid?: number }).pid; } catch { pid = undefined; }
      if (typeof pid === 'number') { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; } }
      fs.unlinkSync(this.lockFilePath); return true;
    } catch { return false; }
  }

  public releaseProcessLock(): void {
    if (this.lockFd === null) return;
    try { fs.closeSync(this.lockFd); } finally { this.lockFd = null; try { fs.unlinkSync(this.lockFilePath); } catch { /* already released */ } }
  }
  public releaseLock(): void { this.releaseProcessLock(); }
  public close(): void { this.releaseProcessLock(); }

  private row(row: Record<string, unknown>): QueueJob {
    return {
      id: String(row.id), bugId: String(row.bug_id), status: String(row.status) as QueueJobStatus,
      priority: Number(row.priority), attempt: Number(row.attempt), createdAt: String(row.created_at),
      startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at),
      heartbeatAt: row.heartbeat_at == null ? null : String(row.heartbeat_at), error: row.error == null ? null : String(row.error), workerId: row.worker_id == null ? null : String(row.worker_id)
    };
  }
  private get(id: string): QueueJob {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Job not found: ${id}`); return this.row(row);
  }
  public getJob(id: string): QueueJob { return this.get(id); }
  public listJobs(): QueueJob[] { return (this.database.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as Record<string, unknown>[]).map((row) => this.row(row)); }

  public enqueueJob(bugId: string, _bugKey?: string, priority = 10): QueueJob {
    const transaction = this.database.transaction(() => {
      const bug = this.database.prepare('SELECT id FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugId, bugId) as { id: string } | undefined;
      if (!bug) throw new Error(`Bug report not found: ${bugId}`);
      const value: QueueJob = { id: newId(), bugId: bug.id, status: 'QUEUED', priority, attempt: 0, createdAt: now(), startedAt: null, finishedAt: null, heartbeatAt: null, error: null, workerId: null };
      this.database.prepare('INSERT INTO jobs (id, bug_id, status, priority, attempt, created_at, worker_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(value.id, value.bugId, value.status, value.priority, value.attempt, value.createdAt, null);
      return value;
    });
    return transaction();
  }
  public enqueue(bugId: string, priority = 10): QueueJob { return this.enqueueJob(bugId, undefined, priority); }

  public claimNextJob(workerId: string): QueueJob | null {
    this.acquireProcessLock();
    const transaction = this.database.transaction(() => {
      const running = this.database.prepare("SELECT 1 FROM jobs WHERE status = 'RUNNING' LIMIT 1").get();
      if (running) return null;
      const row = this.database.prepare("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY priority ASC, created_at ASC LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const started = now();
      const updated = this.database.prepare("UPDATE jobs SET status = 'RUNNING', attempt = attempt + 1, started_at = ?, heartbeat_at = ?, worker_id = ?, error = NULL WHERE id = ? AND status = 'QUEUED'").run(started, started, workerId, row.id);
      if (updated.changes !== 1) return null;
      return this.row({ ...row, status: 'RUNNING', attempt: Number(row.attempt) + 1, started_at: started, heartbeat_at: started, worker_id: workerId, error: null });
    });
    try { return transaction(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY' || (error as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE') return null; throw error; }
  }
  public claim(workerId: string): QueueJob | null { return this.claimNextJob(workerId); }

  private transition(id: string, status: QueueJobStatus, workerId?: string, error?: string | null): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Job not found: ${id}`);
      const current = String(row.status) as QueueJobStatus;
      if (workerId && row.worker_id !== workerId) throw new Error(`Job ${id} is not owned by worker ${workerId}`);
      const allowed = status === 'CANCELLED' ? current === 'QUEUED' || current === 'RUNNING' : current === 'RUNNING';
      if (!allowed) throw new Error(`Cannot transition job ${id} from ${current} to ${status}`);
      const finished = status === 'RUNNING' ? null : now();
      const heartbeat = status === 'RUNNING' ? (row.heartbeat_at ?? now()) : row.heartbeat_at;
      this.database.prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ?, heartbeat_at = ? WHERE id = ?').run(status, error === undefined ? row.error : error, finished, heartbeat, id);
      return this.get(id);
    });
    return transaction();
  }
  public heartbeat(jobId: string, workerId: string): QueueJob { return this.transitionHeartbeat(jobId, workerId); }
  public heartbeatJob(jobId: string, workerId: string): QueueJob { return this.heartbeat(jobId, workerId); }
  private transitionHeartbeat(id: string, workerId: string): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Job not found: ${id}`);
      if (row.status !== 'RUNNING' || row.worker_id !== workerId) throw new Error(`Job ${id} is not owned by worker ${workerId}`);
      const heartbeat = now(); this.database.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'RUNNING' AND worker_id = ?").run(heartbeat, id, workerId); return this.get(id);
    });
    return transaction();
  }
  public completeJob(jobId: string, workerId?: string): QueueJob { return this.transition(jobId, 'COMPLETED', workerId); }
  public failJob(jobId: string, error: string, workerId?: string): QueueJob { return this.transition(jobId, 'FAILED', workerId, error); }
  public cancelJob(jobId: string, workerId?: string): QueueJob { return this.transition(jobId, 'CANCELLED', workerId); }
  public complete(jobId: string, workerId?: string): QueueJob { return this.completeJob(jobId, workerId); }
  public fail(jobId: string, error: string, workerId?: string): QueueJob { return this.failJob(jobId, error, workerId); }
  public cancel(jobId: string, workerId?: string): QueueJob { return this.cancelJob(jobId, workerId); }

  /** Marks stale work interrupted. It intentionally does not enqueue it again. */
  public recoverStaleJobs(staleTimeoutMs = 60000): QueueJob[] {
    this.acquireProcessLock();
    const cutoff = Date.now() - staleTimeoutMs;
    const transaction = this.database.transaction(() => {
      const rows = this.database.prepare("SELECT * FROM jobs WHERE status = 'RUNNING'").all() as Record<string, unknown>[];
      const recovered: QueueJob[] = [];
      for (const row of rows) {
        const heartbeat = row.heartbeat_at ?? row.started_at ?? row.created_at;
        if (new Date(String(heartbeat)).getTime() < cutoff) {
          this.database.prepare("UPDATE jobs SET status = 'INTERRUPTED', finished_at = ?, error = ?, worker_id = NULL WHERE id = ? AND status = 'RUNNING'").run(now(), 'Stale RUNNING job interrupted; manual retry required', row.id);
          recovered.push(this.get(String(row.id)));
        }
      }
      return recovered;
    });
    return transaction();
  }
  public recoverStale(staleTimeoutMs = 60000): QueueJob[] { return this.recoverStaleJobs(staleTimeoutMs); }

  /** Manual retry only: puts interrupted/failed work at the back of the queue. */
  public retryJob(jobId: string): QueueJob {
    const transaction = this.database.transaction(() => {
      const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Job not found: ${jobId}`);
      if (row.status !== 'FAILED' && row.status !== 'INTERRUPTED') throw new Error(`Only FAILED or INTERRUPTED jobs can be retried: ${jobId}`);
      this.database.prepare("UPDATE jobs SET status = 'QUEUED', started_at = NULL, finished_at = NULL, heartbeat_at = NULL, error = NULL, worker_id = NULL, created_at = ? WHERE id = ?").run(now(), jobId);
      return this.get(jobId);
    });
    return transaction();
  }
  public retry(jobId: string): QueueJob { return this.retryJob(jobId); }
}
