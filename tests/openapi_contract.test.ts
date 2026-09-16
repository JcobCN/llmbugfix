import { describe, expect, it } from 'vitest';
import { newId } from '@llmbugfix/shared';
import { ExternalTaskCreateRequestSchema, RepositoryTargetSchema } from '@llmbugfix/api-contract';
import { V1Routes } from '../apps/bug-api/src/v1-routes.js';
import { openapiDocument } from '../apps/bug-api/src/openapi.js';

type Schema = Record<string, any>;
type ValidationResult = { errors: string[]; evaluated: Set<string> };

const schemas = (): Record<string, Schema> => openapiDocument.components.schemas as unknown as Record<string, Schema>;

function resolveSchema(value: Schema): Schema {
  if (typeof value.$ref !== 'string') return value;
  const match = value.$ref.match(/^#\/components\/schemas\/([^/]+)$/u);
  if (!match) throw new Error(`Unsupported schema reference: ${value.$ref}`);
  const resolved = schemas()[match[1]];
  if (!resolved) throw new Error(`Unknown schema reference: ${value.$ref}`);
  return resolved;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A small JSON Schema 2020-12 assertion helper for this contract test. It
 * deliberately exercises refs, oneOf/anyOf, strict objects, const/enum,
 * scalar/array limits, patterns, and formats instead of merely inspecting
 * that a route name occurs in the OpenAPI document.
 */
function validate(input: Schema, value: unknown, path = '$'): string[] {
  return validateWithAnnotations(input, value, path).errors;
}

function validateWithAnnotations(input: Schema, value: unknown, path: string): ValidationResult {
  const schema = resolveSchema(input);
  const errors: string[] = [];
  const evaluated = new Set<string>();
  const type = schema.type;
  const matchesType = (candidate: unknown, expected: string): boolean => {
    if (expected === 'null') return candidate === null;
    if (expected === 'object') return isObject(candidate);
    if (expected === 'array') return Array.isArray(candidate);
    if (expected === 'string') return typeof candidate === 'string';
    if (expected === 'boolean') return typeof candidate === 'boolean';
    if (expected === 'integer') return typeof candidate === 'number' && Number.isInteger(candidate);
    if (expected === 'number') return typeof candidate === 'number' && Number.isFinite(candidate);
    return true;
  };

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch: Schema) => validateWithAnnotations(branch, value, path));
    const valid = branches.filter((branch: ValidationResult) => branch.errors.length === 0);
    if (valid.length !== 1) errors.push(`${path} must match exactly one oneOf branch (matched ${valid.length})`);
    else valid[0].evaluated.forEach((key) => evaluated.add(key));
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch: Schema) => validateWithAnnotations(branch, value, path));
    const valid = branches.filter((branch: ValidationResult) => branch.errors.length === 0);
    if (valid.length === 0) errors.push(`${path} must match at least one anyOf branch`);
    else valid.forEach((branch: ValidationResult) => branch.evaluated.forEach((key) => evaluated.add(key)));
  }
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const result = validateWithAnnotations(branch, value, path);
      errors.push(...result.errors);
      result.evaluated.forEach((key) => evaluated.add(key));
    }
  }

  if (schema.const !== undefined && !Object.is(schema.const, value)) errors.push(`${path} must equal ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry: unknown) => Object.is(entry, value))) errors.push(`${path} is not an allowed enum value`);

  if (type !== undefined) {
    const expected = Array.isArray(type) ? type : [type];
    if (!expected.some((entry: string) => matchesType(value, entry))) {
      errors.push(`${path} has the wrong type`);
      return { errors, evaluated };
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path} is shorter than minLength`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path} is longer than maxLength`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} does not match pattern`);
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) errors.push(`${path} is not a UUID`);
    if (schema.format === 'date-time' && (!value.includes('T') || Number.isNaN(Date.parse(value)))) errors.push(`${path} is not a date-time`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path} is below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path} is above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((entry, index) => errors.push(...validateWithAnnotations(schema.items, entry, `${path}[${index}]`).errors));
  }
  if (isObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const name of required) if (!(name in value)) errors.push(`${path} is missing ${name}`);
    const properties = isObject(schema.properties) ? schema.properties as Record<string, Schema> : {};
    for (const [name, child] of Object.entries(properties)) {
      if (name in value) {
        evaluated.add(name);
        errors.push(...validateWithAnnotations(child, value[name], `${path}.${name}`).errors);
      }
    }
    const unknown = Object.keys(value).filter((name) => !evaluated.has(name));
    if (schema.additionalProperties === false && unknown.length) errors.push(`${path} contains unknown properties: ${unknown.join(', ')}`);
    if (isObject(schema.additionalProperties)) for (const name of unknown) errors.push(...validateWithAnnotations(schema.additionalProperties, value[name], `${path}.${name}`).errors);
    // This is included for schemas using the OpenAPI 3.1 / JSON Schema
    // 2020-12 composition boundary, even though the current submission
    // schema is self-contained for broad validator compatibility.
    if (schema.unevaluatedProperties === false && unknown.length) errors.push(`${path} contains unevaluated properties: ${unknown.join(', ')}`);
  }
  return { errors, evaluated };
}

