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
 * A selected environmentProfileId is an already-known project/profile. It
 * therefore satisfies both the module identity and repository portions of the
 * contract even though the draft does not repeat the profile's details.
 */
export function hasCoreSubmissionInformation(draft: BugReportDraft): boolean {
  const hasKnownProfile = known(draft.environmentProfileId);
  const hasModule = hasKnownProfile || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
  const hasRepository = hasKnownProfile || known(draft.environmentProfile?.repositoryUrl);
  return known(draft.actualBehavior) && known(draft.expectedBehavior) && hasModule && hasRepository;
}

function coreQuestionAnswered(draft: BugReportDraft, field: string): boolean {
  if (field === 'environmentProfile.name') {
    return known(draft.environmentProfileId) || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
  }
  if (field === 'environmentProfile.repositoryUrl') {
    return known(draft.environmentProfileId) || known(draft.environmentProfile?.repositoryUrl);
  }
  return known(read(draft, field));
}

/** Select only unanswered core questions; optional enhancements never block confirmation. */
export function questionStrategy(draft: BugReportDraft, askedFields: readonly string[] = []): InterviewQuestion[] {
  // Keep the parameter for conversation/API compatibility. Required fields
  // remain askable when a previous answer was empty or explicitly unknown.
  void askedFields;
  const candidates = CORE_QUESTIONS;
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
  if (known(draft.actualBehavior)) problem += 15; else missing.push('actualBehavior');
  if (known(draft.expectedBehavior)) problem += 10; else missing.push('expectedBehavior');
  const moduleKnown = known(draft.environmentProfileId) || known(draft.environmentProfile?.name) || known(draft.component) || known(draft.productArea);
  const repositoryKnown = known(draft.environmentProfileId) || known(draft.environmentProfile?.repositoryUrl);
  if (!moduleKnown) missing.push('environmentProfile.name');
  if (!repositoryKnown) missing.push('environmentProfile.repositoryUrl');
  const reproductionDraft = draft.reproduction; const steps = reproductionDraft?.steps ?? [];
  if (steps.length >= 2) reproduction += 20; else if (steps.length === 1) reproduction += 10;
  if (reproductionDraft?.frequency && reproductionDraft.frequency !== 'unknown') reproduction += 5;
  if (reproductionDraft?.reproducible !== null && reproductionDraft?.reproducible !== undefined) reproduction += 5;
  if (draft.executionTarget && draft.executionTarget !== 'unknown') environment += 7;
  if (known(draft.environmentProfileId) || known(draft.environmentProfile?.repositoryUrl)) environment += 4;
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
