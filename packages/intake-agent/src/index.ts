import { z } from 'zod';
import { BugReportDraftSchema, IntakeTurnResultSchema, type BugReportDraft, type BugConversation, type ConversationMessage, type CompletenessEvaluation, type IntakeTurnResult } from '@llmbugfix/bug-domain';
import { evaluateCompleteness, questionStrategy } from '@llmbugfix/intake-policy';

export const BUG_INTAKE_SYSTEM_PROMPT = `You are an internal software bug intake assistant.
Your job is to interview a software tester and produce an engineering-quality BugReport that another coding agent can use to investigate and fix the defect.

This environment has no Internet access. Do not search the web, call public services, modify code, run commands, use Git, start a fixer, diagnose root cause, or access production systems.

Rules:
1. Extract information already provided; never ask again for information already answered.
2. Ask at most 3 questions per turn, prioritizing the problem, reproduction, and expected behavior.
3. Separate actual behavior from expected behavior and distinguish facts from reporter hypotheses.
4. Identify frontend, backend, or unknown; ask the tester when confidence is insufficient.
5. Never invent reproduction steps or environment information. Preserve exact errors where useful.
6. Encourage useful logs or HAR files when relevant. Screenshots may be uploaded, but never assume they were understood unless explicit image-analysis results are provided. If image analysis is unavailable, ask the tester to describe visual details.
7. Never request passwords, tokens, cookies, API keys, or private credentials. Redact or flag possible sensitive data.
8. Allow the tester to answer unknown and do not repeatedly ask for unavailable information.
9. Before submission show the reconstructed report; submission requires explicit tester confirmation.
10. Return only JSON matching the supplied IntakeTurnResult schema.`;

export type IntakeModelInput = {
  currentDraft: BugReportDraft;
  /** Relevant recent messages only; callers should include the latest message separately. */
  relevantMessages?: ConversationMessage[];
  /** Alias accepted for clients using the original contract. */
  messages?: ConversationMessage[];
  latestMessage?: string;
  /** Legacy spelling retained at the boundary; canonical payloads use latestMessage. */
  userMessage?: string;
  /** Paths manually edited by the reporter; those values always win. */
  userEditedFields?: readonly string[];
};

export interface IntakeModel { complete(input: IntakeModelInput): Promise<IntakeTurnResult>; }

export const IntakeModelInputSchema = z.object({
  currentDraft: BugReportDraftSchema,
  relevantMessages: z.array(z.unknown()).optional(),
  latestMessage: z.string().optional(),
  userMessage: z.string().optional(),
  userEditedFields: z.array(z.string()).optional(),
});

const unknownWord = /^(unknown|不清楚|不知道|不确定|无法获得|无)$/i;
const sensitive = /(password|passwd|token|secret|api[_ -]?key|cookie|authorization|Bearer\s+[\w.-]+|密码|口令|令牌|私钥)/i;
const getPath = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, key) => v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined, obj);
const setPath = (obj: Record<string, unknown>, path: string, value: unknown): void => {
  const parts = path.split('.'); let cursor = obj;
  for (const part of parts.slice(0, -1)) cursor = (cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : (cursor[part] = {})) as Record<string, unknown>;
  cursor[parts[parts.length - 1]] = value;
};
const deepMerge = (base: unknown, patch: unknown): unknown => {
  if (Array.isArray(patch)) return [...patch]; // model arrays are complete replacements, never concatenated
  if (!patch || typeof patch !== 'object') return patch;
  const result: Record<string, unknown> = base && typeof base === 'object' && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) result[key] = deepMerge(result[key], value);
  return result;
};

export function mergeDraft(currentDraft: BugReportDraft, fieldUpdates: BugReportDraft, userEditedFields: readonly string[] = []): BugReportDraft {
  const protectedValues = new Map(userEditedFields.map((path) => [path, getPath(currentDraft, path)]));
  const merged = deepMerge(currentDraft, fieldUpdates) as BugReportDraft;
  for (const [path, value] of protectedValues) setPath(merged as Record<string, unknown>, path, value);
  return BugReportDraftSchema.parse(merged);
}
export const mergeDeep = mergeDraft;
export function applyIntakeTurn(currentDraft: BugReportDraft, turn: IntakeTurnResult, userEditedFields: readonly string[] = []): BugReportDraft {
  return mergeDraft(currentDraft, turn.fieldUpdates, userEditedFields);
}

export function detectContradictions(currentDraft: BugReportDraft, fieldUpdates: BugReportDraft) {
  const out: IntakeTurnResult['contradictions'] = [];
  const visit = (before: unknown, after: unknown, path: string): void => {
    if (Array.isArray(after) || !after || typeof after !== 'object') {
      if (before !== undefined && after !== undefined && JSON.stringify(before) !== JSON.stringify(after)) out.push({ field: path, previousValue: before, newValue: after });
      return;
    }
    for (const [key, value] of Object.entries(after as Record<string, unknown>)) visit(before && typeof before === 'object' ? (before as Record<string, unknown>)[key] : undefined, value, path ? `${path}.${key}` : key);
  };
  visit(currentDraft, fieldUpdates, '');
  return out;
}

