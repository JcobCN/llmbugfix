import { describe, expect, it } from 'vitest';
import { openDatabase, pragmaValues, SQLiteBugRepository } from './index.js';
import { newId } from '@bug-agent/shared';

const report = (userId: string, conversationId: string) => ({
  title: 'Example',
  productArea: null,
  component: null,
  bugType: 'functional' as const,
  executionTarget: 'frontend' as const,
  environmentProfileId: null,
  severity: 'medium' as const,
  actualBehavior: 'It fails',
  expectedBehavior: 'It works',
  reproduction: { reproducible: true, frequency: 'always' as const, prerequisites: [], steps: ['click'], testData: [] },
  environment: { environmentName: null, appVersion: null, buildNumber: null, commitSha: null, additionalInfo: {} },
  evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
  impact: { affectedUsers: null, scope: 'unknown' as const, blocksTesting: null, workaroundExists: null, workaround: null },
  regression: { isRegression: null, lastKnownGoodVersion: null, suspectedVersion: null },
  observations: [],
  reporterHypotheses: [],
  reporter: { userId, displayName: 'Tester' },
  intake: { completenessScore: 70, confidence: 0.9, missingInformation: [], conversationId, llmSummary: '' }
});

describe('SQLite repository', () => {
  it('initializes pragmas and allocates monotonic bug keys', () => {
    const db = openDatabase();
    const repo = new SQLiteBugRepository(db);
    const user = repo.createUser({ displayName: 'Tester', email: null });
    const conversationId = newId();
    repo.createConversation({
      id: conversationId,
      reporterId: user.id,
      status: 'active',
      draft: {},
      completeness: { score: 0, dimensions: { problem: 0, reproduction: 0, environment: 0, evidence: 0, impact: 0 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: false }
    });
    const first = repo.createBug(report(user.id, conversationId));
    const second = repo.createBug(report(user.id, conversationId));
    expect(first.bugKey).toBe('BUG-000001');
    expect(second.bugKey).toBe('BUG-000002');
    expect(pragmaValues(db).foreignKeys).toBe(1);
    expect(pragmaValues(db).busyTimeout).toBe(5000);
    expect(repo.changeBugStatus(first.bugKey, 'COLLECTING').bugKey).toBe(first.bugKey);
    expect(() => repo.changeBugStatus(first.bugKey, 'FIXING')).toThrow();
    db.close();
  });

  it('persists bounded, redacted worker events with a bug-scoped cursor', () => {
    const db = openDatabase();
    const repo = new SQLiteBugRepository(db);
    const user = repo.createUser({ displayName: 'Tester', email: null });
    const conversationId = newId();
    repo.createConversation({ id: conversationId, reporterId: user.id, status: 'submitted', draft: {}, completeness: { score: 70, dimensions: { problem: 20, reproduction: 20, environment: 10, evidence: 10, impact: 10 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: true } });
    const bug = repo.createBug(report(user.id, conversationId));
    const job = repo.enqueueJob(bug.id);
    const first = repo.appendWorkerEvent({ bugId: bug.id, jobId: job.id, role: 'fixer', eventType: 'tool_execution_start', tool: 'bash', summary: 'token=secret-value pnpm test' });
    const second = repo.appendWorkerEvent({ bugId: bug.id, jobId: job.id, role: 'fixer', eventType: 'tool_execution_end', tool: 'bash', isError: true, summary: 'finished' });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.summary).toContain('[REDACTED]');
    expect(repo.listWorkerEvents(bug.bugKey, { after: 1, limit: 10 })).toMatchObject([{ sequence: 2, isError: true }]);
    db.close();
  });
});
