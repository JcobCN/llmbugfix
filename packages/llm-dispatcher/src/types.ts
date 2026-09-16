import { z } from 'zod';
import {
  ExternalExecutionTargetSchema,
  ExternalTaskTypeSchema,
  QualityTierSchema,
  ResourceIdSchema,
  RoutingRequirementsSchema,
  type ExternalExecutionTarget,
  type ExternalTaskType,
  type QualityTier,
  type RoutingRequirements,
} from '@llmbugfix/api-contract';

export {
  RoutingRequirementsSchema,
  type RoutingRequirements,
  ExternalExecutionTargetSchema,
  ExternalTaskTypeSchema,
  QualityTierSchema,
};
export type { ExternalExecutionTarget, ExternalTaskType, QualityTier };

export const BackendRoleSchema = z.enum(['intake', 'fixer', 'reviewer']);
export type BackendRole = z.infer<typeof BackendRoleSchema>;

export const BackendHealthStatusSchema = z.enum(['closed', 'open', 'half_open']);
export type BackendHealthStatus = z.infer<typeof BackendHealthStatusSchema>;

export const BackendFailureClassSchema = z.enum([
  'connection',
  'tls',
  'timeout',
  'http_408',
  'http_429',
  'http_5xx',
  'http_4xx',
  'authentication',
  'contract',
  'cancelled',
  'agent_failed',
  'no_diff',
  'validation_failed',
  'review_rejected',
  'unknown',
]);
export type BackendFailureClass = z.infer<typeof BackendFailureClassSchema>;

export const InfrastructureFailureClassSchema = z.enum([
  'connection',
  'tls',
  'timeout',
  'http_408',
  'http_429',
  'http_5xx',
]);
export type InfrastructureFailureClass = z.infer<typeof InfrastructureFailureClassSchema>;

export function isInfrastructureFailureClass(value: BackendFailureClass): value is InfrastructureFailureClass {
  return InfrastructureFailureClassSchema.safeParse(value).success;
}

const backendId = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u);
const positiveInteger = z.number().int().positive();
const positiveNumber = z.number().positive().finite();
const capability = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9+._-]*$/u);

export const LlmBackendConfigSchema = z.object({
  id: backendId,
  endpointUrl: z.string().url().refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'endpointUrl must use http or https'),
  model: z.string().trim().min(1).max(256),
  apiKeyEnv: z.string().trim().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u).optional(),
  roles: z.array(BackendRoleSchema).min(1),
  taskTypes: z.array(ExternalTaskTypeSchema).min(1),
  targets: z.array(ExternalExecutionTargetSchema).min(1),
  capabilities: z.array(capability).max(128).default([]),
  qualityTiers: z.array(QualityTierSchema).min(1),
  maxConcurrency: positiveInteger,
  weight: positiveNumber.default(1),
  enabled: z.boolean().default(true),
  /** A draining backend finishes existing sessions but receives no new work. */
  draining: z.boolean().default(false),
  fixerTimeoutMs: positiveInteger.optional(),
  reviewerTimeoutMs: positiveInteger.optional(),
}).strict();
export type LlmBackendConfig = z.infer<typeof LlmBackendConfigSchema>;

export const BackendRegistryConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({ intakeBackendId: backendId.optional() }).strict().default({}),
  backends: z.array(LlmBackendConfigSchema).min(1),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, backend] of value.backends.entries()) {
    if (ids.has(backend.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['backends', index, 'id'], message: `Duplicate backend id: ${backend.id}` });
    ids.add(backend.id);
  }
  const defaultId = value.defaults.intakeBackendId;
  if (defaultId && !ids.has(defaultId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['defaults', 'intakeBackendId'], message: `Unknown intake backend: ${defaultId}` });
});
export type BackendRegistryConfig = z.infer<typeof BackendRegistryConfigSchema>;

export const BackendLeaseSchema = z.object({
  leaseId: ResourceIdSchema,
  backendId,
  model: z.string().trim().min(1).max(256),
  role: BackendRoleSchema,
  taskId: ResourceIdSchema.nullable().optional(),
  jobId: ResourceIdSchema.nullable().optional(),
  acquiredAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
export type BackendLease = z.infer<typeof BackendLeaseSchema>;

export const BackendHealthSchema = z.object({
  backendId,
  status: BackendHealthStatusSchema,
  consecutiveFailures: z.number().int().nonnegative(),
  openedAt: z.string().datetime({ offset: true }).nullable(),
  retryAt: z.string().datetime({ offset: true }).nullable(),
  inFlight: z.number().int().nonnegative(),
}).strict();
export type BackendHealth = z.infer<typeof BackendHealthSchema>;

export const BackendRouteRequestSchema = z.object({
  role: BackendRoleSchema,
  taskType: ExternalTaskTypeSchema,
  executionTarget: ExternalExecutionTargetSchema,
  requirements: RoutingRequirementsSchema,
  excludeBackendIds: z.array(backendId).max(2).default([]),
}).strict();
export type BackendRouteRequest = z.infer<typeof BackendRouteRequestSchema>;

export const backendFailureClassSchema = BackendFailureClassSchema;
export const llmBackendConfigSchema = LlmBackendConfigSchema;
export const backendLeaseSchema = BackendLeaseSchema;
