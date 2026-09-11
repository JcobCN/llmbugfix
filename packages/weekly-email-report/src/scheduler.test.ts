import { describe, expect, it, vi } from 'vitest';
import { openDatabase, SQLiteWeeklyReportDeliveryRepository } from '@llmbugfix/bug-repository';
import {
  WeeklyReportScheduler,
  weeklyReportMessageId,
  type MailMessage,
  type MailSender,
  type WeeklyReportClock,
  type WeeklyReportService,
} from './index.js';

class FakeClock implements WeeklyReportClock {
  constructor(public value: Date) {}
  now(): Date { return new Date(this.value); }
}

const service = (counter: { value: number }): WeeklyReportService => ({
  generate: (periodStart, periodEnd) => {
    counter.value += 1;
    return { periodStart, periodEnd, successCount: 0, failedCount: 0, inProgressCount: 0, bugs: [] };
  },
});

describe('weekly report scheduler', () => {
  it('records one SMTP failure and never retries the same period after restart', async () => {
    const db = openDatabase();
    const deliveries = new SQLiteWeeklyReportDeliveryRepository(db);
    const clock = new FakeClock(new Date('2026-09-12T09:00:00+08:00'));
    const generated = { value: 0 };
    const attempts: MailMessage[] = [];
    const failing: MailSender = { send: async (message) => {
      attempts.push(message);
      throw new Error('password=do-not-store user@example.com rejected');
    } };
    const first = new WeeklyReportScheduler(clock, deliveries, service(generated), failing, { from: 'sender@example.com', to: ['owner@example.com'] });
    await first.start();
    await first.stop();

    const failed = deliveries.get('2026-09-07T00:00:00+08:00');
    expect(failed).toMatchObject({ status: 'FAILED', attemptCount: 1, nextAttemptAt: null });
    expect(failed?.lastError).not.toMatch(/do-not-store|user@example/u);

    clock.value = new Date('2026-09-12T15:00:00+08:00');
    const restarted = new WeeklyReportScheduler(clock, deliveries, service(generated), { send: async (message) => { attempts.push(message); } }, { from: 'sender@example.com', to: ['owner@example.com'] });
    await restarted.start();
    await restarted.stop();
    expect(attempts).toHaveLength(1);
    expect(generated.value).toBe(1);
    expect(deliveries.get('2026-09-07T00:00:00+08:00')).toMatchObject({ status: 'FAILED', attemptCount: 1, nextAttemptAt: null });
    db.close();
  });

  it('sends a new week despite an older FAILED period and de-duplicates SENT', async () => {
    const db = openDatabase();
    const deliveries = new SQLiteWeeklyReportDeliveryRepository(db);
    const oldStart = '2026-09-07T00:00:00+08:00';
    const oldEnd = '2026-09-12T09:00:00+08:00';
    const old = deliveries.claimDue({
      periodStart: oldStart,
      periodEnd: oldEnd,
      messageId: weeklyReportMessageId(oldStart),
      now: oldEnd,
      createSnapshot: () => ({ periodStart: oldStart, periodEnd: oldEnd, successCount: 0, failedCount: 0, inProgressCount: 0, bugs: [] }),
    })!;
    deliveries.markFailed(old.id, 'temporary SMTP failure', '2026-09-12T09:00:01+08:00');

    const clock = new FakeClock(new Date('2026-09-19T09:00:00+08:00'));
    const generated = { value: 0 };
    const attempts: MailMessage[] = [];
    const sender: MailSender = { send: async (message) => { attempts.push(message); } };
    const current = new WeeklyReportScheduler(clock, deliveries, service(generated), sender, { from: 'sender@example.com', to: ['owner@example.com'] });
    await current.start();
    await current.stop();

    const currentStart = '2026-09-14T00:00:00+08:00';
    expect(attempts.map(({ messageId }) => messageId)).toEqual([weeklyReportMessageId(currentStart)]);
    expect(generated.value).toBe(1);
    expect(deliveries.get(oldStart)).toMatchObject({ status: 'FAILED', attemptCount: 1, nextAttemptAt: null });
    expect(deliveries.get(currentStart)).toMatchObject({ status: 'SENT', attemptCount: 1, nextAttemptAt: null });

    const restarted = new WeeklyReportScheduler(clock, deliveries, service(generated), sender, { from: 'sender@example.com', to: ['owner@example.com'] });
    await restarted.start();
    await restarted.stop();
    expect(attempts).toHaveLength(1);
    expect(generated.value).toBe(1);
    db.close();
  });

  it('persists an explicit terminal failure and never logs success when SENT finalization fails', async () => {
    const db = openDatabase();
    const stored = new SQLiteWeeklyReportDeliveryRepository(db);
    const deliveries = {
      claimDue: stored.claimDue.bind(stored),
      markSent: () => false,
      markFailed: stored.markFailed.bind(stored),
      get: stored.get.bind(stored),
    };
    const info = vi.fn();
    const error = vi.fn();
    const scheduler = new WeeklyReportScheduler(
      new FakeClock(new Date('2026-09-12T09:00:00+08:00')),
      deliveries,
      service({ value: 0 }),
      { send: async () => {} },
      { from: 'sender@example.com', to: ['owner@example.com'], logger: { info, warn: vi.fn(), error } },
    );
    await scheduler.start();
    await scheduler.stop();
    const delivery = stored.get('2026-09-07T00:00:00+08:00');
    expect(delivery).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      nextAttemptAt: null,
      lastError: 'SMTP accepted the weekly email but delivery status finalization failed',
    });
    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    db.close();
  });

  it('cancels in-flight SMTP on stop, records failure, and never resends the period', async () => {
    const db = openDatabase();
    const deliveries = new SQLiteWeeklyReportDeliveryRepository(db);
    const clock = new FakeClock(new Date('2026-09-12T09:00:00+08:00'));
    const generated = { value: 0 };
    let observedAbort = false;
    let restartedAttempts = 0;
    const sender: MailSender = { send: async (_message, signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); }, { once: true });
    }) };
    const scheduler = new WeeklyReportScheduler(clock, deliveries, service(generated), sender, { from: 'sender@example.com', to: ['owner@example.com'] });
    const starting = scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await scheduler.stop();
    await starting;
    expect(observedAbort).toBe(true);
    expect(deliveries.get('2026-09-07T00:00:00+08:00')).toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      nextAttemptAt: null,
      lastError: 'SMTP delivery cancelled during shutdown',
    });

    const restarted = new WeeklyReportScheduler(clock, deliveries, service(generated), { send: async () => { restartedAttempts += 1; } }, { from: 'sender@example.com', to: ['owner@example.com'] });
    await restarted.start();
    await restarted.stop();
    expect(restartedAttempts).toBe(0);
    expect(generated.value).toBe(1);
    db.close();
  });
});
