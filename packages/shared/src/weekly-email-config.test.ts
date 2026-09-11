import { describe, expect, it } from 'vitest';
import { parseWeeklyEmailConfig, sanitizeDiagnostic, WEEKLY_EMAIL_SMTP_URL } from './index.js';

describe('weekly email configuration', () => {
  it('is disabled only when all three enabling variables are absent', () => {
    expect(parseWeeklyEmailConfig({})).toEqual({ enabled: false });
    expect(parseWeeklyEmailConfig({ WEEKLY_EMAIL_SMTP_URL })).toEqual({ enabled: false });
    for (const env of [
      { WEEKLY_EMAIL_USERNAME: '' },
      { WEEKLY_EMAIL_PASSWORD: 'secret' },
      { WEEKLY_EMAIL_RECIPIENTS: 'owner@example.com' },
    ]) expect(() => parseWeeklyEmailConfig(env)).toThrow();
  });

  it('validates the fixed URL and complete nonempty values', () => {
    const base = { WEEKLY_EMAIL_USERNAME: 'sender@example.com', WEEKLY_EMAIL_PASSWORD: ' secret ', WEEKLY_EMAIL_RECIPIENTS: 'owner@example.com' };
    expect(() => parseWeeklyEmailConfig({ ...base, WEEKLY_EMAIL_SMTP_URL: 'smtp://mail.onecloud.cn:465' })).toThrow();
    expect(() => parseWeeklyEmailConfig({ ...base, WEEKLY_EMAIL_USERNAME: 'invalid' })).toThrow();
    expect(() => parseWeeklyEmailConfig({ ...base, WEEKLY_EMAIL_PASSWORD: '  ' })).toThrow();
    expect(() => parseWeeklyEmailConfig({ ...base, WEEKLY_EMAIL_RECIPIENTS: 'owner@example.com,' })).toThrow();
  });

  it('trims and stably de-duplicates recipients without changing password bytes', () => {
    const parsed = parseWeeklyEmailConfig({
      WEEKLY_EMAIL_USERNAME: ' sender@example.com ',
      WEEKLY_EMAIL_PASSWORD: ' secret ',
      WEEKLY_EMAIL_RECIPIENTS: ' Team@example.com, owner@example.com, team@EXAMPLE.com ',
    });
    expect(parsed).toEqual({ enabled: true, value: {
      smtpUrl: WEEKLY_EMAIL_SMTP_URL,
      username: 'sender@example.com',
      password: ' secret ',
      recipients: ['Team@example.com', 'owner@example.com'],
    } });
  });

  it('redacts email addresses, secrets and bounds persisted diagnostics', () => {
    const result = sanitizeDiagnostic(`password=hunter2 owner@example.com\n${'x'.repeat(400)}`);
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('owner@example.com');
    expect(Array.from(result)).toHaveLength(256);
  });
});
