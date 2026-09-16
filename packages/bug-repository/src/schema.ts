import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const timestamps = { createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull() };
export const users = sqliteTable('users', { id: text('id').primaryKey(), displayName: text('display_name').notNull(), email: text('email'), ...timestamps });
export const bugConversations = sqliteTable('bug_conversations', { id: text('id').primaryKey(), reporterId: text('reporter_id').notNull().references(() => users.id), status: text('status').notNull(), draft: text('draft', { mode: 'json' }).notNull(), completeness: text('completeness', { mode: 'json' }).notNull(), ...timestamps });
export const conversationMessages = sqliteTable('conversation_messages', { id: text('id').primaryKey(), conversationId: text('conversation_id').notNull().references(() => bugConversations.id, { onDelete: 'cascade' }), role: text('role').notNull(), content: text('content').notNull(), metadata: text('metadata', { mode: 'json' }).notNull(), createdAt: text('created_at').notNull() });
export const bugReports = sqliteTable('bug_reports', { id: text('id').primaryKey(), bugKey: text('bug_key').notNull().unique(), taskType: text('task_type').notNull().default('bugfix'), reporterId: text('reporter_id').notNull().references(() => users.id), conversationId: text('conversation_id').references(() => bugConversations.id), status: text('status').notNull(), report: text('report', { mode: 'json' }).notNull(), ...timestamps });
export const bugAttachments = sqliteTable('bug_attachments', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), attachment: text('attachment', { mode: 'json' }).notNull(), ...timestamps });
export const bugEvents = sqliteTable('bug_events', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), fromStatus: text('from_status'), toStatus: text('to_status').notNull(), eventType: text('event_type').notNull(), payload: text('payload', { mode: 'json' }).notNull(), createdAt: text('created_at').notNull() });
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), status: text('status').notNull(),
  priority: integer('priority').notNull().default(0), attempt: integer('attempt').notNull().default(0), createdAt: text('created_at').notNull(), startedAt: text('started_at'), finishedAt: text('finished_at'), heartbeatAt: text('heartbeat_at'), error: text('error'),
  workerId: text('worker_id'), leaseToken: text('lease_token'), leaseExpiresAt: text('lease_expires_at'), claimedAt: text('claimed_at'), routingRequirements: text('routing_requirements', { mode: 'json' }), failureClass: text('failure_class'), lastFailureBackendId: text('last_failure_backend_id'),
}, (table) => [index('jobs_queue_idx').on(table.status, table.priority, table.createdAt), index('jobs_lease_expiry_idx').on(table.status, table.leaseExpiresAt)]);
export const agentRuns = sqliteTable('agent_runs', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), jobId: text('job_id').references(() => jobs.id), agentType: text('agent_type').notNull(), status: text('status').notNull(), sessionId: text('session_id'), startedAt: text('started_at').notNull(), finishedAt: text('finished_at'), input: text('input', { mode: 'json' }).notNull(), output: text('output', { mode: 'json' }), error: text('error'), backendId: text('backend_id'), model: text('model'), roleAttempt: integer('role_attempt'), failureClass: text('failure_class'), leaseToken: text('lease_token') });
export const workerEvents = sqliteTable('worker_events', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }), sequence: integer('sequence').notNull(), occurredAt: text('occurred_at').notNull(), role: text('role').notNull(), eventType: text('event_type').notNull(), tool: text('tool'), isError: integer('is_error').notNull().default(0), turnIndex: integer('turn_index'), toolCallCount: integer('tool_call_count'), summary: text('summary').notNull() }, (table) => [uniqueIndex('worker_events_bug_sequence_uidx').on(table.bugId, table.sequence), index('worker_events_job_sequence_idx').on(table.jobId, table.sequence)]);
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

export const taskRepositories = sqliteTable('task_repositories', {
  id: text('id').primaryKey(), bugId: text('bug_id').notNull().unique().references(() => bugReports.id, { onDelete: 'cascade' }), cloneUrl: text('clone_url').notNull(), baseBranch: text('base_branch').notNull(), executionTarget: text('execution_target').notNull(), checkoutId: text('checkout_id'), profileId: text('profile_id'), status: text('status').notNull(), repositoryPath: text('repository_path'), attempt: integer('attempt').notNull().default(0), errorCode: text('error_code'), error: text('error'), startedAt: text('started_at'), finishedAt: text('finished_at'), heartbeatAt: text('heartbeat_at'), createdAt: text('created_at').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [index('task_repositories_status_idx').on(table.status, table.createdAt)]);
export const idempotencyKeys = sqliteTable('idempotency_keys', { scope: text('scope').notNull(), idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), jobId: text('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }), createdAt: text('created_at').notNull() }, (table) => [primaryKey({ columns: [table.scope, table.idempotencyKey] }), index('idempotency_keys_bug_idx').on(table.bugId)]);
export const taskEvents = sqliteTable('task_events', { id: text('id').primaryKey(), bugId: text('bug_id').notNull().references(() => bugReports.id, { onDelete: 'cascade' }), jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }), sequence: integer('sequence').notNull(), type: text('type').notNull(), status: text('status').notNull(), stage: text('stage').notNull(), occurredAt: text('occurred_at').notNull(), data: text('data', { mode: 'json' }).notNull() }, (table) => [uniqueIndex('task_events_bug_sequence_uidx').on(table.bugId, table.sequence), index('task_events_bug_sequence_idx').on(table.bugId, table.sequence)]);

export const coreTables = { users, bugConversations, conversationMessages, bugReports, bugAttachments, bugEvents, jobs, agentRuns, workerEvents, weeklyReportDeliveries, taskRepositories, idempotencyKeys, taskEvents };
