import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '@llmbugfix/shared';
import { ValidationResultSchema, type ValidationResult } from '@llmbugfix/bug-domain';

export interface CommandExecutionResult { command: string; args: string[]; exitCode: number; stdout: string; stderr: string; timedOut: boolean; timeout: boolean; aborted: boolean; }
export interface CommandRunnerOptions { allowedCwdRoots?: string[]; maxOutputChars?: number; env?: NodeJS.ProcessEnv; }
export interface CommandExecutionOptions { cwd: string; timeoutMs?: number; signal?: AbortSignal; maxOutputChars?: number; env?: NodeJS.ProcessEnv; }
export interface CommandProcessHandle {
  readonly command: string;
  readonly args: string[];
  readonly pid: number | undefined;
  readonly result: Promise<CommandExecutionResult>;
  readonly isRunning: () => boolean;
  readonly stop: (signal?: NodeJS.Signals) => Promise<void>;
}
const inside = (root: string, value: string) => value === root || value.startsWith(`${root}${path.sep}`);

/** Executes argv directly. It deliberately has no shell mode and validates cwd. */
export class CommandRunner {
  private readonly roots: string[];
  private readonly maxOutputChars: number;
  private readonly env: NodeJS.ProcessEnv;
  constructor(options: CommandRunnerOptions = {}) { this.roots = (options.allowedCwdRoots ?? []).map((root) => fs.realpathSync.native(path.resolve(root))); this.maxOutputChars = options.maxOutputChars ?? 50_000; this.env = { ...process.env, ...options.env, CI: '1' }; }
  private checkCwd(cwd: string): string { const resolved = path.resolve(cwd); if (!this.roots.length) return resolved; let real: string; try { real = fs.realpathSync.native(resolved); } catch { throw new Error(`cwd does not exist: ${cwd}`); } if (!this.roots.some((root) => inside(root, real))) throw new Error(`cwd is outside the configured allowlist: ${cwd}`); return real; }
  /** Start a long-lived argv process without waiting for it to exit. */
  start(command: string, args: string[] = [], options: { cwd: string; timeoutMs?: number; maxOutputChars?: number; env?: NodeJS.ProcessEnv }): CommandProcessHandle {
    if (!command || /[;&|<>`$\n\r]/.test(command)) throw new Error('Shell metacharacters are not permitted in command executable');
    const cwd = this.checkCwd(options.cwd); const max = options.maxOutputChars ?? this.maxOutputChars;
    const env = { ...this.env, ...options.env };
    let stdout = '', stderr = '', timedOut = false, settled = false, killTimer: NodeJS.Timeout | undefined;
    let resolveResult!: (value: CommandExecutionResult) => void;
    const result = new Promise<CommandExecutionResult>((resolve) => { resolveResult = resolve; });
    // Put the supervised runtime in its own process group so stop() can reap
    // children it launched as well as the direct process.
    const child = spawn(command, args, { cwd, shell: false, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (old: string, data: Buffer | string): string => { const next = old + data.toString(); return next.length > max ? `${next.slice(0, max)}\n... [TRUNCATED]` : next; };
    const sanitize = (value: string): string => {
      let safe = String(redactSecrets(value));
      for (const [key, secret] of Object.entries(env)) if (secret && /password|passwd|token|secret|api[_-]?key|authorization|cookie/i.test(key) && secret.length >= 3) safe = safe.split(secret).join('[REDACTED]');
      return safe;
    };
    const finish = (exitCode: number, aborted = false): void => {
      if (settled) return; settled = true; if (killTimer) clearTimeout(killTimer); if (timer) clearTimeout(timer);
      resolveResult({ command, args: [...args], exitCode, stdout: sanitize(stdout), stderr: sanitize(stderr), timedOut, timeout: timedOut, aborted });
    };
    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) { child.kill(signal); return; }
      try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
    };
    const terminate = (signal: NodeJS.Signals = 'SIGTERM'): void => {
      if (settled) return; killProcessGroup(signal); if (signal !== 'SIGKILL') killTimer = setTimeout(() => killProcessGroup('SIGKILL'), 1_000);
    };
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs) : undefined;
    child.stdout?.on('data', (data) => { stdout = append(stdout, data); }); child.stderr?.on('data', (data) => { stderr = append(stderr, data); });
    child.once('error', (error) => { stderr = append(stderr, error.message); finish(1); });
    child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0), signal === 'SIGTERM' || signal === 'SIGKILL'));
    return {
      command, args: [...args], pid: child.pid, result,
      isRunning: () => !settled,
      stop: async (signal = 'SIGTERM') => { if (settled) return; terminate(signal); await result; },
    };
  }
  /** Alias for callers that use the conventional child-process terminology. */
  spawn(command: string, args: string[] = [], options: { cwd: string; timeoutMs?: number; maxOutputChars?: number }): CommandProcessHandle { return this.start(command, args, options); }
  async run(command: string, args: string[] = [], options: CommandExecutionOptions): Promise<CommandExecutionResult> {
    if (!command || /[;&|<>`$\n\r]/.test(command)) throw new Error('Shell metacharacters are not permitted in command executable');
    const cwd = this.checkCwd(options.cwd); const timeoutMs = options.timeoutMs ?? 60_000; const max = options.maxOutputChars ?? this.maxOutputChars;
    const env = { ...this.env, ...options.env };
    return new Promise((resolve) => {
      let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false; let killTimer: NodeJS.Timeout | undefined;
      const append = (old: string, data: Buffer | string) => { const next = old + data.toString(); return next.length > max ? `${next.slice(0, max)}\n... [TRUNCATED]` : next; };
      const child = spawn(command, args, { cwd, shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const sanitize = (value: string) => { let safe = String(redactSecrets(value)); for (const [key, secret] of Object.entries(env)) if (secret && /password|passwd|token|secret|api[_-]?key|authorization|cookie/i.test(key) && secret.length >= 3) safe = safe.split(secret).join('[REDACTED]'); return safe; };
      const finish = (exitCode: number) => { if (settled) return; settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolve({ command, args: [...args], exitCode, stdout: sanitize(stdout), stderr: sanitize(stderr), timedOut, timeout: timedOut, aborted }); };
      const abort = () => { if (settled) return; aborted = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000); };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1_000); }, timeoutMs);
      if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true }); child.stdout.on('data', (data) => { stdout = append(stdout, data); }); child.stderr.on('data', (data) => { stderr = append(stderr, data); }); child.on('error', (error) => { stderr = append(stderr, error.message); finish(1); }); child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
    });
  }
}
export async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 60_000, maxOutputChars = 50_000, signal?: AbortSignal): Promise<CommandExecutionResult> { return new CommandRunner({ maxOutputChars }).run(command, args, { cwd, timeoutMs, signal }); }

