import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { GitLabPushTarget, mirrorProjectName } from './gitlab.js';

const SIGN_IN_PAGE = '<form><input name="authenticity_token" value="tok-signin" type="hidden"></form>';
const PAT_PAGE = '<form><input name="authenticity_token" value="tok-pat" type="hidden"></form>';
const CREATED_PAGE = '<input type="text" id="created-personal-access-token" value="glpat-created123" readonly>';

interface Call { url: string; method: string; body?: string; headers: Record<string, string> }

/** Stateful fetch double covering the web-session and API flows. */
function fakeGitLab(options: { projectExists?: boolean; projectVisibility?: 'private' | 'public' } = {}) {
  const calls: Call[] = [];
  let patViews = 0;
  const projectVisibility = options.projectVisibility ?? 'public';
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}) as [string, string][]);
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined, headers });
    const response = (status: number, body: string, setCookie?: string) => new Response(body, { status, headers: setCookie ? { 'set-cookie': setCookie } : {} });
    if (url.endsWith('/users/sign_in') && (init.method ?? 'GET') === 'GET') return response(200, SIGN_IN_PAGE, '_gitlab_session=abc');
    if (url.endsWith('/users/sign_in') && init.method === 'POST') return response(302, '', '_gitlab_session=abc; path=/');
    if (url.endsWith('/profile/personal_access_tokens') && (init.method ?? 'GET') === 'GET') {
      patViews += 1;
      return response(200, patViews === 1 ? PAT_PAGE : CREATED_PAGE);
    }
    if (url.endsWith('/profile/personal_access_tokens') && init.method === 'POST') return response(302, '');
    if (url.includes('/api/v4/projects/')) {
      if (init.method === 'PUT') return response(200, '{"visibility":"public"}');
      return response(options.projectExists ? 200 : 404, options.projectExists ? `{"visibility":"${projectVisibility}"}` : '{"message":"404 Project Not Found"}');
    }
    if (url.endsWith('/api/v4/projects') && init.method === 'POST') return response(201, '{"visibility":"public"}');
    return response(404, '');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function target(options: Partial<ConstructorParameters<typeof GitLabPushTarget>[0]> = {}) {
  return new GitLabPushTarget({ baseUrl: 'http://172.29.100.126', account: 'codigger-llm', ...options });
}

function fillGitCredential(environment: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'fill'], { env: { ...process.env, ...environment } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end('protocol=http\nhost=172.29.100.126\n\n');
  });
}

describe('mirrorProjectName', () => {
  it('uses the source repository leaf segment', () => {
    expect(mirrorProjectName('https://git.example.test/team/storefront.git')).toBe('storefront');
    expect(mirrorProjectName('http://172.29.100.126/group/project.git')).toBe('project');
    expect(mirrorProjectName('git@github.com:team/repo.git')).toBe('repo');
    expect(mirrorProjectName('https://git.example.test/a%20b/c%20d.git')).toBe('c-d');
  });
  it('sanitizes unsafe leaves and falls back to a stable digest', () => {
    expect(mirrorProjectName('https://git.example.test/team/.hidden.git')).toBe('hidden');
    expect(mirrorProjectName('https://git.example.test/team/-x-.git')).toBe('x');
    expect(mirrorProjectName('https://git.example.test/team/..git')).toMatch(/^repo-[a-f0-9]{10}$/u);
    expect(mirrorProjectName('https://git.example.test/')).toMatch(/^repo-[a-f0-9]{10}$/u);
    expect(mirrorProjectName('https://git.example.test/team/a.git')).toBe('a');
  });
});

