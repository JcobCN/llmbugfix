import { type AppConfig } from '@llmbugfix/shared';
import { SQLiteBugRepository } from '@llmbugfix/bug-repository';
import { JobQueue, type QueueJob } from '@llmbugfix/job-queue';
import { EnvironmentResolver } from '@llmbugfix/environment-resolver';
import { RepoManager } from '@llmbugfix/repo-manager';
import { EnvironmentRunner } from '@llmbugfix/environment-runner';
import { type AgentRunner } from '@llmbugfix/pi-runner';
import { Validator } from '@llmbugfix/validator';
export interface OrchestratorOptions {
    dryRun?: boolean;
    workerId?: string;
    artifactRoot?: string;
}
export interface PipelineArtifact {
    bugKey: string;
    status: string;
    startedAt: string;
    finishedAt?: string;
    error?: string | null;
}
export declare class Orchestrator {
    private readonly config;
    private readonly repo;
    private readonly queue;
    private readonly envResolver;
    private readonly repoManager;
    private readonly envRunner;
    private readonly agentRunner;
    private readonly validator;
    private timer?;
    private isRunning;
    private readonly options;
    constructor(config: AppConfig, repo: SQLiteBugRepository, queue: JobQueue, envResolver: EnvironmentResolver, repoManager: RepoManager, envRunner: EnvironmentRunner, agentRunner?: AgentRunner, validator?: Validator, options?: OrchestratorOptions);
    start(pollIntervalMs?: number): void;
    stop(): void;
    tick(): Promise<boolean>;
    runJob(job: QueueJob): Promise<void>;
    private writeArtifact;
    private writeRawArtifact;
    private transition;
    private taskFor;
    private processJob;
}
//# sourceMappingURL=index.d.ts.map