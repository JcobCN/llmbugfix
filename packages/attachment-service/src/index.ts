import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentRefSchema, type AttachmentRef } from '@llmbugfix/bug-domain';
import { DisabledVisionProvider, FALLBACK_VISION_PROMPT, type OcrProvider, type VisionProvider } from '@llmbugfix/vision-provider';

export const ALLOWED_ATTACHMENT_TYPES = {
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'],
  'text/plain': ['.txt', '.log'], 'application/json': ['.json', '.har'], 'video/mp4': ['.mp4'],
} as const;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_EXTRACTED_BYTES = 100_000;
type AnalysisStatus = AttachmentRef['analysisStatus'];

export class AttachmentError extends Error {
  constructor(message: string, public readonly code = 'INVALID_ATTACHMENT') { super(message); this.name = 'AttachmentError'; }
}
export type AttachmentServiceOptions = { maxBytes?: number; maxExtractedBytes?: number; visionProvider?: VisionProvider; ocrProvider?: OcrProvider };

const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const BEARER = /(\bBearer\s+)[^\s,;]+/gi;
const SECRET_ASSIGNMENT = /(\b(?:password|passwd|pwd|cookie|set-cookie|authorization|api[-_ ]?key|x-api-key|secret|token)\s*[:=]\s*)(?:Bearer\s+)?[^\r\n,;]*/gi;
const QUOTED_SECRET = /(["'](?:password|passwd|pwd|cookie|set-cookie|authorization|api[-_ ]?key|x-api-key|secret|token)["']\s*:\s*["'])([^"']*)(["'])/gi;

/** Redact attachment content before it is persisted, parsed, or logged. */
export function redactSensitive(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]').replace(JWT, '[REDACTED JWT]').replace(AWS_ACCESS_KEY, '[REDACTED AWS KEY]').replace(BEARER, '$1[REDACTED]').replace(SECRET_ASSIGNMENT, '$1[REDACTED]').replace(QUOTED_SECRET, '$1[REDACTED]$3');
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:password|passwd|pwd|cookie|set[-_ ]?cookie|authorization|api[-_ ]?key|secret|token|private[-_ ]?key|access[-_ ]?key)/i.test(key) ? '[REDACTED]' : redactSensitive(item)]));
  return value;
}
export const redactAttachmentText = (text: string): string => String(redactSensitive(text));
const bounded = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text); if (bytes.length <= maxBytes) return text;
  const marker = Buffer.from('\n[TRUNCATED]'); if (maxBytes <= marker.length) return marker.subarray(0, maxBytes).toString('utf8');
  return `${bytes.subarray(0, maxBytes - marker.length).toString('utf8')}${marker.toString('utf8')}`;
};
const safeComponent = (value: string, label: string): string => { if (!value || value === '.' || value === '..' || path.isAbsolute(value) || /[\\/\0]/u.test(value)) throw new AttachmentError(`${label} contains an unsafe path`, 'UNSAFE_PATH'); if (value.length > 200) throw new AttachmentError(`${label} is too long`, 'UNSAFE_FILENAME'); return value; };
const safeFilename = (filename: string): string => { safeComponent(filename, 'Filename'); const value = filename.normalize('NFKC').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/u, '_'); if (!value || value === '.' || value === '..' || value.length > 200) throw new AttachmentError('Filename is invalid', 'UNSAFE_FILENAME'); return value; };
const isImage = (mime: string): boolean => mime.startsWith('image/');

function validateHar(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AttachmentError('HAR must be a JSON object', 'INVALID_HAR');
  const log = (value as Record<string, unknown>).log;
  if (!log || typeof log !== 'object' || Array.isArray(log) || typeof (log as Record<string, unknown>).version !== 'string' || !Array.isArray((log as Record<string, unknown>).entries)) throw new AttachmentError('HAR.log.version and HAR.log.entries are required', 'INVALID_HAR');
}
function extract(buffer: Buffer, mime: string, ext: string, maxBytes: number): string | null {
  if (mime === 'text/plain') return bounded(redactAttachmentText(buffer.toString('utf8')), maxBytes);
  if (mime !== 'application/json') return null;
  let parsed: unknown; try { parsed = JSON.parse(buffer.toString('utf8')); } catch { throw new AttachmentError('Invalid JSON attachment', 'INVALID_JSON'); }
  if (ext === '.har') validateHar(parsed);
  return bounded(JSON.stringify(redactSensitive(parsed), null, 2), maxBytes);
}

