import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { SqliteDatabase } from './database.js';

const SHA256 = /^[a-f0-9]{64}$/iu;
const MAX_BUG_DOCUMENT_BYTES = 128 * 1024;
type DocumentSyncStatus = 'synced' | 'dirty' | 'reconciling' | 'conflict';
export type DocumentSnapshot = { conversationId?: string; content: string; revision: number; sha256: string; reconciledRevision: number; reconciledSha256: string; syncStatus: DocumentSyncStatus; updatedAt?: string };

export class DocumentRevisionConflictError extends Error {
  readonly code = 'DOCUMENT_REVISION_CONFLICT';
  constructor(readonly snapshot: DocumentSnapshot, message = 'Document revision is stale') { super(message); this.name = 'DocumentRevisionConflictError'; }
}
export class DocumentPathError extends Error {
  readonly code = 'DOCUMENT_PATH_INVALID';
  constructor(message: string) { super(message); this.name = 'DocumentPathError'; }
}
export class DocumentReconciliationRequiredError extends Error {
  readonly code = 'DOCUMENT_RECONCILIATION_REQUIRED';
  constructor(readonly snapshot: DocumentSnapshot, message = 'Document must be reconciled before this operation') { super(message); this.name = 'DocumentReconciliationRequiredError'; }
}

export interface BugDocumentStore {
  create(conversationId: string, initialContent: string): DocumentSnapshot;
  read(conversationId: string): DocumentSnapshot;
  write(conversationId: string, content: string, baseRevision: number): DocumentSnapshot;
  refresh(conversationId: string): DocumentSnapshot;
  markReconciled(conversationId: string, revision: number, sha256: string): DocumentSnapshot;
}

type DocumentRow = { conversation_id: string; relative_path: string; revision: number; sha256: string; reconciled_revision: number; reconciled_sha256: string; sync_status: string; updated_at: string };

function digest(content: string): string { return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'); }
function byteLength(content: string): number { return Buffer.byteLength(content, 'utf8'); }
function assertUtf8Text(content: string): void {
  if (content.includes('\0')) throw new DocumentPathError('Document content must be UTF-8 Markdown text');
  if (byteLength(content) > MAX_BUG_DOCUMENT_BYTES) throw new DocumentPathError(`Document exceeds ${MAX_BUG_DOCUMENT_BYTES} byte limit`);
  // A JavaScript lone surrogate is not valid Unicode text and would be replaced by Buffer.
  if (/[\uD800-\uDFFF]/u.test(content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ''))) throw new DocumentPathError('Document content must contain valid UTF-8 text');
}
function isInside(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }
function safeConversationId(conversationId: string): void { if (!/^[A-Za-z0-9_-]+$/u.test(conversationId)) throw new DocumentPathError('Invalid conversation id'); }

/**
 * A file-backed document store. Metadata is authoritative for CAS, while every read first
 * hashes the actual file so edits made outside the API are observed at the next boundary.
 */
export class SQLiteBugDocumentStore implements BugDocumentStore {
  private readonly dataRoot: string;
  private readonly documentsRoot: string;
  constructor(private readonly database: SqliteDatabase, dataRoot = 'data') {
    this.dataRoot = path.resolve(dataRoot);
    this.documentsRoot = path.resolve(this.dataRoot, 'intake-documents');
    if (!isInside(this.dataRoot, this.documentsRoot)) throw new DocumentPathError('Document root escapes DATA_ROOT');
    this.assertNoSymlinkAncestors(this.dataRoot);
    this.ensureDirectory(this.dataRoot);
    this.ensureDirectory(this.documentsRoot);
  }

