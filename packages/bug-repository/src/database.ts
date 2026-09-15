import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bug_conversations (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, draft TEXT NOT NULL, completeness TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_documents (conversation_id TEXT PRIMARY KEY REFERENCES bug_conversations(id) ON DELETE CASCADE, relative_path TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL, reconciled_revision INTEGER NOT NULL, reconciled_sha256 TEXT NOT NULL, sync_status TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES bug_conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bug_reports (id TEXT PRIMARY KEY, bug_key TEXT NOT NULL UNIQUE, task_type TEXT NOT NULL DEFAULT 'bugfix', reporter_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT REFERENCES bug_conversations(id), status TEXT NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bug_attachments (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE, attachment TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bug_events (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE, from_status TEXT, to_status TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, heartbeat_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, bug_id TEXT NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE, job_id TEXT REFERENCES jobs(id), agent_type TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, input TEXT NOT NULL, output TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS worker_events (
  id TEXT PRIMARY KEY,
  bug_id TEXT NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  role TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tool TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  turn_index INTEGER,
  tool_call_count INTEGER,
  summary TEXT NOT NULL,
  UNIQUE (bug_id, sequence)
);
CREATE TABLE IF NOT EXISTS weekly_report_deliveries (
  id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL UNIQUE,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  message_id TEXT NOT NULL UNIQUE,
  report_snapshot TEXT NOT NULL,
  next_attempt_at TEXT,
  last_error TEXT,
  claimed_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bug_key_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), next_value INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, priority ASC, created_at);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON conversation_messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_deliveries_period_start_uidx ON weekly_report_deliveries(period_start);
CREATE UNIQUE INDEX IF NOT EXISTS weekly_report_deliveries_message_id_uidx ON weekly_report_deliveries(message_id);
CREATE INDEX IF NOT EXISTS weekly_report_deliveries_due_idx ON weekly_report_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS bug_events_weekly_progress_idx ON bug_events(created_at, to_status, bug_id);
CREATE INDEX IF NOT EXISTS worker_events_bug_sequence_idx ON worker_events(bug_id, sequence);
CREATE INDEX IF NOT EXISTS worker_events_job_sequence_idx ON worker_events(job_id, sequence);
`;

export type SqliteDatabase = BetterSqliteDatabase;
export const createDrizzleDatabase = (database: SqliteDatabase) => ({}) as any;

export function initializeDatabase(database: SqliteDatabase): SqliteDatabase {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(CREATE_TABLES_SQL);
  const bugReportColumns = database.prepare('PRAGMA table_info(bug_reports)').all() as Array<{ name: string }>;
  if (!bugReportColumns.some((column) => column.name === 'task_type')) database.exec("ALTER TABLE bug_reports ADD COLUMN task_type TEXT NOT NULL DEFAULT 'bugfix'");
  database.prepare('INSERT OR IGNORE INTO bug_key_sequence (id, next_value) VALUES (1, 1)').run();
  database.exec("UPDATE bug_key_sequence SET next_value = MAX(next_value, COALESCE((SELECT MAX(CAST(substr(bug_key, 5) AS INTEGER)) + 1 FROM bug_reports WHERE bug_key GLOB 'BUG-[0-9]*'), 1)) WHERE id = 1");
  return database;
}

export function openDatabase(filename = ':memory:'): SqliteDatabase {
  if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  return initializeDatabase(new Database(filename));
}

export function pragmaValues(database: SqliteDatabase): { journalMode: string; foreignKeys: number; busyTimeout: number } {
  return {
    journalMode: String(database.pragma('journal_mode', { simple: true })),
    foreignKeys: Number(database.pragma('foreign_keys', { simple: true })),
    busyTimeout: Number(database.pragma('busy_timeout', { simple: true }))
  };
}
