import { describe, expect, it, vi } from 'vitest';
import { FakePiRunner, PiAgentRunner, PiAgentOutputFormatError, PiAgentRunnerTimeoutError, parseAgentJson, type PiSession, type PiSessionFactoryOptions } from './index.js';
import type { BugFixTask } from '@llmbugfix/bug-domain';
import type { EnvironmentProfile } from '@llmbugfix/environment-resolver';

const task = { bugKey: 'BUG-000001', title: 'test', executionTarget: 'backend', environmentProfileId: 'p', actualBehavior: 'bad', expectedBehavior: 'good', reproductionSteps: [], prerequisites: [], environment: {}, errorMessages: [], stackTraces: [], attachments: [], lastKnownGoodVersion: null, failingVersion: null, reporterObservations: [], reporterHypotheses: [], machineObservations: [], missingInformation: [], completenessScore: 100 } as BugFixTask;
const profile: EnvironmentProfile = { id: 'p', name: 'p', target: 'backend', type: 'backend', repository: '/tmp/repo', repoUrl: '/tmp/repo', defaultBranch: 'main', baseBranch: 'main', instructions: [], markdown: [], skills: [], documentationPaths: [], skillPaths: [], setupCommands: [], validationCommands: [], setup: [], validation: [], runtime: undefined };
describe('FakePiRunner', () => {
  it('uses independent fixer and reviewer sessions', async () => { const runner = new FakePiRunner(); const fix = await runner.runFixer({ worktreePath: '/tmp', task, profile, safety: 'safe' }); await runner.runReviewer({ worktreePath: '/tmp', task, profile, diff: '', filesChanged: fix.filesChanged, validation: { passed: true, commands: [], results: [], summary: '', artifacts: [] } }); expect(runner.fixerSessions[0]).toBeTruthy(); expect(runner.fixerSessions[0]).not.toBe(runner.reviewerSessions[0]); });
});

const fixResult = {
  bugKey: task.bugKey,
  status: 'fixed' as const,
  confidence: 0.9,
  summary: 'fixed',
  rootCause: 'test cause',
  reproduced: true,
  regressionTestAdded: true,
  filesChanged: ['src/example.ts'],
  riskNotes: [],
  blockedReason: null,
  missingInformation: [],
};
const reviewResult = {
  verdict: 'approve' as const,
  bugAddressed: true,
  regressionRisk: 'low' as const,
  summary: 'looks good',
  findings: [],
};

function sessionReturning(output: string): PiSession {
  return {
    prompt: vi.fn(async () => undefined),
    getLastAssistantText: vi.fn(() => output),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
  } as unknown as PiSession;
}

