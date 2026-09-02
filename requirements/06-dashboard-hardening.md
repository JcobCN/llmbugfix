# WP06：Dashboard、Hardening 与最终验收（Phase 17–18）

## 目标

完成操作界面、恢复/重试/取消、结果产物、可观测性和不依赖真实 LLM/GitLab 的端到端验证。

## 文件所有权

- `apps/bug-web` 中 dashboard/detail/progress 页面与组件。
- `apps/bug-api` 中查询、retry、cancel、健康检查与 hardening 集成。
- 跨模块测试目录 `tests/**`、最终文档；对其他模块只提交小范围集成修复。

## 必须实现

- Bug list：key/title/target/status/completeness/created/fix branch，含筛选与刷新。
- Bug detail：summary/profile/repro/environment/evidence/attachments/conversation/completeness/progress/fix/validation/review/branch/commit。
- retry 仅允许终态失败或 interrupted；不自动 retry。cancel 对 QUEUED 与安全可中止状态语义明确。
- artifact 目录包含 V4 指定 9 个 JSON/patch 文件（按实际阶段逐步生成且 schema 校验）。
- DRY_RUN、timeout、data path、LLM/Vision/Git host 等配置均有安全默认值和启动校验。
- readiness/liveness、结构化 redacted logs、崩溃恢复、lock cleanup、过期 worktree 清理的安全接口。
- README 覆盖离线安装、迁移、启动、配置、测试、运行边界与故障排查。

## 最终验收

- 使用 Fake Intake/Fake Agent/Disabled Vision/本地临时 Git remote 跑完整 E2E。
- 覆盖：正常 dry run、正常 push、低信息 NEEDS_INFO、无 Vision 图片、validation fail、review reject、crash recovery、人工 retry/cancel。
- 根目录 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全通过。
- 对 V4 Definition of Done 逐项生成可追踪验收表，不把需要真实内网服务的项目伪报为已验证。

