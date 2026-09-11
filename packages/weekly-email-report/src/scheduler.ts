import { createHash } from 'node:crypto';
import { sanitizeDiagnostic } from '@llmbugfix/shared';
import type {
  MailSender,
  WeeklyReportClock,
  WeeklyReportDelivery,
  WeeklyReportDeliveryRepository,
  WeeklyReportService,
} from './schemas.js';
import { renderWeeklyReport } from './service.js';
import { mostRecentDuePeriod, nextScheduledPeriod } from './time.js';

export function weeklyReportMessageId(periodStart: string): string {
  const digest = createHash('sha256').update(`llmbugfix-weekly\0${periodStart}`).digest('hex').slice(0, 32);
  return `<llmbugfix-weekly-${digest}@mail.onecloud.cn>`;
}

export interface WeeklyReportSchedulerLogger {
  info(context: unknown, message?: string): void;
  warn(context: unknown, message?: string): void;
  error(context: unknown, message?: string): void;
}

const silentLogger: WeeklyReportSchedulerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface WeeklyReportSchedulerOptions {
  readonly from: string;
  readonly to: readonly string[];
  readonly maximumTimerMs?: number;
  readonly logger?: WeeklyReportSchedulerLogger;
}

export class WeeklyReportScheduler {
  private readonly logger: WeeklyReportSchedulerLogger;
  private readonly maximumTimerMs: number;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly clock: WeeklyReportClock,
    private readonly deliveries: WeeklyReportDeliveryRepository,
    private readonly reports: WeeklyReportService,
    private readonly mail: MailSender,
    private readonly options: WeeklyReportSchedulerOptions,
  ) {
    if (!options.from || options.to.length === 0) throw new Error('Weekly report sender and recipients are required');
    this.logger = options.logger ?? silentLogger;
    this.maximumTimerMs = options.maximumTimerMs ?? 60 * 60_000;
    if (this.maximumTimerMs <= 0) throw new RangeError('Weekly scheduler maximum timer must be positive');
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.runAndReschedule();
  }

  private async runAndReschedule(): Promise<void> {
    if (!this.active || this.inFlight) return;
    this.inFlight = this.runDueDeliveries();
    try {
      await this.inFlight;
    } catch (error) {
      this.logger.error({ error: sanitizeDiagnostic(error) }, 'Weekly email cycle failed');
    } finally {
      this.inFlight = undefined;
      if (this.active) {
        try {
          this.scheduleNextWake();
        } catch (error) {
          this.logger.error({ error: sanitizeDiagnostic(error) }, 'Unable to calculate next weekly email wake time');
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.runAndReschedule();
          }, this.maximumTimerMs);
          this.timer.unref?.();
        }
      }
    }
  }

  private async runDueDeliveries(): Promise<void> {
    if (!this.active) return;
    await this.claimAndSend(mostRecentDuePeriod(this.clock.now()));
  }

  private async claimAndSend(period: { periodStart: string; periodEnd: string }): Promise<void> {
    if (!this.active) return;
    let delivery: WeeklyReportDelivery | null = null;
    try {
      const current = this.clock.now();
      delivery = this.deliveries.claimDue({
        ...period,
        messageId: weeklyReportMessageId(period.periodStart),
        now: current.toISOString(),
        createSnapshot: () => this.reports.generate(period.periodStart, period.periodEnd),
      });
      if (!delivery || !this.active) return;
      const rendered = renderWeeklyReport(delivery.reportSnapshot);
      this.controller = new AbortController();
      await this.mail.send({
        from: this.options.from,
        to: this.options.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        messageId: delivery.messageId,
      }, this.controller.signal);
      if (!this.active) return;
      const finalizationError = 'SMTP accepted the weekly email but delivery status finalization failed';
      let finalized = false;
      let finalizationCause: unknown;
      try { finalized = this.deliveries.markSent(delivery.id, this.clock.now().toISOString()); }
      catch (error) { finalizationCause = error; }
      if (!finalized) {
        this.recordFailure(delivery, finalizationError);
        this.logger.error({ periodStart: delivery.periodStart, error: finalizationError, ...(finalizationCause ? { cause: sanitizeDiagnostic(finalizationCause) } : {}) }, 'Weekly email delivery finalization failed');
        return;
      }
      this.logger.info({ periodStart: delivery.periodStart, attemptCount: delivery.attemptCount }, 'Weekly email sent');
    } catch (error) {
      if (!this.active && this.controller?.signal.aborted) {
        if (delivery) this.recordFailure(delivery, 'SMTP delivery cancelled during shutdown');
        return;
      }
      const diagnostic = sanitizeDiagnostic(error);
      if (delivery) this.recordFailure(delivery, diagnostic);
      this.logger.error({ periodStart: period.periodStart, error: diagnostic }, 'Weekly email delivery failed');
    } finally {
      this.controller = undefined;
    }
  }

  private recordFailure(delivery: WeeklyReportDelivery, error: string): void {
    const diagnostic = sanitizeDiagnostic(error);
    try {
      const failedAt = this.clock.now();
      const persisted = this.deliveries.markFailed(delivery.id, diagnostic, failedAt.toISOString());
      if (!persisted) this.logger.error({ periodStart: delivery.periodStart, error: diagnostic }, 'Unable to persist weekly email failure');
    } catch (persistenceError) {
      this.logger.error({ periodStart: delivery.periodStart, error: sanitizeDiagnostic(persistenceError), deliveryError: diagnostic }, 'Unable to persist weekly email failure');
    }
  }

  private scheduleNextWake(): void {
    if (!this.active) return;
    const current = this.clock.now();
    const nextPeriod = nextScheduledPeriod(current);
    const wakeAt = Date.parse(nextPeriod.periodEnd);
    const delay = Math.max(1_000, Math.min(this.maximumTimerMs, wakeAt - current.getTime()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runAndReschedule();
    }, delay);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.inFlight;
  }
}
