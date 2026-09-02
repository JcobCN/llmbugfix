import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';

export const FALLBACK_VISION_PROMPT = '截图已保存，但当前环境没有配置图片识别模型。请补充说明截图中最关键的异常。如果里面有错误提示文字，也请直接粘贴出来。';

export type VisionInput = { filePath: string; prompt: string };
export type VisionAnalysis = { description: string; visibleText: string[]; observations: string[]; confidence: number; status?: 'completed' | 'failed' | 'unsupported'; error?: string };
export interface VisionProvider {
  isAvailable(): Promise<boolean>;
  analyzeImage(input: VisionInput): Promise<VisionAnalysis>;
}
export interface OcrProvider {
  isAvailable(): Promise<boolean>;
  extractText(filePath: string): Promise<string[]>;
}

export class DisabledVisionProvider implements VisionProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async analyzeImage(_input: VisionInput): Promise<VisionAnalysis> { return { description: FALLBACK_VISION_PROMPT, visibleText: [], observations: [], confidence: 0, status: 'unsupported' }; }
}
export class DisabledOcrProvider implements OcrProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async extractText(_filePath: string): Promise<string[]> { return []; }
}

export type HttpVisionProviderOptions = {
  timeoutMs?: number;
  model?: string;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
};

const isPrivateIpv4 = (address: string): boolean => {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254));
};
const isPrivateHost = (hostname: string): boolean => {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower === '::1' || lower === '0.0.0.0' || lower.endsWith('.internal') || lower.endsWith('.local')) return true;
  if (net.isIPv4(lower)) return isPrivateIpv4(lower);
  if (net.isIPv6(lower)) return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  return false;
};

/** Resolve DNS before connecting so a hostname cannot silently point at a public service. */
async function resolvesPrivate(hostname: string): Promise<boolean> {
  if (isPrivateHost(hostname)) return true;
  try { const records = await dns.lookup(hostname, { all: true }); return records.length > 0 && records.every((record) => isPrivateHost(record.address)); } catch { return false; }
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]').replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]').replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED JWT]').replace(/(\bBearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [/(?:password|passwd|cookie|authorization|api[-_ ]?key|secret|token|private[-_ ]?key)/i.test(key) ? key : key, /(?:password|passwd|cookie|authorization|api[-_ ]?key|secret|token|private[-_ ]?key)/i.test(key) ? '[REDACTED]' : sanitize(item)]));
  return value;
}

export class HttpVisionProvider implements VisionProvider {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly enabled: boolean;
  private readonly model?: string;
  constructor(serviceUrl: string, timeoutMsOrOptions: number | HttpVisionProviderOptions = {}) {
    const options = typeof timeoutMsOrOptions === 'number' ? { timeoutMs: timeoutMsOrOptions } : timeoutMsOrOptions;
    let parsed: URL; try { parsed = new URL(serviceUrl); } catch { throw new Error('Vision URL is invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !isPrivateHost(parsed.hostname)) throw new Error('Vision URL must point to a configured private-network host');
    this.endpoint = parsed; this.timeoutMs = options.timeoutMs ?? 5_000; this.fetchImpl = options.fetchImpl ?? fetch; this.enabled = options.enabled ?? true; this.model = options.model;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Vision timeout must be positive');
  }
  async isAvailable(): Promise<boolean> { return this.enabled && await resolvesPrivate(this.endpoint.hostname); }
  async analyzeImage(input: VisionInput): Promise<VisionAnalysis> {
    if (!(await this.isAvailable())) return { description: FALLBACK_VISION_PROMPT, visibleText: [], observations: [], confidence: 0, status: 'unsupported' };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const image = (await fs.readFile(input.filePath)).toString('base64');
      const response = await this.fetchImpl(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, imagePath: input.filePath, prompt: input.prompt, model: this.model }), signal: controller.signal });
      if (!response.ok) return { description: FALLBACK_VISION_PROMPT, visibleText: [], observations: [], confidence: 0, status: 'failed', error: `Vision service returned HTTP ${response.status}` };
      const raw = await response.json() as Record<string, unknown>;
      const result = sanitize(raw) as Record<string, unknown>;
      const visibleText = Array.isArray(result.visibleText) ? result.visibleText.filter((v): v is string => typeof v === 'string') : typeof result.text === 'string' ? [result.text] : [];
      const observations = Array.isArray(result.observations) ? result.observations.filter((v): v is string => typeof v === 'string') : [];
      return { description: typeof result.description === 'string' ? result.description : typeof result.summary === 'string' ? result.summary : '', visibleText, observations, confidence: typeof result.confidence === 'number' && Number.isFinite(result.confidence) ? Math.max(0, Math.min(1, result.confidence)) : 0, status: 'completed' };
    } catch (error) { return { description: FALLBACK_VISION_PROMPT, visibleText: [], observations: [], confidence: 0, status: 'failed', error: error instanceof Error && error.name === 'AbortError' ? 'Vision request timed out' : 'Vision request failed' }; }
    finally { clearTimeout(timer); }
  }
}
