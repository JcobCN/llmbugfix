import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from '../apps/orchestrator/src/index.js';
import type { QueueJob } from '../packages/job-queue/src/index.js';
import { BackendRegistry } from '../packages/llm-dispatcher/src/index.js';
import { PiAgentOutputFormatError } from '../packages/pi-runner/src/index.js';

const job = (id: string): QueueJob => ({
  id,
  bugId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  status: 'RUNNING',
  priority: 10,
  attempt: 1,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  heartbeatAt: new Date().toISOString(),
  error: null,
  workerId: 'concurrency-test-worker',
  leaseToken: `lease-${id}`,
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  claimedAt: new Date().toISOString(),
  routingRequirements: null,
  failureClass: null,
  lastFailureBackendId: null,
});

type HarnessOptions = {
  fixer: (backendId: string, input: any, mutations: Map<string, string>) => Promise<any>;
  reviewer: (backendId: string, input: any) => Promise<any>;
  backendIds?: string[];
};

function deferred<T = void>() {
  let settle!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { settle = res; });
  const resolve = (value?: T | PromiseLike<T>) => { settle(value as T); };
  return { promise, resolve };
}

function harness(options: HarnessOptions) {
  const root = fs.mkdtempSync(path.join('/tmp', 'llmbugfix-orchestrator-'));
  const bugId = '00000000-0000-4000-8000-000000000011';
  const bug = {
    id: bugId, bugKey: 'BUG-000011', taskType: 'bugfix', title: 'Button is stuck', productArea: null, component: null,
    bugType: 'functional', executionTarget: 'frontend', environmentProfileId: 'profile', severity: 'medium', actualBehavior: 'No response', expectedBehavior: 'Responds',
    reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['click'], testData: [] },
    environment: { environmentName: 'test', appVersion: '1', buildNumber: null, commitSha: null, additionalInfo: {} },
    evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
    impact: { affectedUsers: 'some', scope: 'some_users', blocksTesting: false, workaroundExists: false, workaround: null },
    regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [],
    reporter: { userId: '00000000-0000-4000-8000-000000000012', displayName: 'test' },
    intake: { completenessScore: 100, confidence: 1, missingInformation: [], conversationId: '00000000-0000-4000-8000-000000000013', llmSummary: 'button' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any;
  const profile = {
    id: 'profile', name: 'test', target: 'frontend', type: 'frontend', repository: root, repoUrl: root, defaultBranch: 'main', baseBranch: 'main',
    instructions: [], markdown: [], skills: [], documentationPaths: [], skillPaths: [], setupCommands: [], validationCommands: [], setup: [], validation: [],
  } as any;
  const statuses: string[] = [];
  const agentRuns: any[] = [];
  const counters = { validation: 0 };
  const mutations = new Map<string, string>();
  const active = { path: '', generation: 0 };
  let currentJob: QueueJob = { ...job('11'), status: 'QUEUED', workerId: null, leaseToken: null, leaseExpiresAt: null, claimedAt: null };
  const queue = {
    recoverStaleJobs: () => [],
    claimNextJob: (workerId: string) => {
      if (currentJob.status !== 'QUEUED') return null;
      currentJob = { ...currentJob, status: 'RUNNING', workerId, leaseToken: 'queue-lease-11', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), claimedAt: new Date().toISOString() };
      return currentJob;
    },
    getJob: (_id: string) => currentJob,
    heartbeat: (_id: string, _worker: string, _token: string) => currentJob,
    completeJob: (_id: string, _worker: string, _token: string) => { currentJob = { ...currentJob, status: 'COMPLETED', workerId: null, leaseToken: null }; return currentJob; },
    failJob: (_id: string, _error: string, _worker: string, _token: string, _failure?: string) => { currentJob = { ...currentJob, status: 'FAILED', workerId: null, leaseToken: null }; return currentJob; },
    cancelJob: (_id: string, workerId?: string, leaseToken?: string) => {
      if (workerId !== undefined && (currentJob.status !== 'RUNNING' || currentJob.workerId !== workerId || currentJob.leaseToken !== leaseToken)) throw new Error('lease fenced');
      currentJob = { ...currentJob, status: 'CANCELLED', workerId: null, leaseToken: null, leaseExpiresAt: null };
      return currentJob;
    },
    interrupt: () => { currentJob = { ...currentJob, status: 'INTERRUPTED', workerId: null, leaseToken: null, leaseExpiresAt: null }; },
    reclaim: (workerId = 'reclaimed-worker', leaseToken = 'reclaimed-lease') => { currentJob = { ...currentJob, status: 'RUNNING', workerId, leaseToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), claimedAt: new Date().toISOString() }; },
  };
  const database = { prepare: (sql: string) => ({
    get: () => ({ status: statuses.at(-1) ?? 'QUEUED' }),
    run: (...args: any[]) => {
      if (sql.includes('UPDATE agent_runs') && sql.includes("SET status = 'CANCELLED'")) {
        const [_finishedAt, id] = args;
        const run = agentRuns.find((item) => item.id === id);
        if (run) Object.assign(run, { status: 'CANCELLED', output: null, error: null, failureClass: null });
      } else if (sql.includes('UPDATE agent_runs')) {
        const [status, _finishedAt, output, error, failureClass, id] = args;
        const run = agentRuns.find((item) => item.id === id);
        if (run) Object.assign(run, { status, output: output ? JSON.parse(output) : null, error, failureClass });
      }
      return { changes: 1 };
    },
  }) };
  const repo = {
    database,
    getBug: () => bug,
    listAttachments: () => [],
    getTaskRepository: () => null,
    changeBugStatus: (_key: string, status: string) => { statuses.push(status); return bug; },
    appendWorkerEvent: () => ({}),
    createAgentRun: (input: any) => { agentRuns.push(input); return input; },
  };
  const repoManager = {
    createBranchName: () => 'ai/BUG-000011-button-fix',
    cleanupWorktree: async () => undefined,
    setupWorktree: async () => { active.generation += 1; active.path = path.join(root, `worktree-${active.generation}`); fs.mkdirSync(active.path, { recursive: true }); return active.path; },
    setupWorktreeAtCommit: async () => { active.generation += 1; active.path = path.join(root, `worktree-${active.generation}`); fs.mkdirSync(active.path, { recursive: true }); return active.path; },
    headCommit: async () => 'a'.repeat(40),
    filesChanged: async () => mutations.has(active.path) ? ['src/button.ts'] : [],
    diff: async () => mutations.has(active.path) ? `diff ${mutations.get(active.path)}\n` : '',
    cleanup: async () => undefined,
    applyPatch: async () => undefined,
    commitAndPush: async () => ({ pushed: true, commitSha: 'b'.repeat(40) }),
  };
  const envRunner = { prepareEnvironment: async () => ({ status: 'ENV_READY', setup: [], runtime: null, health: null, stop: [], error: null }), stopEnvironment: async () => [] };
  const validator = { runValidation: async () => { counters.validation += 1; return { passed: true, commands: [], results: [], summary: 'ok', artifacts: [] }; } };
  const backendIds = options.backendIds ?? ['backend-a', 'backend-b'];
  const backends = backendIds.map((id) => ({ id, endpointUrl: `http://${id}.test/v1`, model: `${id}-model`, roles: ['fixer', 'reviewer'] as ('fixer' | 'reviewer')[], taskTypes: ['bugfix'] as ('bugfix' | 'development')[], targets: ['frontend'] as ('frontend' | 'backend')[], capabilities: [], qualityTiers: ['standard'] as ('standard' | 'high')[], maxConcurrency: 2, weight: 1, enabled: true, draining: false }));
  const dispatcher = new BackendRegistry({ version: 1, defaults: {}, backends }, { acquireTimeoutMs: 100, pollIntervalMs: 1 });
  const runners = new Map(backendIds.map((id) => [id, { runFixer: (input: any) => options.fixer(id, input, mutations), runReviewer: (input: any) => options.reviewer(id, input) }]));
  const runnerFactory = { get: (id: string) => runners.get(id)! };
  const orchestrator = new Orchestrator({ DATA_ROOT: root } as any, repo as any, queue as any, { resolveProfile: () => ({ profile, context: [], markdown: [], skills: [], docsContent: '', skillContent: '' }) } as any, repoManager as any, envRunner as any, {} as any, validator as any, { dryRun: true, workerId: 'concurrency-test-worker', artifactRoot: path.join(root, 'agent-results'), dispatcher, runnerFactory });
  return { orchestrator, active, mutations, statuses, agentRuns, queue, dispatcher, backendIds, root, counters };
}

