import type { BugReportDraft, CompletenessEvaluation, ExecutionTarget, BugType } from '@llmbugfix/bug-domain';

export type InterviewQuestion = {
  field: string;
  text: string;
  importance: 'critical' | 'high' | 'medium' | 'low';
};

export const CORE_QUESTIONS: readonly InterviewQuestion[] = [
  { field: 'actualBehavior', text: '具体发生了什么？请描述实际看到的结果。', importance: 'critical' },
  { field: 'expectedBehavior', text: '正常情况下你期望发生什么？', importance: 'critical' },
  { field: 'environmentProfile.name', text: '这个问题所属的项目或模块名称是什么？', importance: 'critical' },
  { field: 'environmentProfile.repositoryUrl', text: '这个问题所在项目的 Git 仓库远程地址是什么？请提供 HTTPS 或 SSH clone 地址。', importance: 'critical' },
];
export const DEVELOPMENT_CORE_QUESTIONS: readonly InterviewQuestion[] = [
  { field: 'objective', text: '希望新增或改造什么能力？请描述这项开发任务的目标。', importance: 'critical' },
  { field: 'requirements', text: '这项开发任务必须实现哪些具体需求？', importance: 'critical' },
  { field: 'acceptanceCriteria', text: '完成后如何验收？请给出至少一条可验证的验收标准。', importance: 'critical' },
  { field: 'environmentProfile.name', text: '这项任务所属的项目或模块名称是什么？', importance: 'critical' },
  { field: 'environmentProfile.repositoryUrl', text: '这项任务所在项目的 Git 仓库远程地址是什么？请提供 HTTPS 或 SSH clone 地址。', importance: 'critical' },
];
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
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/[.。!！?？]+$/u, '').trim().toLowerCase();
    return normalized.length > 0 && !['unknown', 'unavailable', 'n/a', 'na', 'none', 'not provided', 'not confirmed', '不知道', '不清楚', '不确定', '未知', '无法获得', '无', '未提供', '未确认', '尚未确认'].includes(normalized);
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
};

/**
 * The four facts below are the minimum contract handed to a FixWorker. Other
 * intake facts improve diagnosis, but are optional and must never hold up a
 * report which has this contract.
 *
 * A selected environmentProfileId may identify the module, but it never
 * substitutes for the Git remote supplied in this intake.  The worker cannot
 * be queued until the draft itself contains that address.
 */
export function hasGitRepositoryAddress(draft: BugReportDraft): boolean {
  return known(draft.environmentProfile?.repositoryUrl);
}

export function hasCoreSubmissionInformation(draft: BugReportDraft): boolean {
  const hasKnownProfile = known(draft.environmentProfileId);
  const hasModule = hasKnownProfile || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
  if (draft.taskType === 'development') return known(draft.objective) && known(draft.requirements) && known(draft.acceptanceCriteria) && hasModule && hasGitRepositoryAddress(draft);
  return known(draft.actualBehavior) && known(draft.expectedBehavior) && hasModule && hasGitRepositoryAddress(draft);
}

function coreQuestionAnswered(draft: BugReportDraft, field: string): boolean {
  if (field === 'environmentProfile.name') {
    return known(draft.environmentProfileId) || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
  }
  if (field === 'environmentProfile.repositoryUrl') {
    return hasGitRepositoryAddress(draft);
  }
  return known(read(draft, field));
}

/** Select only unanswered core questions; optional enhancements never block confirmation. */
export function questionStrategy(draft: BugReportDraft, askedFields: readonly string[] = []): InterviewQuestion[] {
  // Keep the parameter for conversation/API compatibility. Required fields
  // remain askable when a previous answer was empty or explicitly unknown.
  void askedFields;
  const candidates = draft.taskType === 'development' ? DEVELOPMENT_CORE_QUESTIONS : CORE_QUESTIONS;
  const unique = new Set<string>();
  return candidates.filter((question) => {
    // A prior question only suppresses a field after it has a meaningful
    // answer. If the reporter answered "unknown" (or skipped it), keep asking
    // for this required fact instead of returning a false-ready confirmation.
    if (unique.has(question.field) || coreQuestionAnswered(draft, question.field)) return false;
    unique.add(question.field);
    return true;
  }).slice(0, 3);
}
export const getNextQuestions = questionStrategy;
export const getAdaptiveQuestions = questionStrategy;

