import { describe, expect, it } from 'vitest';
import {
  ExternalApiErrorSchema,
  ExternalTaskCreateRequestSchema,
  ExternalTaskEventSchema,
  RepositoryTargetSchema,
  RoutingRequirementsSchema,
} from './index.js';

const repository = { cloneUrl: 'https://git.example.test/team/project.git', baseBranch: 'main' };

describe('external API contracts', () => {
  it('accepts both strict task variants and applies routing defaults', () => {
    const bugfix = ExternalTaskCreateRequestSchema.parse({
      taskType: 'bugfix',
      title: 'Fix login',
      executionTarget: 'frontend',
      repository,
      actualBehavior: 'The button does nothing',
      expectedBehavior: 'The user reaches the home page',
      reproductionSteps: ['Open login', 'Click the button'],
    });
    expect(bugfix.routing).toEqual({ priority: 'normal', capabilityHints: [], quality: 'standard' });

    const development = ExternalTaskCreateRequestSchema.parse({
      taskType: 'development',
      title: 'Add CSV export',
      executionTarget: 'backend',
      repository,
      objective: 'Export filtered rows',
      requirements: ['Keep the current filters'],
      acceptanceCriteria: ['The downloaded file is valid CSV'],
    });
    expect(development.taskType).toBe('development');
  });

  it('rejects unknown fields, invalid capabilities, and repository credentials', () => {
    expect(() => ExternalTaskCreateRequestSchema.parse({
      taskType: 'development',
      title: 'Export',
      executionTarget: 'frontend',
      repository,
      objective: 'Export rows',
      requirements: ['CSV'],
      acceptanceCriteria: ['Downloads'],
      backendId: 'secret-model',
    })).toThrow();
    expect(() => RepositoryTargetSchema.parse({ cloneUrl: 'https://token@git.example.test/team/project.git' })).toThrow();
    expect(() => RoutingRequirementsSchema.parse({ capabilityHints: ['React UI'] })).toThrow();
    expect(() => RepositoryTargetSchema.parse({ cloneUrl: 'https://token:secret@git.example.test/team/project.git' })).toThrow();
    expect(() => RepositoryTargetSchema.parse({ cloneUrl: '/tmp/project' })).toThrow();
  });

  it('accepts HTTP, HTTPS, SSH, and scp-style Git remotes', () => {
    for (const cloneUrl of [
      'https://git.example.test/team/project.git',
      'http://git.example.test/team/project.git',
      'ssh://git@git.example.test/team/project.git',
      'git@git.example.test:team/project.git',
    ]) {
      expect(RepositoryTargetSchema.parse({ cloneUrl }).cloneUrl).toBe(cloneUrl);
    }
  });

  it('rejects local paths, credentials, and unsupported or ambiguous remotes', () => {
    for (const cloneUrl of [
      'ftp://git.example.test/team/project.git',
      'file:///tmp/project',
      'https:git.example.test/team/project.git',
      'git.example.test:team/project.git',
      'C:project',
    ]) {
      expect(() => RepositoryTargetSchema.parse({ cloneUrl })).toThrow();
    }
    expect(() => RepositoryTargetSchema.parse({ cloneUrl: 'ssh://git:secret@git.example.test/team/project.git' })).toThrow();
  });

  it('validates baseBranch with Git refname rules', () => {
    for (const baseBranch of ['feature/login', 'main']) {
      expect(RepositoryTargetSchema.parse({ cloneUrl: repository.cloneUrl, baseBranch }).baseBranch).toBe(baseBranch);
    }
    for (const baseBranch of ['a..b', 'a@{b', 'feature.lock', '/main', 'main/', 'a//b', '@', 'main.', '-main', '.hidden', 'feature/.hidden', ' main', 'main ', '\u0001main', 'main\u007f']) {
      expect(() => RepositoryTargetSchema.parse({ cloneUrl: repository.cloneUrl, baseBranch })).toThrow();
    }
  });

  it('validates event and error envelope shape', () => {
    const event = ExternalTaskEventSchema.parse({
      eventId: '11111111-1111-4111-8111-111111111111',
      sequence: 1,
      taskId: '22222222-2222-4222-8222-222222222222',
      type: 'task.queued',
      status: 'queued',
      stage: 'queued',
      occurredAt: '2026-09-16T00:00:00.000Z',
    });
    expect(event.data).toEqual({});
    expect(() => ExternalApiErrorSchema.parse({
      error: { code: 'NOT_A_PUBLIC_CODE', message: 'bad' },
      requestId: '33333333-3333-4333-8333-333333333333',
    })).toThrow();
  });
});
