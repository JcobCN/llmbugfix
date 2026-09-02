import { z } from 'zod';

export const configSchema = z.object({
  DATABASE_PATH: z.string().min(1).default('data/bugfix.sqlite'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_ROOT: z.string().min(1).default('data'),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(52_428_800),
});
export type AppConfig = z.infer<typeof configSchema>;
export const parseConfig = (env: Record<string, string | undefined> = process.env): AppConfig => configSchema.parse(env);
