import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId } from '@llmbugfix/shared';
import { openDatabase, SQLiteBugDocumentStore, SQLiteBugRepository, DocumentRevisionConflictError, DocumentPathError } from '@llmbugfix/bug-repository';
import { evaluateCompleteness } from '@llmbugfix/intake-policy';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('SQLiteBugDocumentStore', () => {
  it('persists Markdown, increments revision, detects external edits, and rejects stale CAS', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-doc-')); roots.push(root);
    const db = openDatabase(); const repo = new SQLiteBugRepository(db); const reporterId = newId(); const conversationId = newId();
    repo.createUser({ id: reporterId, displayName: 'Tester', email: null });
    repo.createConversation({ id: conversationId, reporterId, status: 'active', draft: {}, completeness: evaluateCompleteness({}) });
    const store = new SQLiteBugDocumentStore(db, root); const first = store.create(conversationId, '# Initial\n');
    expect(first.revision).toBe(1); expect(fs.existsSync(path.join(root, 'intake-documents', conversationId, 'bug-report.md'))).toBe(true);
    const second = store.write(conversationId, '# Changed\n', first.revision); expect(second.revision).toBe(2); expect(second.sha256).not.toBe(first.sha256);
    expect(() => store.write(conversationId, '# stale\n', first.revision)).toThrow(DocumentRevisionConflictError);
    fs.writeFileSync(path.join(root, 'intake-documents', conversationId, 'bug-report.md'), '# Outside edit\n');
    const dirty = store.refresh(conversationId); expect(dirty.revision).toBe(3); expect(dirty.syncStatus).toBe('dirty');
    const synced = store.markReconciled(conversationId, dirty.revision, dirty.sha256); expect(synced.syncStatus).toBe('synced');
    db.close();
  });

  it('rejects symlink escapes and immutable submitted documents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-doc-')); roots.push(root);
    const db = openDatabase(); const repo = new SQLiteBugRepository(db); const reporterId = newId(); const conversationId = newId();
    repo.createUser({ id: reporterId, displayName: 'Tester', email: null }); repo.createConversation({ id: conversationId, reporterId, status: 'active', draft: {}, completeness: evaluateCompleteness({}) });
    const store = new SQLiteBugDocumentStore(db, root); const first = store.create(conversationId, '# Initial\n');
    const escapedConversationId = newId();
    repo.createConversation({ id: escapedConversationId, reporterId, status: 'active', draft: {}, completeness: evaluateCompleteness({}) });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-outside-')); roots.push(outside);
    fs.symlinkSync(outside, path.join(root, 'intake-documents', escapedConversationId));
    expect(() => store.create(escapedConversationId, '# escaped\n')).toThrow(DocumentPathError);
    repo.updateConversation(conversationId, { status: 'submitted' });
    expect(() => store.write(conversationId, '# changed', first.revision)).toThrow(DocumentPathError);
    db.close();
  });
});
