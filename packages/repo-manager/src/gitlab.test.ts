import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitLabPushTarget, mirrorProjectName } from './gitlab.js';

const SIGN_IN_PAGE = '<form><input name="authenticity_token" value="tok-signin" type="hidden"></form>';
const PAT_PAGE = '<form><input name="authenticity_token" value="tok-pat" type="hidden"></form>';
const CREATED_PAGE = '<input type="text" id="created-personal-access-token" value="glpat-created123" readonly>';

interface Call { url: string; method: string; body?: string; headers: Record<string, string> }

/** Stateful fetch double covering the web-session and API flows. */
function fakeGitLab(options: { projectExists?: boolean } = {}) {
  const calls: Call[] = [];
  let patViews = 0;
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
    if (url.includes('/api/v4/projects/')) return response(options.projectExists ? 200 : 404, options.projectExists ? '{"visibility":"private"}' : '{"message":"404 Project Not Found"}');
    if (url.endsWith('/api/v4/projects') && init.method === 'POST') return response(201, '{"visibility":"private"}');
    return response(404, '');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function target(options: Partial<ConstructorParameters<typeof GitLabPushTarget>[0]> & { credentialsFile: string; fetchImpl: typeof fetch }) {
  return new GitLabPushTarget({ baseUrl: 'http://172.29.100.126', account: 'codigger-llm', ...options });
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
  it('reuses a stored PAT and creates a missing private project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-gl-'));
    const credentials = path.join(root, '.git-credentials');
    fs.writeFileSync(credentials, `http://codigger-llm:pat-stored@172.29.100.126\n`, 'utf8');
    const { fetchImpl, calls } = fakeGitLab({ projectExists: false });
    const url = await target({ credentialsFile: credentials, fetchImpl }).ensureProject('storefront');
    expect(url).toBe('http://172.29.100.126/codigger-llm/storefront.git');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET http://172.29.100.126/api/v4/projects/codigger-llm%2Fstorefront',
      'POST http://172.29.100.126/api/v4/projects',
    ]);
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('pat-stored');
    expect(calls[1].body).toContain('visibility=private');
    expect(calls[1].body).toContain('name=storefront');
    // the stored credential file is untouched when a PAT already exists
    expect(fs.readFileSync(credentials, 'utf8')).toBe('http://codigger-llm:pat-stored@172.29.100.126\n');
  });

  it('skips creation when the mirror project already exists', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-gl-'));
    const credentials = path.join(root, '.git-credentials');
    fs.writeFileSync(credentials, `http://codigger-llm:pat-stored@172.29.100.126\n`, 'utf8');
    const { fetchImpl, calls } = fakeGitLab({ projectExists: true });
    const url = await target({ credentialsFile: credentials, fetchImpl }).ensureProject('storefront');
    expect(url).toBe('http://172.29.100.126/codigger-llm/storefront.git');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('bootstraps a PAT through the web session when none is stored', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-gl-'));
    const credentials = path.join(root, '.git-credentials');
    const { fetchImpl, calls } = fakeGitLab({ projectExists: true });
    const url = await target({ credentialsFile: credentials, fetchImpl, password: 'Engine#llm' }).ensureProject('storefront');
    expect(url).toBe('http://172.29.100.126/codigger-llm/storefront.git');
    // web session: sign-in page, login, PAT page, create form, confirm page
    const flow = calls.filter((call) => !call.url.includes('/api/v4/')).map((call) => `${call.method} ${call.url}`);
    expect(flow).toEqual([
      'GET http://172.29.100.126/users/sign_in',
      'POST http://172.29.100.126/users/sign_in',
      'GET http://172.29.100.126/profile/personal_access_tokens',
      'POST http://172.29.100.126/profile/personal_access_tokens',
      'GET http://172.29.100.126/profile/personal_access_tokens',
    ]);
    const login = calls.find((call) => call.url.endsWith('/users/sign_in') && call.method === 'POST')!;
    expect(login.body).toContain('user%5Blogin%5D=codigger-llm');
    const create = calls.find((call) => call.url.endsWith('/profile/personal_access_tokens') && call.method === 'POST')!;
    expect(create.body).toContain('personal_access_token%5Bscopes%5D%5B%5D=api');
    // the created PAT is persisted for passwordless pushes and used for the API
    expect(fs.readFileSync(credentials, 'utf8')).toBe('http://codigger-llm:glpat-created123@172.29.100.126\n');
    expect(calls.find((call) => call.url.includes('/api/v4/'))!.headers['PRIVATE-TOKEN']).toBe('glpat-created123');
  });

  it('rejects an invalid GitLab base URL or account', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmbugfix-gl-'));
    const credentials = path.join(root, '.git-credentials');
    expect(() => target({ baseUrl: 'ftp://x', credentialsFile: credentials, fetchImpl: fakeGitLab().fetchImpl })).toThrow(/http\(s\)/u);
    expect(() => target({ account: 'bad/account', credentialsFile: credentials, fetchImpl: fakeGitLab().fetchImpl })).toThrow(/account/u);
  });
});
