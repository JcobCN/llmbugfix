import { describe, it, expect } from 'vitest';
import { evaluateCompleteness, questionStrategy } from './index.js';
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
      executionTarget: 'frontend',
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
});
