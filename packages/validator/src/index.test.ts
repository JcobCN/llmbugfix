import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRunner, Validator } from './index.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-command-'));
describe('CommandRunner', () => {
  it('passes argv literally and redacts/truncates output', async () => {
    const cwd = dir(); const runner = new CommandRunner({ allowedCwdRoots: [cwd], maxOutputChars: 32, env: { TEST_SECRET: 'hidden' } });
    const result = await runner.run('/bin/echo', ['token=hidden;', 'x'.repeat(100)], { cwd });
    expect(result.exitCode).toBe(0); expect(result.stdout).toContain('[REDACTED]'); expect(result.stdout).toContain('[TRUNCATED]');
  });
  it('rejects shell syntax and terminates timed out children', async () => {
    const cwd = dir(); const runner = new CommandRunner({ allowedCwdRoots: [cwd] });
    await expect(runner.run(process.execPath, ['-e', 'process.exit(0)'], { cwd: path.join(cwd, '..') })).rejects.toThrow(/outside|does not exist/);
    await expect(runner.run('echo;touch', [], { cwd })).rejects.toThrow();
    const result = await runner.run('/bin/sleep', ['5'], { cwd, timeoutMs: 20 }); expect(result.timedOut).toBe(true); expect(result.exitCode).not.toBe(0);
  });
  it('captures every deterministic validation command', async () => {
    const cwd = dir(); const validator = new Validator(new CommandRunner({ allowedCwdRoots: [cwd] })); const result = await validator.runValidation(cwd, ['/bin/false', '/bin/echo ok']);
    expect(result.passed).toBe(false); expect(result.results).toHaveLength(2); expect(result.results[1]?.stdout.trim()).toBe('ok');
  });
  it('exposes a controlled non-blocking process handle', async () => {
    const cwd = dir(); const runner = new CommandRunner({ allowedCwdRoots: [cwd] });
    const handle = runner.start(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { cwd, timeoutMs: 1000 });
    expect(handle.isRunning()).toBe(true); await handle.stop(); const result = await handle.result;
    expect(result.exitCode).not.toBe(0); expect(result.aborted).toBe(true);
  });
});
