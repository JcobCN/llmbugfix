import { z } from 'zod';

export const WEEKLY_EMAIL_SMTP_URL = 'smtps://mail.onecloud.cn:465' as const;

const emailAddressSchema = z.string().email();

export const WeeklyEmailConfigSchema = z.object({
  smtpUrl: z.literal(WEEKLY_EMAIL_SMTP_URL),
  username: emailAddressSchema,
  password: z.string().min(1),
  recipients: z.array(emailAddressSchema).min(1),
}).strict();
export type WeeklyEmailConfig = z.infer<typeof WeeklyEmailConfigSchema>;

export type WeeklyEmailConfiguration =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly value: WeeklyEmailConfig };

/**
 * The SMTP URL alone never enables weekly mail.  Once any of the three
 * credential/destination variables is present, however, all three are
 * required and invalid configuration is fatal.
 */
export function parseWeeklyEmailConfig(env: Record<string, string | undefined> = process.env): WeeklyEmailConfiguration {
  const smtpUrl = env.WEEKLY_EMAIL_SMTP_URL ?? WEEKLY_EMAIL_SMTP_URL;
  if (smtpUrl !== WEEKLY_EMAIL_SMTP_URL) {
    throw new Error(`WEEKLY_EMAIL_SMTP_URL must be exactly ${WEEKLY_EMAIL_SMTP_URL}`);
  }

  const rawUsername = env.WEEKLY_EMAIL_USERNAME;
  const rawPassword = env.WEEKLY_EMAIL_PASSWORD;
  const rawRecipients = env.WEEKLY_EMAIL_RECIPIENTS;
  if (rawUsername === undefined && rawPassword === undefined && rawRecipients === undefined) return { enabled: false };

  if (rawUsername === undefined || rawPassword === undefined || rawRecipients === undefined) {
    throw new Error('WEEKLY_EMAIL_USERNAME, WEEKLY_EMAIL_PASSWORD and WEEKLY_EMAIL_RECIPIENTS must be configured together');
  }
  const username = rawUsername.trim();
  if (!username) throw new Error('WEEKLY_EMAIL_USERNAME must not be empty');
  if (!rawPassword.trim()) throw new Error('WEEKLY_EMAIL_PASSWORD must not be empty');
  if (!rawRecipients.trim()) throw new Error('WEEKLY_EMAIL_RECIPIENTS must not be empty');

  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const rawRecipient of rawRecipients.split(',')) {
    const recipient = rawRecipient.trim();
    if (!recipient) throw new Error('WEEKLY_EMAIL_RECIPIENTS must not contain empty entries');
    const parsed = emailAddressSchema.safeParse(recipient);
    if (!parsed.success) throw new Error('WEEKLY_EMAIL_RECIPIENTS contains an invalid email address');
    const key = parsed.data.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      recipients.push(parsed.data);
    }
  }

  const parsedUsername = emailAddressSchema.safeParse(username);
  if (!parsedUsername.success) throw new Error('WEEKLY_EMAIL_USERNAME must be a valid email address');
  return {
    enabled: true,
    value: WeeklyEmailConfigSchema.parse({ smtpUrl, username: parsedUsername.data, password: rawPassword, recipients }),
  };
}

export const configSchema = z.object({
  DATABASE_PATH: z.string().min(1).default('data/bugfix.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_ROOT: z.string().min(1).default('data'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(52_428_800),
});
export type AppConfig = z.infer<typeof configSchema>;
export const parseConfig = (env: Record<string, string | undefined> = process.env): AppConfig => configSchema.parse(env);
