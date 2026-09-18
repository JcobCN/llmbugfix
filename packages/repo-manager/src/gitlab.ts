import { createHash } from 'node:crypto';

/**
 * Push target that mirrors every fixed repository into a private project
 * under one own GitLab account (see docs/gitlab-private-repo-api.md).
 *
 * The GitLab instance is old, HTTP-only and 2FA-enabled, so both the API and
 * git-over-HTTP require a Personal Access Token. The token stays in process
 * memory. It can be supplied directly as a PAT, or bootstrapped once through
 * the web sign-in flow with the configured account password for this process.
 */
export interface GitLabPushTargetOptions {
  /** GitLab base URL, e.g. http://172.29.100.126 */
  baseUrl: string;
  /** Account namespace that owns the private mirror repositories. */
  account: string;
  /** PAT kept in memory and used for both the API and Git operations. */
  token?: string;
  /** Password used only to bootstrap a PAT when no token is configured. */
  password?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Name recorded for PATs created by this target. */
  tokenName?: string;
  /** Per-request network timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const projectFlights = new Map<string, Promise<string>>();
const MEMORY_CREDENTIAL_HELPER = [
  '!f() {',
  '  [ "$1" = get ] || return 0;',
  '  input=$(cat);',
  '  host=$(printf "%s\\n" "$input" | sed -n "s/^host=//p");',
  '  if [ "$host" != "$LLMBUGFIX_GIT_HOST" ] && [ "$host" != "$LLMBUGFIX_GIT_HOST_PORT" ]; then return 0; fi;',
  '  printf "username=%s\\npassword=%s\\n" "$LLMBUGFIX_GIT_USERNAME" "$LLMBUGFIX_GIT_TOKEN";',
  '}; f',
].join(' ');

/** Minimal cookie jar: enough for Rails session cookies, no expiry tracking. */
class CookieJar {
  private readonly cookies = new Map<string, string>();
  absorb(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const raw = headers.getSetCookie?.() ?? (response.headers.get('set-cookie')?.split(/,(?=[^;=]+;)/u) ?? []);
    for (const cookie of raw) {
      const pair = cookie.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header(): string { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
}

const authenticityToken = (html: string): string | null => {
  const forward = /name="authenticity_token"\s+value="([^"]+)"/u.exec(html);
  if (forward?.[1]) return forward[1];
  const reversed = /value="([^"]+)"\s+name="authenticity_token"/u.exec(html);
  return reversed?.[1] ?? null;
};

const decodeHtmlEntities = (value: string): string => value
  .replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
  .replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');

const extractCreatedToken = (html: string): string | null => {
  for (const tag of html.match(/<input\b[^>]*>/giu) ?? []) {
    if (!tag.includes('created-personal-access-token')) continue;
    const value = /\bvalue="([^"]*)"/u.exec(tag);
    if (value?.[1]) return decodeHtmlEntities(value[1]);
  }
  return null;
};

/** Derive the mirror project name from a source remote URL (leaf segment). */
export function mirrorProjectName(remoteUrl: string): string {
  const normalized = remoteUrl.startsWith('git@') ? `ssh://${remoteUrl.replace(':', '/')}` : remoteUrl;
  let leaf = '';
  try { leaf = decodeURIComponent(new URL(normalized).pathname.replace(/\/+$/u, '').split('/').at(-1) ?? ''); } catch { /* fall back to a digest below */ }
  const cleaned = leaf.replace(/\.git$/iu, '').replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^[._-]+/u, '').replace(/[._-]+$/u, '');
  if (PROJECT_NAME.test(cleaned)) return cleaned;
  return `repo-${createHash('sha256').update(remoteUrl).digest('hex').slice(0, 10)}`;
}

export class GitLabPushTarget {
  private readonly base: URL;
  private readonly account: string;
  private readonly configuredToken?: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenName: string;
  private readonly timeoutMs: number;
  private cachedToken: string | null = null;
  private tokenFlight: Promise<string> | null = null;

  constructor(options: GitLabPushTargetOptions) {
    let base: URL;
    try { base = new URL(options.baseUrl); } catch { throw new Error(`Invalid GitLab base URL: ${options.baseUrl}`); }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`GitLab base URL must be http(s): ${options.baseUrl}`);
    this.base = base;
    this.account = options.account.trim();
    if (!this.account || /[\0\r\n/]/u.test(this.account)) throw new Error('GitLab account is invalid');
    this.configuredToken = options.token?.trim() || undefined;
    this.password = options.password?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenName = options.tokenName ?? 'llmbugfix-push';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Push URL of the own-account private project, creating it when missing. */
  async ensureProject(name: string): Promise<string> {
    if (!PROJECT_NAME.test(name)) throw new Error(`Invalid mirror project name: ${name}`);
    const projectKey = `${this.base.origin}\0${this.account}\0${name}`;
    const existing = projectFlights.get(projectKey);
    if (existing) return existing;
    // Store the promise before its first await so every concurrent caller
    // receives this exact flight, including the lookup and possible create.
    const flight = this.ensureProjectFlow(name);
    projectFlights.set(projectKey, flight);
    try {
      return await flight;
    } finally {
      if (projectFlights.get(projectKey) === flight) projectFlights.delete(projectKey);
    }
  }

