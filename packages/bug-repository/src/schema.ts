import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = { createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull() };
export const users = sqliteTable('users', { id: text('id').primaryKey(), displayName: text('display_name').notNull(), email: text('email'), ...timestamps });
export const bugConversations = sqliteTable('bug_conversations', { id: text('id').primaryKey(), reporterId: text('reporter_id').notNull().references(() => users.id), status: text('status').notNull(), draft: text('draft', { mode: 'json' }).notNull(), completeness: text('completeness', { mode: 'json' }).notNull(), ...timestamps });
export const conversationMessages = sqliteTable('conversation_messages', { id: text('id').primaryKey(), conversationId: text('conversation_id').notNull().references(() => bugConversations.id, { onDelete: 'cascade' }), role: text('role').notNull(), content: text('content').notNull(), metadata: text('metadata', { mode: 'json' }).notNull(), createdAt: text('created_at').notNull() });
export const bugReports = sqliteTable('bug_reports', { id: text('id').primaryKey(), bugKey: text('bug_key').notNull().unique(), reporterId: text('reporter_id').notNull().references(() => users.id), conversationId: text('conversation_id').references(() => bugConversations.id), status: text('status').notNull(), report: text('report', { mode: 'json' }).notNull(), ...timestamps });
export const bugAttachments = sqliteTable('bug_attachments', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), attachment: text('attachment', { mode: 'json' }).notNull(), ...timestamps });
export const bugEvents = sqliteTable('bug_events', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), fromStatus: text('from_status'), toStatus: text('to_status').notNull(), eventType: text('event_type').notNull(), payload: text('payload', { mode: 'json' }).notNull(), createdAt: text('created_at').notNull() });
export const jobs = sqliteTable('jobs', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), status: text('status').notNull(), priority: integer('priority').notNull().default(0), attempt: integer('attempt').notNull().default(0), createdAt: text('created_at').notNull(), startedAt: text('started_at'), finishedAt: text('finished_at'), heartbeatAt: text('heartbeat_at'), error: text('error') });
export const agentRuns = sqliteTable('agent_runs', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), jobId: text('job_id').references(() => jobs.id), agentType: text('agent_type').notNull(), status: text('status').notNull(), sessionId: text('session_id'), startedAt: text('started_at').notNull(), finishedAt: text('finished_at'), input: text('input', { mode: 'json' }).notNull(), output: text('output', { mode: 'json' }), error: text('error') });
export const weeklyReportDeliveries = sqliteTable('weekly_report_deliveries', {
  id: text('id').primaryKey(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  status: text('status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  messageId: text('message_id').notNull(),
  reportSnapshot: text('report_snapshot', { mode: 'json' }).notNull(),
  nextAttemptAt: text('next_attempt_at'),
  lastError: text('last_error'),
  claimedAt: text('claimed_at'),
  sentAt: text('sent_at'),
  ...timestamps,
}, (table) => [
  uniqueIndex('weekly_report_deliveries_period_start_uidx').on(table.periodStart),
  uniqueIndex('weekly_report_deliveries_message_id_uidx').on(table.messageId),
  index('weekly_report_deliveries_due_idx').on(table.status, table.nextAttemptAt),
]);

export const coreTables = { users, bugConversations, conversationMessages, bugReports, bugAttachments, bugEvents, jobs, agentRuns, weeklyReportDeliveries };
