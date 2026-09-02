# WP01：项目基础与领域模型（Phase 1–2）

## 目标

创建可离线安装/运行的 TypeScript monorepo，定义全系统唯一领域契约并完成 SQLite schema/repository 基础。

## 文件所有权

- 根目录：`package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、lint/test 配置、`.gitignore`、`.env.example`、`README.md`。
- `packages/shared/**`
- `packages/bug-domain/**`
- `packages/bug-repository/**`

## 必须实现

- workspace scripts：`lint`、`typecheck`、`test`、`build`。
- Zod schema + inferred types：BugReport、BugStatus、AttachmentRef、Conversation/Message、Completeness、Job、AgentRun、BugFixTask、AgentFixResult、ValidationResult、ReviewResult、GitResult。
- 状态枚举覆盖 V4 所有正常/失败状态；提供受控状态转换校验。
- UUID 内部 ID；事务性生成唯一 `BUG-000001` 格式 bugKey。
- Drizzle schema 至少包含 users、bug_conversations、conversation_messages、bug_reports、bug_attachments、bug_events、jobs、agent_runs。
- SQLite 初始化必须设置 WAL、foreign_keys、busy_timeout=5000。
- repository 接口及 SQLite 实现；JSON 字段读写均过 Zod 校验。
- shared 提供配置解析、错误类型、时间/ID、路径边界、secret redaction、结构化日志基础。

## 验收

- 新数据库可迁移并检查 8 张核心表与 PRAGMA。
- 并发/连续创建 Bug 均得到不重复且递增的 bugKey。
- 非法领域对象、非法状态转换被拒绝。
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全通过。

