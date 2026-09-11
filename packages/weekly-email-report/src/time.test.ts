import { describe, expect, it } from 'vitest';
import { mostRecentDuePeriod, nextScheduledPeriod } from './index.js';

describe('Asia/Shanghai weekly boundaries', () => {
  it('uses exact Monday 00:00 and Saturday 09:00 regardless of host time zone', () => {
    expect(nextScheduledPeriod(new Date('2026-09-07T03:15:00-07:00'))).toEqual({
      periodStart: '2026-09-07T00:00:00+08:00',
      periodEnd: '2026-09-12T09:00:00+08:00',
    });
  });

  it('treats Saturday 09:00 as due and advances the next schedule', () => {
    const boundary = new Date('2026-09-12T09:00:00+08:00');
    expect(mostRecentDuePeriod(boundary)).toEqual({
      periodStart: '2026-09-07T00:00:00+08:00', periodEnd: '2026-09-12T09:00:00+08:00',
    });
    expect(nextScheduledPeriod(boundary)).toEqual({
      periodStart: '2026-09-14T00:00:00+08:00', periodEnd: '2026-09-19T09:00:00+08:00',
    });
  });

  it('returns the previous period before this week is due', () => {
    expect(mostRecentDuePeriod(new Date('2026-09-07T00:00:00+08:00'))).toEqual({
      periodStart: '2026-08-31T00:00:00+08:00', periodEnd: '2026-09-05T09:00:00+08:00',
    });
  });
});
