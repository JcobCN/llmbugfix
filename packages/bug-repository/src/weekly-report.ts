import { newId, sanitizeDiagnostic } from '@llmbugfix/shared';
import {
  WEEKLY_PROGRESS_STATUSES,
  WeeklyBugReportSchema,
  WeeklyReportDeliveryStatusSchema,
  type WeeklyBugReport,
  type WeeklyReportDataSource,
  type WeeklyReportDelivery,
  type WeeklyReportDeliveryRepository,
  type WeeklyReportSourceRow,
} from '@llmbugfix/weekly-email-report';
import { z } from 'zod';
import type { SqliteDatabase } from './database.js';

const isoWithOffset = z.string().datetime({ offset: true });

export const WeeklyReportDeliverySchema = z.object({
  id: z.string().uuid(),
  periodStart: isoWithOffset,
  periodEnd: isoWithOffset,
  status: WeeklyReportDeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  messageId: z.string().min(1),
  reportSnapshot: WeeklyBugReportSchema,
  nextAttemptAt: isoWithOffset.nullable(),
  lastError: z.string().refine((value) => Array.from(value).length <= 256, 'diagnostic must not exceed 256 Unicode code points').nullable(),
  claimedAt: isoWithOffset.nullable(),
  sentAt: isoWithOffset.nullable(),
  createdAt: isoWithOffset,
  updatedAt: isoWithOffset,
}).strict();
export type WeeklyReportDeliveryRecord = z.infer<typeof WeeklyReportDeliverySchema>;

const safeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
};

export class SQLiteWeeklyReportDataSource implements WeeklyReportDataSource {
  constructor(private readonly database: SqliteDatabase) {}

  readWeeklyReportRows(periodStart: string, periodEnd: string): readonly WeeklyReportSourceRow[] {
    isoWithOffset.parse(periodStart);
    isoWithOffset.parse(periodEnd);
    const placeholders = WEEKLY_PROGRESS_STATUSES.map(() => '?').join(', ');
    return this.database.transaction(() => {
      const rows = this.database.prepare(`
        WITH relevant_events AS (
          SELECT bug_id, created_at,
            ROW_NUMBER() OVER (PARTITION BY bug_id ORDER BY julianday(created_at) DESC, id DESC) AS row_number
          FROM bug_events
          WHERE julianday(created_at) >= julianday(?)
            AND julianday(created_at) < julianday(?)
            AND to_status IN (${placeholders})
        )
        SELECT bugs.id AS bug_id, bugs.status AS current_status, bugs.report AS report,
               relevant_events.created_at AS latest_progress_at
        FROM relevant_events
        JOIN bug_reports AS bugs ON bugs.id = relevant_events.bug_id
        WHERE relevant_events.row_number = 1
        ORDER BY julianday(relevant_events.created_at) DESC, bugs.bug_key ASC
      `).all(periodStart, periodEnd, ...WEEKLY_PROGRESS_STATUSES) as Array<Record<string, unknown>>;
      const outputStatement = this.database.prepare(`
        SELECT output FROM agent_runs
        WHERE bug_id = ? AND agent_type = 'fixer' AND status = 'COMPLETED' AND output IS NOT NULL
        ORDER BY julianday(COALESCE(finished_at, started_at)) DESC, id DESC
      `);
      return rows.map((row) => ({
        report: safeJson(row.report),
        currentStatus: row.current_status,
        latestProgressAt: row.latest_progress_at,
        agentOutputs: (outputStatement.all(row.bug_id) as Array<{ output: unknown }>).map(({ output }) => safeJson(output)),
      }));
    })();
  }
}

function deliveryFromRow(row: Record<string, unknown>): WeeklyReportDeliveryRecord {
  return WeeklyReportDeliverySchema.parse({
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    messageId: row.message_id,
    reportSnapshot: safeJson(row.report_snapshot),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    claimedAt: row.claimed_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class SQLiteWeeklyReportDeliveryRepository implements WeeklyReportDeliveryRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(periodStart: string): WeeklyReportDeliveryRecord | null {
    const row = this.database.prepare('SELECT * FROM weekly_report_deliveries WHERE period_start = ?').get(periodStart) as Record<string, unknown> | undefined;
    return row ? deliveryFromRow(row) : null;
  }

  claimDue(input: {
    periodStart: string;
    periodEnd: string;
    messageId: string;
    now: string;
    createSnapshot: () => WeeklyBugReport;
  }): WeeklyReportDelivery | null {
    isoWithOffset.parse(input.periodStart);
    isoWithOffset.parse(input.periodEnd);
    isoWithOffset.parse(input.now);
    if (Date.parse(input.periodStart) >= Date.parse(input.periodEnd)) throw new Error('Weekly report period must be increasing');
    if (Date.parse(input.now) < Date.parse(input.periodEnd)) return null;
    const transaction = this.database.transaction((): WeeklyReportDeliveryRecord | null => {
      const existing = this.database.prepare('SELECT id FROM weekly_report_deliveries WHERE period_start = ?').get(input.periodStart);
      if (existing) return null;
      const snapshot = WeeklyBugReportSchema.parse(input.createSnapshot());
      if (snapshot.periodStart !== input.periodStart || snapshot.periodEnd !== input.periodEnd) throw new Error('Weekly report snapshot period mismatch');
      const id = newId();
      this.database.prepare(`
        INSERT INTO weekly_report_deliveries
          (id, period_start, period_end, status, attempt_count, message_id, report_snapshot, next_attempt_at, last_error, claimed_at, sent_at, created_at, updated_at)
        VALUES (?, ?, ?, 'SENDING', 1, ?, ?, NULL, NULL, ?, NULL, ?, ?)
      `).run(id, input.periodStart, input.periodEnd, input.messageId, JSON.stringify(snapshot), input.now, input.now, input.now);
      return this.get(input.periodStart);
    });
    return transaction.immediate();
  }

  markSent(id: string, now: string): boolean {
    isoWithOffset.parse(now);
    const changed = this.database.prepare(`
      UPDATE weekly_report_deliveries
      SET status = 'SENT', sent_at = ?, claimed_at = NULL, next_attempt_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'SENDING'
    `).run(now, now, id);
    return changed.changes === 1;
  }

  markFailed(id: string, error: string, now: string): boolean {
    isoWithOffset.parse(now);
    const changed = this.database.prepare(`
      UPDATE weekly_report_deliveries
      SET status = 'FAILED', next_attempt_at = NULL, last_error = ?, claimed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'SENDING'
    `).run(sanitizeDiagnostic(error), now, id);
    return changed.changes === 1;
  }
}
