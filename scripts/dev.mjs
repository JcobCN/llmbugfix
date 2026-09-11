import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outputDir = resolve('.local-build');
const outputFile = resolve(outputDir, 'local-server.mjs');
const watcherLockFile = resolve('data', 'dev-watcher.lock');
const listenAllInterfaces = process.argv.slice(2).includes('--host');
const serverEnv = {
  ...process.env,
  ...(listenAllInterfaces ? { BUGFIX_LISTEN_HOST: '0.0.0.0' } : {}),
  // Dev defaults to logging full LLM request/response exchanges; opt out with INTAKE_LLM_LOG=0.
  ...(process.env.INTAKE_LLM_LOG === undefined ? { INTAKE_LLM_LOG: '1' } : {}),
};
let server;
let restartChain = Promise.resolve();
let stopping = false;

// Two watchers on the same tree fight over .local-build, port 8033 and the
// orchestrator lock, so a second watcher must refuse to start.
const isPidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
let watcherLockHeld = false;
function acquireWatcherLock() {
  if (existsSync(watcherLockFile)) {
    try {
      const existing = JSON.parse(readFileSync(watcherLockFile, 'utf8'));
      if (existing && typeof existing.pid === 'number' && existing.pid !== process.pid && isPidAlive(existing.pid)) {
        console.error(`Another dev watcher (pid ${existing.pid}) is already running for this tree.`);
        console.error(`Stop it first (kill ${existing.pid}) or connect to its server instead of starting a second watcher.`);
        process.exit(1);
      }
    } catch { /* stale or corrupt watcher lock: take it over below */ }
  }
  mkdirSync(resolve('data'), { recursive: true });
  writeFileSync(watcherLockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  watcherLockHeld = true;
}
function releaseWatcherLock() {
  if (!watcherLockHeld) return;
  try { unlinkSync(watcherLockFile); } catch { /* already removed */ }
  watcherLockHeld = false;
}
acquireWatcherLock();

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
  tsconfig: 'tsconfig.json',
  entryPoints: ['apps/bug-api/src/local-server.ts'],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['@earendil-works/pi-coding-agent', 'better-sqlite3', 'drizzle-orm', 'pino', 'yaml', 'zod'],
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
  releaseWatcherLock();
}

process.once('SIGINT', () => { void shutdown('SIGINT').then(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown('SIGTERM').then(() => process.exit(0)); });