export class AttachmentService {
  readonly storageBaseDir: string; readonly maxBytes: number; readonly maxExtractedBytes: number; readonly visionProvider: VisionProvider; readonly ocrProvider?: OcrProvider;
  constructor(storageBaseDir: string, options: AttachmentServiceOptions = {}) {
    if (!storageBaseDir || storageBaseDir.includes('\0')) throw new AttachmentError('Storage path is invalid', 'UNSAFE_PATH');
    this.storageBaseDir = path.resolve(storageBaseDir); this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES; this.maxExtractedBytes = options.maxExtractedBytes ?? DEFAULT_MAX_EXTRACTED_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw new AttachmentError('maxBytes must be positive', 'INVALID_LIMIT');
    this.visionProvider = options.visionProvider ?? new DisabledVisionProvider(); this.ocrProvider = options.ocrProvider; fs.mkdirSync(this.storageBaseDir, { recursive: true });
  }
  saveAttachment(bugId: string, filename: string, mimeType: string, buffer: Buffer): AttachmentRef {
    if (!Buffer.isBuffer(buffer)) throw new AttachmentError('Attachment data must be a Buffer', 'INVALID_DATA');
    const safeBugId = safeComponent(bugId, 'Bug ID'); const safeName = safeFilename(filename); const mime = mimeType.trim().toLowerCase().split(';', 1)[0]; const ext = path.extname(safeName).toLowerCase();
    const allowed = (ALLOWED_ATTACHMENT_TYPES as Record<string, readonly string[]>)[mime];
    if (!allowed || !allowed.includes(ext)) throw new AttachmentError(`Unsupported MIME type or extension mismatch: ${mimeType} / ${ext}`, 'UNSUPPORTED_TYPE');
    if (buffer.length > this.maxBytes) throw new AttachmentError(`File size exceeds limit (${this.maxBytes} bytes)`, 'FILE_TOO_LARGE');
    const bugDir = path.resolve(this.storageBaseDir, safeBugId); if (!bugDir.startsWith(`${this.storageBaseDir}${path.sep}`)) throw new AttachmentError('Bug ID escapes storage path', 'UNSAFE_PATH'); fs.mkdirSync(bugDir, { recursive: true });
    const id = crypto.randomUUID(); const target = path.resolve(bugDir, `${id}_${safeName}`); if (!target.startsWith(`${bugDir}${path.sep}`)) throw new AttachmentError('Attachment path escapes bug directory', 'UNSAFE_PATH');
    const extractedText = extract(buffer, mime, ext, this.maxExtractedBytes); fs.writeFileSync(target, buffer, { flag: 'wx', mode: 0o600 });
    return AttachmentRefSchema.parse({ id, filename: safeName, mimeType: mime, size: buffer.length, relativePath: path.relative(this.storageBaseDir, target), sha256: crypto.createHash('sha256').update(buffer).digest('hex'), extractedText, analysisStatus: isImage(mime) ? 'unsupported' : 'not_required', analysisResult: isImage(mime) ? FALLBACK_VISION_PROMPT : null });
  }
  async analyzeAttachment(attachment: AttachmentRef): Promise<AttachmentRef> {
    if (!isImage(attachment.mimeType)) return attachment;
    try {
      if (!(await this.visionProvider.isAvailable())) return { ...attachment, analysisStatus: 'unsupported', analysisResult: FALLBACK_VISION_PROMPT };
      const result = await this.visionProvider.analyzeImage({ filePath: this.resolveAttachmentPath(attachment), prompt: FALLBACK_VISION_PROMPT });
      const status: AnalysisStatus = result.status === 'failed' ? 'failed' : result.status === 'unsupported' ? 'unsupported' : 'completed';
      if (status !== 'completed') return { ...attachment, analysisStatus: status, analysisResult: FALLBACK_VISION_PROMPT };
      return { ...attachment, analysisStatus: status, analysisResult: redactAttachmentText(JSON.stringify({ description: result.description, visibleText: result.visibleText, observations: result.observations, confidence: result.confidence })) };
    } catch { return { ...attachment, analysisStatus: 'failed', analysisResult: FALLBACK_VISION_PROMPT }; }
  }
  async extractOcr(attachment: AttachmentRef): Promise<{ text: string[]; available: boolean }> {
    if (!this.ocrProvider || !isImage(attachment.mimeType) || !(await this.ocrProvider.isAvailable())) return { text: [], available: false };
    try { return { text: (await this.ocrProvider.extractText(this.resolveAttachmentPath(attachment))).map(redactAttachmentText), available: true }; } catch { return { text: [], available: false }; }
  }
  resolveAttachmentPath(attachment: Pick<AttachmentRef, 'relativePath'>): string { if (!attachment.relativePath || path.isAbsolute(attachment.relativePath)) throw new AttachmentError('Attachment path is invalid', 'UNSAFE_PATH'); const value = path.resolve(this.storageBaseDir, attachment.relativePath); if (!value.startsWith(`${this.storageBaseDir}${path.sep}`)) throw new AttachmentError('Attachment path escapes storage', 'UNSAFE_PATH'); return value; }
}
export { FALLBACK_VISION_PROMPT } from '@llmbugfix/vision-provider';
