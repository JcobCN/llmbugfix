import { describe, expect, it } from 'vitest';
import {
  BackendRegistry,
  DispatcherError,
  classifyBackendFailure,
  loadBackendRegistry,
  type BackendRegistryConfig,
  type BackendRouteRequest,
} from './index.js';

const request = (capabilityHints: string[] = [], quality: 'standard' | 'high' = 'standard'): BackendRouteRequest => ({
  role: 'fixer', taskType: 'bugfix', executionTarget: 'backend',
  requirements: { priority: 'normal', capabilityHints, quality }, excludeBackendIds: [],
});

const config: BackendRegistryConfig = {
  version: 1, defaults: {},
  backends: [
    { id: 'fast', endpointUrl: 'http://fast.test/v1', model: 'fast-model', roles: ['fixer', 'reviewer'], taskTypes: ['bugfix'], targets: ['backend'], capabilities: ['typescript'], qualityTiers: ['standard'], maxConcurrency: 2, weight: 1, enabled: true, draining: false },
    { id: 'slow', endpointUrl: 'http://slow.test/v1', model: 'slow-model', roles: ['fixer'], taskTypes: ['bugfix'], targets: ['backend'], capabilities: ['typescript'], qualityTiers: ['standard'], maxConcurrency: 1, weight: 1, enabled: true, draining: false },
  ],
};

describe('backend registry', () => {
  it('adapts legacy environment settings to a capacity-one backend', () => {
    const registry = loadBackendRegistry({ env: { LLM_ENDPOINT_URL: 'http://legacy.test/v1', LLM_MODEL: 'legacy-model', LLM_API_KEY: 'secret' } });
    expect(registry.listBackends()).toMatchObject([{ id: 'legacy', maxConcurrency: 1, roles: ['intake', 'fixer', 'reviewer'] }]);
    expect(registry.getIntakeBackend()?.apiKeyEnv).toBe('LLM_API_KEY');
    expect(JSON.stringify(registry.health())).not.toContain('secret');
  });

  it('filters every routing dimension and uses weighted least load', async () => {
    const registry = new BackendRegistry(config);
    expect(registry.route(request(['python']))).toHaveLength(0);
    const first = await registry.acquire(request(['typescript']));
    const selected = registry.route(request(['typescript']))[0];
    expect(selected.backend.id).toBe('fast');
    registry.release(first);
  });

  it('waits for capacity and aborts without reserving a slot', async () => {
    const registry = new BackendRegistry({ ...config, backends: [config.backends[1]] }, { pollIntervalMs: 2 });
    const first = await registry.acquire(request(['typescript']));
    const controller = new AbortController();
    const waiting = registry.acquire(request(['typescript']), { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'DISPATCHER_ABORTED' });
    expect(registry.health()[0].inFlight).toBe(1);
    registry.release(first);
  });

  it('opens after three infrastructure failures and permits one half-open probe', async () => {
    let now = 1_000;
    const registry = new BackendRegistry({ ...config, backends: [config.backends[1]] }, { now: () => now, pollIntervalMs: 1, acquireTimeoutMs: 5, circuitCooldownMs: 100 });
    for (let i = 0; i < 3; i += 1) {
      const lease = await registry.acquire(request(['typescript']));
      registry.fail(lease, 'http_5xx');
    }
    expect(registry.health()[0].status).toBe('open');
    await expect(registry.acquire(request(['typescript']), { timeoutMs: 3 })).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    now += 100;
    const probe = await registry.acquire(request(['typescript']));
    expect(registry.health()[0].status).toBe('half_open');
    registry.complete(probe);
    expect(registry.health()[0].status).toBe('closed');
  });

  it('does not carry infrastructure failures across a non-infrastructure outcome', async () => {
    const registry = new BackendRegistry({ ...config, backends: [config.backends[1]] }, { pollIntervalMs: 1 });
    const first = await registry.acquire(request(['typescript']));
    registry.fail(first, 'http_5xx');
    expect(registry.health()[0].consecutiveFailures).toBe(1);

    const nonInfrastructure = await registry.acquire(request(['typescript']));
    expect(registry.fail(nonInfrastructure, 'contract')).toBe('contract');
    expect(registry.health()[0]).toMatchObject({ status: 'closed', consecutiveFailures: 0, inFlight: 0 });

    const second = await registry.acquire(request(['typescript']));
    registry.fail(second, 'http_5xx');
    expect(registry.health()[0]).toMatchObject({ status: 'closed', consecutiveFailures: 1 });
  });

  it('ignores cancellation for circuit accounting while releasing the lease', async () => {
    const registry = new BackendRegistry({ ...config, backends: [config.backends[1]] }, { pollIntervalMs: 1 });
    for (let i = 0; i < 2; i += 1) {
      const lease = await registry.acquire(request(['typescript']));
      registry.fail(lease, 'http_5xx');
    }

    const cancelled = await registry.acquire(request(['typescript']));
    expect(registry.fail(cancelled, 'cancelled')).toBe('cancelled');
    expect(registry.health()[0]).toMatchObject({ status: 'closed', consecutiveFailures: 2, inFlight: 0 });

    const third = await registry.acquire(request(['typescript']));
    registry.fail(third, 'http_5xx');
    expect(registry.health()[0].status).toBe('open');
  });

  it('classifies only transport/server failures as failover candidates', () => {
    expect(classifyBackendFailure({ status: 503 })).toBe('http_5xx');
    expect(classifyBackendFailure({ status: 401 })).toBe('authentication');
    expect(classifyBackendFailure(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))).toBe('connection');
    expect(classifyBackendFailure(new Error('schema contract invalid'))).toBe('unknown');
  });

  it('reports stable typed errors for permanently unmatched routes', async () => {
    const registry = new BackendRegistry(config);
    await expect(registry.acquire(request(['rust']))).rejects.toBeInstanceOf(DispatcherError);
    await expect(registry.acquire(request(['rust']))).rejects.toMatchObject({ code: 'NO_ELIGIBLE_BACKEND' });
  });
});
