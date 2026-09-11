import { describe, expect, it, vi } from 'vitest';
import { NodemailerSMTPMailSender, SMTPDeliveryError, type MailMessage } from './index.js';

const config = { smtpUrl: 'smtps://mail.onecloud.cn:465' as const, username: 'sender@example.com', password: 'dummy-password', recipients: ['owner@example.com'] };
const message: MailMessage = {
  from: config.username, to: config.recipients, subject: '周报', text: '纯文本', html: '<p>纯文本</p>', messageId: '<stable@example.com>',
};

describe('nodemailer SMTP adapter', () => {
  it('pins implicit TLS, authentication, envelope, UTF-8 alternatives and Message-ID', async () => {
    let transportOptions: Record<string, unknown> | undefined;
    let mailOptions: Record<string, unknown> | undefined;
    const sender = new NodemailerSMTPMailSender(config, { transportFactory: (options) => {
      transportOptions = options as unknown as Record<string, unknown>;
      return { sendMail: async (mail) => { mailOptions = mail; }, close: vi.fn() };
    } });
    await sender.send(message);
    expect(transportOptions).toMatchObject({ host: 'mail.onecloud.cn', port: 465, secure: true, auth: { user: config.username, pass: config.password } });
    expect(transportOptions).not.toHaveProperty('tls.rejectUnauthorized', false);
    expect(mailOptions).toMatchObject({
      from: config.username, to: config.recipients, envelope: { from: config.username, to: config.recipients },
      subject: message.subject, text: message.text, html: message.html, messageId: message.messageId,
    });
  });

  it('maps raw authentication failures to a bounded credential-free diagnostic', async () => {
    const sender = new NodemailerSMTPMailSender(config, { transportFactory: () => ({
      sendMail: async () => { throw Object.assign(new Error(`535 owner@example.com ${config.password} raw server response`), { code: 'EAUTH' }); }, close: vi.fn(),
    }) });
    const error = await sender.send(message).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SMTPDeliveryError);
    expect(String(error)).toContain('SMTP authentication failed');
    expect(String(error)).not.toContain(config.password);
    expect(String(error)).not.toContain(config.recipients[0]);
    expect(String(error)).not.toContain('raw server response');
  });

  it.each([
    [{ code: 'CERT_HAS_EXPIRED', message: `certificate for owner@example.com contained ${config.password}` }, 'SMTP_TLS_FAILED'],
    [{ code: 'ETIMEDOUT', message: `timeout for owner@example.com contained ${config.password}` }, 'SMTP_TIMEOUT'],
  ] as const)('maps TLS and timeout failures without returning raw server text', async (failure, expectedCode) => {
    const sender = new NodemailerSMTPMailSender(config, { transportFactory: () => ({
      sendMail: async () => { throw Object.assign(new Error(failure.message), { code: failure.code }); }, close: vi.fn(),
    }) });
    const error = await sender.send(message).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: expectedCode });
    expect(String(error)).not.toContain(config.password);
    expect(String(error)).not.toContain(config.recipients[0]);
  });

  it('closes the live transport when cancelled', async () => {
    const close = vi.fn();
    let rejectSend: ((reason: unknown) => void) | undefined;
    const sender = new NodemailerSMTPMailSender(config, { transportFactory: () => ({
      sendMail: () => new Promise((_resolve, reject) => { rejectSend = reject; }),
      close: () => { close(); rejectSend?.(Object.assign(new Error('socket closed during AUTH'), { code: 'EAUTH' })); },
    }) });
    const controller = new AbortController();
    const sending = sender.send(message, controller.signal);
    controller.abort();
    await expect(sending).rejects.toMatchObject({ code: 'SMTP_ABORTED' });
    expect(close).toHaveBeenCalled();
  });

  it('keeps timeout classification when close triggers an adversarial transport rejection', async () => {
    vi.useFakeTimers();
    try {
      let rejectSend: ((reason: unknown) => void) | undefined;
      const close = vi.fn(() => { rejectSend?.(Object.assign(new Error('certificate response after close'), { code: 'CERT_HAS_EXPIRED' })); });
      const sender = new NodemailerSMTPMailSender(config, { sendTimeoutMs: 25, transportFactory: () => ({
        sendMail: () => new Promise((_resolve, reject) => { rejectSend = reject; }), close,
      }) });
      const sending = sender.send(message);
      const expectation = expect(sending).rejects.toMatchObject({ code: 'SMTP_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25);
      await expectation;
      expect(close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
