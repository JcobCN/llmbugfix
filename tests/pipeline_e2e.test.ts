import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, SQLiteBugRepository, SQLiteWeeklyReportDataSource } from '../packages/bug-repository/src/index.js';
import { newId } from '../packages/shared/src/index.js';
import { JobQueue } from '../packages/job-queue/src/index.js';
import { EnvironmentResolver } from '../packages/environment-resolver/src/index.js';
import { RepoManager } from '../packages/repo-manager/src/index.js';
import { EnvironmentRunner } from '../packages/environment-runner/src/index.js';
import { FakePiRunner, PiAgentRunnerTimeoutError } from '../packages/pi-runner/src/index.js';
import { Validator } from '../packages/validator/src/index.js';
import { Orchestrator } from '../apps/orchestrator/src/index.js';
import { DefaultWeeklyReportService } from '../packages/weekly-email-report/src/index.js';

class FakeCommandRunner {
  calls: string[][] = [];
  async run(command: string, args: string[], _options: any): Promise<any> {
    this.calls.push([command, ...args]);
    const text = args.join(' ');
    if (args[0] === 'worktree' && args[1] === 'add') {
      const targetDir = args[4];
      if (targetDir) {
        fs.mkdirSync(targetDir, { recursive: true });
        // RepoManager resolves the real worktree before mutating Git metadata.
        // Keep this fake checkout shaped like a normal linked worktree so the
        // push-enabled path exercises the same repository safety gate.
        fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true });
      }
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

class CandidateCommandRunner extends FakeCommandRunner {
  diffOutput = 'diff --git a/index.ts b/index.ts\n+ console.log("fixed");\n';
  override async run(command: string, args: string[], options: any): Promise<any> {
    if (args[0] === 'rev-parse') {
      this.calls.push([command, ...args]);
      return { command, args, exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    if (args[0] === 'diff') {
      this.calls.push([command, ...args]);
      return { command, args, exitCode: 0, stdout: this.diffOutput, stderr: '', timedOut: false, timeout: false, aborted: false };
    }
    return super.run(command, args, options);
  }
}

function createPipelineBug(repo: SQLiteBugRepository, title: string) {
  const user = repo.createUser({ displayName: 'Candidate tester', email: null });
  const conv = repo.createConversation({ id: newId(), reporterId: user.id, status: 'active', draft: {}, completeness: { score: 85, dimensions: { problem: 25, reproduction: 30, environment: 10, evidence: 10, impact: 10 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: true } });
  return repo.createBug({
    title, productArea: 'ui', component: 'button', bugType: 'functional', executionTarget: 'frontend', environmentProfileId: 'frontend-test', severity: 'medium', actualBehavior: 'Button is stuck', expectedBehavior: 'Button responds',
    reproduction: { reproducible: true, frequency: 'always', prerequisites: [], steps: ['Open page', 'Click button'], testData: [] }, environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} },
    evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] }, impact: { affectedUsers: 'some', scope: 'some_users', blocksTesting: false, workaroundExists: false, workaround: null }, regression: { isRegression: false, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [], reporter: { userId: user.id, displayName: 'Candidate tester' }, intake: { completenessScore: 85, confidence: 1, missingInformation: [], conversationId: conv.id, llmSummary: 'Button issue' },
  });
}

function writeCandidateArtifacts(root: string, bugKey: string, baseCommit = 'a'.repeat(40)) {
  const artifactDir = path.join(root, bugKey); fs.mkdirSync(artifactDir, { recursive: true });
  const patch = 'diff --git a/index.ts b/index.ts\n'; const candidate = { bugKey, patchFile: 'diff.patch', patchSha256: createHash('sha256').update(patch).digest('hex'), patchBytes: Buffer.byteLength(patch), baseCommit, reason: 'completion_format_failed', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(artifactDir, 'diff.patch'), patch); fs.writeFileSync(path.join(artifactDir, 'candidate.json'), `${JSON.stringify(candidate)}\n`);
  return { artifactDir, patch, candidate };
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
      executionTarget: 'unknown',
      environmentProfileId: 'frontend-test',
      dev_env_snapshot: 'r35.1',
      dev_env_special: 'raw-spofer-pel v2.0.200',
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

    const attachmentId = newId();
    repo.addAttachment(bug.id, { id: attachmentId, filename: 'screenshot.png', mimeType: 'image/png', size: 3, relativePath: 'attachments/screenshot.png', sha256: 'a'.repeat(64), extractedText: 'button was shifted', analysisStatus: 'completed', analysisResult: 'Visual mismatch' });
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
    const fixTask = JSON.parse(fs.readFileSync(path.join(artifactDir, 'fix-task.json'), 'utf8'));
    expect(fixTask.executionTarget).toBe('frontend');
    expect(fixTask).toMatchObject({ dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200' });
    expect(fixTask.attachments.map((item: { id: string }) => item.id)).toContain(attachmentId);
    const fixerRuns = db.prepare("SELECT output FROM agent_runs WHERE bug_id = ? AND agent_type = 'fixer' AND status = 'COMPLETED'").all(bug.id) as Array<{ output: string }>;
    expect(fixerRuns).toHaveLength(1);
    expect(JSON.parse(fixerRuns[0].output)).toMatchObject({ bugKey: bug.bugKey, summary: 'Fake fixer result' });
    const weeklyReport = new DefaultWeeklyReportService(new SQLiteWeeklyReportDataSource(db)).generate(
      new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    );
    expect(weeklyReport.bugs).toHaveLength(1);
    expect(weeklyReport.bugs[0]).toMatchObject({ bugKey: bug.bugKey, summary: 'Fake fixer result', currentStatus: 'FIX_READY' });
  });

  it('runs a development task through coder, validation and acceptance review', async () => {
    const user = repo.createUser({ displayName: 'Product developer', email: null }); const conv = repo.createConversation({ id: newId(), reporterId: user.id, status: 'active', draft: { taskType: 'development' }, completeness: { score: 85, dimensions: { problem: 0, reproduction: 0, environment: 15, evidence: 0, impact: 0, objective: 25, requirements: 25, acceptance: 25, scope: 0 }, missingCriticalInformation: [], recommendedQuestions: [], readyForSubmission: true } });
    const bug = repo.createBug({ taskType: 'development', title: 'Add CSV export', productArea: 'orders', component: 'orders-page', bugType: 'unknown', executionTarget: 'frontend', environmentProfileId: 'frontend-test', dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200', severity: 'unknown', actualBehavior: '', expectedBehavior: null, objective: 'Add CSV export', requirements: ['Export filtered rows'], acceptanceCriteria: ['Export downloads a CSV with filtered rows'], nonGoals: [], constraints: [], referenceContext: [], reproduction: { reproducible: null, frequency: 'unknown', prerequisites: [], steps: [], testData: [] }, environment: { environmentName: 'test', appVersion: '1.0', buildNumber: null, commitSha: null, additionalInfo: {} }, evidence: { errorMessages: [], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] }, impact: { affectedUsers: null, scope: 'unknown', blocksTesting: null, workaroundExists: null, workaround: null }, regression: { isRegression: null, lastKnownGoodVersion: null, suspectedVersion: null }, observations: [], reporterHypotheses: [], reporter: { userId: user.id, displayName: 'Product developer' }, intake: { completenessScore: 85, confidence: 1, missingInformation: [], conversationId: conv.id, llmSummary: 'Add CSV export' } });
    queueBug(repo, bug.bugKey); queue.enqueueJob(bug.id, bug.bugKey);
    const agent = { runFixer: async () => { throw new Error('legacy fixer must not run'); }, runCoder: async (input: any) => { fs.writeFileSync(path.join(input.worktreePath, 'feature.txt'), 'csv export'); return { bugKey: input.task.bugKey, taskType: 'development', status: 'completed', confidence: 1, summary: 'Implemented export', filesChanged: ['feature.txt'], validationNotes: [], riskNotes: [], blockedReason: null, missingInformation: [], developmentDetails: { requirementsAddressed: input.task.requirements, acceptanceCriteriaAddressed: input.task.acceptanceCriteria, designNotes: [] } }; }, runReviewer: async (input: any) => ({ verdict: 'approve', taskAddressed: true, acceptanceCriteriaMet: input.task.acceptanceCriteria.map((criterion: string) => ({ criterion, met: true, evidence: 'validated diff' })), regressionRisk: 'low', summary: 'Accepted', findings: [] }) };
    const orchestrator = new Orchestrator({ DATA_ROOT: dataRootDir } as any, repo, queue, envResolver, repoManager, envRunner, agent as any, new Validator(fakeRunner as any), { dryRun: true, artifactRoot: path.join(dataRootDir, 'agent-results') });
    expect(await orchestrator.tick()).toBe(true); expect(getBugStatus(repo, bug.id)).toBe('FIX_READY');
    const artifactDir = path.join(dataRootDir, 'agent-results', bug.bugKey); expect(JSON.parse(fs.readFileSync(path.join(artifactDir, 'coding-task.json'), 'utf8'))).toMatchObject({ taskType: 'development', acceptanceCriteria: ['Export downloads a CSV with filtered rows'], dev_env_snapshot: 'r35.1', dev_env_special: 'raw-spofer-pel v2.0.200' }); expect(JSON.parse(fs.readFileSync(path.join(artifactDir, 'agent-result.json'), 'utf8'))).toMatchObject({ taskType: 'development', status: 'completed' });
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

  it('preserves a non-empty diff as FIX_CANDIDATE when fixer times out', async () => {
    const bug = createPipelineBug(repo, 'Timeout candidate'); queueBug(repo, bug.bugKey); queue.enqueueJob(bug.id, bug.bugKey);
    const commandRunner = new CandidateCommandRunner(); let reviewerCalls = 0;
    const agentRunner = { runFixer: async (input: { worktreePath: string }) => { fs.writeFileSync(path.join(input.worktreePath, 'agent-change.txt'), 'real fixer work\n'); throw new PiAgentRunnerTimeoutError('fixer', 1000); }, runReviewer: async () => { reviewerCalls += 1; throw new Error('reviewer is not reached after fixer timeout'); } };
    const artifactRoot = path.join(dataRootDir, 'agent-results');
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any, repo, queue, envResolver, new RepoManager({ worktreesRoot: worktreeRootDir, repositoryRoots: [tmpDir, repoDir], allowedRemoteHosts: ['localhost'], commandRunner: commandRunner as any }), new EnvironmentRunner({ commandRunner: commandRunner as any }), agentRunner as any, new Validator(commandRunner as any), { dryRun: false, artifactRoot },
    );

    expect(await orchestrator.tick()).toBe(true); expect(getBugStatus(repo, bug.id)).toBe('FIX_CANDIDATE'); expect(reviewerCalls).toBe(0);
    const artifactDir = path.join(artifactRoot, bug.bugKey); const candidate = JSON.parse(fs.readFileSync(path.join(artifactDir, 'candidate.json'), 'utf8'));
    expect(candidate).toMatchObject({ bugKey: bug.bugKey, reason: 'fixer_timeout', patchFile: 'diff.patch' }); expect(candidate.patchSha256).toMatch(/^[a-f0-9]{64}$/u); expect(fs.readFileSync(path.join(artifactDir, 'diff.patch'), 'utf8')).toContain('diff --git'); expect(commandRunner.calls.some((call) => call[1] === 'push')).toBe(false);
  });

  it('fails as FIX_FAILED instead of creating a candidate when fixer timeout leaves no diff', async () => {
    const bug = createPipelineBug(repo, 'Timeout without diff'); queueBug(repo, bug.bugKey); queue.enqueueJob(bug.id, bug.bugKey);
    const commandRunner = new CandidateCommandRunner(); commandRunner.diffOutput = ''; const agentRunner = { runFixer: async () => { throw new PiAgentRunnerTimeoutError('fixer', 1000); }, runReviewer: async () => { throw new Error('reviewer is not reached'); } };
    const artifactRoot = path.join(dataRootDir, 'agent-results');
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any, repo, queue, envResolver, new RepoManager({ worktreesRoot: worktreeRootDir, repositoryRoots: [tmpDir, repoDir], allowedRemoteHosts: ['localhost'], commandRunner: commandRunner as any }), new EnvironmentRunner({ commandRunner: commandRunner as any }), agentRunner as any, new Validator(commandRunner as any), { dryRun: false, artifactRoot },
    );

    expect(await orchestrator.tick()).toBe(true); expect(getBugStatus(repo, bug.id)).toBe('FIX_FAILED'); const artifactDir = path.join(artifactRoot, bug.bugKey); expect(fs.existsSync(path.join(artifactDir, 'candidate.json'))).toBe(false); expect(fs.existsSync(path.join(artifactDir, 'diff.patch'))).toBe(false);
  });

  it('recovers a fixer candidate without rerunning the fixer and archives it after both gates', async () => {
    const bug = createPipelineBug(repo, 'Recover candidate fix'); queueBug(repo, bug.bugKey); queue.enqueueJob(bug.id, bug.bugKey);
    const { artifactDir } = writeCandidateArtifacts(path.join(dataRootDir, 'agent-results'), bug.bugKey);
    const commandRunner = new CandidateCommandRunner();
    const candidateRepoManager = new RepoManager({ worktreesRoot: worktreeRootDir, repositoryRoots: [tmpDir, repoDir], allowedRemoteHosts: ['localhost'], commandRunner: commandRunner as any });
    let fixerCalls = 0; let reviewerCalls = 0;
    const agentRunner = {
      runFixer: async () => { fixerCalls += 1; throw new Error('candidate retry must not call fixer'); },
      runReviewer: async (input: { filesChanged: string[] }) => { reviewerCalls += 1; expect(input.filesChanged.length).toBeGreaterThan(0); return { verdict: 'approve' as const, bugAddressed: true, regressionRisk: 'low' as const, summary: 'Candidate reviewed', findings: [] }; },
    };
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any, repo, queue, envResolver, candidateRepoManager, new EnvironmentRunner({ commandRunner: commandRunner as any }), agentRunner as any, new Validator(commandRunner as any), { dryRun: true, artifactRoot: path.join(dataRootDir, 'agent-results') },
    );

    expect(await orchestrator.tick()).toBe(true);
    expect(fixerCalls).toBe(0); expect(reviewerCalls).toBe(1); expect(getBugStatus(repo, bug.id)).toBe('FIX_READY');
    expect(fs.existsSync(path.join(artifactDir, 'candidate.json'))).toBe(false); expect(fs.existsSync(path.join(artifactDir, 'candidate-used.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(artifactDir, 'agent-result.json'), 'utf8')).status).toBe('fixed');
    expect(commandRunner.calls.some((call) => call[1] === 'push')).toBe(false);
  });

  it('keeps a recovered candidate behind deterministic validation and never invokes reviewer or push on validation failure', async () => {
    const bug = createPipelineBug(repo, 'Candidate validation failure'); queueBug(repo, bug.bugKey); queue.enqueueJob(bug.id, bug.bugKey);
    const { artifactDir } = writeCandidateArtifacts(path.join(dataRootDir, 'agent-results'), bug.bugKey);
    const commandRunner = new CandidateCommandRunner(); let fixerCalls = 0; let reviewerCalls = 0;
    const failingValidator = { runValidation: async () => ({ passed: false, commands: ['npm test'], summary: 'Validation failed', artifacts: [], results: [{ command: 'npm test', exitCode: 1, passed: false, stdout: '', stderr: 'failure', output: 'failure', timedOut: false, timeout: false }] }) };
    const agentRunner = { runFixer: async () => { fixerCalls += 1; throw new Error('must not rerun fixer'); }, runReviewer: async () => { reviewerCalls += 1; throw new Error('reviewer must be gated'); } };
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any, repo, queue, envResolver, new RepoManager({ worktreesRoot: worktreeRootDir, repositoryRoots: [tmpDir, repoDir], allowedRemoteHosts: ['localhost'], commandRunner: commandRunner as any }), new EnvironmentRunner({ commandRunner: commandRunner as any }), agentRunner as any, failingValidator as any, { dryRun: false, artifactRoot: path.join(dataRootDir, 'agent-results') },
    );

    expect(await orchestrator.tick()).toBe(true); expect(getBugStatus(repo, bug.id)).toBe('VALIDATION_FAILED'); expect(fixerCalls).toBe(0); expect(reviewerCalls).toBe(0);
    expect(fs.existsSync(path.join(artifactDir, 'candidate.json'))).toBe(true); expect(commandRunner.calls.some((call) => call[1] === 'push')).toBe(false);
  });

  it('does not push a recovered candidate rejected by the reviewer', async () => {
    const bug = createPipelineBug(repo, 'Candidate review rejection'); queueBug(repo, bug.bugKey); queue.enqueueJob(bug.id, bug.bugKey);
    const { artifactDir } = writeCandidateArtifacts(path.join(dataRootDir, 'agent-results'), bug.bugKey);
    const commandRunner = new CandidateCommandRunner(); let reviewerCalls = 0;
    const agentRunner = { runFixer: async () => { throw new Error('must not rerun fixer'); }, runReviewer: async () => { reviewerCalls += 1; return { verdict: 'reject' as const, bugAddressed: false, regressionRisk: 'high' as const, summary: 'Candidate rejected', findings: ['unsafe'] }; } };
    const orchestrator = new Orchestrator(
      { DATA_ROOT: dataRootDir } as any, repo, queue, envResolver, new RepoManager({ worktreesRoot: worktreeRootDir, repositoryRoots: [tmpDir, repoDir], allowedRemoteHosts: ['localhost'], commandRunner: commandRunner as any }), new EnvironmentRunner({ commandRunner: commandRunner as any }), agentRunner as any, new Validator(commandRunner as any), { dryRun: false, artifactRoot: path.join(dataRootDir, 'agent-results') },
    );

    expect(await orchestrator.tick()).toBe(true); expect(getBugStatus(repo, bug.id)).toBe('REVIEW_REJECTED'); expect(reviewerCalls).toBe(1);
    expect(fs.existsSync(path.join(artifactDir, 'candidate.json'))).toBe(true); expect(commandRunner.calls.some((call) => call[1] === 'push')).toBe(false);
  });
});