describe('PiAgentRunner', () => {
  it('registers the provider in the real isolated Pi ModelRuntime', async () => {
    const runner = new PiAgentRunner({
      endpointUrl: 'http://127.0.0.1:19999/v1',
      model: 'runtime-smoke-model',
      sessionFactory: async (options) => {
        expect(options.model).toMatchObject({ provider: 'llmbugfix', id: 'runtime-smoke-model' });
        return { session: sessionReturning(JSON.stringify(fixResult)) };
      },
    });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).resolves.toEqual(fixResult);
  });

  it('registers the OpenAI-compatible provider and creates isolated role sessions', async () => {
    const runtime = {
      registerProvider: vi.fn(),
      getModel: vi.fn(() => ({ id: 'test-model' })),
    };
    const sessionOptions: PiSessionFactoryOptions[] = [];
    const sessions = [sessionReturning(JSON.stringify(fixResult)), sessionReturning(`\`\`\`json\n${JSON.stringify(reviewResult)}\n\`\`\``)];
    const runner = new PiAgentRunner({
      endpointUrl: 'http://llm.test/v1',
      model: 'test-model',
      apiKey: 'test-secret',
      modelRuntime: runtime,
      sessionFactory: async (options) => { sessionOptions.push(options); return { session: sessions.shift() as PiSession }; },
    });

    const fix = await runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe', docs: [{ path: 'README.md', content: 'docs' }] });
    const review = await runner.runReviewer({ worktreePath: '/tmp/worktree', task, profile, diff: 'diff', filesChanged: fix.filesChanged, validation: { passed: true, commands: [], results: [], summary: '', artifacts: [] } });

    expect(fix).toEqual(fixResult);
    expect(review).toEqual(reviewResult);
    expect(runtime.registerProvider).toHaveBeenCalledWith('llmbugfix', expect.objectContaining({
      baseUrl: 'http://llm.test/v1', apiKey: 'test-secret', api: 'openai-completions', authHeader: true,
    }));
    expect(sessionOptions.map((options) => [...options.tools])).toEqual([
      ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'],
      ['read', 'grep', 'find', 'ls'],
    ]);
    expect(sessionOptions[0].cwd).toBe('/tmp/worktree');
    expect(sessionOptions[0].sessionManager).not.toBe(sessionOptions[1].sessionManager);
    expect(sessionOptions[0].resourceLoader.getSkills().skills).toEqual([]);
    expect(sessionOptions[0].resourceLoader.getPrompts().prompts).toEqual([]);
    expect(sessionOptions[0].resourceLoader.getExtensions().extensions).toEqual([]);
    expect(sessionOptions[1].resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect((sessions as unknown[])).toHaveLength(0);
  });

  it('accepts one JSON document or one fenced JSON block, and rejects surrounding prose', () => {
    expect(parseAgentJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseAgentJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(() => parseAgentJson('Here is the result:\n{"ok":true}')).toThrow();
    expect(() => parseAgentJson('```json\n{"ok":true}\n```\n```json\n{"ok":false}\n```')).toThrow();
  });

  it('aborts and disposes a session on timeout', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const abort = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const session = { prompt: vi.fn(() => new Promise<void>(() => undefined)), getLastAssistantText: vi.fn(() => undefined), abort, dispose } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', fixerTimeoutMs: 10, modelRuntime: runtime, sessionFactory: async () => ({ session }) });

    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).rejects.toBeInstanceOf(PiAgentRunnerTimeoutError);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('strictly validates the final agent JSON contract', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session: sessionReturning(JSON.stringify({ ...fixResult, unexpected: true })) }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).rejects.toThrow();
  });

  it('allows an unauthenticated endpoint when no API key is configured', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session: sessionReturning(JSON.stringify(fixResult)) }) });
    await runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' });
    expect(runtime.registerProvider).toHaveBeenCalledWith('llmbugfix', expect.objectContaining({ apiKey: undefined, authHeader: false }));
  });

  it('rejects a fixer result for a different bug', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session: sessionReturning(JSON.stringify({ ...fixResult, bugKey: 'BUG-999999' })) }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).rejects.toThrow('expected BUG-000001');
  });

  it('fails closed when a real fixer has no host sandbox profile', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, requireSandbox: true, sessionFactory: async () => ({ session: sessionReturning(JSON.stringify(fixResult)) }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).rejects.toThrow(/sandbox/i);
  });

  it('passes confined fixer tools to the session and rejects paths outside the worktree', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const sessionOptions: PiSessionFactoryOptions[] = [];
    const runner = new PiAgentRunner({
      endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime,
      bashShellPath: '/opt/fixer-bash', confineWorkspace: true,
      sessionFactory: async (options) => { sessionOptions.push(options); return { session: sessionReturning(JSON.stringify(fixResult)) }; },
    });
    await runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' });
    const tools = sessionOptions[0].customTools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual(['bash', 'edit', 'write']);
    const edit = tools.find((tool) => tool.name === 'edit');
    expect(edit).toBeTruthy();
    await expect(edit!.execute('t1', { path: '../escape.txt', edits: [] }, undefined, undefined, {} as never)).rejects.toThrow(/escapes the worktree sandbox/);
    await expect(edit!.execute('t2', { path: '/etc/passwd', edits: [] }, undefined, undefined, {} as never)).rejects.toThrow(/escapes the worktree sandbox/);
  });

  it('does not add confined tools when no sandbox options are set', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const sessionOptions: PiSessionFactoryOptions[] = [];
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async (options) => { sessionOptions.push(options); return { session: sessionReturning(JSON.stringify(fixResult)) }; } });
    await runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' });
    expect(sessionOptions[0].customTools).toBeUndefined();
  });

  it('feeds a validation failure back once and accepts the corrected output', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const outputs = [`修好了，详情如下：\n${JSON.stringify(fixResult)}`, JSON.stringify(fixResult)];
    const prompt = vi.fn(async () => undefined);
    const session = { prompt, getLastAssistantText: vi.fn(() => outputs.shift()), abort: vi.fn(async () => undefined), dispose: vi.fn() } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).resolves.toEqual(fixResult);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('throws PiAgentOutputFormatError with the raw output after a failed correction', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const bad = 'prose with no JSON at all';
    const session = { prompt: vi.fn(async () => undefined), getLastAssistantText: vi.fn(() => bad), abort: vi.fn(async () => undefined), dispose: vi.fn() } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).rejects.toMatchObject({ name: 'PiAgentOutputFormatError', rawOutput: bad, validationError: expect.stringMatching(/exactly one JSON object/) });
  });
});