  private assertNoSymlinkAncestors(target: string): void {
    const parsed = path.parse(target); let cursor = parsed.root;
    for (const item of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, item);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new DocumentPathError('DATA_ROOT must not contain symlink ancestors');
    }
  }

  private ensureDirectory(directory: string): void {
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DocumentPathError('Document path must not be a symlink');
    } else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private paths(conversationId: string): { directory: string; file: string; relativePath: string } {
    safeConversationId(conversationId);
    const directory = path.resolve(this.documentsRoot, conversationId);
    const file = path.resolve(directory, 'bug-report.md');
    if (!isInside(this.documentsRoot, directory) || !isInside(this.documentsRoot, file)) throw new DocumentPathError('Document path escapes DATA_ROOT');
    return { directory, file, relativePath: path.relative(this.dataRoot, file).split(path.sep).join('/') };
  }
  private assertNoSymlink(file: string, allowMissing = true): void {
    const relative = path.relative(this.dataRoot, file).split(path.sep);
    let cursor = this.dataRoot;
    for (const item of relative) {
      cursor = path.join(cursor, item);
      if (!fs.existsSync(cursor)) { if (allowMissing) continue; throw new DocumentPathError('Document path does not exist'); }
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new DocumentPathError('Document path must not follow symlinks');
    }
  }
  private ensureConversationDirectory(conversationId: string): { directory: string; file: string; relativePath: string } {
    const value = this.paths(conversationId);
    this.assertNoSymlink(this.dataRoot);
    this.ensureDirectory(this.documentsRoot);
    if (fs.existsSync(value.directory)) {
      this.assertNoSymlink(value.directory);
      this.ensureDirectory(value.directory);
    } else fs.mkdirSync(value.directory, { recursive: false, mode: 0o700 });
    return value;
  }
  private row(conversationId: string): DocumentRow | undefined {
    return this.database.prepare('SELECT * FROM conversation_documents WHERE conversation_id = ?').get(conversationId) as DocumentRow | undefined;
  }
  private assertConversationActive(conversationId: string): void {
    const row = this.database.prepare('SELECT status FROM bug_conversations WHERE id = ?').get(conversationId) as { status?: string } | undefined;
    if (row?.status === 'submitted') throw new DocumentPathError('Submitted conversation documents are immutable');
  }
  private load(conversationId: string, refresh = true): DocumentSnapshot {
    const paths = this.paths(conversationId);
    const metadata = this.row(conversationId);
    if (!metadata || !fs.existsSync(paths.file)) throw new Error(`Document not found for conversation ${conversationId}`);
    this.assertNoSymlink(paths.file, false);
    const stat = fs.lstatSync(paths.file); if (!stat.isFile()) throw new DocumentPathError('Document path is not a regular file');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(paths.file)); assertUtf8Text(content);
    const actualSha = digest(content);
    let row = metadata;
    if (refresh && actualSha !== metadata.sha256) {
      const updatedAt = new Date().toISOString();
      this.database.prepare('UPDATE conversation_documents SET revision = revision + 1, sha256 = ?, sync_status = ?, updated_at = ? WHERE conversation_id = ?').run(actualSha, 'dirty', updatedAt, conversationId);
      row = this.row(conversationId)!;
    }
    const status = ['synced', 'dirty', 'reconciling', 'conflict'].includes(row.sync_status) ? row.sync_status as DocumentSyncStatus : 'conflict';
    return { conversationId, content, revision: Number(row.revision), sha256: actualSha, reconciledRevision: Number(row.reconciled_revision), reconciledSha256: row.reconciled_sha256, syncStatus: actualSha === row.reconciled_sha256 && Number(row.revision) === Number(row.reconciled_revision) ? 'synced' : status, updatedAt: row.updated_at };
  }
  create(conversationId: string, initialContent: string): DocumentSnapshot {
    assertUtf8Text(initialContent); this.assertConversationActive(conversationId);
    const paths = this.ensureConversationDirectory(conversationId);
    const existing = this.row(conversationId);
    if (existing && fs.existsSync(paths.file)) return this.load(conversationId);
    this.atomicWrite(paths.file, initialContent);
    const sha256 = digest(initialContent); const updatedAt = new Date().toISOString();
    this.database.prepare('INSERT OR REPLACE INTO conversation_documents (conversation_id, relative_path, revision, sha256, reconciled_revision, reconciled_sha256, sync_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(conversationId, paths.relativePath, 1, sha256, 1, sha256, 'synced', updatedAt);
    return this.load(conversationId, false);
  }
  read(conversationId: string): DocumentSnapshot { return this.load(conversationId); }
  refresh(conversationId: string): DocumentSnapshot { return this.load(conversationId, true); }
  write(conversationId: string, content: string, baseRevision: number): DocumentSnapshot {
    assertUtf8Text(content); this.assertConversationActive(conversationId);
    const current = this.refresh(conversationId);
    if (!Number.isInteger(baseRevision) || baseRevision !== current.revision) throw new DocumentRevisionConflictError(current);
    const paths = this.paths(conversationId); this.assertNoSymlink(paths.file, false); this.atomicWrite(paths.file, content);
    const sha256 = digest(content); const updatedAt = new Date().toISOString();
    this.database.prepare('UPDATE conversation_documents SET revision = revision + 1, sha256 = ?, sync_status = ?, updated_at = ? WHERE conversation_id = ? AND revision = ?').run(sha256, 'dirty', updatedAt, conversationId, current.revision);
    const updated = this.refresh(conversationId);
    if (updated.revision !== current.revision + 1) throw new DocumentRevisionConflictError(updated, 'Document changed while writing');
    return updated;
  }
  markReconciled(conversationId: string, revision: number, sha256: string): DocumentSnapshot {
    if (!SHA256.test(sha256)) throw new DocumentPathError('Invalid document SHA-256');
    const current = this.refresh(conversationId);
    if (current.revision !== revision || current.sha256 !== sha256) throw new DocumentRevisionConflictError(current, 'Document changed before reconciliation completed');
    this.database.prepare('UPDATE conversation_documents SET reconciled_revision = ?, reconciled_sha256 = ?, sync_status = ?, updated_at = ? WHERE conversation_id = ? AND revision = ? AND sha256 = ?').run(revision, sha256, 'synced', new Date().toISOString(), conversationId, revision, sha256);
    return this.load(conversationId, false);
  }
  private atomicWrite(file: string, content: string): void {
    const directory = path.dirname(file); this.assertNoSymlink(directory, false);
    const temporary = path.join(directory, `.bug-report.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try { fs.writeFileSync(descriptor, content, { encoding: 'utf8' }); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, file);
      try { fs.chmodSync(file, 0o600); } catch { /* chmod may be unavailable on some platforms */ }
    } catch (error) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original error */ }
      throw error;
    }
  }
}

export const BugDocumentStore = SQLiteBugDocumentStore;
