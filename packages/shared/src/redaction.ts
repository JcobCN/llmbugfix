const SECRET = /((?:password|passwd|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*)([^\s,;]+)/gi;
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => /password|token|secret|api[_-]?key|authorization|cookie/i.test(k) ? [k, '[REDACTED]'] : [k, redactSecrets(v)]));
  return value;
}

const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;

/** A short, single-line diagnostic suitable for logs and persistence. */
export function sanitizeDiagnostic(value: unknown, maximumCodePoints = 256): string {
  const source = value instanceof Error ? value.message : typeof value === 'string' ? value : 'Unknown error';
  const oneLine = String(redactSecrets(source)).replace(EMAIL, '[EMAIL REDACTED]').replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim() || 'Unknown error';
  const points = Array.from(oneLine);
  if (points.length <= maximumCodePoints) return oneLine;
  const marker = '…[truncated]';
  return `${points.slice(0, Math.max(0, maximumCodePoints - Array.from(marker).length)).join('')}${marker}`;
}
