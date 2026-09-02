import path from 'node:path';
import { BoundaryError } from './errors.js';

/** Resolve a user supplied relative path and ensure it remains below root. */
export function safeRelativePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new BoundaryError('Path must be a non-empty relative path');
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new BoundaryError('Path escapes its configured root');
  return path.relative(base, resolved);
}

export const attachmentPath = (root: string, bugKey: string, filename: string): string => safeRelativePath(root, path.join(bugKey, filename));

/** Compatibility helper: validate and return an absolute path under root. */
export function assertPathSafe(root: string, candidate: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new BoundaryError('Path escapes its configured root');
  return resolved;
}
