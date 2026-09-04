import { CommandRunner, parseCommand, type CommandExecutionResult, type CommandProcessHandle } from '@llmbugfix/validator';
import type { EnvironmentProfile } from '@llmbugfix/environment-resolver';

export type EnvironmentStatus = 'ENV_READY' | 'ENVIRONMENT_FAILED';
export interface EnvironmentRunResult { status: EnvironmentStatus; setup: CommandExecutionResult[]; runtime: CommandExecutionResult | null; health: CommandExecutionResult | null; stop: CommandExecutionResult[]; error: string | null; }
export interface EnvironmentRunnerOptions { commandRunner?: CommandRunner; commandTimeoutMs?: number; }
type RuntimeProfile = NonNullable<EnvironmentProfile['runtime']> & { stop?: string; detached?: boolean; startDetached?: boolean };

/** Runs setup and supervises foreground runtimes until the orchestrator stops them. */
export class EnvironmentRunner {
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  private readonly runtimes = new Map<string, CommandProcessHandle>();
  private readonly startedRuntimes = new Set<string>();
  constructor(options: EnvironmentRunnerOptions = {}) { this.runner = options.commandRunner ?? new CommandRunner(); this.timeoutMs = options.commandTimeoutMs ?? 120_000; }
  private async execute(worktreePath: string, command: string, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<CommandExecutionResult> { const [bin, ...args] = parseCommand(command); return this.runner.run(bin, args, { cwd: worktreePath, timeoutMs, signal }); }
  private runtimeResult(command: string, args: string[]): CommandExecutionResult { return { command, args: [...args], exitCode: 0, stdout: '', stderr: '', timedOut: false, timeout: false, aborted: false }; }
  private async stopHandle(worktreePath: string): Promise<void> { const handle = this.runtimes.get(worktreePath); if (!handle) return; this.runtimes.delete(worktreePath); try { await handle.stop(); } catch { /* preserve pipeline result */ } }
  private async stopWithProfile(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<CommandExecutionResult[]> {
    const output: CommandExecutionResult[] = []; const runtime = profile.runtime as RuntimeProfile | undefined; const command = runtime?.stopCommand ?? runtime?.stop;
    if (command && this.startedRuntimes.has(worktreePath)) { try { output.push(await this.execute(worktreePath, command, this.timeoutMs, signal)); } catch { /* process handle is still reaped below */ } }
    this.startedRuntimes.delete(worktreePath);
    await this.stopHandle(worktreePath); return output;
  }
  async prepareEnvironment(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<EnvironmentRunResult> {
    const setup: CommandExecutionResult[] = []; const stop: CommandExecutionResult[] = []; let runtime: CommandExecutionResult | null = null; let health: CommandExecutionResult | null = null;
    const fail = async (error: string): Promise<EnvironmentRunResult> => ({ status: 'ENVIRONMENT_FAILED', setup, runtime, health, stop: [...stop, ...(await this.stopWithProfile(worktreePath, profile, signal))], error });
    try {
      const setupCommands = profile.setupCommands.length ? profile.setupCommands : profile.setup;
      for (const command of setupCommands) { const result = await this.execute(worktreePath, command, this.timeoutMs, signal); setup.push(result); if (result.exitCode !== 0 || result.timedOut || result.aborted) return fail(`Setup command failed: ${command}`); }
      const runtimeProfile = profile.runtime as RuntimeProfile | undefined; const runtimeCommand = runtimeProfile?.startCommand ?? runtimeProfile?.start;
      if (runtimeCommand) {
        const [bin, ...args] = parseCommand(runtimeCommand); const runnerWithStart = this.runner as unknown as { start?: unknown; spawn?: unknown }; const canStart = typeof runnerWithStart.start === 'function' || typeof runnerWithStart.spawn === 'function'; const detached = runtimeProfile?.detached === true || runtimeProfile?.startDetached === true;
        if (canStart && !detached) {
          const start = (typeof runnerWithStart.start === 'function' ? runnerWithStart.start : runnerWithStart.spawn) as (command: string, args: string[], options: { cwd: string; timeoutMs?: number }) => CommandProcessHandle;
          // The startup timeout applies to readiness checks, not to the
          // lifetime of a healthy foreground service.
          const handle = start.call(this.runner, bin, args, { cwd: worktreePath });
          this.runtimes.set(worktreePath, handle); runtime = this.runtimeResult(bin, args); if (!handle.isRunning()) return fail(`Runtime command exited before readiness: ${runtimeCommand}`);
        } else {
          runtime = await this.execute(worktreePath, runtimeCommand, runtimeProfile?.startupTimeoutSeconds ? runtimeProfile.startupTimeoutSeconds * 1000 : this.timeoutMs, signal); if (runtime.exitCode !== 0 || runtime.timedOut || runtime.aborted) return fail(`Runtime command failed: ${runtimeCommand}`);
        }
        this.startedRuntimes.add(worktreePath);
      }
      const healthCommand = runtimeProfile?.healthCheck;
      if (healthCommand) { health = await this.execute(worktreePath, healthCommand, runtimeProfile?.startupTimeoutSeconds ? runtimeProfile.startupTimeoutSeconds * 1000 : this.timeoutMs, signal); if (health.exitCode !== 0 || health.timedOut || health.aborted) return fail(`Health check failed: ${healthCommand}`); }
      if (runtime && this.runtimes.get(worktreePath) && !this.runtimes.get(worktreePath)!.isRunning()) return fail(`Runtime command exited before readiness: ${runtimeCommand ?? 'runtime'}`);
      return { status: 'ENV_READY', setup, runtime, health, stop, error: null };
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }
  async run(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<EnvironmentRunResult> { return this.prepareEnvironment(worktreePath, profile, signal); }
  async stopEnvironment(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<CommandExecutionResult[]> { return this.stopWithProfile(worktreePath, profile, signal); }
  async setupEnvironment(worktreePath: string, setupCommands: string[]): Promise<boolean> { for (const command of setupCommands) { const result = await this.execute(worktreePath, command); if (result.exitCode !== 0 || result.timedOut || result.aborted) return false; } return true; }
}
