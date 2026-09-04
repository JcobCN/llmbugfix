import type { BugReportDraft, CompletenessEvaluation, ExecutionTarget, BugType } from '@llmbugfix/bug-domain';

export type InterviewQuestion = {
  field: string;
  text: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
};

export const CORE_QUESTIONS: readonly InterviewQuestion[] = [
  { field: 'actualBehavior', text: '具体发生了什么？请描述实际看到的结果。', importance: 'critical' },
  { field: 'expectedBehavior', text: '正常情况下你期望发生什么？', importance: 'critical' },
  { field: 'reproduction.steps', text: '能提供从开始到出现问题的操作步骤吗？', importance: 'critical' },
  { field: 'executionTarget', text: '问题主要发生在前端界面，还是后端服务/API？也可以回答“不确定”。', importance: 'critical' },
  { field: 'environmentProfile.repositoryUrl', text: '这个问题所在项目的 Git 仓库远程地址是什么？请提供 HTTPS 或 SSH clone 地址。', importance: 'high' },
  { field: 'evidence', text: '是否有错误信息、日志、堆栈、截图或 HAR 可以提供？没有也可以回答 unknown。', importance: 'high' },
  { field: 'impact.scope', text: '影响范围是单个用户、部分用户，还是所有用户？', importance: 'medium' },
];
const FRONTEND_QUESTIONS: readonly InterviewQuestion[] = [
  { field: 'environment.frontend.route', text: '出问题的页面 Route/URL 是什么？', importance: 'high' },
  { field: 'environment.frontend.browser', text: '使用的浏览器及版本是什么？', importance: 'high' },
  { field: 'environment.frontend.os', text: '使用的操作系统是什么？', importance: 'medium' },
  { field: 'evidence.errorMessages', text: '浏览器 Console 或 Network 面板有报错吗？请粘贴原文。', importance: 'high' },
];
const BACKEND_QUESTIONS: readonly InterviewQuestion[] = [
  { field: 'environment.backend.service', text: '哪个服务出现问题？', importance: 'high' },
  { field: 'environment.backend.endpoint', text: '请求的 API Endpoint、HTTP Method 和 Status Code 是什么？', importance: 'high' },
  { field: 'evidence.errorMessages', text: '服务日志或 Stack Trace 中有没有相关错误？请粘贴原文。', importance: 'high' },
];
const TYPE_QUESTIONS: Record<string, readonly InterviewQuestion[]> = {
  api: [{ field: 'environment.backend.endpoint', text: '请提供完整的请求、响应和 HTTP 状态码。', importance: 'high' }],
  ui: [{ field: 'environment.frontend.route', text: '页面上哪个控件或区域表现异常？触发它的操作是什么？', importance: 'high' }],
  crash: [{ field: 'evidence.stackTraces', text: '可以提供崩溃时的完整 Stack Trace 吗？', importance: 'high' }],
  performance: [{ field: 'evidence.logs', text: '可以提供耗时、时间点或性能日志作为证据吗？', importance: 'medium' }],
};
const read = (draft: BugReportDraft, path: string): unknown => {
  let value: unknown = draft;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
};
const known = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim().toLowerCase() !== 'unknown';
  if (Array.isArray(value)) return value.length > 0;
  return true;
};
const answered = (value: unknown): boolean => value !== undefined && value !== null && (!(typeof value === 'string') || value.trim().length > 0);

/** Select unanswered questions; an explicit unknown is an answer and is not repeated. */
export function questionStrategy(draft: BugReportDraft, askedFields: readonly string[] = []): InterviewQuestion[] {
  const asked = new Set(askedFields);
  const target = draft.executionTarget;
  const candidates = [...CORE_QUESTIONS.slice(0, 4), ...(target === 'frontend' ? FRONTEND_QUESTIONS : target === 'backend' ? BACKEND_QUESTIONS : []), ...(draft.bugType ? TYPE_QUESTIONS[draft.bugType] ?? [] : []), ...CORE_QUESTIONS.slice(4)];
  const unique = new Set<string>();
  return candidates.filter((question) => {
    // An explicit "unknown" is still an answer; it must not cause an endless loop.
    if (unique.has(question.field) || asked.has(question.field) || answered(read(draft, question.field))) return false;
    unique.add(question.field);
    return true;
  }).slice(0, 3);
}
export const getNextQuestions = questionStrategy;
export const getAdaptiveQuestions = questionStrategy;

export function evaluateCompleteness(draft: BugReportDraft): CompletenessEvaluation {
  let problem = 0; let reproduction = 0; let environment = 0; let evidence = 0; let impact = 0;
  const missing: string[] = [];
  if (known(draft.actualBehavior)) problem += 15; else missing.push('actualBehavior');
  if (known(draft.expectedBehavior)) problem += 10; else missing.push('expectedBehavior');
  const reproductionDraft = draft.reproduction; const steps = reproductionDraft?.steps ?? [];
  if (steps.length >= 2) reproduction += 20; else if (steps.length === 1) reproduction += 10; else missing.push('reproduction.steps');
  if (reproductionDraft?.frequency && reproductionDraft.frequency !== 'unknown') reproduction += 5;
  if (reproductionDraft?.reproducible !== null && reproductionDraft?.reproducible !== undefined) reproduction += 5;
  if (draft.executionTarget && draft.executionTarget !== 'unknown') environment += 7; else missing.push('executionTarget');
  if (known(draft.environmentProfileId) || known(draft.environmentProfile?.repositoryUrl)) environment += 4;
  if (known(draft.environment?.environmentName) || known(draft.environment?.appVersion) || known(draft.environment?.buildNumber)) environment += 4; else missing.push('environment');
  const ev = draft.evidence;
  const evidenceCount = (ev?.errorMessages?.length ?? 0) + (ev?.stackTraces?.length ?? 0) + (ev?.logs?.length ?? 0) + (ev?.screenshots?.length ?? 0) + (ev?.networkTraces?.length ?? 0) + (ev?.jsonFiles?.length ?? 0) + (ev?.otherFiles?.length ?? 0);
  if (evidenceCount > 0) evidence += 20; else missing.push('evidence');
  if (draft.impact?.scope && draft.impact.scope !== 'unknown') impact += 7; else missing.push('impact.scope');
  if (draft.impact?.blocksTesting !== null && draft.impact?.blocksTesting !== undefined) impact += 3;
  const score = problem + reproduction + environment + evidence + impact;
  const missingList = [...new Set(missing)];
  return { score, dimensions: { problem, reproduction, environment, evidence, impact }, missingCriticalInformation: missingList, recommendedQuestions: questionStrategy(draft).map((q) => q.text), readyForSubmission: score >= 65, readyForConfirmation: score >= 65 };
}
export type { ExecutionTarget, BugType };
