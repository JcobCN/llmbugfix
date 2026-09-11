import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { AppError, WeeklyEmailConfigSchema, type WeeklyEmailConfig } from '@llmbugfix/shared';
import type { MailMessage, MailSender } from './schemas.js';

interface SMTPTransportLike {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export type SMTPTransportFactory = (options: SMTPTransport.Options) => SMTPTransportLike;

export interface SMTPMailSenderOptions {
  readonly connectionTimeoutMs?: number;
  readonly authenticationTimeoutMs?: number;
  readonly socketTimeoutMs?: number;
  readonly sendTimeoutMs?: number;
  /** Test seam: production always uses nodemailer's SMTP transport. */
  readonly transportFactory?: SMTPTransportFactory;
}

export class SMTPDeliveryError extends AppError {
  constructor(code: 'SMTP_ABORTED' | 'SMTP_TIMEOUT' | 'SMTP_AUTHENTICATION_FAILED' | 'SMTP_TLS_FAILED' | 'SMTP_SEND_FAILED', message: string) {
    super(code, message);
    this.name = 'SMTPDeliveryError';
  }
}

function safeSMTPError(error: unknown): SMTPDeliveryError {
  const record = error && typeof error === 'object' ? error as { code?: unknown; command?: unknown; name?: unknown; message?: unknown } : {};
  const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
  const command = typeof record.command === 'string' ? record.command.toUpperCase() : '';
  const name = typeof record.name === 'string' ? record.name.toUpperCase() : '';
  const message = typeof record.message === 'string' ? record.message.toUpperCase() : '';
  if (code === 'EAUTH' || command === 'AUTH') return new SMTPDeliveryError('SMTP_AUTHENTICATION_FAILED', 'SMTP authentication failed');
  if (code.includes('CERT') || code.includes('TLS') || name.includes('CERT') || message.includes('CERTIFICATE')) return new SMTPDeliveryError('SMTP_TLS_FAILED', 'SMTP TLS certificate verification failed');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || message.includes('TIMEOUT')) return new SMTPDeliveryError('SMTP_TIMEOUT', 'SMTP operation timed out');
  return new SMTPDeliveryError('SMTP_SEND_FAILED', 'SMTP delivery failed');
}

export class NodemailerSMTPMailSender implements MailSender {
  private readonly config: WeeklyEmailConfig;
  private readonly options: Required<Omit<SMTPMailSenderOptions, 'transportFactory'>>;
  private readonly factory: SMTPTransportFactory;

  constructor(config: WeeklyEmailConfig, options: SMTPMailSenderOptions = {}) {
    this.config = WeeklyEmailConfigSchema.parse(config);
    this.options = {
      connectionTimeoutMs: options.connectionTimeoutMs ?? 10_000,
      authenticationTimeoutMs: options.authenticationTimeoutMs ?? 10_000,
      socketTimeoutMs: options.socketTimeoutMs ?? 30_000,
      sendTimeoutMs: options.sendTimeoutMs ?? 30_000,
    };
    for (const [name, value] of Object.entries(this.options)) {
      if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    }
    this.factory = options.transportFactory ?? ((transportOptions) => nodemailer.createTransport(transportOptions));
  }

  async send(message: MailMessage, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SMTPDeliveryError('SMTP_ABORTED', 'SMTP delivery was cancelled');
    if (message.from.toLocaleLowerCase('en-US') !== this.config.username.toLocaleLowerCase('en-US')) {
      throw new SMTPDeliveryError('SMTP_SEND_FAILED', 'SMTP sender does not match configured account');
    }
    const expectedRecipients = this.config.recipients.map((recipient) => recipient.toLocaleLowerCase('en-US'));
    const actualRecipients = message.to.map((recipient) => recipient.toLocaleLowerCase('en-US'));
    if (expectedRecipients.length !== actualRecipients.length || expectedRecipients.some((recipient, index) => recipient !== actualRecipients[index])) {
      throw new SMTPDeliveryError('SMTP_SEND_FAILED', 'SMTP recipients do not match configured destinations');
    }

    const transport = this.factory({
      host: 'mail.onecloud.cn',
      port: 465,
      secure: true,
      tls: { rejectUnauthorized: !this.config.allowInsecureTls },
      auth: { user: this.config.username, pass: this.config.password },
      authMethod: 'LOGIN',
      connectionTimeout: this.options.connectionTimeoutMs,
      greetingTimeout: this.options.authenticationTimeoutMs,
      socketTimeout: this.options.socketTimeoutMs,
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let termination: 'abort' | 'timeout' | undefined;
    let rejectTermination: ((reason: SMTPDeliveryError) => void) | undefined;
    const terminated = new Promise<never>((_resolve, reject) => { rejectTermination = reject; });
    const terminate = (kind: 'abort' | 'timeout', error: SMTPDeliveryError): void => {
      if (termination) return;
      // Settle our deterministic classification before close() can make the
      // underlying transport reject with an arbitrary socket/authentication error.
      termination = kind;
      rejectTermination?.(error);
      transport.close();
    };
    const abort = (): void => {
      terminate('abort', new SMTPDeliveryError('SMTP_ABORTED', 'SMTP delivery was cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const send = transport.sendMail({
        from: this.config.username,
        to: [...message.to],
        envelope: { from: this.config.username, to: [...message.to] },
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
        textEncoding: 'quoted-printable',
        headers: { 'X-LLMBugFix-Report': 'weekly' },
      });
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new SMTPDeliveryError('SMTP_TIMEOUT', 'SMTP send timed out');
          terminate('timeout', error);
          reject(error);
        }, this.options.sendTimeoutMs);
        timeout.unref?.();
      });
      await Promise.race([send, timedOut, terminated]);
    } catch (error) {
      if (termination === 'abort' || signal?.aborted) throw new SMTPDeliveryError('SMTP_ABORTED', 'SMTP delivery was cancelled');
      if (termination === 'timeout') throw new SMTPDeliveryError('SMTP_TIMEOUT', 'SMTP send timed out');
      if (error instanceof SMTPDeliveryError) throw error;
      throw safeSMTPError(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      transport.close();
    }
  }
}
