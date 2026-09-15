import { describe, expect, it, vi } from 'vitest';
import { createSubmitFixResultTool, FakePiRunner, PiAgentRunner, PiAgentOutputFormatError, PiAgentLoopBudgetError, PiAgentRunnerTimeoutError, parseAgentJson, type PiSession, type PiSessionFactoryOptions } from './index.js';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BugFixTask, CodingTask } from '@llmbugfix/bug-domain';
import type { EnvironmentProfile } from '@llmbugfix/environment-resolver';

const task = { bugKey: 'BUG-000001', title: 'test', executionTarget: 'backend', environmentProfileId: 'p', actualBehavior: 'bad', expectedBehavior: 'good', reproductionSteps: [], prerequisites: [], environment: {}, errorMessages: [], stackTraces: [], attachments: [], lastKnownGoodVersion: null, failingVersion: null, reporterObservations: [], reporterHypotheses: [], machineObservations: [], missingInformation: [], completenessScore: 100 } as BugFixTask;
const profile: EnvironmentProfile = { id: 'p', name: 'p', target: 'backend', type: 'backend', repository: '/tmp/repo', repoUrl: '/tmp/repo', defaultBranch: 'main', baseBranch: 'main', instructions: [], markdown: [], skills: [], documentationPaths: [], skillPaths: [], setupCommands: [], validationCommands: [], setup: [], validation: [], runtime: undefined };
describe('FakePiRunner', () => {
  it('completes a development task with acceptance coverage', async () => { const developmentTask: CodingTask = { bugKey: 'BUG-000002', taskType: 'development', title: 'export', executionTarget: 'backend', environmentProfileId: 'p', objective: 'Add export', requirements: ['Export rows'], acceptanceCriteria: ['A CSV downloads'], nonGoals: [], constraints: [], referenceContext: [], environment: {}, attachments: [], reporterObservations: [], machineObservations: [], missingInformation: [], completenessScore: 100 }; const result = await new FakePiRunner().runCoder!({ worktreePath: '/tmp', task: developmentTask, profile, safety: 'safe' }); expect(result).toMatchObject({ taskType: 'development', status: 'completed', developmentDetails: { acceptanceCriteriaAddressed: ['A CSV downloads'] } }); });
  it('uses independent fixer and reviewer sessions', async () => { const runner = new FakePiRunner(); const fix = await runner.runFixer({ worktreePath: '/tmp', task, profile, safety: 'safe' }); await runner.runReviewer({ worktreePath: '/tmp', task, profile, diff: '', filesChanged: fix.filesChanged, validation: { passed: true, commands: [], results: [], summary: '', artifacts: [] } }); expect(runner.fixerSessions[0]).toBeTruthy(); expect(runner.fixerSessions[0]).not.toBe(runner.reviewerSessions[0]); });
  it('forwards bounded completion events through the explicit progress sink', async () => {
    const events: string[] = [];
    const runner = new FakePiRunner();
    await runner.runFixer({ worktreePath: '/tmp', task, profile, safety: 'safe', progress: (event) => { events.push(`${event.role}:${event.eventType}:${event.summary}`); } });
    expect(events).toEqual(['fixer:completed:fixer completed']);
  });
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
      ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash', 'submit_fix_result'],
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
    expect(tools.map((tool) => tool.name).sort()).toEqual(['bash', 'edit', 'submit_fix_result', 'write']);
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
    expect(sessionOptions[0].customTools?.map((tool) => tool.name)).toContain('submit_fix_result');
  });

  it('keeps the first submit_fix_result authoritative and rejects every duplicate', async () => {
    const accepted: unknown[] = [];
    const tool = createSubmitFixResultTool({ expectedBugKey: task.bugKey, onSubmit: (result) => accepted.push(result) });
    await tool.execute('first', fixResult, undefined, undefined, {} as never);
    await expect(tool.execute('same', fixResult, undefined, undefined, {} as never)).rejects.toThrow(/only be called once/);
    await expect(tool.execute('conflict', { ...fixResult, summary: 'different result' }, undefined, undefined, {} as never)).rejects.toThrow(/only be called once/);
    expect(accepted).toEqual([fixResult]);
  });

  it('strictly rejects unknown keys and semantic type/value errors at submit_fix_result', async () => {
    const invalidInputs = [
      { ...fixResult, unexpected: true },
      { ...fixResult, status: 'done' },
      { ...fixResult, confidence: '0.9' },
      { ...fixResult, reproduced: 'true' },
    ];
    for (const input of invalidInputs) {
      const tool = createSubmitFixResultTool({ expectedBugKey: task.bugKey, onSubmit: () => undefined });
      await expect(tool.execute('invalid', input, undefined, undefined, {} as never)).rejects.toThrow(/submit_fix_result rejected/);
    }
  });

  it('repairs only legacy string array fields and records the repair event', async () => {
    const info = vi.fn(); const accepted: any[] = [];
    const tool = createSubmitFixResultTool({ expectedBugKey: task.bugKey, logger: { info, error: vi.fn() }, onSubmit: (result) => accepted.push(result) });
    await tool.execute('legacy', { ...fixResult, riskNotes: 'legacy note', missingInformation: '' }, undefined, undefined, {} as never);
    expect(accepted[0]).toMatchObject({ riskNotes: ['legacy note'], missingInformation: [] });
    expect(info).toHaveBeenCalledWith({ role: 'fixer', fields: ['riskNotes', 'missingInformation'] }, 'contract_repaired');
  });

  it('accepts authoritative submit_fix_result followed by ordinary prose', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    let submit: ToolDefinition | undefined;
    const session = {
      prompt: vi.fn(async () => { await submit?.execute('submit-1', fixResult, undefined, undefined, {} as never); }),
      getLastAssistantText: vi.fn(() => '修复完成，以上工具提交为准。'),
      abort: vi.fn(async () => undefined), dispose: vi.fn(),
    } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async (options) => { submit = options.customTools?.find((tool) => tool.name === 'submit_fix_result'); return { session }; } });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).resolves.toEqual(fixResult);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it('repairs only string array fields at the fallback wire boundary', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    const repaired = { ...fixResult, riskNotes: 'a long note', missingInformation: '' };
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session: sessionReturning(JSON.stringify(repaired)) }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).resolves.toMatchObject({ riskNotes: ['a long note'], missingInformation: [] });
  });

  it('requests one closeout and aborts when a loop repeats the same tool', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    let listener: ((event: any) => void) | undefined;
    let releaseInitial!: () => void; let releaseCloseout!: () => void;
    const initialPending = new Promise<void>((resolve) => { releaseInitial = resolve; });
    const abort = vi.fn(async () => { releaseInitial(); releaseCloseout?.(); });
    const prompt = vi.fn((text: string, options?: { streamingBehavior?: string }) => { if (text.includes('Stop inspecting')) { expect(options?.streamingBehavior).toBe('steer'); return new Promise<void>((resolve) => { releaseCloseout = resolve; }); } listener?.({ type: 'tool_execution_start', toolName: 'read', args: { path: 'x' } }); listener?.({ type: 'tool_execution_start', toolName: 'read', args: { path: 'x' } }); return initialPending; });
    const session = { prompt, getLastAssistantText: vi.fn(() => 'not a result'), abort, dispose: vi.fn(), subscribe: vi.fn((fn) => { listener = fn; return () => undefined; }) } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, fixerMaxRepeatedToolCalls: 2, fixerCloseoutGraceMs: 1, sessionFactory: async () => ({ session }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).rejects.toThrow(/budget/);
    expect(abort).toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('never persists shell command arguments in progress events', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    let listener: ((event: any) => void) | undefined;
    const session = {
      prompt: vi.fn(async () => { listener?.({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'curl -H "Authorization: Bearer top-secret" https://example.test' } }); }),
      getLastAssistantText: vi.fn(() => JSON.stringify(fixResult)), abort: vi.fn(async () => undefined), dispose: vi.fn(),
      subscribe: vi.fn((fn) => { listener = fn; return () => undefined; }),
    } as unknown as PiSession;
    const events: Array<{ eventType: string; summary: string }> = [];
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, sessionFactory: async () => ({ session }) });
    await runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe', progress: (event) => { events.push(event); } });
    const toolEvent = events.find((event) => event.eventType === 'tool_execution_start');
    expect(toolEvent?.summary).toBe('bash started');
    expect(JSON.stringify(events)).not.toContain('top-secret');
  });

  it('accepts a reviewer JSON result produced by the single budget closeout steer', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    let listener: ((event: any) => void) | undefined; let closeout = false;
    const prompt = vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
      if (text.includes('Stop inspecting')) { closeout = true; expect(options?.streamingBehavior).toBe('steer'); return; }
      listener?.({ type: 'tool_execution_start', toolName: 'read', args: { path: 'x' } });
    });
    const session = { prompt, getLastAssistantText: vi.fn(() => closeout ? JSON.stringify(reviewResult) : 'not ready'), abort: vi.fn(async () => undefined), dispose: vi.fn(), subscribe: vi.fn((fn) => { listener = fn; return () => undefined; }) } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, reviewerMaxRepeatedToolCalls: 1, reviewerCloseoutGraceMs: 20, sessionFactory: async () => ({ session }) });
    await expect(runner.runReviewer({ worktreePath: '/tmp/worktree', task, profile, diff: 'diff', filesChanged: ['src/example.ts'], validation: { passed: true, commands: [], results: [], summary: '', artifacts: [] } })).resolves.toEqual(reviewResult);
    expect(prompt).toHaveBeenCalledTimes(2); expect(prompt.mock.calls.filter(([text]) => text.includes('Stop inspecting'))).toHaveLength(1); expect(session.abort).not.toHaveBeenCalled();
  });

  it('aborts after the closeout grace and returns budget failure when the reviewer JSON is invalid', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    let listener: ((event: any) => void) | undefined; let closeout = false;
    const prompt = vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
      if (text.includes('Stop inspecting')) { closeout = true; expect(options?.streamingBehavior).toBe('steer'); return; }
      listener?.({ type: 'tool_execution_start', toolName: 'read', args: { path: 'x' } });
    });
    const getLastAssistantText = vi.fn(() => closeout ? 'ordinary prose' : 'not ready');
    const abort = vi.fn(async () => undefined);
    const session = { prompt, getLastAssistantText, abort, dispose: vi.fn(), subscribe: vi.fn((fn) => { listener = fn; return () => undefined; }) } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, reviewerMaxRepeatedToolCalls: 1, reviewerCloseoutGraceMs: 5, sessionFactory: async () => ({ session }) });
    await expect(runner.runReviewer({ worktreePath: '/tmp/worktree', task, profile, diff: 'diff', filesChanged: ['src/example.ts'], validation: { passed: true, commands: [], results: [], summary: '', artifacts: [] } })).rejects.toBeInstanceOf(PiAgentLoopBudgetError);
    expect(getLastAssistantText).toHaveBeenCalledTimes(1); expect(prompt).toHaveBeenCalledTimes(2); expect(prompt.mock.calls.filter(([text]) => text.includes('Stop inspecting'))).toHaveLength(1); expect(abort).toHaveBeenCalledTimes(1);
  });

  it('accepts a fixer JSON fallback from the single budget closeout steer', async () => {
    const runtime = { registerProvider: vi.fn(), getModel: vi.fn(() => ({ id: 'test-model' })) };
    let listener: ((event: any) => void) | undefined; let closeout = false;
    const prompt = vi.fn(async (text: string, options?: { streamingBehavior?: string }) => {
      if (text.includes('Stop inspecting')) { closeout = true; expect(options?.streamingBehavior).toBe('steer'); return; }
      listener?.({ type: 'tool_execution_start', toolName: 'read', args: { path: 'x' } });
    });
    const session = { prompt, getLastAssistantText: vi.fn(() => closeout ? JSON.stringify(fixResult) : 'not ready'), abort: vi.fn(async () => undefined), dispose: vi.fn(), subscribe: vi.fn((fn) => { listener = fn; return () => undefined; }) } as unknown as PiSession;
    const runner = new PiAgentRunner({ endpoint: 'http://llm.test/v1', model: 'test-model', modelRuntime: runtime, fixerMaxRepeatedToolCalls: 1, fixerCloseoutGraceMs: 20, sessionFactory: async () => ({ session }) });
    await expect(runner.runFixer({ worktreePath: '/tmp/worktree', task, profile, safety: 'safe' })).resolves.toEqual(fixResult);
    expect(prompt).toHaveBeenCalledTimes(2); expect(prompt.mock.calls.filter(([text]) => text.includes('Stop inspecting'))).toHaveLength(1);
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
