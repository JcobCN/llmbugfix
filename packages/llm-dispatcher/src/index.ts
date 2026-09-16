import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import yaml from 'yaml';
import {
  BackendFailureClassSchema,
  BackendHealthSchema,
  BackendRegistryConfigSchema,
  BackendRouteRequestSchema,
  InfrastructureFailureClassSchema,
  type BackendFailureClass,
  type BackendHealth,
  type BackendLease,
  type BackendRegistryConfig,
  type BackendRole,
  type BackendRouteRequest,
  type InfrastructureFailureClass,
  type LlmBackendConfig,
} from './types.js';

export * from './types.js';

export type DispatcherErrorCode =
  | 'NO_ELIGIBLE_BACKEND'
  | 'BACKEND_UNAVAILABLE'
  | 'DISPATCHER_ABORTED'
  | 'INVALID_BACKEND_CONFIG';

export class DispatcherError extends Error {
  constructor(readonly code: DispatcherErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DispatcherError';
  }
}

export class BackendConfigurationError extends DispatcherError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('INVALID_BACKEND_CONFIG', message, details);
    this.name = 'BackendConfigurationError';
  }
}

export type BackendRegistrySource = BackendRegistryConfig | string | Record<string, unknown>;

export interface BackendRegistryOptions {
  config?: BackendRegistrySource;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  acquireTimeoutMs?: number;
  pollIntervalMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
}

export interface BackendAcquireOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  taskId?: string | null;
  jobId?: string | null;
}

export interface BackendSelection {
  backend: LlmBackendConfig;
  score: number;
  inFlight: number;
  halfOpenProbe: boolean;
}

type RuntimeState = {
  config: LlmBackendConfig;
  inFlight: number;
  consecutiveFailures: number;
  status: 'closed' | 'open' | 'half_open';
  openedAt: number | null;
  retryAt: number | null;
  halfOpenProbeInUse: boolean;
};

type HeldLease = { backendId: string; released: boolean; halfOpenProbe: boolean };

const DEFAULT_ACQUIRE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 60 * 1000;

function validPositiveNumber(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new BackendConfigurationError(`${name} must be a positive number`);
  return result;
}

function validPositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) throw new BackendConfigurationError(`${name} must be a positive integer`);
  return result;
}

function parseConfigValue(value: BackendRegistrySource): BackendRegistryConfig {
  try {
    const parsed = typeof value === 'string' ? yaml.parse(value) : value;
    return BackendRegistryConfigSchema.parse(parsed);
  } catch (error) {
    if (error instanceof BackendConfigurationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new BackendConfigurationError(`Invalid LLM backend configuration: ${message}`);
  }
}

export function loadBackendRegistry(options: BackendRegistryOptions = {}): BackendRegistry {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.LLM_BACKENDS_CONFIG_PATH?.trim();
  let config: BackendRegistryConfig;
  if (options.config !== undefined) {
    config = parseConfigValue(options.config);
  } else if (configPath) {
    let content: string;
    try {
      content = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      throw new BackendConfigurationError(`Cannot read LLM backend configuration: ${configPath}`, { cause: error instanceof Error ? error.message : String(error) });
    }
    config = parseConfigValue(content);
  } else {
    const endpointUrl = env.LLM_ENDPOINT_URL?.trim() ?? '';
    const model = env.LLM_MODEL?.trim() ?? '';
    if (Boolean(endpointUrl) !== Boolean(model)) throw new BackendConfigurationError('LLM_ENDPOINT_URL and LLM_MODEL must be configured together');
    if (!endpointUrl && !model) return new BackendRegistry({ version: 1, defaults: {}, backends: [] }, options);
    config = {
      version: 1,
      defaults: { intakeBackendId: 'legacy' },
      backends: [{
        id: 'legacy', endpointUrl, model,
        ...(env.LLM_API_KEY?.trim() ? { apiKeyEnv: 'LLM_API_KEY' } : {}),
        roles: ['intake', 'fixer', 'reviewer'], taskTypes: ['bugfix', 'development'], targets: ['frontend', 'backend'],
        capabilities: [], qualityTiers: ['standard', 'high'], maxConcurrency: 1, weight: 1, enabled: true, draining: false,
      }],
    };
  }
  return new BackendRegistry(config, options);
}

export const createBackendRegistry = (options: BackendRegistryOptions = {}): BackendRegistry => loadBackendRegistry(options);

export function parseBackendRegistryConfig(value: BackendRegistrySource): BackendRegistryConfig {
  return parseConfigValue(value);
}

export function resolveBackendApiKey(config: LlmBackendConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return config.apiKeyEnv ? env[config.apiKeyEnv]?.trim() || undefined : undefined;
}

export function classifyBackendFailure(error: unknown): BackendFailureClass {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const response = value.response && typeof value.response === 'object' ? value.response as Record<string, unknown> : undefined;
    const status = typeof value.status === 'number' ? value.status : typeof value.statusCode === 'number' ? value.statusCode : typeof response?.status === 'number' ? response.status : undefined;
    if (status === 408) return 'http_408';
    if (status === 429) return 'http_429';
    if (status !== undefined && status >= 500 && status <= 599) return 'http_5xx';
    if (status !== undefined && status >= 400 && status <= 499) return status === 401 || status === 403 ? 'authentication' : 'http_4xx';
    const code = typeof value.code === 'string' ? value.code.toUpperCase() : '';
    const name = typeof value.name === 'string' ? value.name.toLowerCase() : '';
    const message = typeof value.message === 'string' ? value.message.toLowerCase() : '';
    if (name === 'aborterror' || code === 'ABORT_ERR' || code === 'ERR_CANCELED' || message.includes('cancel')) return 'cancelled';
    if (code.includes('TLS') || code.includes('CERT') || message.includes('tls') || message.includes('certificate')) return 'tls';
    if (name.includes('timeout') || code.includes('TIMEOUT') || code === 'ETIMEDOUT' || message.includes('timed out') || message.includes('timeout')) return 'timeout';
    if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || name.includes('network') || name.includes('connection')) return 'connection';
  }
  if (typeof error === 'string' && error.toLowerCase().includes('cancel')) return 'cancelled';
  return 'unknown';
}

