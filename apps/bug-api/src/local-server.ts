/**
 * Local-only bootstrap for trying the intake UI and API without external
 * services. It deliberately starts no repair worker: the checked-in
 * environment profiles contain deployment-specific repository placeholders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentService } from '@llmbugfix/attachment-service';
import { openDatabase, SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { JobQueue } from '@llmbugfix/job-queue';
import { parseConfig } from '@llmbugfix/shared';
import { renderDashboardHtml, renderDetailHtml, renderIndexHtml } from '../../bug-web/src/index.js';
import { BugApiServer } from './index.js';

function loadDotEnv(filename = '.env'): void {
  if (!fs.existsSync(filename)) return;
  for (const sourceLine of fs.readFileSync(filename, 'utf8').split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function portFromEnv(value: string | undefined): number {
  if (value === undefined || value === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  return port;
}

loadDotEnv();
const config = parseConfig();
const db = openDatabase(config.DATABASE_PATH);
const repo = new SQLiteBugRepository(db);
const queue = new JobQueue(repo, path.join(config.DATA_ROOT, 'queue'), { autoAcquireLock: true });
const attachments = new AttachmentService(path.join(config.DATA_ROOT, 'attachments'), { maxBytes: config.MAX_ATTACHMENT_BYTES });
const pageRenderer = (pathname: string): string | undefined => {
  if (pathname === '/') return renderIndexHtml();
  if (pathname === '/dashboard') return renderDashboardHtml();
  const detail = pathname.match(/^\/bugs\/([^/]+)$/u);
  return detail ? renderDetailHtml(decodeURIComponent(detail[1])) : undefined;
};
const api = new BugApiServer({ ...process.env, ...config, DRY_RUN: true }, { repo, queue, attachments, pageRenderer });
const port = await api.listen(portFromEnv(process.env.PORT), '127.0.0.1');
console.log(`LLM Bugfix local verification server is ready at http://127.0.0.1:${port}`);
console.log('External LLM, vision, Git, and repair worker are disabled; submitted reports stay in the local queue.');

let closing = false;
const shutdown = (signal: string): void => {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing local server.`);
  void api.close().finally(() => { queue.close(); db.close(); });
};
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
