import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnvironmentRunner } from './index.js';
import type { EnvironmentProfile } from '@llmbugfix/environment-resolver';

const profile: EnvironmentProfile = { id: 'p', name: 'p', target: 'backend', type: 'backend', repository: '/tmp/repo', repoUrl: '/tmp/repo', defaultBranch: 'main', baseBranch: 'main', instructions: [], markdown: [], skills: [], documentationPaths: [], skillPaths: [], setupCommands: ['/bin/echo setup'], validationCommands: [], setup: [], validation: [], runtime: { startCommand: '/bin/echo runtime', healthCheck: '/bin/echo health', stopCommand: '/bin/echo stop', startupTimeoutSeconds: 1 } };
class FakeRunner { commands: string[] = []; failHealth = false; async run(command: string, args: string[]): Promise<any> { this.commands.push([command, ...args].join(' ')); const failed = this.failHealth && command === '/bin/echo' && args[0] === 'health'; return { command, args, exitCode: failed ? 1 : 0, stdout: '', stderr: '', timedOut: false, timeout: false, aborted: false }; } }
describe('EnvironmentRunner', () => {
  it('executes setup, runtime, health and stop in order', async () => { const fake = new FakeRunner(); const runner = new EnvironmentRunner({ commandRunner: fake as any, commandTimeoutMs: 100 }); const result = await runner.run('/tmp', profile); expect(result.status).toBe('ENV_READY'); await runner.stopEnvironment('/tmp', profile); expect(fake.commands.map((x) => x.split(' ')[1])).toEqual(['setup', 'runtime', 'health', 'stop']); });
  it('stops a started runtime and blocks on failed health', async () => { const fake = new FakeRunner(); fake.failHealth = true; const runner = new EnvironmentRunner({ commandRunner: fake as any }); const result = await runner.run('/tmp', profile); expect(result.status).toBe('ENVIRONMENT_FAILED'); expect(result.stop).toHaveLength(1); expect(fake.commands.at(-1)).toContain('stop'); });
  it('starts a foreground runtime without waiting for process exit and reaps it on stop', async () => {
    let running = false; let stopped = false; const commands: string[] = [];
    const fake = {
      async run(command: string, args: string[]): Promise<any> { commands.push([command, ...args].join(' ')); return { command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false, timeout: false, aborted: false }; },
      start(command: string, args: string[]): any { running = true; return { command, args, pid: 42, result: Promise.resolve({ command, args, exitCode: 0, stdout: '', stderr: '', timedOut: false, timeout: false, aborted: false }), isRunning: () => running, stop: async () => { running = false; stopped = true; } }; },
    };
    const runner = new EnvironmentRunner({ commandRunner: fake as any }); const result = await runner.run('/tmp', profile);
    expect(result.status).toBe('ENV_READY'); expect(commands).toEqual(['/bin/echo setup', '/bin/echo health']); expect(running).toBe(true);
    await runner.stopEnvironment('/tmp', profile); expect(stopped).toBe(true); expect(running).toBe(false); expect(commands.at(-1)).toBe('/bin/echo stop');
  });
});
