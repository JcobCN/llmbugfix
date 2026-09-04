# V4 实施需求包

本目录将《LLM Bug 提交 → Pi Agent 自动修复系统实施计划 V4》拆成可独立实现和验收的工作包。原始 V4 文档是最终需求来源；发生冲突时以原文和本目录的架构契约为准。

## 全局约束

- 只在当前仓库工作；不得修改仓库外文件。
- 使用 pnpm workspace、TypeScript、Zod、Drizzle SQLite、Pino、Vitest。
- SQLite 是唯一业务数据库；附件和流水线产物只能放本地文件系统。
- 默认无公网；不得通过实现或测试下载依赖，不接入任何公共服务。
- 所有 LLM/Pi/Vision/OCR 都必须通过 Adapter/Provider；无 Vision 时核心流程仍可用。
- Queue 并发恒为 1；Fixer 不得 push/merge/deploy；Reviewer 使用独立 session。
- Validation 由 Orchestrator 执行；仅 reviewer gate 通过后可 commit/push `ai/*`。
- 所有子进程有 timeout、exit code 和截断后的 stdout/stderr；日志和持久化内容须脱敏。
- Phase 顺序是验收顺序；只有当前阶段测试通过后才算解锁下一阶段。

## 工作包与阶段映射

1. `01-foundation-domain.md`：Phase 1–2，仓库骨架、共享设施、领域模型和数据库。
2. `02-intake-ui-api.md`：Phase 3–6，Chat + Draft、Intake、追问、完整度与 API。
3. `03-attachments-vision.md`：Phase 7–8，附件、文本提取、脱敏、可选 Vision/OCR。
4. `04-environment-queue.md`：Phase 9–10，环境配置/文档/Skill 和 SQLite 单 worker 队列。
5. `05-execution-pipeline.md`：Phase 11–16，Repo、环境准备、Pi、验证、Review、安全推送。
6. `06-dashboard-hardening.md`：Phase 17–18，Dashboard、恢复、重试、Dry Run、产物与端到端验收。
7. `07-conversational-intake-redesign.md`：Conversational-First Intake、可编辑 Markdown 与 revision/hash 对账。
8. `08-intake-submission-ux.md`：Intake 初始化、提交反馈、成功终态与后续导航闭环。

## 集成原则

- 公共领域类型只由 foundation 工作包维护；其他包从 `@bug-agent/bug-domain` 导入。
- 各 package 暴露稳定的 `src/index.ts`，禁止跨 package 深层导入。
- 业务层依赖接口，不依赖 HTTP/LLM/Pi SDK 或具体文件路径实现。
- 所有路径先解析并验证仍位于配置允许的根目录内。
- 每个模块包含单元测试；API、数据库、队列和流水线包含集成测试。
