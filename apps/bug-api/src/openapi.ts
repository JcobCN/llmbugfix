/**
 * Hand-maintained public contract for the external task API.
 *
 * The request and response objects are intentionally described here instead
 * of being generated from the internal/domain schemas. The latter contain
 * fields which are useful to workers but must never become part of the public
 * API. This document is served verbatim from GET /openapi.json.
 */

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorRef = () => ({ $ref: '#/components/responses/ApiError' });

const PUBLIC_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
const PUBLIC_STAGES = [
  'queued',
  'preparing_environment',
  'fixing',
  'validating',
  'reviewing',
  'pushing',
  'ready',
  'human_review',
  'failed',
  'cancelled',
] as const;
const PUBLIC_EVENT_TYPES = [
  'task.created',
  'task.queued',
  'task.started',
  'task.stage_changed',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.retry_requested',
] as const;
const API_ERROR_CODES = [
  'INVALID_JSON',
  'INVALID_REQUEST',
  'MISSING_IDEMPOTENCY_KEY',
  'INVALID_IDEMPOTENCY_KEY',
  'INVALID_CURSOR',
  'TASK_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'TASK_NOT_CANCELLABLE',
  'TASK_NOT_RETRYABLE',
  'REPOSITORY_URL_INVALID',
  'REPOSITORY_HOST_NOT_ALLOWED',
  'INVALID_BASE_BRANCH',
  'QUEUE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

const NORMALIZED_CAPABILITY = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[a-z0-9][a-z0-9+._-]*$',
  description: 'A normalized capability label: lowercase ASCII, starting with a letter or digit.',
};