export const ValidationCommandResultSchema = z.object({ command: z.string(), exitCode: z.number().int(), passed: z.boolean(), timedOut: z.boolean(), timeout: z.boolean(), stdout: z.string(), stderr: z.string(), output: z.string() }).strict();
export type ValidationCommandResult = z.infer<typeof ValidationCommandResultSchema>;
export const DeterministicValidationSchema = z.object({ passed: z.boolean(), commands: z.array(z.string()), results: z.array(ValidationCommandResultSchema), summary: z.string(), artifacts: z.array(z.string()) }).strict();
export type DeterministicValidation = z.infer<typeof DeterministicValidationSchema>;
export class Validator {
  constructor(private readonly runner = new CommandRunner()) {}
  async runValidation(worktreeDir: string, validationCommands: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ValidationResult & { results: ValidationCommandResult[] }> {
    const results: ValidationCommandResult[] = [];
    for (const raw of validationCommands) { const [bin, ...args] = parseCommand(raw); if (!bin) continue; const result = await this.runner.run(bin, args, { cwd: worktreeDir, timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal }); const passed = result.exitCode === 0 && !result.timedOut && !result.aborted; results.push({ command: raw, exitCode: result.exitCode, passed, timedOut: result.timedOut, timeout: result.timedOut, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}`.trim() }); }
    const passed = results.every((r) => r.passed);
    const summary = results.length === 0
      ? 'No deterministic validation commands were configured; reviewer assessment is required.'
      : passed ? 'All validation checks passed.' : 'Validation checks failed.';
    const base = ValidationResultSchema.parse({ passed, commands: validationCommands, results, summary, artifacts: [] });
    return { ...base, results } as ValidationResult & { results: ValidationCommandResult[] };
  }
}
/** Parse a simple configured argv string while rejecting shell syntax. */
export function parseCommand(value: string): string[] { if (/[;&|<>`$\n\r]/.test(value)) throw new Error('Shell metacharacters are not permitted in configured commands'); const out: string[] = []; let current = '', quote = '', escaped = false; for (const char of value.trim()) { if (escaped) { current += char; escaped = false; continue; } if (char === '\\' && quote !== "'") { escaped = true; continue; } if (quote) { if (char === quote) quote = ''; else current += char; continue; } if (char === '"' || char === "'") { quote = char; continue; } if (/\s/.test(char)) { if (current) { out.push(current); current = ''; } } else current += char; } if (escaped || quote) throw new Error('Malformed configured command'); if (current) out.push(current); return out; }
