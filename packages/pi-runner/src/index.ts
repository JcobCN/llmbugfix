import { newId } from '@llmbugfix/shared';
import { AgentFixResultSchema, BugFixTaskSchema, ReviewResultSchema, type AgentFixResult, type BugFixTask, type ReviewResult } from '@llmbugfix/bug-domain';
import { EnvironmentProfileSchema, type EnvironmentProfile } from '@llmbugfix/environment-resolver';
import { DeterministicValidationSchema, type DeterministicValidation } from '@llmbugfix/validator';
import { z } from 'zod';

const StrictFixResultSchema = AgentFixResultSchema.strict();
const StrictReviewResultSchema = ReviewResultSchema.strict();
export type AgentFixResultChecked = z.infer<typeof StrictFixResultSchema>;
export type ReviewResultChecked = z.infer<typeof StrictReviewResultSchema>;
export interface FixerInput { worktreePath: string; task: BugFixTask; profile: EnvironmentProfile; safety: string; docs?: Array<{ path: string; content: string }>; skills?: Array<{ path: string; content: string }>; attachments?: Array<{ id: string; text?: string; analysis?: string }>; }
export interface ReviewerInput { worktreePath: string; task: BugFixTask; profile: EnvironmentProfile; diff: string; filesChanged: string[]; validation: DeterministicValidation; }
export interface AgentRunner { runFixer(input: FixerInput): Promise<AgentFixResultChecked>; runReviewer(input: ReviewerInput): Promise<ReviewResultChecked>; }
/** Legacy name retained as a local interface alias; Pi SDK remains encapsulated here. */
export type PiRunnerAdapter = AgentRunner;
export interface PiSdk { run(input: { sessionId: string; prompt: string; cwd: string }): Promise<unknown>; }

export class PiAgentRunner implements AgentRunner {
  constructor(private readonly sdk: PiSdk, private readonly safety = 'No network, push, merge, deploy, or production access.') {}
  async runFixer(input: FixerInput): Promise<AgentFixResultChecked> {
    BugFixTaskSchema.parse(input.task); EnvironmentProfileSchema.parse(input.profile);
    const sessionId = newId(); const output = await this.sdk.run({ sessionId, cwd: input.worktreePath, prompt: JSON.stringify({ safety: input.safety || this.safety, task: input.task, profile: input.profile, docs: input.docs ?? [], skills: input.skills ?? [], attachments: input.attachments ?? [] }) });
    return StrictFixResultSchema.parse(output);
  }
  async runReviewer(input: ReviewerInput): Promise<ReviewResultChecked> {
    BugFixTaskSchema.parse(input.task); EnvironmentProfileSchema.parse(input.profile); DeterministicValidationSchema.parse(input.validation);
    const sessionId = newId(); const output = await this.sdk.run({ sessionId, cwd: input.worktreePath, prompt: JSON.stringify({ task: input.task, profile: input.profile, diff: input.diff, filesChanged: input.filesChanged, validation: input.validation }) });
    return StrictReviewResultSchema.parse(output);
  }
}

export class FakePiRunner implements AgentRunner {
  readonly fixerSessions: string[] = []; readonly reviewerSessions: string[] = [];
  constructor(private readonly fixResult?: AgentFixResultChecked, private readonly reviewResult?: ReviewResultChecked) {}
  async runFixer(input: FixerInput): Promise<AgentFixResultChecked> { const sessionId = newId(); this.fixerSessions.push(sessionId); return StrictFixResultSchema.parse(this.fixResult ?? { bugKey: input.task.bugKey, status: 'fixed', confidence: 1, summary: 'Fake fixer result', rootCause: null, reproduced: true, regressionTestAdded: false, filesChanged: [], riskNotes: [], blockedReason: null, missingInformation: [] }); }
  async runReviewer(input: ReviewerInput): Promise<ReviewResultChecked> { const sessionId = newId(); this.reviewerSessions.push(sessionId); return StrictReviewResultSchema.parse(this.reviewResult ?? { verdict: input.validation.passed ? 'approve' : 'reject', bugAddressed: input.validation.passed, regressionRisk: 'low', summary: 'Fake review result', findings: [] }); }
}
