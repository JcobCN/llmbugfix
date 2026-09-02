import { CommandRunner, parseCommand, type CommandExecutionResult } from '@llmbugfix/validator';
import type { EnvironmentProfile } from '@llmbugfix/environment-resolver';

export type EnvironmentStatus = 'ENV_READY' | 'ENVIRONMENT_FAILED';
export interface EnvironmentRunResult { status: EnvironmentStatus; setup: CommandExecutionResult[]; runtime: CommandExecutionResult | null; health: CommandExecutionResult | null; stop: CommandExecutionResult[]; error: string | null; }
export interface EnvironmentRunnerOptions { commandRunner?: CommandRunner; commandTimeoutMs?: number; }

export class EnvironmentRunner {
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;
  constructor(options: EnvironmentRunnerOptions = {}) { this.runner = options.commandRunner ?? new CommandRunner(); this.timeoutMs = options.commandTimeoutMs ?? 120_000; }
  private async execute(worktreePath: string, command: string, timeoutMs = this.timeoutMs, signal?: AbortSignal): Promise<CommandExecutionResult> { const [bin, ...args] = parseCommand(command); return this.runner.run(bin, args, { cwd: worktreePath, timeoutMs, signal }); }
  async prepareEnvironment(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<EnvironmentRunResult> {
    const setup: CommandExecutionResult[] = []; const stop: CommandExecutionResult[] = []; let runtime: CommandExecutionResult | null = null; let health: CommandExecutionResult | null = null;
    const fail = async (error: string): Promise<EnvironmentRunResult> => { const stopCommand = profile.runtime ? ((profile.runtime as EnvironmentProfile['runtime'] & { stop?: string }).stopCommand ?? (profile.runtime as EnvironmentProfile['runtime'] & { stop?: string }).stop) : undefined; if (runtime && stopCommand) { try { stop.push(await this.execute(worktreePath, stopCommand, this.timeoutMs, signal)); } catch { /* preserve the original environment failure */ } } return { status: 'ENVIRONMENT_FAILED', setup, runtime, health, stop, error }; };
    try {
      const setupCommands = profile.setupCommands.length ? profile.setupCommands : profile.setup;
      for (const command of setupCommands) { const result = await this.execute(worktreePath, command, this.timeoutMs, signal); setup.push(result); if (result.exitCode !== 0 || result.timedOut || result.aborted) return fail(`Setup command failed: ${command}`); }
      const runtimeCommand = profile.runtime?.startCommand ?? profile.runtime?.start;
      if (runtimeCommand) { runtime = await this.execute(worktreePath, runtimeCommand, profile.runtime?.startupTimeoutSeconds ? profile.runtime.startupTimeoutSeconds * 1000 : this.timeoutMs, signal); if (runtime.exitCode !== 0 || runtime.timedOut || runtime.aborted) return fail(`Runtime command failed: ${runtimeCommand}`); }
      const healthCommand = profile.runtime?.healthCheck;
      if (healthCommand) { health = await this.execute(worktreePath, healthCommand, this.timeoutMs, signal); if (health.exitCode !== 0 || health.timedOut || health.aborted) return fail(`Health check failed: ${healthCommand}`); }
      return { status: 'ENV_READY', setup, runtime, health, stop, error: null };
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  }
  async run(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<EnvironmentRunResult> { return this.prepareEnvironment(worktreePath, profile, signal); }
  /** Stop is explicit so the orchestrator can stop a runtime in a finally block. */
  async stopEnvironment(worktreePath: string, profile: EnvironmentProfile, signal?: AbortSignal): Promise<CommandExecutionResult[]> { const runtime = profile.runtime as (EnvironmentProfile['runtime'] & { stop?: string }) | undefined; const command = runtime?.stopCommand ?? runtime?.stop; if (!command) return []; return [await this.execute(worktreePath, command, this.timeoutMs, signal)]; }
  async setupEnvironment(worktreePath: string, setupCommands: string[]): Promise<boolean> { for (const command of setupCommands) { const result = await this.execute(worktreePath, command); if (result.exitCode !== 0 || result.timedOut || result.aborted) return false; } return true; }
}
