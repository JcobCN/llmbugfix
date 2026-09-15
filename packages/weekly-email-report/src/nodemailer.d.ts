declare module 'nodemailer' {
  export type Transporter = { sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>; close(): void };
  export function createTransport(options: unknown): Transporter;
}
declare module 'nodemailer/lib/smtp-transport/index.js' {
  namespace SMTPTransport { type Options = Record<string, unknown>; }
  export = SMTPTransport;
}
