import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { z } from 'zod';
import { AppError } from '@llmbugfix/shared';

/** A BLOCKED result is safe for callers to expose without leaking a stack trace. */
export class EnvironmentBlockedError extends AppError {
  constructor(message: string, details?: unknown) { super('BLOCKED', message, details); this.name = 'EnvironmentBlockedError'; }
}

const relativePath = z.string().min(1).refine((value) => !path.isAbsolute(value), 'path must be relative');
const command = z.string().min(1);

/** Profile contains machine configuration only. repository is an env placeholder in checked-in examples. */
export const EnvironmentProfileSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), target: z.enum(['frontend', 'backend']).optional(), type: z.enum(['frontend', 'backend']).optional(),
  repository: z.string().min(1).optional(), repoUrl: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(), baseBranch: z.string().min(1).optional(), instructions: z.array(z.string()).default([]),
  docsPath: relativePath.optional(), skillPath: relativePath.optional(), markdown: z.array(relativePath).default([]), skills: z.array(relativePath).default([]),
  documentationPaths: z.array(relativePath).default([]), skillPaths: z.array(relativePath).default([]),
  setupCommands: z.array(command).default([]), validationCommands: z.array(command).default([]), setup: z.array(command).default([]), validation: z.array(command).default([]),
  runtime: z.object({ startCommand: command.optional(), start: command.optional(), stopCommand: command.optional(), stop: command.optional(), healthCheck: z.string().optional(), startupTimeoutSeconds: z.number().int().positive().default(120), detached: z.boolean().optional(), startDetached: z.boolean().optional() }).optional()
}).superRefine((value, ctx) => {
  if (!value.repository && !value.repoUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repository'], message: 'repository is required' });
  if (!value.target && !value.type) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'target/type is required' });
  if (value.target && value.type && value.target !== value.type) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['target'], message: 'target and type must agree' });
}).transform((value) => ({
  ...value, target: value.target ?? value.type as 'frontend' | 'backend', type: value.type ?? value.target as 'frontend' | 'backend',
  repository: value.repository ?? value.repoUrl as string, repoUrl: value.repoUrl ?? value.repository as string,
  defaultBranch: value.defaultBranch ?? value.baseBranch ?? 'main', baseBranch: value.baseBranch ?? value.defaultBranch ?? 'main',
  markdown: value.markdown.length ? value.markdown : value.documentationPaths.length ? value.documentationPaths : value.docsPath ? [value.docsPath] : [],
  documentationPaths: value.documentationPaths.length ? value.documentationPaths : value.markdown.length ? value.markdown : value.docsPath ? [value.docsPath] : [],
  skills: value.skills.length ? value.skills : value.skillPaths.length ? value.skillPaths : value.skillPath ? [value.skillPath] : [],
  skillPaths: value.skillPaths.length ? value.skillPaths : value.skills.length ? value.skills : value.skillPath ? [value.skillPath] : [],
  setupCommands: value.setupCommands.length ? value.setupCommands : value.setup,
  validationCommands: value.validationCommands.length ? value.validationCommands : value.validation,
  runtime: value.runtime ? { ...value.runtime, startCommand: value.runtime.startCommand ?? value.runtime.start } : undefined
}));
export type EnvironmentProfile = z.infer<typeof EnvironmentProfileSchema>;
export const EnvironmentConfigSchema = z.preprocess((value) => {
  if (value && typeof value === 'object' && 'profiles' in value && value.profiles && typeof value.profiles === 'object') {
    return { environments: Object.entries(value.profiles as Record<string, unknown>).map(([id, profile]) => ({ ...(profile as object), id })) };
  }
  return value;
}, z.object({ environments: z.array(EnvironmentProfileSchema) }));

export interface EnvironmentContextEntry { kind: 'markdown' | 'skill'; path: string; content: string; }
export interface ResolvedEnvironment {
  profile: EnvironmentProfile; context: EnvironmentContextEntry[]; markdown: EnvironmentContextEntry[]; skills: EnvironmentContextEntry[];
  /** Compatibility fields consumed by the existing fixer adapter. */
  docsContent: string; skillContent: string;
}
export interface EnvironmentResolverOptions { maxFileBytes?: number; env?: Record<string, string | undefined>; }
const isWithin = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(`${root}${path.sep}`);
const environmentVariable = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;

