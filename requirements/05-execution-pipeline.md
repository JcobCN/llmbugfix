# WP05：自动修复执行流水线（Phase 11–16）

## 目标

实现从安全 worktree 到 Pi Fixer、确定性验证、独立 Review、受控 commit/push 的完整编排。

## 文件所有权

- `packages/repo-manager/**`
- `packages/environment-runner/**`
- `packages/pi-runner/**`
- `packages/validator/**`
- `apps/orchestrator/**`

## 必须实现

- 统一 CommandRunner：cwd allowlist、timeout、exit code、输出上限、redaction、abort；禁止 shell 字符串拼接。
- RepoManager：校验 repo、fetch、生成安全 slug/`ai/<bugKey>-<slug>`、worktree、diff、commit、push、cleanup。
- push 前必须同时校验当前 branch 是 `ai/*`、不属于保护分支、origin host 等于 allowlist；不调用 GitLab API。
- EnvironmentRunner 按 profile 执行 setup/runtime/health/stop；失败状态 ENVIRONMENT_FAILED 且不能调用 Fixer。
- Pi SDK/CLI 仅在 pi-runner 内；AgentRunner Adapter 支持 fake 测试实现。
- Fixer context 仅含 safety + BugFixTask + profile +相关 MD/Skill +附件派生信息；结果必须 Zod 校验并落 artifact。
- Validator 独立执行 validationCommands，保存逐命令 stdout/stderr/exit/timeout；Agent 自报测试不计入结果。
- Reviewer 使用全新 session，仅收 BugFixTask/diff/files/validation/profile；结果过 Zod。
- gate：approve && bugAddressed && regressionRisk != high && validation pass 才进入 commit/push。
- Dry Run 跑到 review/diff，但不得 commit/push。
- 状态机和 artifact 写入应支持失败重启后审计。

## 验收

- 本地临时 git remote 的成功 happy path 到 READY_FOR_HUMAN_REVIEW。
- validation fail、review reject/high risk、错误 remote、保护分支、timeout 均保证零 push。
- Fake Agent 可证明 Fixer/Reviewer session ID 不同。
- 命令参数注入、路径穿越、超时子进程和 secret 输出测试通过。

