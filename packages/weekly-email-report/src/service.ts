import { AgentFixResultSchema, BugReportSchema, BugStatusSchema, type BugStatus } from '@llmbugfix/bug-domain';
import { AppError } from '@llmbugfix/shared';
import {
  WeeklyBugReportSchema,
  type WeeklyBugReport,
  type WeeklyBugReportItem,
  type WeeklyReportCategory,
  type WeeklyReportDataSource,
  type WeeklyReportService,
} from './schemas.js';
import { shanghaiDate, shanghaiDateTime } from './time.js';

const categoryStatuses: Record<WeeklyReportCategory, ReadonlySet<BugStatus>> = {
  success: new Set(['FIX_READY', 'READY_FOR_HUMAN_REVIEW']),
  failed: new Set(['FIX_FAILED', 'ENVIRONMENT_FAILED', 'VALIDATION_FAILED', 'REVIEW_REJECTED', 'PUSH_FAILED', 'BLOCKED', 'REJECTED', 'CANCELLED']),
  inProgress: new Set(['QUEUED', 'NEEDS_INFO', 'PREPARING_ENV', 'FIXING', 'FIX_CANDIDATE', 'VALIDATING', 'REVIEWING', 'PUSHING']),
};

export const WEEKLY_PROGRESS_STATUSES = [
  'QUEUED', 'NEEDS_INFO', 'PREPARING_ENV', 'FIXING', 'FIX_CANDIDATE', 'VALIDATING', 'REVIEWING', 'FIX_READY', 'FIX_FAILED', 'PUSHING',
  'READY_FOR_HUMAN_REVIEW', 'BLOCKED', 'CANCELLED', 'REJECTED', 'ENVIRONMENT_FAILED', 'VALIDATION_FAILED', 'REVIEW_REJECTED', 'PUSH_FAILED',
] as const;

export class WeeklyReportContractError extends AppError {
  constructor(message: string) {
    super('WEEKLY_REPORT_CONTRACT_ERROR', message);
    this.name = 'WeeklyReportContractError';
  }
}

function categoryForStatus(status: BugStatus): WeeklyReportCategory {
  for (const category of ['success', 'failed', 'inProgress'] as const) if (categoryStatuses[category].has(status)) return category;
  throw new WeeklyReportContractError(`Selected bug has unsupported current status: ${status}`);
}

/** Limits the complete rendered summary, including the marker, to 500 code points. */
export function truncateWeeklySummary(value: string): string {
  const points = Array.from(value);
  if (points.length <= 500) return value;
  const marker = '…（已截断）';
  return `${points.slice(0, 500 - Array.from(marker).length).join('')}${marker}`;
}

function summaryFor(report: ReturnType<typeof BugReportSchema.parse>, outputs: readonly unknown[]): string | null {
  for (const output of outputs) {
    const parsed = AgentFixResultSchema.strict().safeParse(output);
    if (!parsed.success || parsed.data.bugKey !== report.bugKey) continue;
    const value = parsed.data.status === 'fixed' ? parsed.data.summary : parsed.data.blockedReason?.trim() || parsed.data.summary;
    if (value.trim()) return truncateWeeklySummary(value.trim());
  }
  const intake = report.intake.llmSummary.trim();
  return intake ? truncateWeeklySummary(intake) : null;
}

function itemOrder(left: WeeklyBugReportItem, right: WeeklyBugReportItem): number {
  const byTime = Date.parse(right.latestProgressAt) - Date.parse(left.latestProgressAt);
  return byTime || left.bugKey.localeCompare(right.bugKey, 'en');
}

export class DefaultWeeklyReportService implements WeeklyReportService {
  constructor(private readonly source: WeeklyReportDataSource) {}

