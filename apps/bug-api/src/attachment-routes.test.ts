import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentService } from '@llmbugfix/attachment-service';
import { createAttachmentRoutes } from './attachment-routes.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('attachment route plugin', () => {
  it('uploads base64 content and keeps vision degradation successful', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-')); roots.push(root);
    const routes = createAttachmentRoutes({ attachments: new AttachmentService(root) });
    const upload = await routes({ method: 'POST', pathname: '/api/bugs/BUG-000001/attachments', body: { filename: 'screen.png', mimeType: 'image/png', data: Buffer.from('image').toString('base64') } });
    expect(upload?.status).toBe(201);
    const vision = await routes({ method: 'POST', pathname: '/internal/vision/analyze', body: { relativePath: (upload?.body as { attachment: { relativePath: string } }).attachment.relativePath } });
    expect(vision?.status).toBe(200); expect((vision?.body as { analysisStatus: string }).analysisStatus).toBe('unsupported'); expect((vision?.body as { reporterObservations: string[] }).reporterObservations).toEqual([]);
  });
  it('rejects malformed upload data', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-api-')); roots.push(root);
    const routes = createAttachmentRoutes({ attachments: new AttachmentService(root) });
    const result = await routes({ method: 'POST', pathname: '/api/bugs/BUG-000001/attachments', body: { filename: 'x.txt', mimeType: 'text/plain', data: '!' } });
    expect(result?.status).toBe(400);
  });
});
