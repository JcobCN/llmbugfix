import { type EnvironmentProfileProposal } from '@llmbugfix/bug-domain';
import { type BugDocumentStore, type SQLiteBugRepository, type BugRepository } from '@llmbugfix/bug-repository';
import { IntakeService } from '@llmbugfix/intake-agent';
import { createAttachmentRoutes } from './attachment-routes.js';
type QueueJobLike = {
    id: string;
    bugId: string;
    status: string;
    attempt?: number;
    error?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    heartbeatAt?: string | null;
    workerId?: string | null;
};
export type QueueLike = {
    enqueueJob(bugId: string, bugKey?: string, priority?: number): unknown;
    listJobs?: () => QueueJobLike[];
    getJob?: (id: string) => QueueJobLike;
    retryJob?: (id: string) => QueueJobLike;
    cancelJob?: (id: string) => QueueJobLike;
    recoverStaleJobs?: (timeoutMs?: number) => QueueJobLike[];
};
type ProvisionedEnvironmentProfile = {
    id: string;
    target: 'frontend' | 'backend';
};
type EnvironmentSource = {
    listProfiles(): unknown[];
    resolveProfile?: (target: string, requestedProfileId?: string) => unknown;
    /** Creates a local checkout + generated profile after the reporter confirms. */
    provisionProfile?: (proposal: EnvironmentProfileProposal & {
        target: 'frontend' | 'backend';
    }) => Promise<ProvisionedEnvironmentProfile> | ProvisionedEnvironmentProfile;
};
export type PageRenderer = (pathname: string) => string | undefined;
export type ApiDependencies = {
    repo: BugRepository;
    intake?: IntakeService;
    queue?: QueueLike;
    environments?: EnvironmentSource;
    attachments?: Parameters<typeof createAttachmentRoutes>[0]['attachments'];
    pageRenderer?: PageRenderer;
    documentStore?: BugDocumentStore;
};
export type InjectRequest = {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
};
export type InjectResponse<T = unknown> = {
    status: number;
    headers: Record<string, string>;
    data: T;
    raw: string;
};
export declare const DEFAULT_API_CONFIG: {
    readonly DRY_RUN: true;
    readonly FIXER_TIMEOUT_MS: 2700000;
    readonly REVIEWER_TIMEOUT_MS: 900000;
    readonly ENVIRONMENT_TIMEOUT_MS: 600000;
    readonly PIPELINE_TIMEOUT_MS: 5400000;
    readonly DATA_ROOT: "data";
    readonly LLM_HOST: "disabled://local";
    readonly VISION_HOST: "disabled://local";
    readonly GIT_HOST: "localhost";
    readonly GIT_ALLOWED_HOSTS: "localhost";
};
/** Safe startup defaults. Secrets are deliberately not accepted as log context. */
export declare function resolveApiConfig(value?: unknown): Record<string, unknown>;
export declare class BugApiServer {
    private readonly config;
    private readonly attachmentService?;
    private readonly server;
    private readonly repo;
    private readonly intake;
    private readonly environments?;
    private readonly queue?;
    private readonly pageRenderer?;
    private readonly apiConfig;
    private readonly attachmentRoutes?;
    private readonly documentStore?;
    private readonly logger;
    private readonly manualFields;
    constructor(config: unknown, repoOrDeps?: SQLiteBugRepository | ApiDependencies, intake?: IntakeService, attachmentService?: unknown | undefined, queue?: QueueLike, envResolver?: EnvironmentSource);
    private makeDocumentStore;
    inject<T = unknown>(request: InjectRequest): Promise<InjectResponse<T>>;
    listen(port?: number, host?: string): Promise<number>;
    close(): Promise<void>;
    private handle;
    private optionalBody;
    private readDocument;
    private documentResponse;
    private markDocumentConflict;
    private persistGeneratedDocument;
    /** Shared chat-message pipeline used by both the JSON and the SSE endpoints. */
    private runMessagePipeline;
    /** SSE variant of the chat pipeline: stage/progress/heartbeat events, then result or error. */
    private streamMessagePipeline;
    private handleConversation;
    private submit;
    private handleBug;
    private isReady;
    private jobsFor;
    private statusFor;
    private dashboardItem;
    private detailFor;
    private artifactsFor;
    private cancelBug;
    private retryBug;
}
export {};
//# sourceMappingURL=index.d.ts.map