function assertValid(schemaName: string, payload: unknown): void {
  const errors = validate(schemas()[schemaName], payload);
  expect(errors, `${schemaName} validation failed: ${errors.join('; ')}`).toEqual([]);
}

const taskId = newId();
const eventId = newId();

function routeFixture(status: 'QUEUED' | 'FIX_READY' = 'FIX_READY', withCapabilities = false): V1Routes {
  let bug: Record<string, unknown> = {
    id: taskId,
    bugKey: 'BUG-000123',
    taskType: 'bugfix',
    title: 'Broken login',
    executionTarget: 'frontend',
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const result = {
    taskId,
    status: 'succeeded',
    completedAt: '2026-01-01T00:00:00.000Z',
    fix: {
      status: 'fixed',
      confidence: 0.95,
      summary: 'The login handler now redirects after authentication.',
      rootCause: null,
      filesChanged: ['src/login.ts'],
      riskNotes: ['Authentication flow changed.'],
    },
    validation: {
      passed: true,
      summary: 'Targeted tests passed.',
      commands: ['pnpm test --filter login'],
      results: [{ command: 'pnpm test --filter login', exitCode: 0, passed: true, output: '1 test passed' }],
    },
    review: {
      verdict: 'approve',
      addressed: true,
      regressionRisk: 'low',
      summary: 'Reviewed the focused patch.',
      findings: [],
    },
    delivery: { type: 'patch', pushed: false, branch: null, commitSha: null, diff: '@@ login @@' },
    error: null,
  };
  const repo = {
    getBug: () => bug,
    listBugs: () => [bug],
    createExternalTask: (input: unknown) => {
      const request = (input as { request?: { taskType?: string } }).request;
      bug = { ...bug, taskType: request?.taskType ?? bug.taskType };
      return { taskId, status };
    },
    listTaskEvents: () => [{ eventId, sequence: 1, taskId, type: 'task.stage_changed', status: 'succeeded', stage: 'ready', occurredAt: '2026-01-01T00:00:00.000Z', data: { source: 'worker' } }],
    getTaskResult: () => result,
  } as never;
  return new V1Routes({
    repo,
    ...(withCapabilities ? {
      capabilities: () => ({
        dispatcher: {
          loaded: true,
          backendCount: 1,
          health: [{ backendId: 'primary', status: 'closed', consecutiveFailures: 0, openedAt: null, retryAt: null, inFlight: 0 }],
        },
        capabilities: [{
          id: 'primary',
          roles: ['intake', 'fixer', 'reviewer'],
          taskTypes: ['bugfix', 'development'],
          targets: ['frontend', 'backend'],
          capabilities: ['typescript', 'react.ui'],
          qualityTiers: ['standard', 'high'],
          maxConcurrency: 2,
          enabled: true,
          draining: false,
          status: 'closed',
        }],
      }),
    } : {}),
  });
}

const request = (method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) => ({
  method,
  pathname,
  query: new URLSearchParams(),
  headers,
  body,
});

describe('external REST API OpenAPI contract', () => {
  it('declares OpenAPI 3.1, every v1 route, and response schemas', () => {
    expect(openapiDocument.openapi).toBe('3.1.0');
    expect(openapiDocument.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(openapiDocument.paths).toEqual(expect.objectContaining({
      '/api/v1/tasks': expect.any(Object),
      '/api/v1/tasks/{taskId}': expect.any(Object),
      '/api/v1/tasks/{taskId}/events': expect.any(Object),
      '/api/v1/tasks/{taskId}/result': expect.any(Object),
      '/api/v1/tasks/{taskId}/cancel': expect.any(Object),
      '/api/v1/tasks/{taskId}/retry': expect.any(Object),
      '/api/v1/capabilities': expect.any(Object),
    }));
    expect((openapiDocument.paths['/api/v1/tasks'].post?.responses['202'] as any).content['application/json'].schema.$ref).toBe('#/components/schemas/ExternalTaskSubmission');
    expect((openapiDocument.paths['/api/v1/tasks/{taskId}/result'].get?.responses['200'] as any).content['application/json'].schema.$ref).toBe('#/components/schemas/ExternalTaskResult');
    expect((openapiDocument.paths['/api/v1/capabilities'].get?.responses['200'] as any).content['application/json'].schema.$ref).toBe('#/components/schemas/ExternalCapabilitiesResponse');
  });

  it('documents strict bugfix/development input variants and their bounds', () => {
    const bugfix = schemas().ExternalBugfixTask;
    const development = schemas().ExternalDevelopmentTask;
    expect(bugfix.required).toEqual(['taskType', 'title', 'executionTarget', 'repository', 'actualBehavior', 'expectedBehavior', 'reproductionSteps']);
    expect(development.required).toEqual(['taskType', 'title', 'executionTarget', 'repository', 'objective', 'requirements', 'acceptanceCriteria']);
    expect(Object.keys(bugfix.properties)).toEqual(expect.arrayContaining(['errorMessages', 'stackTraces', 'environment', 'routing']));
    expect(Object.keys(development.properties)).toEqual(expect.arrayContaining(['constraints', 'nonGoals', 'routing']));
    expect(bugfix.properties.reproductionSteps).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(development.properties.requirements).toMatchObject({ minItems: 1, maxItems: 100 });
    expect(development.properties.constraints).toMatchObject({ maxItems: 100 });
    expect(schemas().RoutingRequirements.properties.capabilityHints).toMatchObject({ maxItems: 16 });
    expect(schemas().RoutingRequirements.properties.capabilityHints.items).toMatchObject({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9+._-]*$' });
    expect(schemas().RepositoryTarget.properties.cloneUrl).toMatchObject({ minLength: 1, maxLength: 2048 });
    expect(schemas().RepositoryTarget.properties.baseBranch).toMatchObject({ minLength: 1, maxLength: 255 });
    expect(schemas().ExternalApiError.properties.error.properties.code.enum).toEqual(expect.arrayContaining(['INVALID_JSON', 'IDEMPOTENCY_CONFLICT', 'QUEUE_UNAVAILABLE', 'INTERNAL_ERROR']));
  });

  it('keeps repository URL and Git branch valid/invalid cases aligned with Zod', () => {
    const repositoryCases: Array<{ name: string; value: { cloneUrl: string; baseBranch?: string }; valid: boolean }> = [
      { name: 'https URL', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'main' }, valid: true },
      { name: 'ssh URL with user and port', value: { cloneUrl: ' ssh://git@git.example.test:2222/team/project.git ', baseBranch: 'feature/api' }, valid: true },
      { name: 'scp URL with required user', value: { cloneUrl: 'git@git.example.test:team/project.git', baseBranch: '@foo' }, valid: true },
      { name: 'scp URL without user', value: { cloneUrl: 'git.example.test:team/project.git', baseBranch: 'component]name' }, valid: false },
      { name: 'URL over 2048 characters', value: { cloneUrl: `https://git.example.test/${'a'.repeat(2040)}`, baseBranch: 'main' }, valid: false },
      { name: 'ssh password', value: { cloneUrl: 'ssh://git:secret@git.example.test/team/project.git', baseBranch: 'foo.locked' }, valid: false },
      { name: 'https credentials', value: { cloneUrl: 'https://user:secret@git.example.test/team/project.git', baseBranch: 'foo.lock/bar.locked' }, valid: false },
      { name: 'local path', value: { cloneUrl: './project', baseBranch: 'foo.lock/bar' }, valid: false },
      { name: 'URL without repository path', value: { cloneUrl: 'https://git.example.test', baseBranch: 'foo/bar.lock' }, valid: false },
      { name: 'single at sign', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: '@' }, valid: false },
      { name: 'leading dash', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: '-main' }, valid: false },
      { name: 'double dot', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'a..b' }, valid: false },
      { name: 'revision expression', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'a@{b' }, valid: false },
      { name: 'leading slash', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: '/main' }, valid: false },
      { name: 'trailing slash', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'main/' }, valid: false },
      { name: 'double slash', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'a//b' }, valid: false },
      { name: 'trailing dot', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'a.' }, valid: false },
      { name: 'leading dot component', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: '.hidden' }, valid: false },
      { name: 'hidden path component', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'component/.hidden' }, valid: false },
      { name: 'lock path component', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'foo.lock/bar' }, valid: false },
      { name: 'lock final component', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'foo/bar.lock' }, valid: false },
      { name: 'DEL byte', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'foo\u007fbar' }, valid: false },
      { name: 'newline byte', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'foo\n' }, valid: false },
      { name: 'left bracket', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'foo[bar' }, valid: false },
      { name: 'right bracket remains legal', value: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'foo]bar' }, valid: true },
    ];
    for (const testCase of repositoryCases) {
      const zodValid = RepositoryTargetSchema.safeParse(testCase.value).success;
      const openApiValid = validate(schemas().RepositoryTarget, testCase.value).length === 0;
      expect(zodValid, `${testCase.name}: Zod result`).toBe(testCase.valid);
      expect(openApiValid, `${testCase.name}: OpenAPI result`).toBe(testCase.valid);
    }
  });

  it('rejects whitespace-only trimmed fields in both runtime and OpenAPI task contracts', () => {
    const bugfix = {
      taskType: 'bugfix',
      title: 'A login bug',
      executionTarget: 'frontend',
      repository: { cloneUrl: 'https://git.example.test/team/project.git' },
      actualBehavior: 'The button is inert',
      expectedBehavior: 'The button submits',
      reproductionSteps: ['Open the page'],
      errorMessages: ['TypeError'],
      stackTraces: ['at submit'],
    };
    const development = {
      taskType: 'development',
      title: 'Add export',
      executionTarget: 'backend',
      repository: { cloneUrl: 'git@git.example.test:team/project.git' },
      objective: 'Export rows',
      requirements: ['Keep current filters'],
      acceptanceCriteria: ['The CSV opens'],
      constraints: ['Keep JSON API'],
      nonGoals: ['Formatting'],
    };
    const taskCases: Array<{ name: string; payload: Record<string, unknown>; valid: boolean }> = [
      { name: 'bugfix baseline', payload: bugfix, valid: true },
      { name: 'development baseline', payload: development, valid: true },
      { name: 'bugfix title', payload: { ...bugfix, title: ' \t ' }, valid: false },
      { name: 'bugfix actualBehavior', payload: { ...bugfix, actualBehavior: '  ' }, valid: false },
      { name: 'bugfix expectedBehavior', payload: { ...bugfix, expectedBehavior: '\n\t' }, valid: false },
      { name: 'bugfix reproduction item', payload: { ...bugfix, reproductionSteps: ['  '] }, valid: false },
      { name: 'bugfix error item', payload: { ...bugfix, errorMessages: ['\t'] }, valid: false },
      { name: 'bugfix stack item', payload: { ...bugfix, stackTraces: ['\n'] }, valid: false },
      { name: 'development title', payload: { ...development, title: '  ' }, valid: false },
      { name: 'development objective', payload: { ...development, objective: '\t\n' }, valid: false },
      { name: 'development requirement item', payload: { ...development, requirements: ['  '] }, valid: false },
      { name: 'development acceptance item', payload: { ...development, acceptanceCriteria: ['\n'] }, valid: false },
      { name: 'development constraint item', payload: { ...development, constraints: ['\t'] }, valid: false },
      { name: 'development non-goal item', payload: { ...development, nonGoals: ['  '] }, valid: false },
    ];
    for (const testCase of taskCases) {
      const zodValid = ExternalTaskCreateRequestSchema.safeParse(testCase.payload).success;
      const openApiValid = validate(schemas().ExternalTaskCreateRequest, testCase.payload).length === 0;
      expect(zodValid, `${testCase.name}: Zod result`).toBe(testCase.valid);
      expect(openApiValid, `${testCase.name}: OpenAPI result`).toBe(testCase.valid);
    }
  });

  it('validates representative real bugfix and development requests and responses with OpenAPI schemas', async () => {
    const bugfixRequest = {
      taskType: 'bugfix',
      title: 'Broken login',
      executionTarget: 'frontend',
      repository: { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'main' },
      actualBehavior: 'Clicking login does nothing.',
      expectedBehavior: 'The user reaches the home page.',
      reproductionSteps: ['Open login', 'Click the button'],
      errorMessages: ['TypeError: handler is undefined'],
      stackTraces: ['at submit (src/login.ts:10:2)'],
      environment: { browser: 'Chromium', version: 1 },
      routing: { priority: 'high', capabilityHints: ['typescript', 'react.ui'], quality: 'high' },
    };
    assertValid('ExternalTaskCreateRequest', bugfixRequest);
    const api = routeFixture();
    const accepted = await api.handle(request('POST', '/api/v1/tasks', bugfixRequest, { 'Idempotency-Key': 'contract-bugfix-1' }));
    expect(accepted?.status).toBe(202);
    assertValid('ExternalTaskSubmission', accepted?.body);
    const task = await api.handle(request('GET', `/api/v1/tasks/${taskId}`));
    assertValid('ExternalTaskResource', task?.body);
    const list = await api.handle(request('GET', '/api/v1/tasks'));
    assertValid('ExternalTaskList', list?.body);
    const events = await api.handle(request('GET', `/api/v1/tasks/${taskId}/events`));
    assertValid('ExternalTaskEventPage', events?.body);
    const completedResult = await api.handle(request('GET', `/api/v1/tasks/${taskId}/result`));
    assertValid('ExternalTaskResult', completedResult?.body);

    const developmentRequest = {
      taskType: 'development',
      title: 'Add CSV export',
      executionTarget: 'backend',
      repository: { cloneUrl: 'git@git.example.test:team/project.git' },
      objective: 'Export filtered rows as CSV.',
      requirements: ['Preserve the current filters'],
      acceptanceCriteria: ['The downloaded file is valid CSV'],
      constraints: ['Do not change the existing JSON endpoint'],
      nonGoals: ['No spreadsheet formatting'],
      routing: { priority: 'normal', capabilityHints: ['typescript'], quality: 'standard' },
    };
    assertValid('ExternalTaskCreateRequest', developmentRequest);
    const developmentAccepted = await routeFixture().handle(request('POST', '/api/v1/tasks', developmentRequest, { 'Idempotency-Key': 'contract-development-1' }));
    expect(developmentAccepted?.status).toBe(202);
    assertValid('ExternalTaskSubmission', developmentAccepted?.body);
  });

  it('validates pending results, configured capabilities, and the unified error envelope', async () => {
    const pending = await routeFixture('QUEUED').handle(request('GET', `/api/v1/tasks/${taskId}/result`));
    expect(pending?.status).toBe(202);
    assertValid('ExternalTaskResultPending', pending?.body);

    const capabilities = await routeFixture('QUEUED', true).handle(request('GET', '/api/v1/capabilities'));
    assertValid('ExternalCapabilitiesResponse', capabilities?.body);

    const error = await routeFixture().handle(request('POST', '/api/v1/tasks', { taskType: 'bugfix' }));
    expect(error?.status).toBe(400);
    assertValid('ExternalApiError', error?.body);
    expect((error?.body as { error: { code: string } }).error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('closes task submission independently so idempotent is legal and unknown fields remain illegal', () => {
    const submission = schemas().ExternalTaskSubmission;
    expect(submission.allOf).toBeUndefined();
    expect(submission.additionalProperties).toBe(false);
    expect(submission.required).toContain('idempotent');
    const resource = {
      taskId,
      taskKey: 'BUG-000123',
      taskType: 'bugfix',
      title: 'Broken login',
      executionTarget: 'frontend',
      status: 'queued',
      stage: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      links: { self: `/api/v1/tasks/${taskId}`, events: `/api/v1/tasks/${taskId}/events`, result: `/api/v1/tasks/${taskId}/result` },
      idempotent: true,
    };
    expect(validate(submission, resource)).toEqual([]);
    expect(validate(submission, { ...resource, unexpected: true })).not.toEqual([]);
    expect(validate(schemas().RoutingRequirements, { capabilityHints: ['React UI'] })).not.toEqual([]);
  });
});
