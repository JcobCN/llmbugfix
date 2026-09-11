import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const outputDir = resolve('dist');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

await build({
  absWorkingDir: process.cwd(),
  tsconfig: 'tsconfig.json',
  entryPoints: ['apps/bug-api/src/local-server.ts'],
  outfile: resolve(outputDir, 'local-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: [
    '@earendil-works/pi-coding-agent',
    'better-sqlite3',
    'drizzle-orm',
    'pino',
    'yaml',
    'zod',
  ],
});

cpSync(resolve('apps/bug-web/public'), resolve(outputDir, 'public'), {
  recursive: true,
});
