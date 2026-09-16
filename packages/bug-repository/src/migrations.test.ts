import { describe, expect, it } from 'vitest';
import { openDatabase } from './index.js';

describe('versioned database migrations', () => {
  it('records migrations transactionally and installs lease/task tables', () => {
    const database = openDatabase(':memory:');
    expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
    for (const table of ['task_repositories', 'idempotency_keys', 'task_events']) expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'jobs_one_running_idx'").get()).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'jobs_active_bug_uidx'").get()).toBeTruthy();
    database.close();
  });
});