describe('GitLabPushTarget', () => {
  it('uses a configured PAT and creates a missing public project', async () => {
    const { fetchImpl, calls } = fakeGitLab({ projectExists: false });
    const url = await target({ token: 'pat-configured', fetchImpl }).ensureProject('storefront');
    expect(url).toBe('http://172.29.100.126/codigger-llm/storefront.git');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET http://172.29.100.126/api/v4/projects/codigger-llm%2Fstorefront',
      'POST http://172.29.100.126/api/v4/projects',
    ]);
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('pat-configured');
    expect(calls[1].body).toContain('visibility=public');
    expect(calls[1].body).toContain('name=storefront');
  });

  it('skips creation when the mirror project already exists', async () => {
    const { fetchImpl, calls } = fakeGitLab({ projectExists: true });
    const url = await target({ token: 'pat-configured', fetchImpl }).ensureProject('storefront');
    expect(url).toBe('http://172.29.100.126/codigger-llm/storefront.git');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('makes an existing private mirror project public', async () => {
    const { fetchImpl, calls } = fakeGitLab({ projectExists: true, projectVisibility: 'private' });
    await target({ token: 'pat-configured', fetchImpl }).ensureProject('storefront');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].body).toContain('visibility=public');
  });

  it('single-flights concurrent ensureProject calls for one mirror project', async () => {
    const { fetchImpl, calls } = fakeGitLab({ projectExists: false });
    const pushTarget = target({ token: 'pat-configured', fetchImpl });
    const urls = await Promise.all([
      pushTarget.ensureProject('storefront'),
      pushTarget.ensureProject('storefront'),
      pushTarget.ensureProject('storefront'),
    ]);
    expect(urls).toEqual([
      'http://172.29.100.126/codigger-llm/storefront.git',
      'http://172.29.100.126/codigger-llm/storefront.git',
      'http://172.29.100.126/codigger-llm/storefront.git',
    ]);
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/api/v4/projects/'))).toHaveLength(1);
  });

  it('bootstraps and caches a PAT in memory when no token is configured', async () => {
    const { fetchImpl, calls } = fakeGitLab({ projectExists: true });
    const pushTarget = target({ fetchImpl, password: 'explicit-test-password' });
    await Promise.all([pushTarget.ensureProject('storefront'), pushTarget.ensureProject('another')]);
    expect(calls.filter((call) => call.url.endsWith('/users/sign_in') && call.method === 'GET')).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith('/profile/personal_access_tokens') && call.method === 'POST')).toHaveLength(1);
    const environment = await pushTarget.gitCredentialEnvironment();
    expect(environment.LLMBUGFIX_GIT_TOKEN).toBe('glpat-created123');
    expect(environment.GIT_CONFIG_VALUE_1).not.toContain('glpat-created123');
  });

  it('passes a configured PAT to Git through a host-scoped in-memory helper', async () => {
    const { fetchImpl, calls } = fakeGitLab({ projectExists: true });
    const pushTarget = target({ fetchImpl, token: 'pat-configured' });
    await pushTarget.ensureProject('storefront');
    const environment = await pushTarget.gitCredentialEnvironment();
    expect(environment.LLMBUGFIX_GIT_TOKEN).toBe('pat-configured');
    expect(environment.LLMBUGFIX_GIT_USERNAME).toBe('codigger-llm');
    expect(environment.LLMBUGFIX_GIT_HOST).toBe('172.29.100.126');
    expect(environment.GIT_CONFIG_VALUE_0).toBe('');
    expect(environment.GIT_CONFIG_VALUE_1).toContain('LLMBUGFIX_GIT_TOKEN');
    expect(calls.some((call) => call.url.endsWith('/users/sign_in'))).toBe(false);
    const filled = await fillGitCredential(environment);
    expect(filled.code, filled.stderr).toBe(0);
    expect(filled.stdout).toContain('username=codigger-llm');
    expect(filled.stdout).toContain('password=pat-configured');
  });

  it('rejects an invalid GitLab base URL or account', () => {
    expect(() => target({ baseUrl: 'ftp://x', token: 'pat-configured', fetchImpl: fakeGitLab().fetchImpl })).toThrow(/http\(s\)/u);
    expect(() => target({ account: 'bad/account', token: 'pat-configured', fetchImpl: fakeGitLab().fetchImpl })).toThrow(/account/u);
  });
});
