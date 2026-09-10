import { cpSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// The root TypeScript build intentionally emits JavaScript beside source files
// for the packages that do not yet have individual project references. Package
// exports, however, point at dist/. Mirror only runnable build output there so
// the local verification bootstrap can use normal workspace resolution.
const packages = [
  'shared',
  'bug-domain',
  'bug-repository',
  'intake-policy',
  'intake-agent',
  'vision-provider',
  'attachment-service',
  'job-queue',
  'environment-resolver',
  'environment-runner',
  'pi-runner',
  'repo-manager',
  'validator',
];
const outputFile = /(?:\.js|\.d\.ts|\.map)$/u;
for (const name of packages) {
  const source = resolve('packages', name, 'src');
  if (!existsSync(source)) continue;
  cpSync(source, resolve('packages', name, 'dist'), {
    recursive: true,
    filter: (entry) => statSync(entry).isDirectory() || outputFile.test(entry),
  });
}

// The local server imports the orchestrator through its workspace export as
// well, so mirror its emitted runtime files just like the package modules.
const appPackages = ['orchestrator', 'bug-web'];
for (const name of appPackages) {
  const source = resolve('apps', name, 'src');
  if (!existsSync(source)) continue;
  cpSync(source, resolve('apps', name, 'dist'), {
    recursive: true,
    filter: (entry) => statSync(entry).isDirectory() || outputFile.test(entry),
  });
}

const bugWebPublic = resolve('apps', 'bug-web', 'public');
if (existsSync(bugWebPublic)) {
  cpSync(bugWebPublic, resolve('apps', 'bug-web', 'dist', 'public'), {
    recursive: true,
  });
}