describe('Orchestrator concurrency', () => {
  it('claims and waits for a batch without exceeding configured concurrency', async () => {
    const pending = [job('1'), job('2'), job('3')];
    const queue = {
      recoverStaleJobs: () => [],
      claimNextJob: () => pending.shift() ?? null,
    };
    const orchestrator = new Orchestrator(
      { DATA_ROOT: '/tmp/llmbugfix-concurrency-test' } as any,
      {} as any,
      queue as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { workerId: 'concurrency-test-worker', maxConcurrentJobs: 2 },
    );
    let active = 0;
    let maximum = 0;
    let completed = 0;
    (orchestrator as any).processJob = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      completed += 1;
    };

    expect(await orchestrator.tick()).toBe(true);
    expect(maximum).toBe(2);
    expect(completed).toBe(2);
    expect(pending).toHaveLength(1);
    expect(await orchestrator.tick()).toBe(true);
    expect(completed).toBe(3);
    expect(pending).toHaveLength(0);
  });

  it('keeps the legacy default at one active job', async () => {
    const pending = [job('4'), job('5')];
    const queue = { recoverStaleJobs: () => [], claimNextJob: () => pending.shift() ?? null };
    const orchestrator = new Orchestrator({ DATA_ROOT: '/tmp/llmbugfix-concurrency-test' } as any, {} as any, queue as any, {} as any, {} as any, {} as any, {} as any, {} as any, { workerId: 'concurrency-test-worker' });
    let active = 0;
    let maximum = 0;
    (orchestrator as any).processJob = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };
    await orchestrator.tick();
    expect(maximum).toBe(1);
    expect(pending).toHaveLength(1);
  });

  it('fails over a fixer to a second backend on transport failure and recreates a clean worktree', async () => {
    const seenPaths: string[] = [];
    const h = harness({
      fixer: async (backendId, input, mutations) => {
        seenPaths.push(input.worktreePath);
        if (backendId === 'backend-a') {
          mutations.set(input.worktreePath, 'first-attempt-mutation');
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }
        expect(mutations.has(input.worktreePath)).toBe(false);
        mutations.set(input.worktreePath, 'second-attempt-mutation');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async () => ({ verdict: 'approve', bugAddressed: true, regressionRisk: 'low', summary: 'approved', findings: [] }),
    });
    await h.orchestrator.tick();
    expect(seenPaths).toHaveLength(2);
    expect(seenPaths[0]).not.toBe(seenPaths[1]);
    expect(h.mutations.get(seenPaths[1])).toBe('second-attempt-mutation');
    expect(h.queue.getJob('job').status).toBe('COMPLETED');
    expect(h.statuses).toContain('FIX_READY');
    expect(h.agentRuns.filter((run) => run.agentType === 'fixer')).toHaveLength(2);
    expect(h.agentRuns.filter((run) => run.agentType === 'fixer').every((run) => run.status === 'FAILED' || run.status === 'COMPLETED')).toBe(true);
  });

  it('does not fail over contract or no-diff fixer failures', async () => {
    for (const failure of ['contract', 'no_diff'] as const) {
      let calls = 0;
      const h = harness({
        fixer: async (backendId, input, mutations) => {
          calls += 1;
          expect(backendId).toBe('backend-a');
          if (failure === 'contract') throw new PiAgentOutputFormatError('fixer', 'not-json', 'invalid result');
          return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'no diff', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
        },
        reviewer: async () => { throw new Error('reviewer must not run'); },
      });
      await h.orchestrator.tick();
      expect(calls).toBe(1);
      expect(h.statuses).toContain('FIX_FAILED');
      expect(h.agentRuns.filter((run) => run.agentType === 'fixer')).toHaveLength(1);
    }
  });

  it('uses another backend for reviewer infrastructure fallback without rerunning fixer or validation', async () => {
    const fixerCalls: string[] = [];
    const reviewerCalls: string[] = [];
    const h = harness({
      backendIds: ['backend-a', 'backend-b', 'backend-c'],
      fixer: async (backendId, input, mutations) => {
        fixerCalls.push(backendId);
        mutations.set(input.worktreePath, 'fix');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async (backendId) => {
        reviewerCalls.push(backendId);
        if (backendId === 'backend-b') throw Object.assign(new Error('upstream unavailable'), { status: 503 });
        return { verdict: 'approve', bugAddressed: true, regressionRisk: 'low', summary: 'approved', findings: [] };
      },
    });
    await h.orchestrator.tick();
    expect(fixerCalls).toEqual(['backend-a']);
    expect(reviewerCalls).toEqual(['backend-b', 'backend-c']);
    expect(h.counters.validation).toBe(1);
    expect(h.statuses).toContain('FIX_READY');
  });

  it('does not fail over a reviewer rejection', async () => {
    const reviewerCalls: string[] = [];
    const h = harness({
      fixer: async (_backendId, input, mutations) => {
        mutations.set(input.worktreePath, 'fix');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async (backendId) => {
        reviewerCalls.push(backendId);
        return { verdict: 'reject', bugAddressed: false, regressionRisk: 'high', summary: 'rejected', findings: ['unsafe'] };
      },
    });
    await h.orchestrator.tick();
    expect(reviewerCalls).toEqual(['backend-b']);
    expect(h.statuses).toContain('REVIEW_REJECTED');
  });

  it('fences a reviewer that returns after its job was interrupted', async () => {
    const entered = deferred();
    const release = deferred();
    const forbidden = new Set(['REVIEW_REJECTED', 'FIX_READY', 'FIX_FAILED']);
    let mutateJob!: () => void;
    const h = harness({
      fixer: async (_backendId, input, mutations) => {
        mutations.set(input.worktreePath, 'fix');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async () => {
        entered.resolve();
        await release.promise;
        return { verdict: 'reject', bugAddressed: false, regressionRisk: 'high', summary: 'rejected after interruption', findings: ['stale'] };
      },
    });
    mutateJob = () => h.queue.interrupt();
    const pipeline = h.orchestrator.tick();
    await entered.promise;
    mutateJob();
    release.resolve();
    await pipeline;

    expect(h.queue.getJob('job').status).toBe('INTERRUPTED');
    expect(h.statuses.some((status) => forbidden.has(status))).toBe(false);
    expect(h.dispatcher.health().every((backend) => backend.inFlight === 0)).toBe(true);
  });

  it('does not let a reclaimed old reviewer overwrite the new worker state', async () => {
    const entered = deferred();
    const release = deferred();
    const forbidden = new Set(['REVIEW_REJECTED', 'FIX_READY', 'FIX_FAILED']);
    let reclaim!: () => void;
    const h = harness({
      fixer: async (_backendId, input, mutations) => {
        mutations.set(input.worktreePath, 'fix');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async () => {
        entered.resolve();
        await release.promise;
        return { verdict: 'approve', bugAddressed: true, regressionRisk: 'low', summary: 'approved by stale reviewer', findings: [] };
      },
    });
    reclaim = () => { h.queue.reclaim('new-worker', 'new-lease'); h.statuses.push('FIXING'); };
    const pipeline = h.orchestrator.tick();
    await entered.promise;
    reclaim();
    release.resolve();
    await pipeline;

    expect(h.queue.getJob('job')).toMatchObject({ status: 'RUNNING', workerId: 'new-worker', leaseToken: 'new-lease' });
    expect(h.statuses.at(-1)).toBe('FIXING');
    expect(h.statuses.some((status) => forbidden.has(status))).toBe(false);
    expect(h.dispatcher.health().every((backend) => backend.inFlight === 0)).toBe(true);
  });

  it('marks the current reviewer run CANCELLED for an explicit cancellation', async () => {
    const entered = deferred();
    const release = deferred();
    let cancel!: () => void;
    const h = harness({
      fixer: async (_backendId, input, mutations) => {
        mutations.set(input.worktreePath, 'fix');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async () => {
        entered.resolve();
        await release.promise;
        return { verdict: 'approve', bugAddressed: true, regressionRisk: 'low', summary: 'cancelled session', findings: [] };
      },
    });
    cancel = () => h.statuses.push('CANCELLED');
    const pipeline = h.orchestrator.tick();
    await entered.promise;
    cancel();
    release.resolve();
    await pipeline;

    expect(h.queue.getJob('job').status).toBe('CANCELLED');
    expect(h.agentRuns.filter((run) => run.agentType === 'reviewer').every((run) => run.status === 'CANCELLED')).toBe(true);
    expect(h.statuses.some((status) => status === 'REVIEW_REJECTED' || status === 'FIX_READY' || status === 'FIX_FAILED')).toBe(false);
    expect(h.dispatcher.health().every((backend) => backend.inFlight === 0)).toBe(true);
  });

  it('does not mark an old reviewer run CANCELLED after cancellation is reclaimed', async () => {
    const entered = deferred();
    const release = deferred();
    let cancelAndReclaim!: () => void;
    const h = harness({
      fixer: async (_backendId, input, mutations) => {
        mutations.set(input.worktreePath, 'fix');
        return { bugKey: 'BUG-000011', status: 'fixed', confidence: 1, summary: 'fixed', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] };
      },
      reviewer: async () => {
        entered.resolve();
        await release.promise;
        return { verdict: 'approve', bugAddressed: true, regressionRisk: 'low', summary: 'stale result', findings: [] };
      },
    });
    cancelAndReclaim = () => { h.statuses.push('CANCELLED'); h.queue.reclaim('new-worker', 'new-lease'); };
    const pipeline = h.orchestrator.tick();
    await entered.promise;
    cancelAndReclaim();
    release.resolve();
    await pipeline;

    expect(h.queue.getJob('job')).toMatchObject({ status: 'RUNNING', workerId: 'new-worker', leaseToken: 'new-lease' });
    expect(h.agentRuns.filter((run) => run.agentType === 'reviewer').every((run) => run.status === 'RUNNING')).toBe(true);
    expect(h.dispatcher.health().every((backend) => backend.inFlight === 0)).toBe(true);
  });
});
