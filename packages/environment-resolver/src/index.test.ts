import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnvironmentBlockedError, EnvironmentResolver } from '@llmbugfix/environment-resolver';

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-resolver-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true }); fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'facts.md'), 'facts'); fs.writeFileSync(path.join(root, 'skills', 'behavior.md'), 'behavior');
  const config = path.join(root, 'environments.yaml'); fs.writeFileSync(config, 'environments:\n  - id: one\n    name: One\n    target: frontend\n    repository: "${REPO}"\n    markdown: [docs/facts.md]\n    skills: [skills/behavior.md]\n');
  return { root, config };
};

describe('EnvironmentResolver', () => {
  it('loads ordered context and resolves the approved repository from the server environment', () => { const value = fixture(); const result = new EnvironmentResolver(value.config, value.root, { env: { REPO: '/approved/repository' } }).resolveProfile('frontend'); expect(result.profile.repository).toBe('/approved/repository'); expect(result.context.map((entry) => entry.kind)).toEqual(['markdown', 'skill']); expect(result.docsContent).toBe('facts'); expect(result.skillContent).toBe('behavior'); });
  it('blocks an unresolved repository placeholder', () => { const value = fixture(); expect(() => new EnvironmentResolver(value.config, value.root, { env: {} })).toThrowError(/Repository environment variable is not configured: REPO/); });
  it('blocks missing, escaping and oversized files', () => {
    const value = fixture(); fs.writeFileSync(value.config, fs.readFileSync(value.config, 'utf8').replace('docs/facts.md', '../outside.md'));
    expect(() => new EnvironmentResolver(value.config, value.root, { env: { REPO: '/repo' } }).resolveProfile('frontend')).toThrowError(EnvironmentBlockedError);
    const sizeConfig = fs.readFileSync(value.config, 'utf8').replace('../outside.md', 'docs/facts.md'); fs.writeFileSync(value.config, sizeConfig); fs.writeFileSync(path.join(value.root, 'docs', 'facts.md'), '12345');
    expect(() => new EnvironmentResolver(value.config, value.root, { maxFileBytes: 2, env: { REPO: '/repo' } }).resolveProfile('frontend')).toThrowError(/size limit/);
  });
  it('blocks zero and ambiguous target matches while honoring explicit id', () => {
    const value = fixture(); const text = fs.readFileSync(value.config, 'utf8').replace('target: frontend', 'target: backend'); fs.writeFileSync(value.config, `${text}\n  - id: two\n    name: Two\n    target: frontend\n    repository: "${'${REPO2}'}"\n    markdown: [docs/facts.md]\n    skills: [skills/behavior.md]\n`);
    const resolver = new EnvironmentResolver(value.config, value.root, { env: { REPO: '/repo', REPO2: '/repo2' } }); expect(() => resolver.resolveProfile('mobile')).toThrowError(/BLOCKED|No environment/); expect(() => resolver.resolveProfile('frontend')).not.toThrow(); expect(() => resolver.resolveProfile('frontend', 'none')).toThrowError(/not found/); expect(() => resolver.resolveProfile('backend', 'two')).toThrowError(/does not match target/);
  });
});