function textLines(text: string): string[] { return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function extractUpdates(text: string, current: BugReportDraft): BugReportDraft {
  const updates: Record<string, unknown> = {};
  const lower = text.toLowerCase();
  if (/(frontend|front-end|\bui\b|\bweb\b|browser|前端|页面|网页|按钮)/i.test(text)) updates.executionTarget = 'frontend';
  else if (/(backend|back-end|\bapi\b|server|database|后端|接口|服务|服务器)/i.test(text)) updates.executionTarget = 'backend';
  if (!current.actualBehavior) updates.actualBehavior = text;
  if (/expected|should|expect|期望|应该|正常/.test(lower)) updates.expectedBehavior = text;
  if (!current.title) updates.title = textLines(text)[0]?.slice(0, 120) || '未命名 Bug';
  const stepLines = textLines(text).filter((line) => /^(?:step\s*)?\d+[.)、：:]/i.test(line));
  if (stepLines.length) updates.reproduction = { ...(current.reproduction ?? {}), reproducible: true, frequency: 'always', prerequisites: current.reproduction?.prerequisites ?? [], steps: stepLines, testData: current.reproduction?.testData ?? [] };
  if (/(unknown|不清楚|不知道|不确定|无法获得)/i.test(text) && /target|frontend|backend|前端|后端|环境|日志|error|错误/i.test(text)) updates.executionTarget = 'unknown';
  const errors = textLines(text).filter((line) => /(error|exception|traceback|TypeError|报错|错误|异常|500\b)/i.test(line));
  if (errors.length) updates.evidence = { ...(current.evidence ?? {}), errorMessages: errors, stackTraces: current.evidence?.stackTraces ?? [], logs: current.evidence?.logs ?? [], screenshots: current.evidence?.screenshots ?? [], videos: current.evidence?.videos ?? [], networkTraces: current.evidence?.networkTraces ?? [], jsonFiles: current.evidence?.jsonFiles ?? [], otherFiles: current.evidence?.otherFiles ?? [] };
  return updates as BugReportDraft;
}

export class FakeIntakeModel implements IntakeModel {
  async complete(input: IntakeModelInput): Promise<IntakeTurnResult> {
    const messages = input.relevantMessages ?? input.messages ?? [];
    const latestMessage = input.latestMessage ?? input.userMessage ?? '';
    const updates = extractUpdates(latestMessage, input.currentDraft);
    const contradictions = detectContradictions(input.currentDraft, updates);
    const draft = mergeDraft(input.currentDraft, updates, input.userEditedFields ?? []);
    const questions = questionStrategy(draft, messages.flatMap((m) => Array.isArray(m.metadata?.askedFields) ? m.metadata.askedFields as string[] : []));
    const result: IntakeTurnResult = { fieldUpdates: updates, observations: [latestMessage], reporterHypotheses: [], contradictions, possibleSensitiveData: sensitive.test(latestMessage), executionTargetConfidence: updates.executionTarget ? (input.userEditedFields?.includes('executionTarget') ? 0.99 : 0.72) : 0.25, questions, readyForConfirmation: evaluateCompleteness(draft).readyForConfirmation ?? false };
    return IntakeTurnResultSchema.parse(result);
  }
}

function assertInternalUrl(baseUrl: string): URL {
  const value = new URL(baseUrl);
  if (value.protocol !== 'http:' && value.protocol !== 'https:') throw new Error('Intake LLM URL must use HTTP(S)');
  const host = value.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host.endsWith('.internal') || host.endsWith('.local') || /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host) || /^10\.|^192\.168\.|^127\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!privateHost) throw new Error('Refusing public Intake LLM endpoint; configure an internal host');
  return value;
}
export type OpenAICompatibleIntakeModelOptions = { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch };
export class OpenAICompatibleIntakeModel implements IntakeModel {
  private readonly endpoint: URL;
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: OpenAICompatibleIntakeModelOptions) { this.endpoint = assertInternalUrl(options.baseUrl.replace(/\/$/, '') + '/chat/completions'); this.request = options.fetch ?? globalThis.fetch; }
  async complete(input: IntakeModelInput): Promise<IntakeTurnResult> {
    const messages = input.relevantMessages ?? input.messages ?? [];
    const payload = { model: this.options.model, temperature: 0, messages: [{ role: 'system', content: BUG_INTAKE_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify({ currentDraft: input.currentDraft, relevantRecentMessages: messages.slice(-12), latestMessage: input.latestMessage ?? input.userMessage ?? '' }) }], response_format: { type: 'json_object' } };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await this.request(this.endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}) }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) throw new Error(`Intake LLM returned HTTP ${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string | unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Intake LLM response did not contain JSON content');
      let parsed: unknown; try { parsed = JSON.parse(content); } catch { throw new Error('Intake LLM returned invalid JSON'); }
      return IntakeTurnResultSchema.parse(parsed);
    } finally { clearTimeout(timer); }
  }
}
export const OpenAIIntakeModel = OpenAICompatibleIntakeModel;

export class IntakeService {
  constructor(private readonly model: IntakeModel = new FakeIntakeModel()) {}
  async processUserMessage(currentDraft: BugReportDraft, history: ConversationMessage[], userText: string, userEditedFields: readonly string[] = []) {
    const relevant = history.slice(-12);
    const turn = await this.model.complete({ currentDraft, relevantMessages: relevant, latestMessage: userText, userEditedFields });
    const updatedDraft = mergeDraft(currentDraft, turn.fieldUpdates, userEditedFields);
    const completeness = evaluateCompleteness(updatedDraft);
    return { turn, updatedDraft, reply: turn.questions.length ? turn.questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n') : '收到，当前信息已整理到 Bug 草稿中，请核对后确认提交。', completeness };
  }
  async processTurn(currentDraft: BugReportDraft, history: ConversationMessage[], userText: string, userEditedFields: readonly string[] = []) {
    return this.processUserMessage(currentDraft, history, userText, userEditedFields);
  }
  async complete(input: IntakeModelInput) { return this.model.complete(input); }
}

export type { BugConversation, CompletenessEvaluation, ConversationMessage, IntakeTurnResult };
