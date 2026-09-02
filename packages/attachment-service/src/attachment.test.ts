import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentError, AttachmentService, FALLBACK_VISION_PROMPT } from './index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const service = (options = {}) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-attachments-')); roots.push(root); return new AttachmentService(root, options); };

describe('AttachmentService', () => {
  it.each([
    ['image/png', 'screen.png'], ['image/jpeg', 'screen.jpg'], ['image/jpeg', 'screen.jpeg'], ['image/webp', 'screen.webp'],
    ['text/plain', 'notes.txt'], ['text/plain', 'server.log'], ['application/json', 'data.json'], ['application/json', 'trace.har'], ['video/mp4', 'capture.mp4'],
  ])('stores allowed %s (%s) with a digest', (mime, filename) => {
    const data = mime === 'application/json' ? Buffer.from(filename.endsWith('.har') ? JSON.stringify({ log: { version: '1.2', entries: [] } }) : '{"ok":true}') : Buffer.from(`content for ${filename}`); const result = service().saveAttachment('BUG-000001', filename, mime, data);
    expect(result.sha256).toBe(crypto.createHash('sha256').update(data).digest('hex'));
    expect(fs.readFileSync(path.join(roots.at(-1)!, result.relativePath))).toEqual(data);
  });

  it('rejects unknown types, mismatched extensions, unsafe paths and oversized data', () => {
    const instance = service({ maxBytes: 3 });
    expect(() => instance.saveAttachment('BUG-000001', 'x.exe', 'image/png', Buffer.from('x'))).toThrow(AttachmentError);
    expect(() => instance.saveAttachment('BUG-000001', '../x.txt', 'text/plain', Buffer.from('x'))).toThrow(/unsafe/i);
    expect(() => instance.saveAttachment('../BUG-000001', 'x.txt', 'text/plain', Buffer.from('x'))).toThrow(/unsafe/i);
    expect(() => instance.saveAttachment('BUG-000001', 'x.txt', 'text/plain', Buffer.from('1234'))).toThrow(/size/i);
  });

  it('redacts secrets and validates JSON/HAR before persistence', () => {
    const instance = service();
    const text = instance.saveAttachment('BUG-000001', 'x.log', 'text/plain', Buffer.from('Authorization: Bearer abc.def\npassword=hello\nCookie: sid=secret'));
    expect(text.extractedText).not.toMatch(/abc\.def|hello|sid=secret/);
    expect(() => instance.saveAttachment('BUG-000001', 'x.json', 'application/json', Buffer.from('{'))).toThrow(/JSON/i);
    expect(() => instance.saveAttachment('BUG-000001', 'x.har', 'application/json', Buffer.from('{}'))).toThrow(/HAR/i);
    const har = instance.saveAttachment('BUG-000001', 'x.har', 'application/json', Buffer.from(JSON.stringify({ log: { version: '1.2', entries: [{ request: {} }] } })));
    expect(har.extractedText).toContain('version');
  });

  it('uses bounded extraction and a safe disabled-vision fallback', () => {
    const result = service({ maxExtractedBytes: 16 }).saveAttachment('BUG-000001', 'x.txt', 'text/plain', Buffer.alloc(100, 97));
    expect(Buffer.byteLength(result.extractedText!)).toBeLessThanOrEqual(32);
    const image = service().saveAttachment('BUG-000001', 'x.png', 'image/png', Buffer.from('png'));
    expect(image.analysisStatus).toBe('unsupported'); expect(image.analysisResult).toBe(FALLBACK_VISION_PROMPT);
  });
});
