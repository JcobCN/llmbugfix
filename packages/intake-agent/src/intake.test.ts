import { describe, it, expect } from 'vitest';
import { FakeIntakeModel, IntakeService, mergeDraft } from './index.js';
import type { BugReportDraft } from '@llmbugfix/bug-domain';

describe('Intake Agent & Service', () => {
  it('processes natural language message with FakeIntakeModel', async () => {
    const model = new FakeIntakeModel();
    const service = new IntakeService(model);
    const draft: BugReportDraft = {};

    const res = await service.processTurn(
      draft,
      [],
      '用户在订单列表点击退款按钮后页面无响应，控制台提示 TypeError'
    );

    expect(res.updatedDraft.executionTarget).toBe('frontend');
    expect(res.updatedDraft.actualBehavior).toContain('退款');
    expect(res.turn.questions.length).toBeLessThanOrEqual(3);
  });

  it('merges draft preserving existing fields and avoiding overwrite', () => {
    const base: BugReportDraft = {
      title: '原始标题',
      executionTarget: 'backend',
    };
    const updates: Partial<BugReportDraft> = {
      actualBehavior: '返回 500 错误',
      reproduction: {
        steps: ['POST /api/order'],
        frequency: 'always',
        prerequisites: [],
        testData: [],
        reproducible: true,
      },
    };

    const merged = mergeDraft(base, updates);
    expect(merged.title).toBe('原始标题');
    expect(merged.executionTarget).toBe('backend');
    expect(merged.actualBehavior).toBe('返回 500 错误');
    expect(merged.reproduction?.steps).toEqual(['POST /api/order']);
  });
});