export function evaluateCompleteness(draft: BugReportDraft): CompletenessEvaluation {
  let problem = 0; let reproduction = 0; let environment = 0; let evidence = 0; let impact = 0;
  const missing: string[] = [];
  if (draft.taskType === 'development') {
    let objective = 0; let requirements = 0; let acceptance = 0; let scope = 0;
    if (known(draft.objective)) objective = 25; else missing.push('objective');
    if (known(draft.requirements)) requirements = 25; else missing.push('requirements');
    if (known(draft.acceptanceCriteria)) acceptance = 25; else missing.push('acceptanceCriteria');
    if ((draft.nonGoals?.length ?? 0) > 0) scope += 5;
    if ((draft.constraints?.length ?? 0) > 0) scope += 5;
    const moduleKnown = known(draft.environmentProfileId) || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
    const repositoryKnown = hasGitRepositoryAddress(draft);
    if (!moduleKnown) missing.push('environmentProfile.name');
    if (!repositoryKnown) missing.push('environmentProfile.repositoryUrl');
    if (draft.executionTarget && draft.executionTarget !== 'unknown') environment += 7;
    if (repositoryKnown) environment += 4;
    if (moduleKnown) environment += 4;
    const rawScore = objective + requirements + acceptance + scope + environment;
    const coreReady = hasCoreSubmissionInformation(draft);
    const score = coreReady ? Math.max(rawScore, 65) : Math.min(rawScore, 64);
    const missingList = [...new Set(missing)];
    return { score, dimensions: { problem: 0, reproduction: 0, environment, evidence: 0, impact: 0, objective, requirements, acceptance, scope }, missingCriticalInformation: missingList, recommendedQuestions: questionStrategy(draft).map((q) => q.text), readyForSubmission: coreReady, readyForConfirmation: coreReady };
  }
  if (known(draft.actualBehavior)) problem += 15; else missing.push('actualBehavior');
  if (known(draft.expectedBehavior)) problem += 10; else missing.push('expectedBehavior');
  const moduleKnown = known(draft.environmentProfileId) || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
  const repositoryKnown = hasGitRepositoryAddress(draft);
  if (!moduleKnown) missing.push('environmentProfile.name');
  if (!repositoryKnown) missing.push('environmentProfile.repositoryUrl');
  const reproductionDraft = draft.reproduction; const steps = reproductionDraft?.steps ?? [];
  if (steps.length >= 2) reproduction += 20; else if (steps.length === 1) reproduction += 10;
  if (reproductionDraft?.frequency && reproductionDraft.frequency !== 'unknown') reproduction += 5;
  if (reproductionDraft?.reproducible !== null && reproductionDraft?.reproducible !== undefined) reproduction += 5;
  if (draft.executionTarget && draft.executionTarget !== 'unknown') environment += 7;
  if (repositoryKnown) environment += 4;
  if (known(draft.environment?.environmentName) || known(draft.environment?.appVersion) || known(draft.environment?.buildNumber)) environment += 4;
  const ev = draft.evidence;
  const evidenceCount = (ev?.errorMessages?.length ?? 0) + (ev?.stackTraces?.length ?? 0) + (ev?.logs?.length ?? 0) + (ev?.screenshots?.length ?? 0) + (ev?.networkTraces?.length ?? 0) + (ev?.jsonFiles?.length ?? 0) + (ev?.otherFiles?.length ?? 0);
  if (evidenceCount > 0) evidence += 20;
  if (draft.impact?.scope && draft.impact.scope !== 'unknown') impact += 7;
  if (draft.impact?.blocksTesting !== null && draft.impact?.blocksTesting !== undefined) impact += 3;
  const rawScore = problem + reproduction + environment + evidence + impact;
  const coreReady = hasCoreSubmissionInformation(draft);
  // Keep quality dimensions useful for diagnostics, but make the public score
  // obey the core contract. Optional evidence cannot push an incomplete report
  // into the FixWorker queue; a minimal core-complete report is passing.
  const score = coreReady ? Math.max(rawScore, 65) : Math.min(rawScore, 64);
  const missingList = [...new Set(missing)];
  return { score, dimensions: { problem, reproduction, environment, evidence, impact }, missingCriticalInformation: missingList, recommendedQuestions: questionStrategy(draft).map((q) => q.text), readyForSubmission: coreReady, readyForConfirmation: coreReady };
}
export type { ExecutionTarget, BugType };
