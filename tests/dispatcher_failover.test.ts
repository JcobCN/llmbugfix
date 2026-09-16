import { describe, expect, it } from 'vitest';
import { BackendAttemptTracker, BackendRegistry, canFailover, classifyBackendFailure, type BackendRegistryConfig, type BackendRouteRequest } from '../packages/llm-dispatcher/src/index.js';

const config: BackendRegistryConfig = {
  version: 1,
  defaults: { intakeBackendId: 'primary' },
  backends: [
    { id: 'primary', endpointUrl: 'http://primary.invalid/v1', model: 'primary-model', roles: ['fixer', 'reviewer'], taskTypes: ['bugfix'], targets: ['backend'], capabilities: ['typescript'], qualityTiers: ['standard'], maxConcurrency: 1, weight: 1, enabled: true, draining: false },
    { id: 'secondary', endpointUrl: 'http://secondary.invalid/v1', model: 'secondary-model', roles: ['fixer', 'reviewer'], taskTypes: ['bugfix'], targets: ['backend'], capabilities: ['typescript'], qualityTiers: ['standard'], maxConcurrency: 1, weight: 1, enabled: true, draining: false },
  ],
};

const request: BackendRouteRequest = {
  role: 'fixer', taskType: 'bugfix', executionTarget: 'backend',
  requirements: { priority: 'normal', capabilityHints: ['typescript'], quality: 'standard' },
  excludeBackendIds: [],
};

describe('dispatcher integration contract', () => {
  it('routes to a different backend after an infrastructure failure', async () => {
    const registry = new BackendRegistry(config, { pollIntervalMs: 1 });
    const first = await registry.acquire(request);
    expect(first.backendId).toBe('primary');
    expect(registry.fail(first, { status: 503 })).toBe('http_5xx');

    const second = await registry.acquire({ ...request, excludeBackendIds: [first.backendId] });
    expect(second.backendId).toBe('secondary');
    registry.complete(second);
  });

  it('does not classify contract or agent failures as automatic failover', () => {
    expect(canFailover(classifyBackendFailure({ status: 422 }))).toBe(false);
    expect(canFailover('contract')).toBe(false);
    expect(canFailover('agent_failed')).toBe(false);
    expect(canFailover('timeout')).toBe(true);
  });

  it('limits one role to two distinct backend attempts', () => {
    const tracker = new BackendAttemptTracker('reviewer');
    expect(tracker.record('primary')).toBe(1);
    expect(tracker.record('secondary')).toBe(2);
    expect(tracker.canTry('primary')).toBe(true);
    expect(tracker.canTry('tertiary')).toBe(false);
  });
});
