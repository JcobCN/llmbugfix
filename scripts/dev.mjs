import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const outputDir = resolve('.local-build');
const outputFile = resolve(outputDir, 'local-server.mjs');
const listenAllInterfaces = process.argv.slice(2).includes('--host');
const serverEnv = {
  ...process.env,
  ...(listenAllInterfaces ? { BUGFIX_LISTEN_HOST: '0.0.0.0' } : {}),
};
let server;
let restartChain = Promise.resolve();
let stopping = false;

async function stopServer() {
  const current = server;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise((resolveStop) => {
    const force = setTimeout(() => current.kill('SIGKILL'), 5_000);
    current.once('exit', () => { clearTimeout(force); resolveStop(); });
    current.kill('SIGTERM');
  });
  if (server === current) server = undefined;
}

async function restartServer() {
  if (stopping) return;
  await stopServer();
  server = spawn(process.execPath, [outputFile], {
    cwd: process.cwd(),
    env: serverEnv,
    stdio: 'inherit',
  });
  server.once('error', (error) => console.error(`Unable to start local server: ${error.message}`));
}

if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
const watcher = await context({
  absWorkingDir: process.cwd(),
  entryPoints: ['apps/bug-api/src/local-server.ts'],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['better-sqlite3', 'drizzle-orm', 'pino', 'yaml', 'zod'],
  plugins: [{
    name: 'restart-local-server',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length || stopping) return;
        restartChain = restartChain.then(restartServer).catch((error) => console.error(`Unable to restart local server: ${error.message}`));
      });
    },
  }],
});

await watcher.watch();
console.log('esbuild is watching TypeScript sources; the local server will restart after each successful build.');

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; stopping esbuild and local server.`);
  await watcher.dispose();
  await stopServer();
}

process.once('SIGINT', () => { void shutdown('SIGINT').then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown('SIGTERM').then(() => process.exit(0)); });