export class EnvironmentResolver {
  private profiles: EnvironmentProfile[] = [];
  private readonly maxFileBytes: number;
  private readonly rootDir: string;
  private readonly env: Record<string, string | undefined>;
  constructor(private readonly configPath: string, rootDir = process.cwd(), options: EnvironmentResolverOptions = {}) {
    this.rootDir = fs.realpathSync.native(path.resolve(rootDir)); this.maxFileBytes = options.maxFileBytes ?? 256 * 1024; this.env = options.env ?? process.env; this.reload();
  }
  public reload(): EnvironmentProfile[] {
    if (!fs.existsSync(this.configPath)) throw new EnvironmentBlockedError(`Environment config file not found: ${this.configPath}`);
    let parsed: unknown;
    try { parsed = EnvironmentConfigSchema.parse(yaml.parse(fs.readFileSync(this.configPath, 'utf8'))); }
    catch (error) { throw new EnvironmentBlockedError('Environment configuration is invalid', error instanceof z.ZodError ? error.issues : undefined); }
    const profiles = parsed as { environments: EnvironmentProfile[] }; const ids = new Set<string>();
    this.profiles = profiles.environments.map((profile) => {
      if (ids.has(profile.id)) throw new EnvironmentBlockedError(`Duplicate environment profile id: ${profile.id}`); ids.add(profile.id);
      const placeholder = profile.repository.match(environmentVariable);
      if (!placeholder) return profile;
      const repository = this.env[placeholder[1]]?.trim();
      if (!repository) throw new EnvironmentBlockedError(`Repository environment variable is not configured: ${placeholder[1]}`, { profileId: profile.id });
      return EnvironmentProfileSchema.parse({ ...profile, repository, repoUrl: repository });
    });
    return this.listProfiles();
  }
  public listProfiles(): EnvironmentProfile[] { return this.profiles.map((profile) => ({ ...profile, markdown: [...profile.markdown], skills: [...profile.skills], setupCommands: [...profile.setupCommands], validationCommands: [...profile.validationCommands] })); }
  public getProfile(id: string): EnvironmentProfile | null { return this.profiles.find((profile) => profile.id === id) ?? null; }
  private loadFile(relative: string, kind: 'markdown' | 'skill'): EnvironmentContextEntry {
    if (!relative || path.isAbsolute(relative)) throw new EnvironmentBlockedError(`${kind} path must be relative: ${relative}`);
    const lexical = path.resolve(this.rootDir, relative); if (!isWithin(this.rootDir, lexical)) throw new EnvironmentBlockedError(`${kind} path escapes environment root: ${relative}`);
    if (!fs.existsSync(lexical)) throw new EnvironmentBlockedError(`${kind} file not found: ${relative}`);
    let real: string; try { real = fs.realpathSync.native(lexical); } catch { throw new EnvironmentBlockedError(`${kind} file cannot be resolved: ${relative}`); }
    if (!isWithin(this.rootDir, real)) throw new EnvironmentBlockedError(`${kind} path escapes environment root: ${relative}`);
    const stat = fs.statSync(real); if (!stat.isFile()) throw new EnvironmentBlockedError(`${kind} path is not a file: ${relative}`);
    if (stat.size > this.maxFileBytes) throw new EnvironmentBlockedError(`${kind} file exceeds size limit: ${relative}`);
    return { kind, path: path.relative(this.rootDir, real), content: fs.readFileSync(real, 'utf8') };
  }
  public loadMarkdown(relative: string): EnvironmentContextEntry { return this.loadFile(relative, 'markdown'); }
  public loadSkill(relative: string): EnvironmentContextEntry { return this.loadFile(relative, 'skill'); }
  public resolve(input: { executionTarget: string; environmentProfileId?: string | null }): ResolvedEnvironment {
    return this.resolveProfile(input.executionTarget, input.environmentProfileId ?? undefined);
  }
  public resolveProfile(target: string, requestedProfileId?: string): ResolvedEnvironment {
    let profile: EnvironmentProfile | undefined;
    if (requestedProfileId) {
      profile = this.profiles.find((candidate) => candidate.id === requestedProfileId);
      if (!profile) throw new EnvironmentBlockedError(`Requested environment profile "${requestedProfileId}" not found`, { target, requestedProfileId });
      if ((target === 'frontend' || target === 'backend') && profile.target !== target) throw new EnvironmentBlockedError(`Environment profile "${requestedProfileId}" does not match target "${target}"`, { target, requestedProfileId, profileTarget: profile.target });
    }
    else { const matches = this.profiles.filter((candidate) => candidate.target === target); if (matches.length !== 1) throw new EnvironmentBlockedError(matches.length === 0 ? `No environment profile matches target "${target}"` : `Ambiguous environment target "${target}"`, { target, candidates: matches.map((candidate) => candidate.id) }); profile = matches[0]; }
    const markdown = profile.markdown.map((file) => this.loadMarkdown(file)); const skills = profile.skills.map((file) => this.loadSkill(file));
    return { profile, context: [...markdown, ...skills], markdown, skills, docsContent: markdown.map((entry) => entry.content).join('\n\n'), skillContent: skills.map((entry) => entry.content).join('\n\n') };
  }
}
