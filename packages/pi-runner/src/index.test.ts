import { describe, expect, it } from 'vitest';
import { FakePiRunner } from './index.js';
import type { BugFixTask } from '@llmbugfix/bug-domain';
import type { EnvironmentProfile } from '@llmbugfix/environment-resolver';

const task = { bugKey: 'BUG-000001', title: 'test', executionTarget: 'backend', environmentProfileId: 'p', actualBehavior: 'bad', expectedBehavior: 'good', reproductionSteps: [], prerequisites: [], environment: {}, errorMessages: [], stackTraces: [], attachments: [], lastKnownGoodVersion: null, failingVersion: null, reporterObservations: [], reporterHypotheses: [], machineObservations: [], missingInformation: [], completenessScore: 100 } as BugFixTask;
const profile: EnvironmentProfile = { id: 'p', name: 'p', target: 'backend', type: 'backend', repository: '/tmp/repo', repoUrl: '/tmp/repo', defaultBranch: 'main', baseBranch: 'main', instructions: [], markdown: [], skills: [], documentationPaths: [], skillPaths: [], setupCommands: [], validationCommands: [], setup: [], validation: [], runtime: undefined };
describe('FakePiRunner', () => {
  it('uses independent fixer and reviewer sessions', async () => { const runner = new FakePiRunner(); const fix = await runner.runFixer({ worktreePath: '/tmp', task, profile, safety: 'safe' }); await runner.runReviewer({ worktreePath: '/tmp', task, profile, diff: '', filesChanged: fix.filesChanged, validation: { passed: true, commands: [], results: [], summary: '', artifacts: [] } }); expect(runner.fixerSessions[0]).toBeTruthy(); expect(runner.fixerSessions[0]).not.toBe(runner.reviewerSessions[0]); });
});