  generate(periodStart: string, periodEnd: string): WeeklyBugReport {
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() >= end.getTime()) {
      throw new WeeklyReportContractError('Weekly report period must be a valid increasing ISO interval');
    }
    const bugs = this.source.readWeeklyReportRows(periodStart, periodEnd).map((row): WeeklyBugReportItem => {
      const report = BugReportSchema.strict().parse(row.report);
      const parsedStatus = BugStatusSchema.safeParse(row.currentStatus);
      if (!parsedStatus.success) throw new WeeklyReportContractError(`Selected bug ${report.bugKey} has invalid current status`);
      const status = parsedStatus.data;
      const latestProgressAt = typeof row.latestProgressAt === 'string' ? row.latestProgressAt : '';
      if (Number.isNaN(Date.parse(latestProgressAt))) throw new WeeklyReportContractError(`Selected bug ${report.bugKey} has invalid progress time`);
      return {
        bugKey: report.bugKey,
        title: report.title,
        productArea: report.productArea,
        component: report.component,
        executionTarget: report.executionTarget,
        currentStatus: status,
        latestProgressAt,
        category: categoryForStatus(status),
        summary: summaryFor(report, row.agentOutputs),
      };
    });
    const categoryOrder: Record<WeeklyReportCategory, number> = { success: 0, failed: 1, inProgress: 2 };
    bugs.sort((left, right) => categoryOrder[left.category] - categoryOrder[right.category] || itemOrder(left, right));
    return WeeklyBugReportSchema.parse({
      periodStart,
      periodEnd,
      successCount: bugs.filter((bug) => bug.category === 'success').length,
      failedCount: bugs.filter((bug) => bug.category === 'failed').length,
      inProgressCount: bugs.filter((bug) => bug.category === 'inProgress').length,
      bugs,
    });
  }
}

export function weeklyReportSubject(report: WeeklyBugReport): string {
  return `[LLMBugFix] Bug 修复周报 ${shanghaiDate(report.periodStart)} ~ ${shanghaiDate(report.periodEnd)}`;
}

const categoryLabels: Record<WeeklyReportCategory, string> = { success: '修复成功', failed: '失败/阻塞', inProgress: '处理中' };
const display = (value: string | null): string => value ?? '-';
const escapeHtml = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

export interface RenderedWeeklyReport { readonly subject: string; readonly text: string; readonly html: string }

export function renderWeeklyReport(value: WeeklyBugReport): RenderedWeeklyReport {
  const report = WeeklyBugReportSchema.parse(value);
  const period = `${shanghaiDateTime(report.periodStart)} ~ ${shanghaiDateTime(report.periodEnd)}（Asia/Shanghai）`;
  const text: string[] = [
    'LLMBugFix Bug 修复周报',
    `统计区间：${period}`,
    `修复成功：${report.successCount}；失败/阻塞：${report.failedCount}；处理中：${report.inProgressCount}`,
    '',
  ];
  const html: string[] = [
    '<!doctype html><html><head><meta charset="utf-8"><title>LLMBugFix Bug 修复周报</title></head><body>',
    '<h1>LLMBugFix Bug 修复周报</h1>',
    `<p>统计区间：${escapeHtml(period)}</p>`,
    `<p>修复成功：${report.successCount}；失败/阻塞：${report.failedCount}；处理中：${report.inProgressCount}</p>`,
  ];
  if (report.bugs.length === 0) {
    text.push('本周无 Bug 修复进展');
    html.push('<p>本周无 Bug 修复进展</p>');
  } else {
    for (const category of ['success', 'failed', 'inProgress'] as const) {
      const items = report.bugs.filter((bug) => bug.category === category).sort(itemOrder);
      text.push(`${categoryLabels[category]}（${items.length}）`);
      html.push(`<h2>${categoryLabels[category]}（${items.length}）</h2><ul>`);
      for (const bug of items) {
        const fields = [
          ['Bug Key', bug.bugKey], ['标题', bug.title], ['项目/模块', `${display(bug.productArea)} / ${display(bug.component)}`],
          ['执行目标', bug.executionTarget], ['当前状态', bug.currentStatus], ['最近进展时间', shanghaiDateTime(bug.latestProgressAt)], ['摘要', display(bug.summary)],
        ] as const;
        text.push(...fields.map(([label, field]) => `${label}：${field}`), '');
        html.push('<li><dl>', ...fields.map(([label, field]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(field)}</dd>`), '</dl></li>');
      }
      html.push('</ul>');
    }
  }
  html.push('</body></html>');
  return { subject: weeklyReportSubject(report), text: text.join('\n').trimEnd(), html: html.join('') };
}
