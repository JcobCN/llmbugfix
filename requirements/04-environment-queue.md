# WP04：Environment Profile 与 SQLite Queue（Phase 9–10）

## 目标

通过 YAML + Markdown + Skill 扩展执行项目，并提供严格单任务、可恢复的 SQLite job queue。

## 文件所有权

- `packages/environment-resolver/**`
- `packages/job-queue/**`
- `config/environments.yaml`
- `environments/**`
- `.pi/skills/**`

## 必须实现

- Zod 校验 EnvironmentProfile；从 YAML 加载，不硬编码语言/项目逻辑。
- 显式 profile id 优先；否则仅在 target 唯一匹配时自动选择；0 或多个匹配都返回可识别 BLOCKED 错误。
- Skill/Markdown loader 验证路径范围、存在性、大小，并按配置顺序组装 context；三层职责不混合。
- 提供 frontend-main/backend-main 示例配置、事实文档与行为 Skill，示例 repository 用环境变量占位而非虚构可执行路径。
- jobs 的 enqueue/claim/heartbeat/complete/fail/cancel/retry 全事务化。
- claim 按 priority ASC、createdAt ASC 且任意时刻最多一个 RUNNING。
- 排他 process lock 位于 data；可识别 stale RUNNING 并标 INTERRUPTED/FAILED，MVP 不自动重跑。

## 验收

- 新增 profile 只改 YAML/Markdown/Skill 就能被 API/resolver 发现。
- 显式错误 target/profile 及歧义匹配均安全阻断。
- 两个 worker 竞争时只有一个 claim 成功。
- stale recovery 不自动重复执行；人工 retry 新增 attempt 或安全重排。
- 锁释放、异常退出恢复有测试。

