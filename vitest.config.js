import { defineConfig } from 'vitest/config';
import path from 'path';
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
        alias: {
            '@llmbugfix/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
            '@llmbugfix/bug-domain': path.resolve(__dirname, 'packages/bug-domain/src/index.ts'),
            '@llmbugfix/bug-repository': path.resolve(__dirname, 'packages/bug-repository/src/index.ts'),
            '@llmbugfix/intake-agent': path.resolve(__dirname, 'packages/intake-agent/src/index.ts'),
            '@llmbugfix/intake-policy': path.resolve(__dirname, 'packages/intake-policy/src/index.ts'),
            '@llmbugfix/attachment-service': path.resolve(__dirname, 'packages/attachment-service/src/index.ts'),
            '@llmbugfix/vision-provider': path.resolve(__dirname, 'packages/vision-provider/src/index.ts'),
            '@llmbugfix/environment-resolver': path.resolve(__dirname, 'packages/environment-resolver/src/index.ts'),
            '@llmbugfix/job-queue': path.resolve(__dirname, 'packages/job-queue/src/index.ts'),
            '@llmbugfix/repo-manager': path.resolve(__dirname, 'packages/repo-manager/src/index.ts'),
            '@llmbugfix/environment-runner': path.resolve(__dirname, 'packages/environment-runner/src/index.ts'),
            '@llmbugfix/pi-runner': path.resolve(__dirname, 'packages/pi-runner/src/index.ts'),
            '@llmbugfix/validator': path.resolve(__dirname, 'packages/validator/src/index.ts'),
            '@bug-agent/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
            '@bug-agent/bug-domain': path.resolve(__dirname, 'packages/bug-domain/src/index.ts'),
            '@bug-agent/bug-repository': path.resolve(__dirname, 'packages/bug-repository/src/index.ts'),
            '@bug-agent/intake-agent': path.resolve(__dirname, 'packages/intake-agent/src/index.ts'),
            '@bug-agent/intake-policy': path.resolve(__dirname, 'packages/intake-policy/src/index.ts'),
            '@bug-agent/attachment-service': path.resolve(__dirname, 'packages/attachment-service/src/index.ts'),
            '@bug-agent/vision-provider': path.resolve(__dirname, 'packages/vision-provider/src/index.ts'),
            '@bug-agent/environment-resolver': path.resolve(__dirname, 'packages/environment-resolver/src/index.ts'),
            '@bug-agent/job-queue': path.resolve(__dirname, 'packages/job-queue/src/index.ts'),
            '@bug-agent/repo-manager': path.resolve(__dirname, 'packages/repo-manager/src/index.ts'),
            '@bug-agent/environment-runner': path.resolve(__dirname, 'packages/environment-runner/src/index.ts'),
            '@bug-agent/pi-runner': path.resolve(__dirname, 'packages/pi-runner/src/index.ts'),
            '@bug-agent/validator': path.resolve(__dirname, 'packages/validator/src/index.ts'),
        }
    }
});
//# sourceMappingURL=vitest.config.js.map