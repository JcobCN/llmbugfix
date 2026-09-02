import { describe, expect, it } from 'vitest';
import { DisabledOcrProvider, DisabledVisionProvider, FALLBACK_VISION_PROMPT, HttpVisionProvider } from './index.js';

describe('optional vision providers', () => {
  it('disabled providers are explicit and harmless', async () => {
    const vision = new DisabledVisionProvider(); const ocr = new DisabledOcrProvider();
    expect(await vision.isAvailable()).toBe(false); expect((await vision.analyzeImage({ filePath: '/no-file', prompt: 'x' })).description).toBe(FALLBACK_VISION_PROMPT);
    expect(await ocr.isAvailable()).toBe(false); expect(await ocr.extractText('/no-file')).toEqual([]);
  });
  it('rejects public vision endpoints', () => { expect(() => new HttpVisionProvider('https://example.com')).toThrow(/private/i); });
  it('times out and degrades without throwing', async () => {
    const provider = new HttpVisionProvider('http://127.0.0.1:1', { timeoutMs: 20 });
    const result = await provider.analyzeImage({ filePath: '/no-file', prompt: 'x' });
    expect(result.status).toMatch(/failed|unsupported/); expect(result.description).toBe(FALLBACK_VISION_PROMPT);
  });
});
