import pino, { type Logger } from 'pino';
import { redactSecrets } from './redaction.js';
export const createLogger = (name = 'llm-bugfix'): Logger => pino({ name, level: process.env.LOG_LEVEL ?? 'info', redact: ['password', 'token', 'secret', 'apiKey', 'authorization', 'cookie'] });
export const safeLogContext = (context: unknown): unknown => redactSecrets(context);
