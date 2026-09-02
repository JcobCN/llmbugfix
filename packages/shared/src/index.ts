import { createLogger } from './logger.js';
import { parseConfig } from './config.js';
export * from './config.js';
export * from './errors.js';
export * from './ids.js';
export * from './logger.js';
export * from './path.js';
export * from './redaction.js';
export * from './time.js';

// Compatibility names used by the other workspace packages.
export { newId as generateId } from './ids.js';
export const logger = createLogger();
export { assertPathSafe } from './path.js';
export const loadConfig = () => {
  const config = parseConfig();
  return {
    ...config,
    dataDir: config.DATA_ROOT,
    sqlitePath: config.DATABASE_PATH,
    attachmentsDir: `${config.DATA_ROOT}/attachments`,
    logsDir: `${config.DATA_ROOT}/logs`,
    worktreesDir: `${config.DATA_ROOT}/worktrees`,
    resultsDir: `${config.DATA_ROOT}/results`,
    dryRun: false,
    visionEnabled: false,
    gitAllowedHosts: [],
  };
};
