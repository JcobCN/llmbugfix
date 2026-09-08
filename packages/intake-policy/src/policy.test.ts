import { describe, it, expect } from 'vitest';
import { evaluateCompleteness, hasCoreSubmissionInformation, questionStrategy } from './index.js';
import type { BugReportDraft } from '@llmbugfix/bug-domain';

describe('Intake Policy & Completeness Scoring', () => {
  it('scores 0 for empty draft and identifies missing information', () => {
    const result = evaluateCompleteness({});
    expect(result.score).toBe(0);
    expect(result.readyForConfirmation).toBe(false);
    expect(result.missingCriticalInformation.length).toBeGreaterThan(0);
  });

  it('calculates 5 dimensions and sets ready when score >= 65', () => {
    const draft: BugReportDraft = {
      title: '登录按钮点击无响应',
      actualBehavior: '点击后按钮一直转圈',
      expectedBehavior: '跳转至首页',
      component: 'login',
      executionTarget: 'frontend',
      environmentProfile: { name: 'frontend', repositoryUrl: 'https://git.example.test/team/frontend.git' },
      bugType: 'ui',
      reproduction: {
        steps: ['1. 打开登录页', '2. 输入用户名密码', '3. 点击登录'],
        frequency: 'always',
        prerequisites: [],
        testData: [],
        reproducible: true,
      },
      environment: {
        frontend: {
          route: '/login',
          browser: 'Chrome',
          browserVersion: '128',
          os: 'macOS',
          resolution: '1920x1080',
        },
        environmentName: 'staging',
        appVersion: 'v1.2.0',
        buildNumber: null,
        commitSha: null,
        additionalInfo: {},
      },
      evidence: {
        errorMessages: ['TypeError: Cannot read properties of undefined'],
        stackTraces: [],
        logs: [],
        screenshots: [],
        videos: [],
        networkTraces: [],
        jsonFiles: [],
        otherFiles: [],
      },
      impact: {
        scope: 'all_users',
        blocksTesting: true,
        affectedUsers: null,
        workaroundExists: false,
        workaround: null,
      },
    };

    const result = evaluateCompleteness(draft);
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(result.readyForConfirmation).toBe(true);
    expect(result.dimensions.problem).toBe(25);
    expect(result.dimensions.reproduction).toBe(30);
  });

  it('limits questions to at most 3 and focuses on critical missing fields', () => {
    const questions = questionStrategy({ actualBehavior: '系统报错 500' });
    expect(questions.length).toBeLessThanOrEqual(3);
    expect(questions.length).toBeGreaterThan(0);
  });

  it('passes the minimum four-fact contract without optional diagnostics', () => {
    const draft: BugReportDraft = {
      actualBehavior: '点击 App Desktop Addon 后仍停留在原 tab，无任何切换。',
      expectedBehavior: '点击 tab 后应正常切换。',
      component: 'app-honourbell-store',
      environmentProfile: {
        name: 'app-honourbell-store',
        repositoryUrl: 'http://172.29.100.126/codigger-llm/app-honourbell-store.git',
        defaultBranch: 'llm-bugfix',
      },
    };

    expect(hasCoreSubmissionInformation(draft)).toBe(true);
    const result = evaluateCompleteness(draft);
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(result.readyForSubmission).toBe(true);
    expect(result.readyForConfirmation).toBe(true);
    expect(result.missingCriticalInformation).toEqual([]);
    expect(result.recommendedQuestions).toEqual([]);
    expect(questionStrategy(draft)).toEqual([]);
  });

  it('treats an existing environment profile as the module and repository', () => {
    const result = evaluateCompleteness({
      actualBehavior: '页面无响应',
      expectedBehavior: '页面正常切换',
      environmentProfileId: 'frontend-main',
    });
    expect(result.readyForSubmission).toBe(true);
    expect(result.missingCriticalInformation).toEqual([]);
  });

  it.each([
    ['actualBehavior', { expectedBehavior: '应该切换', component: 'store', environmentProfile: { repositoryUrl: 'https://git.example.test/store.git' } }],
    ['expectedBehavior', { actualBehavior: '停留在原 tab', component: 'store', environmentProfile: { repositoryUrl: 'https://git.example.test/store.git' } }],
    ['module', { actualBehavior: '停留在原 tab', expectedBehavior: '应该切换', environmentProfile: { repositoryUrl: 'https://git.example.test/store.git' } }],
    ['repository', { actualBehavior: '停留在原 tab', expectedBehavior: '应该切换', component: 'store' }],
  ] as const)('does not pass when the core %s fact is missing even with optional evidence', (_missing, draft) => {
    const result = evaluateCompleteness({
      ...draft,
      reproduction: { steps: ['打开页面', '点击 tab'], prerequisites: [], testData: [], reproducible: true, frequency: 'always' },
      executionTarget: 'frontend',
      environment: { environmentName: 'staging', appVersion: '1.0.0', buildNumber: null, commitSha: null, additionalInfo: {} },
      evidence: { errorMessages: ['many optional details'], stackTraces: [], logs: [], screenshots: [], videos: [], networkTraces: [], jsonFiles: [], otherFiles: [] },
      impact: { scope: 'all_users', blocksTesting: true, affectedUsers: null, workaroundExists: null, workaround: null },
    });
    expect(result.score).toBeLessThan(65);
    expect(result.readyForSubmission).toBe(false);
    expect(result.readyForConfirmation).toBe(false);
    expect(result.missingCriticalInformation.length).toBeGreaterThan(0);
  });
});
