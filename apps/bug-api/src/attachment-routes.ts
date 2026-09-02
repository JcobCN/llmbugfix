import type { BugRepository } from '@llmbugfix/bug-repository';
import { AttachmentError, AttachmentService } from '@llmbugfix/attachment-service';
import { FALLBACK_VISION_PROMPT } from '@llmbugfix/vision-provider';

export type AttachmentRouteRequest = { method?: string; pathname: string; body?: Record<string, unknown> };
export type AttachmentRouteResponse = { status: number; body: unknown };
export type AttachmentRouteDependencies = { attachments: AttachmentService; repo?: BugRepository };

const response = (status: number, body: unknown): AttachmentRouteResponse => ({ status, body });
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/**
 * Attachment and internal-vision routes are kept as a small plugin so the API
 * startup skeleton does not acquire a direct dependency on a vision model.
 * Return undefined for paths owned by the normal bug API.
 */
export function createAttachmentRoutes(deps: AttachmentRouteDependencies) {
  return async (request: AttachmentRouteRequest): Promise<AttachmentRouteResponse | undefined> => {
    const method = (request.method ?? 'GET').toUpperCase();
    const body = request.body ?? {};
    const upload = request.pathname.match(/^\/api\/bugs\/([^/]+)\/attachments$/);
    if (upload) {
      if (method === 'GET') return deps.repo ? response(200, { attachments: deps.repo.listAttachments(upload[1]) }) : response(404, { error: 'Attachment listing is unavailable' });
      if (method !== 'POST') return response(405, { error: 'Method not allowed' });
      if (deps.repo && !deps.repo.getBug(upload[1])) return response(404, { error: 'Bug report not found' });
      const filename = typeof body.filename === 'string' ? body.filename : '';
      const mimeType = typeof body.mimeType === 'string' ? body.mimeType : '';
      const encoded = typeof body.data === 'string' ? body.data : typeof body.base64 === 'string' ? body.base64 : '';
      if (!filename || !mimeType || !encoded) return response(400, { error: 'filename, mimeType and base64 data are required' });
      try {
        const buffer = Buffer.from(encoded, 'base64');
        // Reject malformed base64 rather than silently decoding arbitrary text.
        if (!buffer.length || encoded.replace(/\s/g, '').replace(/=+$/, '').length % 4 === 1) return response(400, { error: 'Invalid base64 attachment data' });
        const attachment = deps.attachments.saveAttachment(upload[1], filename, mimeType, buffer);
        if (deps.repo) deps.repo.addAttachment(upload[1], attachment);
        return response(201, { attachment });
      } catch (error) { return response(error instanceof AttachmentError ? 400 : 500, { error: error instanceof Error ? error.message : 'Attachment upload failed' }); }
    }
    const vision = request.pathname === '/internal/vision/analyze';
    if (vision) {
      if (method !== 'POST') return response(405, { error: 'Method not allowed' });
      const relativePath = typeof body.relativePath === 'string' ? body.relativePath : '';
      if (!relativePath) return response(400, { error: 'relativePath is required' });
      try {
        const filePath = deps.attachments.resolveAttachmentPath({ relativePath });
        const result = await deps.attachments.visionProvider.analyzeImage({ filePath, prompt: typeof body.prompt === 'string' ? body.prompt : FALLBACK_VISION_PROMPT });
        return response(200, { analysisStatus: result.status ?? 'completed', description: result.description, visibleText: result.visibleText, machineObservations: result.observations, reporterObservations: [], confidence: result.confidence, fallbackPrompt: result.status === 'completed' ? null : FALLBACK_VISION_PROMPT });
      } catch { return response(200, { analysisStatus: 'failed', description: FALLBACK_VISION_PROMPT, visibleText: [], machineObservations: [], reporterObservations: [], confidence: 0, fallbackPrompt: FALLBACK_VISION_PROMPT }); }
    }
    return undefined;
  };
}

export const isAttachmentRouteBody = isObject;
