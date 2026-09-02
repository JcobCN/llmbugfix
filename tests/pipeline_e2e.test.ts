import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, SQLiteBugRepository } from '../packages/bug-repository/src/index.js';
import { newId } from '../packages/shared/src/index.js';
import { JobQueue } from '../packages/job-queue/src/index.js';
import { EnvironmentResolver } from '../packages/environment-resolver/src/index.js';
import { RepoManager } from '../packages/repo-manager/src/index.js';
import { EnvironmentRunner } from '../packages/environment-runner/src/index.js';
import { FakePiRunner } from '../packages/pi-runner/src/index.js';
import { Validator } from '../packages/validator/src/index.js';
import { Orchestrator } from '../apps/orchestrator/src/index.js';

class FakeCommandRunner {
  calls: string[][] = [];
  async run(command: string, args: string[], _options: any): Promise<any> {
    this.calls.push([command, ...args]);
    const text = args.join(' ');
    if (args[0] === 'worktree' && args[1] === 'add') {
      const targetDir = args[4];
      if (targetDir) fs.mkdirSync(targetDir, { recursive: true });
      return { command, args, exitCode: 0, stdout: 'Preparing worktree\n', stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    if (text.includes('branch --show-current')) {
      return { command, args, exitCode: 0, stdout: 'ai/BUG-000001-fix-ui-button-rendering\n', stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    if (text.includes('remote get-url origin')) {
      return { command, args, exitCode: 0, stdout: 'https://localhost/example.git\n', stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    if (args[0] === 'rev-parse') {
      return { command, args, exitCode: 0, stdout: 'abc123commitsha\n', stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    if (args[0] === 'diff') {
      return { command, args, exitCode: 0, stdout: 'diff --git a/index.ts b/index.ts\n+ console.log("fixed");\n', stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    return { command, args, exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, timeout: false, aborted: false };
  }
}

function queueBug(repo: SQLiteBugRepository, bugKey: string) {
  repo.changeBugStatus(bugKey, 'COLLECTING');
  repo.changeBugStatus(bugKey, 'READY_FOR_CONFIRMATION');
  repo.changeBugStatus(bugKey, 'SUBMITTED');
  repo.changeBugStatus(bugKey, 'TRIAGING');
  return repo.changeBugStatus(bugKey, 'QUEUED');
}

function getBugStatus(repo: SQLiteBugRepository, bugIdOrKey: string): string {
  const row = repo.database.prepare('SELECT status FROM bug_reports WHERE id = ? OR bug_key = ?').get(bugIdOrKey, bugIdOrKey) as { status: string } | undefined;
  return row?.status ?? 'UNKNOWN';
}

describe('Bug Repository & Domain Integration', () => {
  let db: any;
  let repo: SQLiteBugRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SQLiteBugRepository(db);
  });

  afterEach(() => {
    if (db) db.close();
  });

  it('generates sequential unique bug keys BUG-000001, BUG-000002', () => {
    const user = repo.createUser({ displayName: 'Tester', email: null });
    const conv = repo.createConversation({
      id: newId(),
      reporterId: user.id,
      status: 'active',
      draft: {},
      completeness: {
        score: 80,
        dimensions: { problem: 20, reproduction: 30, environment: 10, evidence: 10, impact: 10 },
        missingCriticalInformation: [],
        recommendedQuestions: [],
        readyForSubmission: true
      }
    });

    const b1 = repo.createBug({
      title: 'Login button broken',
      productArea: null,
      component: null,
      bugType: 'functional',
      executionTarget: 'frontend',
      environmentProfileId: 'frontend-main',
      severity: 'medium',
      actualBehavior: 'Button does not respond to clicks',
      expectedBehavior: 'Form submits and navigates to home page',
      reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['1. Go to /login', '2. Click submit'], testData: [] },
      environment: { environmentName: 'staging', appVersion: '1.0.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: ['TypeError: undefined'], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { affectedUsers: 'all', scope: 'all_users', blocksTesting: false, workaroundExists: false, workaround: null },
      regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null },
      observations: [],
      reporterHypotheses: [],
      reporter: { userId: user.id, displayName: 'Tester' },
      intake: { completenessScore: 80, confidence: 0.95, missingInformation: [], conversationId: conv.id, llmSummary: 'Login click issue' }
    });

    const b2 = repo.createBug({
      title: 'API returns 500 on checkout',
      productArea: null,
      component: null,
      bugType: 'functional',
      executionTarget: 'backend',
      environmentProfileId: 'backend-main',
      severity: 'high',
      actualBehavior: 'HTTP 500 Internal Server Error',
      expectedBehavior: 'HTTP 200 Order Created',
      reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['1. POST /orders'], testData: [] },
      environment: { environmentName: 'staging', appVersion: '1.0.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: ['Database connection timeout'], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { affectedUsers: 'all', scope: 'all_users', blocksTesting: true, workaroundExists: false, workaround: null },
      regression: { isRegression: true, lastKnownGoodVersion: 'v0.9.9', suspectedVersion: 'v1.0.0' },
      observations: [],
      reporterHypotheses: [],
      reporter: { userId: user.id, displayName: 'Tester' },
      intake: { completenessScore: 85, confidence: 0.98, missingInformation: [], conversationId: conv.id, llmSummary: 'Checkout 500 failure' }
    });

    expect(b1.bugKey).toBe('BUG-000001');
    expect(b2.bugKey).toBe('BUG-000002');
  });
});

describe('Orchestrator End-to-End Pipeline', () => {
  let tmpDir: string;
  let worktreeRootDir: string;
  let repoDir: string;
  let dataRootDir: string;
  let envConfigFile: string;
  let db: any;
  let repo: SQLiteBugRepository;
  let queue: JobQueue;
  let envResolver: EnvironmentResolver;
  let repoManager: RepoManager;
  let envRunner: EnvironmentRunner;
  let fakeRunner: FakeCommandRunner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join('/tmp', 'e2e-orchestrator-'));
    repoDir = path.join(tmpDir, 'repo');
    worktreeRootDir = path.join(tmpDir, 'worktrees');
    dataRootDir = path.join(tmpDir, 'data');
    fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
    fs.mkdirSync(worktreeRootDir, { recursive: true });
    fs.mkdirSync(dataRootDir, { recursive: true });

    // Create environment profile and docs
    const envDir = path.join(tmpDir, 'environments');
    const skillDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(envDir, { recursive: true });
    fs.mkdirSync(skillDir, { recursive: true });

    fs.writeFileSync(path.join(envDir, 'frontend.md'), '# Frontend architecture docs\n');
    fs.writeFileSync(path.join(skillDir, 'fix.md'), '# Bug fix skill\n');

    envConfigFile = path.join(tmpDir, 'environments.yaml');
    fs.writeFileSync(
      envConfigFile,
      `
environments:
  - id: frontend-test
    name: Frontend Test
    target: frontend
    repository: "${repoDir}"
    defaultBranch: main
    markdown:
      - environments/frontend.md
    skills:
      - skills/fix.md
    setupCommands:
      - "node -v"
    validationCommands:
      - "npm test"
`
    );

    db = openDatabase(':memory:');
    repo = new SQLiteBugRepository(db);
    queue = new JobQueue(repo, path.join(tmpDir, 'locks'));
    envResolver = new EnvironmentResolver(envConfigFile, tmpDir);
    fakeRunner = new FakeCommandRunner();
    repoManager = new RepoManager({
      worktreesRoot: worktreeRootDir,
      repositoryRoots: [tmpDir, repoDir],
      allowedRemoteHosts: ['localhost'],
      commandRunner: fakeRunner as any
    });
    envRunner = new EnvironmentRunner({
      commandRunner: fakeRunner as any
    });
  });

  afterEach(() => {
    if (db) db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('runs complete dry-run pipeline and writes all 9 artifacts', async () => {
    const user = repo.createUser({ displayName: 'Dev', email: null });
    const conv = repo.createConversation({
      id: newId(),
      reporterId: user.id,
      status: 'active',
      draft: {},
      completeness: {
        score: 85,
        dimensions: { problem: 25, reproduction: 30, environment: 10, evidence: 10, impact: 10 },
        missingCriticalInformation: [],
        recommendedQuestions: [],
        readyForSubmission: true
      }
    });

    const bug = repo.createBug({
      title: 'Fix UI button rendering',
      productArea: 'ui',
      component: 'button',
      bugType: 'functional',
      executionTarget: 'frontend',
      environmentProfileId: 'frontend-test',
      severity: 'medium',
      actualBehavior: 'Button text misaligned',
      expectedBehavior: 'Button text centered',
      reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['Open page'], testData: [] },
      environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { affectedUsers: 'some', scope: 'some_users', blocksTesting: false, workaroundExists: false, workaround: null },
      regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null },
      observations: [],
      reporterHypotheses: [],
      reporter: { userId: user.id, displayName: 'Dev' },
      intake: { completenessScore: 85, confidence: 1, missingInformation: [], conversationId: conv.id, llmSummary: 'Button alignment' }
    });

    queueBug(repo, bug.bugKey);
    const job = queue.enqueueJob(bug.id, bug.bugKey);
    expect(job).toBeDefined();

    const fakeAgent = new FakePiRunner();
    const validator = new Validator(fakeRunner as any);
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any,
      repo,
      queue,
      envResolver,
      repoManager,
      envRunner,
      fakeAgent,
      validator,
      { dryRun: true, artifactRoot: path.join(dataRootDir, 'agent-results') }
    );

    const handled = await orchestrator.tick();
    expect(handled).toBe(true);

    expect(getBugStatus(repo, bug.id)).toBe('FIX_READY');

    // Verify all 9 artifacts + pipeline.json exist
    const artifactDir = path.join(dataRootDir, 'agent-results', bug.bugKey);
    expect(fs.existsSync(path.join(artifactDir, 'pipeline.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'bug.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'environment.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'fix-task.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'environment-run.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'agent-result.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'validation.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'diff.patch'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'review.json'))).toBe(true);
    expect(fs.existsSync(path.join(artifactDir, 'git-result.json'))).toBe(true);

    const gitResult = JSON.parse(fs.readFileSync(path.join(artifactDir, 'git-result.json'), 'utf8'));
    expect(gitResult.pushed).toBe(false);
    expect(gitResult.error).toBe('DRY_RUN');
  });

  it('runs push-enabled pipeline and reaches READY_FOR_HUMAN_REVIEW', async () => {
    const user = repo.createUser({ displayName: 'Dev', email: null });
    const conv = repo.createConversation({
      id: newId(),
      reporterId: user.id,
      status: 'active',
      draft: {},
      completeness: {
        score: 85,
        dimensions: { problem: 25, reproduction: 30, environment: 10, evidence: 10, impact: 10 },
        missingCriticalInformation: [],
        recommendedQuestions: [],
        readyForSubmission: true
      }
    });

    const bug = repo.createBug({
      title: 'Fix UI button rendering',
      productArea: 'ui',
      component: 'button',
      bugType: 'functional',
      executionTarget: 'frontend',
      environmentProfileId: 'frontend-test',
      severity: 'medium',
      actualBehavior: 'Button text misaligned',
      expectedBehavior: 'Button text centered',
      reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['Open page'], testData: [] },
      environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { affectedUsers: 'some', scope: 'some_users', blocksTesting: false, workaroundExists: false, workaround: null },
      regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null },
      observations: [],
      reporterHypotheses: [],
      reporter: { userId: user.id, displayName: 'Dev' },
      intake: { completenessScore: 85, confidence: 1, missingInformation: [], conversationId: conv.id, llmSummary: 'Button alignment' }
    });

    queueBug(repo, bug.bugKey);
    queue.enqueueJob(bug.id, bug.bugKey);

    const fakeAgent = new FakePiRunner();
    const validator = new Validator(fakeRunner as any);
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any,
      repo,
      queue,
      envResolver,
      repoManager,
      envRunner,
      fakeAgent,
      validator,
      { dryRun: false, artifactRoot: path.join(dataRootDir, 'agent-results') }
    );

    const handled = await orchestrator.tick();
    expect(handled).toBe(true);

    expect(getBugStatus(repo, bug.id)).toBe('READY_FOR_HUMAN_REVIEW');

    const artifactDir = path.join(dataRootDir, 'agent-results', bug.bugKey);
    const gitResult = JSON.parse(fs.readFileSync(path.join(artifactDir, 'git-result.json'), 'utf8'));
    expect(gitResult.pushed).toBe(true);
    expect(gitResult.commitSha).toBe('abc123commitsha');
  });

  it('handles validation failure correctly', async () => {
    const user = repo.createUser({ displayName: 'Dev', email: null });
    const conv = repo.createConversation({
      id: newId(),
      reporterId: user.id,
      status: 'active',
      draft: {},
      completeness: {
        score: 90,
        dimensions: { problem: 25, reproduction: 30, environment: 15, evidence: 10, impact: 10 },
        missingCriticalInformation: [],
        recommendedQuestions: [],
        readyForSubmission: true
      }
    });

    const bug = repo.createBug({
      title: 'Broken validation case',
      productArea: null,
      component: null,
      bugType: 'functional',
      executionTarget: 'frontend',
      environmentProfileId: 'frontend-test',
      severity: 'high',
      actualBehavior: 'Crash',
      expectedBehavior: 'No crash',
      reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['Step 1'], testData: [] },
      environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { affectedUsers: 'all', scope: 'all_users', blocksTesting: true, workaroundExists: false, workaround: null },
      regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null },
      observations: [],
      reporterHypotheses: [],
      reporter: { userId: user.id, displayName: 'Dev' },
      intake: { completenessScore: 90, confidence: 1, missingInformation: [], conversationId: conv.id, llmSummary: 'Crash' }
    });

    queueBug(repo, bug.bugKey);
    queue.enqueueJob(bug.id, bug.bugKey);

    const failingValidator = {
      runValidation: async () => ({
        passed: false,
        commands: ['npm test'],
        summary: 'Validation checks failed.',
        artifacts: [],
        results: [{ command: 'npm test', exitCode: 1, passed: false, stdout: '', stderr: 'Test failed', output: 'Test failed', timedOut: false, timeout: false }]
      })
    } as any;

    const fakeAgent = new FakePiRunner();
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any,
      repo,
      queue,
      envResolver,
      repoManager,
      envRunner,
      fakeAgent,
      failingValidator,
      { dryRun: true, artifactRoot: path.join(dataRootDir, 'agent-results') }
    );

    const handled = await orchestrator.tick();
    expect(handled).toBe(true);

    expect(getBugStatus(repo, bug.id)).toBe('VALIDATION_FAILED');
  });

  it('handles review rejection correctly', async () => {
    const user = repo.createUser({ displayName: 'Dev', email: null });
    const conv = repo.createConversation({
      id: newId(),
      reporterId: user.id,
      status: 'active',
      draft: {},
      completeness: {
        score: 80,
        dimensions: { problem: 20, reproduction: 30, environment: 10, evidence: 10, impact: 10 },
        missingCriticalInformation: [],
        recommendedQuestions: [],
        readyForSubmission: true
      }
    });

    const bug = repo.createBug({
      title: 'Review rejected case',
      productArea: null,
      component: null,
      bugType: 'functional',
      executionTarget: 'frontend',
      environmentProfileId: 'frontend-test',
      severity: 'medium',
      actualBehavior: 'Bug',
      expectedBehavior: 'Fix',
      reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['Step 1'], testData: [] },
      environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { affectedUsers: 'some', scope: 'some_users', blocksTesting: false, workaroundExists: false, workaround: null },
      regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null },
      observations: [],
      reporterHypotheses: [],
      reporter: { userId: user.id, displayName: 'Dev' },
      intake: { completenessScore: 80, confidence: 1, missingInformation: [], conversationId: conv.id, llmSummary: 'Issue' }
    });

    queueBug(repo, bug.bugKey);
    queue.enqueueJob(bug.id, bug.bugKey);

    const rejectingAgent = new FakePiRunner(undefined, {
      verdict: 'reject',
      bugAddressed: false,
      regressionRisk: 'high',
      summary: 'Fix introduces security flaw',
      findings: ['High risk regression found']
    });

    const validator = new Validator(fakeRunner as any);
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any,
      repo,
      queue,
      envResolver,
      repoManager,
      envRunner,
      rejectingAgent,
      validator,
      { dryRun: true, artifactRoot: path.join(dataRootDir, 'agent-results') }
    );

    const handled = await orchestrator.tick();
    expect(handled).toBe(true);

    expect(getBugStatus(repo, bug.id)).toBe('REVIEW_REJECTED');
  });
});
