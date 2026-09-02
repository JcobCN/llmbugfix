const SECRET = /((?:password|passwd|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*)([^\s,;]+)/gi;
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET, '$1[REDACTED]');
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [/password|token|secret|api[_-]?key|authorization|cookie/i.test(k) ? [k, '[REDACTED]'] : [k, redactSecrets(v)] ]));
  return value;
}
