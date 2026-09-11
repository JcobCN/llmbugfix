# V4 实施追踪与验收矩阵

状态说明：

- **已验证**：由当前仓库的 Vitest、TypeScript 或 ESLint 实际覆盖。
- **已实现，待内网验收**：接口和安全边界已实现，但需要真实公司的 LLM、Pi、目标仓库或 GitLab remote 才能完成最终验证。
- **刻意不实现**：V4 明确禁止或排除的能力。

## Phase 追踪

| Phase | V4 交付 | 实现位置 | 验收状态 |
| --- | --- | --- | --- |
| 1 | pnpm/TS/Zod/SQLite/Pino/Vitest 基础 | package.json、packages/shared、packages/bug-domain | 已验证：typecheck/lint/build |
| 2 | Domain、SQLite schema/repository | packages/bug-domain、packages/bug-repository | 已验证：状态机/仓储测试 |
| 3 | Chat、Draft、字段编辑、目标/环境选择 | apps/bug-web、apps/bug-api | 已验证：API 注入测试；浏览器视觉回归待内网验收 |
| 4 | Intake adapter、严格 JSON、merge/contradiction | packages/intake-agent | 已验证：Fake adapter/Schema 测试；真实内网模型待验收 |
| 5 | Adaptive interview | packages/intake-policy | 已验证：问题去重、unknown、最多三问测试 |
| 6 | Completeness 与确认提交 | packages/intake-policy、apps/bug-api | 已验证：五维评分、显式确认、NEEDS_INFO 路径 |
| 7 | Local attachments、文本提取、secret detection | packages/attachment-service、apps/bug-api/src/attachment-routes.ts | 已验证：12 个附件安全/脱敏测试 |
| 8 | Optional Vision/OCR | packages/vision-provider | 已验证：Disabled、内网 URL 拒绝、timeout 降级测试；真实内网 Provider 待验收 |
| 9 | Environment Profile/Skill/Markdown | packages/environment-resolver、config、environments、.pi/skills | 已验证：解析、歧义阻断、路径边界测试 |
| 10 | SQLite single-worker queue | packages/job-queue | 已验证：优先级、单 RUNNING、lock、stale recovery/人工 retry 测试 |
| 11 | Repo/worktree/branch | packages/repo-manager | 已验证：branch/remote guard 单测；真实 Git worktree/remote 待内网验收 |
| 12 | Environment preparation | packages/environment-runner | 已验证：setup/runtime/health/stop、失败阻断测试 |
| 13 | Pi Fixer adapter | packages/pi-runner | 已验证：Fake adapter/结构化结果；真实 Pi SDK 待内网验收 |
| 14 | Deterministic validation | packages/validator | 已验证：argv、timeout、redaction、每命令结果测试 |
| 15 | Independent reviewer | packages/pi-runner、apps/orchestrator | 已验证：Fixer/Reviewer session 分离和 reject gate 测试 |
| 16 | Safe Git push | packages/repo-manager、apps/orchestrator | 已验证：ai/*、保护分支、remote host、Dry Run gate；真实内网 GitLab push 待验收 |
| 17 | Dashboard/detail | apps/bug-web、apps/bug-api | 已实现/API 已验证；宿主应用须将 HTML renderer 映射为页面路由 |
| 18 | Recovery/retry/cleanup/dry-run/artifacts | packages/job-queue、apps/orchestrator、apps/bug-api | 已验证：stale/manual retry、Dry Run、9 个 artifacts、health/retry/cancel API |

## Definition of Done 追踪

| DoD 范围 | 状态 | 实现/验证 |
| --- | --- | --- |
| 单机、SQLite 唯一业务库、本地附件/产物 | 已验证 | bug-repository + attachment-service；无 PostgreSQL/Redis/MinIO 依赖 |
| 自然语言提交、Chat + Draft、手动 target/profile 修正 | 已验证 | intake-agent、intake-policy、bug-api、bug-web |
| 每轮最多三问、前后端分类、结构化 BugReport、完整度与确认门禁 | 已验证 | Intake/Policy/API tests |
| Profile 可扩展、Profile/Markdown/Skill 分层 | 已验证 | YAML resolver、示例 environment/skill、resolver tests |
| 截图及 PNG/JPG/WEBP/TXT/LOG/JSON/HAR/MP4、无 Vision 可提交 | 已验证 | attachment/vision tests；机器观察与 reporter observation 分开 |
| secret detection/redaction | 已验证 | attachment 与 validator tests；Pino/shared redaction |
| SQLite queue、严格单任务、crash recovery、人工 retry | 已验证 | queue lock/claim/recovery tests |
| worktree、Pi Fixer、独立 validator/reviewer、Validation/Review 阻断 push | 已验证（Fake） | pipeline E2E 覆盖 dry run、validation fail、review reject；真实 Pi/目标仓库待内网验收 |
| 只 push ai/*、remote allow-list、无 GitLab API/MR/merge/deploy | 已验证（guard） | RepoManager/Orchestrator guard tests；真实 GitLab push 待内网验收 |
| Dashboard/detail 显示 branch/commit/validation/review | 已实现/API 已验证 | Dashboard renderer + bug detail API |
| DRY_RUN | 已验证 | 默认配置、Orchestrator Dry Run E2E：不 commit/push |

## 当前离线验收事实

- `pnpm test`：18 个测试文件、153 项测试通过。
- `pnpm typecheck`、16 个子 workspace 的递归 typecheck、`pnpm lint` 和 `pnpm build` 均通过；TypeScript 只做 `--noEmit` 类型检查，运行产物由 esbuild 统一写入根 `dist/`。
- E2E 使用 Fake Intake、Fake Pi、Disabled Vision 和 FakeCommandRunner；它验证状态机、gate 和 artifact，不声称已实际访问 GitLab、内网 LLM、真实 Pi SDK 或真实项目运行环境。
- 系统不实现 Web Search、GitLab REST/GraphQL、Merge Request、自动 merge 或自动 deploy。
