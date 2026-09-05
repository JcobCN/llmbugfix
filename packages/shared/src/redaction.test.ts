import { describe, expect, it } from 'vitest';
import { redactSecrets, safeLogContext } from './index.js';

describe('secret redaction', () => {
  it('preserves log context while redacting secret fields and values', () => {
    const context = {
      path: '/api/bugs/conversations/123/messages',
      method: 'POST',
      error: 'This operation was aborted',
      request: { apiKey: 'top-secret', message: 'token: abc123' },
    };

    expect(redactSecrets(context)).toEqual({
      path: '/api/bugs/conversations/123/messages',
      method: 'POST',
      error: 'This operation was aborted',
      request: { apiKey: '[REDACTED]', message: 'token: [REDACTED]' },
    });
    expect(safeLogContext({ path: context.path, method: context.method, error: context.error })).toEqual({
      path: context.path,
      method: context.method,
      error: context.error,
    });
  });
});
