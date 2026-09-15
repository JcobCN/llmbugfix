import { describe, expect, it } from 'vitest';
import { DefaultWeeklyReportService, renderWeeklyReport, truncateWeeklySummary, WeeklyReportContractError, type WeeklyReportSourceRow } from './index.js';

const report = (bugKey: string, title = 'Example <bug>', summary = 'intake & summary') => ({
  id: crypto.randomUUID(), bugKey, title, productArea: 'Payments', component: 'API', bugType: 'functional', executionTarget: 'backend', environmentProfileId: null,
  severity: 'medium', actualBehavior: 'fails', expectedBehavior: 'works',
  reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['click'], testData: [] },
  environment: { environmentName: null, appVersion: null, buildNumber: null, commitSha: null, additionalInfo: {} },
  evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
  impact: { affectedUsers: null, scope: 'unknown', blocksTesting: null, workaroundExists: null, workaround: null },
  regression: { isRegression: null, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [],
  reporter: { userId: crypto.randomUUID(), displayName: 'Tester' },
  intake: { completenessScore: 90, confidence: 0.9, missingInformation: [], conversationId: crypto.randomUUID(), llmSummary: summary },
  createdAt: '2026-08-01T00:00:00+08:00', updatedAt: '2026-09-10T00:00:00+08:00',
});

describe('weekly report generation', () => {
  it('classifies by current status and orders time descending then bug key', () => {
    const rows: WeeklyReportSourceRow[] = [
      { report: report('BUG-000003'), currentStatus: 'FIX_READY', latestProgressAt: '2026-09-10T10:00:00+08:00', agentOutputs: [] },
      { report: report('BUG-000002'), currentStatus: 'READY_FOR_HUMAN_REVIEW', latestProgressAt: '2026-09-11T10:00:00+08:00', agentOutputs: [] },
      { report: report('BUG-000001'), currentStatus: 'READY_FOR_HUMAN_REVIEW', latestProgressAt: '2026-09-11T10:00:00+08:00', agentOutputs: [] },
      { report: report('BUG-000004'), currentStatus: 'BLOCKED', latestProgressAt: '2026-09-09T10:00:00+08:00', agentOutputs: [] },
    ];
    const generated = new DefaultWeeklyReportService({ readWeeklyReportRows: () => rows }).generate('2026-09-07T00:00:00+08:00', '2026-09-12T09:00:00+08:00');
    expect(generated.bugs.map(({ bugKey }) => bugKey)).toEqual(['BUG-000001', 'BUG-000002', 'BUG-000003', 'BUG-000004']);
    expect([generated.successCount, generated.failedCount, generated.inProgressCount]).toEqual([3, 1, 0]);
  });

  it('uses only schema-valid AgentFixResult summaries and escapes all HTML', () => {
    const fixResult = {
      bugKey: 'BUG-000001', status: 'blocked', confidence: 1, summary: 'ignored', rootCause: null, reproduced: true,
      regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: '<blocked & reason>', missingInformation: [],
    };
    const generated = new DefaultWeeklyReportService({ readWeeklyReportRows: () => [{
      report: report('BUG-000001'), currentStatus: 'BLOCKED', latestProgressAt: '2026-09-10T10:00:00+08:00',
      agentOutputs: [{ summary: 'unvalidated secret' }, fixResult],
    }] }).generate('2026-09-07T00:00:00+08:00', '2026-09-12T09:00:00+08:00');
    const rendered = renderWeeklyReport(generated);
    expect(generated.bugs[0].summary).toBe('<blocked & reason>');
    expect(rendered.html).toContain('Example &lt;bug&gt;');
    expect(rendered.html).toContain('&lt;blocked &amp; reason&gt;');
    expect(rendered.html).not.toContain('unvalidated secret');
    expect(rendered.text).toContain('<blocked & reason>');
    expect(rendered.text).not.toContain('左闭右开');
    expect(rendered.html).not.toContain('左闭右开');
  });

  it('fails closed with a contract error for unmapped or invalid current status and renders an explicit empty week', () => {
    for (const currentStatus of ['DRAFT', 'NOT_A_STATUS']) {
      const service = new DefaultWeeklyReportService({ readWeeklyReportRows: () => [{ report: report('BUG-000001'), currentStatus, latestProgressAt: '2026-09-10T10:00:00+08:00', agentOutputs: [] }] });
      expect(() => service.generate('2026-09-07T00:00:00+08:00', '2026-09-12T09:00:00+08:00')).toThrow(WeeklyReportContractError);
    }
    const empty = new DefaultWeeklyReportService({ readWeeklyReportRows: () => [] }).generate('2026-09-07T00:00:00+08:00', '2026-09-12T09:00:00+08:00');
    expect(renderWeeklyReport(empty).text).toContain('本周无开发任务进展');
  });

  it('truncates by Unicode code point with an explicit marker', () => {
    const result = truncateWeeklySummary('💡'.repeat(600));
    expect(Array.from(result)).toHaveLength(500);
    expect(result).toMatch(/已截断）$/u);
    const generated = new DefaultWeeklyReportService({ readWeeklyReportRows: () => [{ report: report('BUG-000001', 'emoji', '💡'.repeat(600)), currentStatus: 'FIXING', latestProgressAt: '2026-09-10T10:00:00+08:00', agentOutputs: [] }] }).generate('2026-09-07T00:00:00+08:00', '2026-09-12T09:00:00+08:00');
    expect(Array.from(generated.bugs[0].summary!)).toHaveLength(500);
  });
});