const TASK_RESOURCE_REQUIRED = ['taskId', 'taskKey', 'taskType', 'title', 'executionTarget', 'status', 'stage', 'createdAt', 'updatedAt', 'links'] as const;
const TASK_RESOURCE_PROPERTIES = {
  taskId: { type: 'string', format: 'uuid' },
  taskKey: { type: 'string', pattern: '^BUG-[0-9]{6,}$' },
  taskType: { type: 'string', enum: ['bugfix', 'development'] },
  // Resource titles come from persisted tasks and the response contract only
  // guarantees non-empty text (the 500-character bound is enforced on create
  // requests below).
  title: { type: 'string', minLength: 1 },
  executionTarget: { type: 'string', enum: ['frontend', 'backend'] },
  status: { type: 'string', enum: PUBLIC_STATUSES },
  stage: { type: 'string', enum: PUBLIC_STAGES },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  links: schemaRef('TaskLinks'),
};

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'LLM Bugfix Developer Gateway',
    version: '1.0.0',
    description: 'Asynchronous bugfix and development task API.',
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  paths: {
    '/api/v1/tasks': {
      post: {
        operationId: 'createTask',
        summary: 'Create an asynchronous task',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: schemaRef('ExternalTaskCreateRequest') },
          },
        },
        responses: {
          '202': {
            description: 'Task accepted. The Location header points to the task resource.',
            headers: { Location: { schema: { type: 'string', minLength: 1 } } },
            content: { 'application/json': { schema: schemaRef('ExternalTaskSubmission') } },
          },
          '400': errorRef(),
          '409': errorRef(),
          '503': errorRef(),
          default: errorRef(),
        },
      },
      get: {
        operationId: 'listTasks',
        summary: 'List tasks',
        parameters: [
          { $ref: '#/components/parameters/Status' },
          { $ref: '#/components/parameters/TaskType' },
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': { description: 'Task page', content: { 'application/json': { schema: schemaRef('ExternalTaskList') } } },
          '400': errorRef(),
          default: errorRef(),
        },
      },
    },
    '/api/v1/tasks/{taskId}': {
      get: {
        operationId: 'getTask',
        summary: 'Get a task',
        parameters: [{ $ref: '#/components/parameters/TaskId' }],
        responses: {
          '200': { description: 'Task', content: { 'application/json': { schema: schemaRef('ExternalTaskResource') } } },
          '404': errorRef(),
          default: errorRef(),
        },
      },
    },
    '/api/v1/tasks/{taskId}/events': {
      get: {
        operationId: 'listTaskEvents',
        summary: 'List task events',
        parameters: [
          { $ref: '#/components/parameters/TaskId' },
          { $ref: '#/components/parameters/After' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': { description: 'Event page', content: { 'application/json': { schema: schemaRef('ExternalTaskEventPage') } } },
          '400': errorRef(),
          '404': errorRef(),
          default: errorRef(),
        },
      },
    },
    '/api/v1/tasks/{taskId}/result': {
      get: {
        operationId: 'getTaskResult',
        summary: 'Get a completed task result',
        parameters: [{ $ref: '#/components/parameters/TaskId' }],
        responses: {
          '200': { description: 'Completed task result', content: { 'application/json': { schema: schemaRef('ExternalTaskResult') } } },
          '202': { description: 'Task is still running', content: { 'application/json': { schema: schemaRef('ExternalTaskResultPending') } } },
          '404': errorRef(),
          default: errorRef(),
        },
      },
    },
    '/api/v1/tasks/{taskId}/cancel': {
      post: {
        operationId: 'cancelTask',
        summary: 'Cancel a queued or running task',
        parameters: [{ $ref: '#/components/parameters/TaskId' }],
        responses: {
          '200': { description: 'Task cancelled', content: { 'application/json': { schema: schemaRef('ExternalTaskResource') } } },
          '404': errorRef(),
          '409': errorRef(),
          default: errorRef(),
        },
      },
    },
    '/api/v1/tasks/{taskId}/retry': {
      post: {
        operationId: 'retryTask',
        summary: 'Retry a failed task',
        parameters: [{ $ref: '#/components/parameters/TaskId' }],
        responses: {
          '202': { description: 'Retry queued', content: { 'application/json': { schema: schemaRef('ExternalTaskResource') } } },
          '404': errorRef(),
          '409': errorRef(),
          default: errorRef(),
        },
      },
    },
    '/api/v1/capabilities': {
      get: {
        operationId: 'listCapabilities',
        summary: 'List configured public capabilities',
        responses: {
          '200': { description: 'Dispatcher and backend capabilities', content: { 'application/json': { schema: schemaRef('ExternalCapabilitiesResponse') } } },
          default: errorRef(),
        },
      },
    },
  },
  components: {
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\r\\n]*$' },
        description: 'Required replay key. A key may be reused only with the same request body.',
      },
      TaskId: { name: 'taskId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      Cursor: { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
      After: { name: 'after', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
      Limit: { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      Status: { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: PUBLIC_STATUSES } },
      TaskType: { name: 'taskType', in: 'query', required: false, schema: { type: 'string', enum: ['bugfix', 'development'] } },
    },
    responses: {
      ApiError: {
        description: 'Unified API error envelope',
        content: { 'application/json': { schema: schemaRef('ExternalApiError') } },
      },
    },
    schemas: {
      ExternalTaskCreateRequest: {
        oneOf: [schemaRef('ExternalBugfixTask'), schemaRef('ExternalDevelopmentTask')],
        discriminator: {
          propertyName: 'taskType',
          mapping: {
            bugfix: '#/components/schemas/ExternalBugfixTask',
            development: '#/components/schemas/ExternalDevelopmentTask',
          },
        },
      },
      ExternalBugfixTask: {
        type: 'object',
        additionalProperties: false,
        required: ['taskType', 'title', 'executionTarget', 'repository', 'dev_env_snapshot', 'dev_env_special', 'actualBehavior', 'expectedBehavior', 'reproductionSteps'],
        properties: {
          taskType: { const: 'bugfix' },
          // zod trims this field before applying min/max; `\\S` keeps
          // whitespace-only input from being accepted by the wire schema.
          title: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          executionTarget: { type: 'string', enum: ['frontend', 'backend'] },
          repository: schemaRef('RepositoryTarget'),
          dev_env_snapshot: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S', description: 'Development environment release snapshot, for example r35.1.', examples: ['r35.1'] },
          dev_env_special: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S', description: 'Special development environment component and version, for example raw-spofer-pel v2.0.200.', examples: ['raw-spofer-pel v2.0.200'] },
          actualBehavior: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S' },
          expectedBehavior: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S' },
          reproductionSteps: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
          },
          errorMessages: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S' },
          },
          stackTraces: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S' },
          },
          environment: {
            type: 'object',
            description: 'Additional environment facts. Keys and values are intentionally opaque to the gateway.',
            additionalProperties: true,
          },
          routing: schemaRef('RoutingRequirements'),
        },
      },
      ExternalDevelopmentTask: {
        type: 'object',
        additionalProperties: false,
        required: ['taskType', 'title', 'executionTarget', 'repository', 'dev_env_snapshot', 'dev_env_special', 'objective', 'requirements', 'acceptanceCriteria'],
        properties: {
          taskType: { const: 'development' },
          title: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          executionTarget: { type: 'string', enum: ['frontend', 'backend'] },
          repository: schemaRef('RepositoryTarget'),
          dev_env_snapshot: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S', description: 'Development environment release snapshot, for example r35.1.', examples: ['r35.1'] },
          dev_env_special: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S', description: 'Special development environment component and version, for example raw-spofer-pel v2.0.200.', examples: ['raw-spofer-pel v2.0.200'] },
          objective: { type: 'string', minLength: 1, maxLength: 50_000, pattern: '\\S' },
          requirements: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
          },
          acceptanceCriteria: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
          },
          constraints: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
          },
          nonGoals: {
            type: 'array',
            maxItems: 100,
            items: { type: 'string', minLength: 1, maxLength: 10_000, pattern: '\\S' },
          },
          routing: schemaRef('RoutingRequirements'),
        },
      },
      RepositoryTarget: {
        type: 'object',
        additionalProperties: false,
        required: ['cloneUrl'],
        properties: {
          cloneUrl: {
            type: 'string',
            minLength: 1,
            maxLength: 2_048,
            // The service accepts HTTPS/HTTP, ssh://, and scp-style SSH
            // remotes. HTTP(S) credentials and local paths intentionally do
            // not match these forms (the service repeats the checks with URL
            // parsing so encoded edge cases are also rejected).
            oneOf: [
              { pattern: '^\\s*https?:\\/\\/[^\\s/@]+(?:\\/[^\\s/][^\\s]*)+\\s*$' },
              { pattern: '^\\s*ssh:\\/\\/(?:[^\\s/@:]+@)?[^\\s/@]+\\/[^\\s/][^\\s]*\\s*$' },
              { pattern: '^\\s*(?:[^@/\\\\:\\s]+@)[^/\\\\:\\s]+:[^\\s]+\\s*$' },
            ],
            description: 'HTTPS, SSH URL, or scp-style SSH Git remote. Local paths and embedded credentials are rejected by the service.',
          },
          baseBranch: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            // Mirrors isValidGitBranchName in api-contract, including the
            // component checks performed by git check-ref-format. `]` is
            // deliberately allowed; only `[` is in the runtime deny-list.
            pattern: '^(?!@$)(?!-)(?![\\s\\S]*\\.\\.)(?![\\s\\S]*@\\{)(?!\\/)(?![\\s\\S]*\\/$)(?![\\s\\S]*\\/\\/)(?![\\s\\S]*\\.$)(?![\\s\\S]*(?:^|\\/)\\.)(?![\\s\\S]*(?:^|\\/)[^/]*\\.lock(?:\\/|$))(?![\\s\\S]*[\\u0000-\\u0020\\u007f~^:?*\\[\\\\])[\\s\\S]+$',
            default: 'main',
          },
        },
      },
      RoutingRequirements: {
        type: 'object',
        additionalProperties: false,
        properties: {
          priority: { type: 'string', enum: ['high', 'normal', 'low'], default: 'normal' },
          capabilityHints: {
            type: 'array',
            maxItems: 16,
            default: [],
            items: NORMALIZED_CAPABILITY,
          },
          quality: { type: 'string', enum: ['standard', 'high'], default: 'standard' },
        },
        default: { priority: 'normal', capabilityHints: [], quality: 'standard' },
      },

      // Keep the resource and submission schemas self-contained. In
      // particular, composing a closed resource with allOf would make the
      // resource's additionalProperties:false reject idempotent before the
      // submission branch can evaluate it.
      ExternalTaskResource: {
        type: 'object',
        additionalProperties: false,
        required: TASK_RESOURCE_REQUIRED,
        properties: TASK_RESOURCE_PROPERTIES,
      },
      ExternalTaskSubmission: {
        type: 'object',
        additionalProperties: false,
        required: [...TASK_RESOURCE_REQUIRED, 'idempotent'],
        properties: { ...TASK_RESOURCE_PROPERTIES, idempotent: { type: 'boolean' } },
      },
      TaskLinks: {
        type: 'object',
        additionalProperties: false,
        required: ['self', 'events', 'result'],
        properties: {
          self: { type: 'string', minLength: 1 },
          events: { type: 'string', minLength: 1 },
          result: { type: 'string', minLength: 1 },
        },
      },
      ExternalTaskList: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'nextCursor', 'hasMore'],
        properties: {
          data: { type: 'array', items: schemaRef('ExternalTaskResource') },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
      },
      ExternalTaskEvent: {
        type: 'object',
        additionalProperties: false,
        required: ['eventId', 'sequence', 'taskId', 'type', 'status', 'stage', 'occurredAt', 'data'],
        properties: {
          eventId: { type: 'string', format: 'uuid' },
          sequence: { type: 'integer', minimum: 0 },
          taskId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: PUBLIC_EVENT_TYPES },
          status: { type: 'string', enum: PUBLIC_STATUSES },
          stage: { type: 'string', enum: PUBLIC_STAGES },
          occurredAt: { type: 'string', format: 'date-time' },
          data: { type: 'object', additionalProperties: true },
        },
      },
      ExternalTaskEventPage: {
        type: 'object',
        additionalProperties: false,
        required: ['data', 'nextAfter', 'hasMore'],
        properties: {
          data: { type: 'array', items: schemaRef('ExternalTaskEvent') },
          nextAfter: { type: ['integer', 'null'], minimum: 0 },
          hasMore: { type: 'boolean' },
        },
      },

      ExternalFixSummary: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'confidence', 'summary', 'filesChanged', 'riskNotes'],
        properties: {
          status: { type: 'string', enum: ['fixed', 'blocked', 'not_reproducible', 'failed', 'completed'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          summary: { type: 'string', maxLength: 8_000 },
          rootCause: { type: ['string', 'null'], maxLength: 8_000 },
          filesChanged: { type: 'array', items: { type: 'string', maxLength: 500 } },
          riskNotes: { type: 'array', items: { type: 'string', maxLength: 2_000 } },
        },
      },
      ExternalValidationResult: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'exitCode', 'passed', 'output'],
        properties: {
          command: { type: 'string', maxLength: 500 },
          exitCode: { type: 'integer' },
          passed: { type: 'boolean' },
          output: { type: 'string', maxLength: 8_000 },
        },
      },
      ExternalValidationSummary: {
        type: 'object',
        additionalProperties: false,
        required: ['passed', 'summary', 'commands', 'results'],
        properties: {
          passed: { type: 'boolean' },
          summary: { type: 'string', maxLength: 8_000 },
          commands: { type: 'array', items: { type: 'string', maxLength: 500 } },
          results: { type: 'array', items: schemaRef('ExternalValidationResult') },
        },
      },
      ExternalReviewSummary: {
        type: 'object',
        additionalProperties: false,
        required: ['verdict', 'addressed', 'regressionRisk', 'summary', 'findings'],
        properties: {
          verdict: { type: 'string', enum: ['approve', 'reject'] },
          addressed: { type: 'boolean' },
          regressionRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
          summary: { type: 'string', maxLength: 8_000 },
          findings: { type: 'array', items: { type: 'string', maxLength: 2_000 } },
        },
      },
      PatchDelivery: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'pushed', 'branch', 'commitSha', 'diff'],
        properties: {
          type: { const: 'patch' },
          pushed: { const: false },
          branch: { type: 'null' },
          commitSha: { type: 'null' },
          diff: { type: ['string', 'null'], maxLength: 200_000 },
        },
      },
      GitBranchDelivery: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'pushed', 'branch', 'commitSha', 'diff'],
        properties: {
          type: { const: 'git_branch' },
          pushed: { const: true },
          branch: { type: 'string', minLength: 1, maxLength: 255 },
          commitSha: { type: 'string', pattern: '^[A-Fa-f0-9]{7,64}$' },
          diff: { type: ['string', 'null'], maxLength: 200_000 },
        },
      },
      ExternalDelivery: { oneOf: [schemaRef('PatchDelivery'), schemaRef('GitBranchDelivery')] },
      ExternalTaskFailure: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 100 },
          message: { type: 'string', minLength: 1, maxLength: 8_000 },
        },
      },
      ExternalTaskResult: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'status', 'completedAt', 'fix', 'validation', 'review', 'delivery', 'error'],
        properties: {
          taskId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['succeeded', 'failed', 'cancelled'] },
          completedAt: { type: 'string', format: 'date-time' },
          fix: { anyOf: [schemaRef('ExternalFixSummary'), { type: 'null' }] },
          validation: { anyOf: [schemaRef('ExternalValidationSummary'), { type: 'null' }] },
          review: { anyOf: [schemaRef('ExternalReviewSummary'), { type: 'null' }] },
          delivery: { anyOf: [schemaRef('ExternalDelivery'), { type: 'null' }] },
          error: { anyOf: [schemaRef('ExternalTaskFailure'), { type: 'null' }] },
        },
      },
      ExternalTaskResultPending: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'result'],
        properties: {
          task: schemaRef('ExternalTaskResource'),
          result: { type: 'null' },
        },
      },

      ExternalBackendHealth: {
        type: 'object',
        additionalProperties: false,
        required: ['backendId', 'status', 'consecutiveFailures', 'openedAt', 'retryAt', 'inFlight'],
        properties: {
          backendId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          status: { type: 'string', enum: ['closed', 'open', 'half_open'] },
          consecutiveFailures: { type: 'integer', minimum: 0 },
          openedAt: { type: ['string', 'null'], format: 'date-time' },
          retryAt: { type: ['string', 'null'], format: 'date-time' },
          inFlight: { type: 'integer', minimum: 0 },
        },
      },
      ExternalCapability: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'roles', 'taskTypes', 'targets', 'capabilities', 'qualityTiers', 'maxConcurrency', 'enabled', 'draining', 'status'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          roles: { type: 'array', minItems: 1, items: { type: 'string', enum: ['intake', 'fixer', 'reviewer'] } },
          taskTypes: { type: 'array', minItems: 1, items: { type: 'string', enum: ['bugfix', 'development'] } },
          targets: { type: 'array', minItems: 1, items: { type: 'string', enum: ['frontend', 'backend'] } },
          capabilities: { type: 'array', maxItems: 128, items: NORMALIZED_CAPABILITY },
          qualityTiers: { type: 'array', minItems: 1, items: { type: 'string', enum: ['standard', 'high'] } },
          maxConcurrency: { type: 'integer', minimum: 1 },
          enabled: { type: 'boolean' },
          draining: { type: 'boolean' },
          status: { type: 'string', enum: ['closed', 'open', 'half_open'] },
        },
      },
      ExternalDispatcher: {
        type: 'object',
        additionalProperties: false,
        required: ['loaded', 'backendCount', 'health'],
        properties: {
          loaded: { type: 'boolean' },
          backendCount: { type: 'integer', minimum: 0 },
          health: { type: 'array', items: schemaRef('ExternalBackendHealth') },
        },
      },
      ExternalCapabilitiesResponse: {
        type: 'object',
        additionalProperties: false,
        required: ['capabilities'],
        properties: {
          dispatcher: schemaRef('ExternalDispatcher'),
          capabilities: { type: 'array', items: schemaRef('ExternalCapability') },
        },
      },
      ExternalApiError: {
        type: 'object',
        additionalProperties: false,
        required: ['error', 'requestId'],
        properties: {
          error: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', enum: API_ERROR_CODES },
              message: { type: 'string', minLength: 1, maxLength: 8_000 },
              details: { type: 'object', additionalProperties: true },
            },
          },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
    },
  },
} as const;

export const openapiDocument = OPENAPI_DOCUMENT;
export const getOpenApiDocument = (): typeof OPENAPI_DOCUMENT => OPENAPI_DOCUMENT;
