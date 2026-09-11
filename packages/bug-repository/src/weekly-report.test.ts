import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@llmbugfix/shared';
import { DefaultWeeklyReportService, weeklyReportMessageId } from '@llmbugfix/weekly-email-report';
import { openDatabase, SQLiteBugRepository, SQLiteWeeklyReportDataSource, SQLiteWeeklyReportDeliveryRepository } from './index.js';

const reportInput = (userId: string, conversationId: string, title: string) => ({
  title, productArea: null, component: null, bugType: 'functional' as const, executionTarget: 'frontend' as const, environmentProfileId: null,
  severity: 'medium' as const, actualBehavior: 'fails', expectedBehavior: 'works',
  reproduction: { reproducible: true, frequency: 'always' as const, prerequisites: [], steps: ['click'], testData: [] },
  environment: { environmentName: null, appVersion: null, buildNumber: null, commitSha: null, additionalInfo: {} },
  evidence: { errorMessages: ['must never be mailed'], stackTraces: ['secret stack'], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
  impact: { affectedUsers: null, scope: 'unknown' as const, blocksTesting: null, workaroundExists: null, workaround: null },
  regression: { isRegression: null, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [],
  reporter: { userId, displayName: 'Tester' },
  intake: { completenessScore: 70, confidence: 0.9, missingInformation: [], conversationId, llmSummary: 'safe summary' },
});

const emptySnapshot = (periodStart: string, periodEnd: string) => ({ periodStart, periodEnd, successCount: 0, failedCount: 0, inProgressCount: 0, bugs: [] });

describe('SQLite weekly report repositories', () => {
  it('selects only created_at progress events in [start,end), de-duplicates, and reads current status', () => {
    const db = openDatabase();
    const bugs = new SQLiteBugRepository(db);
    const user = bugs.createUser({ displayName: 'Tester', email: null });
    const conversationId = newId();
    bugs.createConversation({ id: conversationId, reporterId: user.id, status: 'active', draft: {}, completeness: { score: 0, dimensions: { problem: 0, reproduction: 0, environment: 0, evidence: 0, impact: 0 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: false } });
    const included = bugs.createBug(reportInput(user.id, conversationId, 'included'));
    const exactEnd = bugs.createBug(reportInput(user.id, conversationId, 'exact end'));
    const updatedOnly = bugs.createBug(reportInput(user.id, conversationId, 'updated only'));
    const event = (bugId: string, id: string, status: string, createdAt: string) => db.prepare('INSERT INTO bug_events (id, bug_id, from_status, to_status, event_type, payload, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(id, bugId, status, 'test', '{}', createdAt);
    event(included.id, newId(), 'QUEUED', '2026-09-06T16:00:00Z');
    event(included.id, newId(), 'FIXING', '2026-09-11T08:00:00+08:00');
    event(exactEnd.id, newId(), 'FIX_READY', '2026-09-12T10:00:00+09:00');
    db.prepare("UPDATE bug_reports SET status = 'READY_FOR_HUMAN_REVIEW' WHERE id = ?").run(included.id);
    db.prepare("UPDATE bug_reports SET updated_at = '2026-09-10T00:00:00+08:00' WHERE id = ?").run(updatedOnly.id);
    const fixResult = { bugKey: included.bugKey, status: 'fixed' as const, confidence: 0.9, summary: 'validated agent summary', rootCause: null, reproduced: true, regressionTestAdded: true, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
    bugs.createAgentRun({ bugId: included.id, jobId: null, agentType: 'fixer', status: 'COMPLETED', sessionId: null, startedAt: '2026-09-10T07:00:00+08:00', finishedAt: '2026-09-10T08:00:00+08:00', input: {}, output: fixResult, error: null });
    bugs.createAgentRun({ bugId: included.id, jobId: null, agentType: 'fixer', status: 'COMPLETED', sessionId: null, startedAt: '2026-09-10T08:00:00+08:00', finishedAt: '2026-09-10T09:00:00+08:00', input: {}, output: { summary: 'unvalidated raw output' }, error: null });
    bugs.createAgentRun({ bugId: included.id, jobId: null, agentType: 'reviewer', status: 'COMPLETED', sessionId: null, startedAt: '2026-09-10T09:00:00+08:00', finishedAt: '2026-09-10T10:00:00+08:00', input: {}, output: { ...fixResult, summary: 'wrong agent type' }, error: null });
    const reportService = new DefaultWeeklyReportService(new SQLiteWeeklyReportDataSource(db));
    const report = reportService.generate('2026-09-07T00:00:00+08:00', '2026-09-12T09:00:00+08:00');
    expect(report.bugs).toHaveLength(1);
    expect(report.bugs[0]).toMatchObject({ bugKey: included.bugKey, currentStatus: 'READY_FOR_HUMAN_REVIEW', latestProgressAt: '2026-09-11T08:00:00+08:00', summary: 'validated agent summary' });
    expect(JSON.stringify(report)).not.toContain('secret stack');
    expect(JSON.stringify(report)).not.toContain('unvalidated raw output');
    const deliveries = new SQLiteWeeklyReportDeliveryRepository(db);
    const claimed = deliveries.claimDue({
      periodStart: report.periodStart, periodEnd: report.periodEnd, messageId: weeklyReportMessageId(report.periodStart), now: report.periodEnd,
      createSnapshot: () => reportService.generate(report.periodStart, report.periodEnd),
    });
    db.prepare("UPDATE bug_reports SET status = 'BLOCKED' WHERE id = ?").run(included.id);
    expect(deliveries.get(report.periodStart)?.reportSnapshot.bugs[0].currentStatus).toBe('READY_FOR_HUMAN_REVIEW');
    expect(claimed?.attemptCount).toBe(1);
    db.close();
  });

  it('atomically claims once and leaves a failed period terminal', () => {
    const db = openDatabase();
    const repository = new SQLiteWeeklyReportDeliveryRepository(db);
    const periodStart = '2026-09-07T00:00:00+08:00';
    const periodEnd = '2026-09-12T09:00:00+08:00';
    const messageId = weeklyReportMessageId(periodStart);
    let generated = 0;
    const claimed = repository.claimDue({ periodStart, periodEnd, messageId, now: '2026-09-12T09:00:00+08:00', createSnapshot: () => { generated += 1; return emptySnapshot(periodStart, periodEnd); } });
    expect(claimed).toMatchObject({ status: 'SENDING', attemptCount: 1, messageId });
    expect(repository.claimDue({ periodStart, periodEnd, messageId, now: '2026-09-12T09:00:01+08:00', createSnapshot: () => { generated += 1; return emptySnapshot(periodStart, periodEnd); } })).toBeNull();
    repository.markFailed(claimed!.id, 'password=secret owner@example.com raw', '2026-09-12T09:00:01+08:00');
    const failed = repository.get(periodStart)!;
    expect(failed).toMatchObject({ status: 'FAILED', attemptCount: 1, nextAttemptAt: null });
    expect(failed.lastError).not.toMatch(/secret|owner@example/u);
    const reclaimed = repository.claimDue({ periodStart, periodEnd, messageId, now: '2026-09-12T09:01:01+08:00', createSnapshot: () => { generated += 1; return emptySnapshot(periodStart, periodEnd); } });
    expect(reclaimed).toBeNull();
    expect(generated).toBe(1);
    db.close();
  });

  it('allows only one claim across independent SQLite connections', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-delivery-claim-'));
    const filename = path.join(directory, 'deliveries.sqlite');
    const firstDatabase = openDatabase(filename);
    const secondDatabase = openDatabase(filename);
    try {
      const first = new SQLiteWeeklyReportDeliveryRepository(firstDatabase);
      const second = new SQLiteWeeklyReportDeliveryRepository(secondDatabase);
      const periodStart = '2026-09-07T00:00:00+08:00';
      const periodEnd = '2026-09-12T09:00:00+08:00';
      let snapshots = 0;
      const input = { periodStart, periodEnd, messageId: weeklyReportMessageId(periodStart), now: periodEnd, createSnapshot: () => { snapshots += 1; return emptySnapshot(periodStart, periodEnd); } };
      expect(first.claimDue(input)).toMatchObject({ status: 'SENDING', attemptCount: 1 });
      expect(second.claimDue(input)).toBeNull();
      expect(snapshots).toBe(1);
      expect((secondDatabase.prepare('SELECT COUNT(*) AS count FROM weekly_report_deliveries WHERE period_start = ?').get(periodStart) as { count: number }).count).toBe(1);
    } finally {
      secondDatabase.close();
      firstDatabase.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never reclaims an interrupted SENDING delivery', () => {
    const db = openDatabase();
    const repository = new SQLiteWeeklyReportDeliveryRepository(db);
    const periodStart = '2026-09-07T00:00:00+08:00';
    const periodEnd = '2026-09-12T09:00:00+08:00';
    const messageId = weeklyReportMessageId(periodStart);
    repository.claimDue({ periodStart, periodEnd, messageId, now: '2026-09-12T09:00:00+08:00', createSnapshot: () => emptySnapshot(periodStart, periodEnd) });
    expect(repository.claimDue({ periodStart, periodEnd, messageId, now: '2026-10-12T09:00:00+08:00', createSnapshot: () => emptySnapshot(periodStart, periodEnd) })).toBeNull();
    expect(repository.get(periodStart)).toMatchObject({ status: 'SENDING', attemptCount: 1, nextAttemptAt: null, reportSnapshot: emptySnapshot(periodStart, periodEnd) });
    db.close();
  });
});
