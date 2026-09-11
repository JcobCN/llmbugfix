import { BugStatusSchema, ExecutionTargetSchema } from '@llmbugfix/bug-domain';
import { z } from 'zod';

const isoWithOffset = z.string().datetime({ offset: true });

export const WeeklyReportCategorySchema = z.enum(['success', 'failed', 'inProgress']);
export type WeeklyReportCategory = z.infer<typeof WeeklyReportCategorySchema>;

export const WeeklyBugReportItemSchema = z.object({
  bugKey: z.string().regex(/^BUG-[0-9]{6,}$/u),
  title: z.string().min(1),
  productArea: z.string().nullable(),
  component: z.string().nullable(),
  executionTarget: ExecutionTargetSchema,
  currentStatus: BugStatusSchema,
  latestProgressAt: isoWithOffset,
  category: WeeklyReportCategorySchema,
  summary: z.string().refine((value) => Array.from(value).length <= 500, 'summary must not exceed 500 Unicode code points').nullable(),
}).strict();
export type WeeklyBugReportItem = z.infer<typeof WeeklyBugReportItemSchema>;

export const WeeklyBugReportSchema = z.object({
  periodStart: isoWithOffset,
  periodEnd: isoWithOffset,
  successCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  inProgressCount: z.number().int().nonnegative(),
  bugs: z.array(WeeklyBugReportItemSchema),
}).strict().superRefine((report, context) => {
  const counts = {
    success: report.bugs.filter((bug) => bug.category === 'success').length,
    failed: report.bugs.filter((bug) => bug.category === 'failed').length,
    inProgress: report.bugs.filter((bug) => bug.category === 'inProgress').length,
  };
  if (report.successCount !== counts.success) context.addIssue({ code: z.ZodIssueCode.custom, path: ['successCount'], message: 'count does not match bugs' });
  if (report.failedCount !== counts.failed) context.addIssue({ code: z.ZodIssueCode.custom, path: ['failedCount'], message: 'count does not match bugs' });
  if (report.inProgressCount !== counts.inProgress) context.addIssue({ code: z.ZodIssueCode.custom, path: ['inProgressCount'], message: 'count does not match bugs' });
});
export type WeeklyBugReport = z.infer<typeof WeeklyBugReportSchema>;

export interface WeeklyReportSourceRow {
  readonly report: unknown;
  readonly currentStatus: unknown;
  readonly latestProgressAt: unknown;
  /** Newest first. The service validates every candidate before using it. */
  readonly agentOutputs: readonly unknown[];
}

export interface WeeklyReportDataSource {
  readWeeklyReportRows(periodStart: string, periodEnd: string): readonly WeeklyReportSourceRow[];
}

export interface MailMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly messageId: string;
}

export interface MailSender {
  send(message: MailMessage, signal?: AbortSignal): Promise<void>;
}

export interface WeeklyReportClock {
  now(): Date;
}

export interface WeeklyReportService {
  generate(periodStart: string, periodEnd: string): WeeklyBugReport;
}

export const SystemWeeklyReportClock: WeeklyReportClock = { now: () => new Date() };

export const WeeklyReportDeliveryStatusSchema = z.enum(['PENDING', 'SENDING', 'SENT', 'FAILED']);
export type WeeklyReportDeliveryStatus = z.infer<typeof WeeklyReportDeliveryStatusSchema>;

export interface WeeklyReportDelivery {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: WeeklyReportDeliveryStatus;
  readonly attemptCount: number;
  readonly messageId: string;
  readonly reportSnapshot: WeeklyBugReport;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
  readonly claimedAt: string | null;
  readonly sentAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WeeklyReportDeliveryRepository {
  claimDue(input: {
    periodStart: string;
    periodEnd: string;
    messageId: string;
    now: string;
    createSnapshot: () => WeeklyBugReport;
  }): WeeklyReportDelivery | null;
  markSent(id: string, now: string): boolean;
  markFailed(id: string, error: string, now: string): boolean;
  get(periodStart: string): WeeklyReportDelivery | null;
}