  private async ensureProjectFlow(name: string): Promise<string> {
    const token = await this.resolveToken();
    const projectPath = encodeURIComponent(`${this.account}/${name}`);
    const check = await this.request('GET', `/api/v4/projects/${projectPath}`, { token });
    if (check.status === 200) return this.projectUrl(name);
    if (check.status !== 404) throw new Error(`GitLab project lookup failed (${check.status}): ${this.excerpt(check.body)}`);
    const created = await this.request('POST', '/api/v4/projects', {
      token,
      form: new URLSearchParams({ name, path: name, visibility: 'private' }),
    });
    if (created.status === 201 || created.status === 200) return this.projectUrl(name);
    // A concurrent creator outside this process may have won the race;
    // treating GitLab's "taken" response as success is safe and idempotent.
    if (created.status === 400 && /already (been )?taken/iu.test(created.body)) return this.projectUrl(name);
    throw new Error(`GitLab project creation failed (${created.status}): ${this.excerpt(created.body)}`);
  }

  private projectUrl(name: string): string { return `${this.base.href.replace(/\/+$/u, '')}/${this.account}/${name}.git`; }

  private excerpt(body: string): string { return body.replace(/\s+/gu, ' ').trim().slice(0, 300); }

  private async resolveToken(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    if (this.tokenFlight) return this.tokenFlight;
    this.tokenFlight = (async () => {
      if (this.configuredToken) { this.cachedToken = this.configuredToken; return this.configuredToken; }
      const created = await this.createToken();
      this.cachedToken = created;
      return created;
    })();
    try {
      return await this.tokenFlight;
    } finally {
      this.tokenFlight = null;
    }
  }

  /** Bootstrap a PAT through the web sign-in flow (2FA-safe: password login). */
  private async createToken(): Promise<string> {
    if (!this.password) throw new Error(`No PAT for ${this.account} at ${this.base.host} and no GITLAB_TOKEN or password configured`);
    const jar = new CookieJar();
    const signIn = await this.request('GET', '/users/sign_in', { jar });
    const loginToken = authenticityToken(signIn.body);
    if (!loginToken) throw new Error('GitLab sign-in page did not provide an authenticity token');
    await this.request('POST', '/users/sign_in', {
      jar,
      form: new URLSearchParams({ authenticity_token: loginToken, 'user[login]': this.account, 'user[password]': this.password }),
    });
    const page = await this.request('GET', '/profile/personal_access_tokens', { jar });
    if (page.status !== 200) throw new Error(`GitLab login failed for ${this.account} (status ${page.status})`);
    const formToken = authenticityToken(page.body);
    if (!formToken) throw new Error('GitLab PAT page did not provide an authenticity token');
    await this.request('POST', '/profile/personal_access_tokens', {
      jar,
      form: new URLSearchParams({
        authenticity_token: formToken,
        utf8: '✓',
        'personal_access_token[name]': this.tokenName,
        'personal_access_token[scopes][]': 'api',
        'personal_access_token[expires_at]': '',
      }),
    });
    const confirmed = await this.request('GET', '/profile/personal_access_tokens', { jar });
    const token = extractCreatedToken(confirmed.body);
    if (!token) throw new Error('GitLab did not expose the created personal access token');
    return token;
  }

  /** Environment for Git's in-memory credential helper; no credential file is consulted. */
  async gitCredentialEnvironment(): Promise<NodeJS.ProcessEnv> {
    const token = await this.resolveToken();
    return {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: MEMORY_CREDENTIAL_HELPER,
      GIT_TERMINAL_PROMPT: '0',
      LLMBUGFIX_GIT_HOST: this.base.hostname,
      LLMBUGFIX_GIT_HOST_PORT: this.base.host,
      LLMBUGFIX_GIT_USERNAME: this.account,
      LLMBUGFIX_GIT_TOKEN: token,
    };
  }

  private async request(
    method: 'GET' | 'POST',
    pathname: string,
    options: { token?: string; form?: URLSearchParams; jar?: CookieJar } = {},
  ): Promise<{ status: number; body: string }> {
    const url = `${this.base.href.replace(/\/+$/u, '')}${pathname}`;
    const headers: Record<string, string> = {};
    if (options.token) headers['PRIVATE-TOKEN'] = options.token;
    if (options.form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const cookie = options.jar?.header();
    if (cookie) headers.cookie = cookie;
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.form?.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    options.jar?.absorb(response);
    return { status: response.status, body: await response.text() };
  }
}