export const isInfrastructureFailure = (value: BackendFailureClass | unknown): value is InfrastructureFailureClass => typeof value === 'string' && InfrastructureFailureClassSchema.safeParse(value).success;
export const canFailover = (failure: BackendFailureClass): boolean => isInfrastructureFailure(failure);

export class BackendRegistry {
  private readonly states = new Map<string, RuntimeState>();
  private readonly heldLeases = new Map<string, HeldLease>();
  private readonly now: () => number;
  private readonly acquireTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly waiters = new Set<() => void>();
  private readonly config: BackendRegistryConfig;

  constructor(config: BackendRegistryConfig, options: BackendRegistryOptions = {}) {
    // Parse once at the boundary so YAML/object callers receive the same
    // defaults and strict validation as loadBackendRegistry(). An empty
    // registry is the intentional queue-only mode when no LLM is configured.
    this.config = config.backends.length === 0
      ? { version: 1, defaults: config.defaults ?? {}, backends: [] }
      : BackendRegistryConfigSchema.parse(config);
    this.now = options.now ?? Date.now;
    this.acquireTimeoutMs = validPositiveNumber(options.acquireTimeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS, 'acquireTimeoutMs');
    this.pollIntervalMs = validPositiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 'pollIntervalMs');
    this.circuitFailureThreshold = validPositiveInteger(options.circuitFailureThreshold, DEFAULT_CIRCUIT_FAILURE_THRESHOLD, 'circuitFailureThreshold');
    this.circuitCooldownMs = validPositiveNumber(options.circuitCooldownMs, DEFAULT_CIRCUIT_COOLDOWN_MS, 'circuitCooldownMs');
    const ids = new Set<string>();
    for (const backend of this.config.backends) {
      if (ids.has(backend.id)) throw new BackendConfigurationError(`Duplicate backend id: ${backend.id}`);
      ids.add(backend.id);
      this.states.set(backend.id, {
        config: { ...backend, capabilities: [...backend.capabilities], roles: [...backend.roles], taskTypes: [...backend.taskTypes], targets: [...backend.targets], qualityTiers: [...backend.qualityTiers] },
        inFlight: 0, consecutiveFailures: 0, status: 'closed', openedAt: null, retryAt: null, halfOpenProbeInUse: false,
      });
    }
  }

  get defaults(): BackendRegistryConfig['defaults'] { return this.config.defaults; }
  getConfig(): BackendRegistryConfig { return { ...this.config, defaults: { ...this.config.defaults }, backends: this.listBackends() }; }
  getBackend(backendId: string): LlmBackendConfig | undefined { return this.states.get(backendId)?.config; }
  listBackends(): LlmBackendConfig[] { return [...this.states.values()].map((state) => ({ ...state.config, capabilities: [...state.config.capabilities], roles: [...state.config.roles], taskTypes: [...state.config.taskTypes], targets: [...state.config.targets], qualityTiers: [...state.config.qualityTiers] })); }

  getIntakeBackend(): LlmBackendConfig | undefined {
    const configured = this.config.defaults.intakeBackendId;
    if (configured) return this.getBackend(configured);
    return this.listBackends().find((backend) => backend.enabled && !backend.draining && backend.roles.includes('intake'));
  }

  health(): BackendHealth[] {
    this.refreshCircuits();
    return [...this.states.values()].map((state) => BackendHealthSchema.parse({
      backendId: state.config.id, status: state.status, consecutiveFailures: state.consecutiveFailures,
      openedAt: state.openedAt === null ? null : new Date(state.openedAt).toISOString(), retryAt: state.retryAt === null ? null : new Date(state.retryAt).toISOString(), inFlight: state.inFlight,
    }));
  }

  setDraining(backendId: string, draining = true): void {
    const state = this.states.get(backendId);
    if (!state) throw new DispatcherError('NO_ELIGIBLE_BACKEND', `Unknown backend: ${backendId}`);
    state.config = { ...state.config, draining }; this.notifyWaiters();
  }

  recordSuccess(backendId: string): void {
    const state = this.states.get(backendId); if (!state) return;
    this.resetCircuit(state);
    this.notifyWaiters();
  }

  recordFailure(backendId: string, failureClass: BackendFailureClass): void {
    const state = this.states.get(backendId); if (!state) return;

    // A cancellation is an administrative outcome, rather than evidence
    // about the backend. Preserve the circuit state and failure streak; the
    // lease owner is still responsible for releasing its capacity slot.
    if (failureClass === 'cancelled') return;

    // Contract/schema, agent, validation, review, and other non-transport
    // outcomes prove that the backend answered. They therefore break an
    // infrastructure-failure streak and close a circuit, just like success.
    if (!isInfrastructureFailure(failureClass)) {
      this.resetCircuit(state);
      this.notifyWaiters();
      return;
    }

    this.refreshCircuit(state); state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.circuitFailureThreshold) { state.status = 'open'; state.openedAt = this.now(); state.retryAt = state.openedAt + this.circuitCooldownMs; state.halfOpenProbeInUse = false; }
    this.notifyWaiters();
  }

  private resetCircuit(state: RuntimeState): void {
    state.consecutiveFailures = 0;
    state.status = 'closed';
    state.openedAt = null;
    state.retryAt = null;
    state.halfOpenProbeInUse = false;
  }

  markFailure(backendId: string, error: unknown): BackendFailureClass { const failureClass = classifyBackendFailure(error); this.recordFailure(backendId, failureClass); return failureClass; }

  route(request: BackendRouteRequest): BackendSelection[] {
    const parsed = BackendRouteRequestSchema.parse(request); this.refreshCircuits(); return this.select(parsed);
  }

  private staticCandidates(request: BackendRouteRequest): RuntimeState[] {
    const hints = request.requirements.capabilityHints; const excluded = new Set(request.excludeBackendIds);
    return [...this.states.values()].filter((state) => {
      const backend = state.config;
      return backend.enabled && !excluded.has(backend.id) && backend.roles.includes(request.role) && backend.taskTypes.includes(request.taskType) && backend.targets.includes(request.executionTarget) && backend.qualityTiers.includes(request.requirements.quality) && hints.every((hint) => backend.capabilities.includes(hint));
    });
  }

  private refreshCircuit(state: RuntimeState): void {
    if (state.status === 'open' && state.retryAt !== null && this.now() >= state.retryAt) { state.status = 'half_open'; state.halfOpenProbeInUse = false; }
  }
  private refreshCircuits(): void { for (const state of this.states.values()) this.refreshCircuit(state); }

  private select(request: BackendRouteRequest): BackendSelection[] {
    return this.staticCandidates(request).filter((state) => {
      this.refreshCircuit(state);
      if (state.config.draining || state.status === 'open' || state.inFlight >= state.config.maxConcurrency) return false;
      return state.status !== 'half_open' || !state.halfOpenProbeInUse;
    }).map((state) => ({ backend: state.config, score: (state.inFlight + 1) / (state.config.maxConcurrency * state.config.weight), inFlight: state.inFlight, halfOpenProbe: state.status === 'half_open' })).sort((left, right) => left.score - right.score || left.backend.id.localeCompare(right.backend.id));
  }

  private async waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<'changed' | 'timeout'> {
    if (signal?.aborted) throw new DispatcherError('DISPATCHER_ABORTED', 'Backend acquisition was cancelled');
    return new Promise<'changed' | 'timeout'>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (result: 'changed' | 'timeout', error?: DispatcherError): void => { if (timer) clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(result); };
      const wake = (): void => done('changed');
      const abort = (): void => done('changed', new DispatcherError('DISPATCHER_ABORTED', 'Backend acquisition was cancelled'));
      this.waiters.add(wake); timer = setTimeout(() => done('timeout'), timeoutMs); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    });
  }
  private notifyWaiters(): void { for (const wake of [...this.waiters]) wake(); }

  async acquire(request: BackendRouteRequest, options: BackendAcquireOptions = {}): Promise<BackendLease> {
    const parsed = BackendRouteRequestSchema.parse(request); const staticCandidates = this.staticCandidates(parsed);
    if (staticCandidates.length === 0) throw new DispatcherError('NO_ELIGIBLE_BACKEND', 'No backend matches the requested role, task type, target, quality, and capabilities', { role: parsed.role, taskType: parsed.taskType, executionTarget: parsed.executionTarget });
    const timeoutMs = validPositiveNumber(options.timeoutMs, this.acquireTimeoutMs, 'timeoutMs');
    // `this.now()` is intentionally injectable for circuit cooldown tests and
    // represents logical provider time. Acquisition deadlines must use an
    // independent monotonic clock; otherwise a frozen circuit clock can make
    // a capacity waiter live forever.
    const started = performance.now();
    while (true) {
      if (options.signal?.aborted) throw new DispatcherError('DISPATCHER_ABORTED', 'Backend acquisition was cancelled');
      const selected = this.select(parsed)[0];
      if (selected) {
        const state = this.states.get(selected.backend.id);
        if (!state || state.config.draining || state.inFlight >= state.config.maxConcurrency || (state.status === 'half_open' && state.halfOpenProbeInUse)) continue;
        state.inFlight += 1; if (selected.halfOpenProbe) state.halfOpenProbeInUse = true;
        const leaseId = randomUUID(); this.heldLeases.set(leaseId, { backendId: state.config.id, released: false, halfOpenProbe: selected.halfOpenProbe });
        return { leaseId, backendId: state.config.id, model: state.config.model, role: parsed.role, taskId: options.taskId ?? null, jobId: options.jobId ?? null, acquiredAt: new Date(this.now()).toISOString(), expiresAt: null };
      }
      const remaining = timeoutMs - (performance.now() - started); if (remaining <= 0) throw new DispatcherError('BACKEND_UNAVAILABLE', 'No eligible backend capacity is currently available', { timeoutMs });
      await this.waitForChange(Math.min(this.pollIntervalMs, remaining), options.signal);
    }
  }

  release(lease: BackendLease): void {
    const held = this.heldLeases.get(lease.leaseId); if (!held || held.released) return;
    const state = this.states.get(held.backendId); if (state) { state.inFlight = Math.max(0, state.inFlight - 1); if (held.halfOpenProbe) state.halfOpenProbeInUse = false; }
    held.released = true; this.heldLeases.delete(lease.leaseId); this.notifyWaiters();
  }
  complete(lease: BackendLease): void { this.recordSuccess(lease.backendId); this.release(lease); }
  fail(lease: BackendLease, errorOrFailure: unknown): BackendFailureClass {
    const failureClass = typeof errorOrFailure === 'string' && BackendFailureClassSchema.safeParse(errorOrFailure).success ? errorOrFailure as BackendFailureClass : classifyBackendFailure(errorOrFailure);
    this.recordFailure(lease.backendId, failureClass); this.release(lease); return failureClass;
  }
  releaseById(leaseId: string): void { this.release({ leaseId } as BackendLease); }
}

export class LlmDispatcher extends BackendRegistry {}
export class BackendDispatcher extends BackendRegistry {}
export { BackendRegistry as Dispatcher };

export type BackendAttempt = { backendId: string; role: BackendRole; attempt: number };
export class BackendAttemptTracker {
  private readonly attempted = new Set<string>();
  private readonly maxBackends: number;
  constructor(readonly role: BackendRole, maxBackends = 2) { this.maxBackends = Math.max(1, Math.min(2, Math.floor(maxBackends))); }
  canTry(backendId: string): boolean { return this.attempted.has(backendId) || this.attempted.size < this.maxBackends; }
  record(backendId: string): number {
    if (!this.attempted.has(backendId) && this.attempted.size >= this.maxBackends) throw new DispatcherError('BACKEND_UNAVAILABLE', `The ${this.role} role may use at most ${this.maxBackends} different backends`);
    this.attempted.add(backendId); return this.attempted.size;
  }
  attemptedBackendIds(): string[] { return [...this.attempted]; }
  exclusions(): string[] { return this.attemptedBackendIds(); }
}

export const isInfrastructureFailureClass = isInfrastructureFailure;
