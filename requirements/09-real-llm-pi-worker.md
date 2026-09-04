# WP09：真实 LLM Intake、Pi Agent 与本地 Worker

> 状态：实施规格
>
> 本工作包把现有的 fake Intake/Pi 与“只入队、不消费”的本地启动流程，接通到一个 OpenAI-compatible LLM endpoint 和真实 Pi Coding Agent。Pi 是唯一支持的编码 Agent；不实现或接入 OpenCode。

## 1. 目标与结果

配置好一个 OpenAI-compatible endpoint、模型名、Intake Markdown 规则和受批准的项目/模块映射后，运行 `pnpm dev` 应能完成以下闭环：

```text
测试者打开 Intake
    ↓
同一个 LLM endpoint 驱动 Intake 对话和追问
    ↓
测试者提供项目/模块标识及 Bug 信息
    ↓
服务端将标识解析为受批准的环境 profile / repository
    ↓
Bug 提交并进入 SQLite queue
    ↓
同进程单 worker claim job
    ↓
Pi Fixer（独立 session）读代码、修改和运行命令
    ↓
Orchestrator 确定性验证
    ↓
Pi Reviewer（另一个独立、只读 session）审查
    ↓
按既有 gate 进入人工 review 或失败状态
```

本工作包必须让真实 LLM 流程可以运行，同时保留 fake 实现供不联网的单元测试和本地回归使用。

## 2. 范围与非目标

### 2.1 范围

- 引入并封装 `@earendil-works/pi-coding-agent@0.84.4`。
- `PiAgentRunner` 直接调用 Pi SDK 的 session API；保留 `AgentRunner` 和 `FakePiRunner`。
- 使用同一个 OpenAI-compatible endpoint 驱动 Intake、Fixer 和 Reviewer。
- 从 `INTAKE_CONFIG_PATH` 加载 Intake Markdown 规则，并将规则纳入 Intake 的 system/context。
- 要求 Intake 收集项目/模块标识，服务端只允许映射到配置中批准的 repository/profile。
- 在 API 启动时按配置启动真实 worker，并实现优雅停止、超时和失败恢复。
- 对 Pi 输出做严格 JSON contract 校验，并记录可审计 artifact。

### 2.2 非目标

- 不支持 OpenCode，不新增第二套 Agent loop 或 tool-call 协议。
- 不在本工作包中自行实现 `while → LLM → function call → tool result` 循环；该循环全部由 Pi SDK 负责。
- 不允许测试者通过表单提交任意本地路径、任意 Git URL 或 shell 命令来选择执行目标。
- 第一版不实现容器、seccomp、网络隔离等 Pi `bash` sandbox（见第 10 节风险与后续约束）。
- 不修改 Bug 状态机、deterministic Validator 或 push gate 的既有业务语义。

## 3. 配置契约

### 3.1 最小运行配置

`.env` 或部署环境至少提供：

```dotenv
LLM_ENDPOINT_URL=http://your-endpoint/v1
LLM_MODEL=your-model
LLM_API_KEY=optional
INTAKE_CONFIG_PATH=config/bug-intake.md
FIXER_TIMEOUT_MS=2700000
REVIEWER_TIMEOUT_MS=900000
```

| 配置 | 要求 |
| --- | --- |
| `LLM_ENDPOINT_URL` | 必填。OpenAI-compatible API 的 base URL，通常以 `/v1` 结尾；Intake、Pi Fixer、Pi Reviewer 必须使用同一值。实现应统一去掉末尾 `/`，请求路径不得重复拼接 `/chat/completions`。 |
| `LLM_MODEL` | 必填。传给 Intake Adapter 和 Pi custom provider 的模型 id。 |
| `LLM_API_KEY` | 可选。若提供，作为 endpoint credential 发送；不得记录到日志、prompt、artifact 或错误消息。变量名不能使用容易与 Pi 自身配置混淆的 `PI_API_KEY`。 |
| `INTAKE_CONFIG_PATH` | 必填或使用 `config/bug-intake.md` 默认值。必须是仓库/部署允许根目录内的 Markdown 文件，并执行存在性、大小和 regular-file 校验。 |
| `FIXER_TIMEOUT_MS` | 正整数，默认 `2_700_000`（45 分钟）；超时必须取消 Pi session，并将 job 标记为失败。 |
| `REVIEWER_TIMEOUT_MS` | 正整数，默认 `900_000`（15 分钟）；超时必须取消 Reviewer session，并将 job 标记为失败。 |

已有的 `DATABASE_PATH`、`DATA_ROOT`、`PORT`、`DRY_RUN`、`config/environments.yaml` 等配置仍遵守 WP01/WP04/WP05。Repository 的真实路径由受批准的 profile 配置和部署环境变量提供，不从 Intake 请求中直接读取。

### 3.2 启动模式

- 当 `LLM_ENDPOINT_URL` 和 `LLM_MODEL` 均存在，且 environment profiles、repository 映射及 repository 路径校验均成功时，`pnpm dev` 启动 API 和真实 Orchestrator worker。
- 缺少上述配置时，可以显式进入 local verification/fake 模式；启动日志必须说明“worker 未启用，提交会停留在队列”，不能伪装成自动修复已经开启。
- LLM 配置存在但 profile/repository 无效时，应快速失败并给出可识别的配置错误；不能悄悄回退到 `FakePiRunner`。
- API 和 worker 必须复用同一个进程内 `JobQueue` 实例，避免各自抢占 queue process lock。worker 并发恒为 1。
- shutdown 顺序为停止接收新任务、停止 worker polling/取消当前 Agent、关闭 API、最后释放 queue lock 和数据库连接。

## 4. Intake Markdown 与项目/模块映射

### 4.1 Intake Markdown

`INTAKE_CONFIG_PATH` 是产品/测试团队可编辑的收集规则，不是可执行代码。文档至少应说明：

- 报告目的、回答方式和语言风格。
- 必填信息：Bug 标题、实际/预期行为、复现步骤、项目/模块标识、运行目标（frontend/backend）和必要环境信息。
- 可选信息：版本、浏览器/操作系统、接口、日志、错误栈、影响范围、回归版本和附件说明。
- 何时继续追问、何时允许确认提交、哪些字段可接受“不知道”。
- 项目/模块标识的可选值或命名示例；文档不得要求测试者填写服务器绝对路径。

服务端在启动或首次请求时读取该 Markdown，并将其作为 Intake system/context 的明确一部分传给 `OpenAICompatibleIntakeModel`。文件内容应受到大小上限和路径 allowlist 保护；读取失败必须是可见的配置错误。不能将 Markdown 中的内容当作 shell 指令执行。

Intake LLM 仍须遵守已有 `IntakeTurnResultSchema`/Draft contract：模型负责理解回答、更新 draft 和提出最多三条问题；服务端负责 schema 校验、完整度计算、revision/CAS 和最终提交。

### 4.2 项目/模块到 profile/repository

测试者提交的是稳定的项目名、模块名或配置中的 alias，而不是 `repositoryPath`、Git URL、`cwd` 或命令。服务端在提交和 worker claim 前完成以下解析：

1. 对 project/module 做大小、字符集和长度校验，并规范化 alias；不得把它拼入文件路径或 shell 字符串。
2. 在受信任的 environment/profile 配置中做精确或唯一 alias 匹配。
3. 匹配结果必须唯一，并得到 `environmentProfileId`、target、approved repository 和 default branch。
4. 未匹配或多匹配时返回可理解的 `BLOCKED`/`NEEDS_INFO` 结果并继续追问，不能创建可执行 queue job。
5. RepoManager 再验证 repository 是允许的本地仓库、realpath 位于批准根目录内，且 branch/remote 满足 WP05；任何失败都阻断 pipeline。

配置可以继续使用 `config/environments.yaml` 的 profile，并增加项目/模块 aliases 或独立映射区；具体字段必须由 Zod schema 校验、禁止重复 id/alias。为兼容现有领域模型，用户填写的 project/module 可落入 draft 的 `productArea`/`component`，最终执行目标必须落为明确的 `environmentProfileId`。持久化 BugReport 不得保存用户提供的任意 raw repository path 作为执行依据。

## 5. Pi SDK 集成

### 5.1 包和边界

- workspace 依赖固定为 `@earendil-works/pi-coding-agent@0.84.4`，运行时满足其 Node `>=22.19.0` 要求。
- Pi SDK 的 import、model/provider 初始化、session 生命周期和 SDK 适配代码只能位于 `packages/pi-runner`。
- Orchestrator 只依赖 `AgentRunner`；不得 import Pi SDK 类型或调用 `createAgentSession`。
- 删除当前自定义的 fake `PiSdk.run()` 接口。保留 `AgentRunner` 和 `FakePiRunner`，fake runner 的 session 记录能力继续用于测试。

### 5.2 每次运行的 session

`PiAgentRunner.runFixer` 和 `runReviewer` 每次调用都必须创建新的、互不共享 transcript 的 in-memory session，核心流程为：

```text
ModelRuntime（隔离配置）
    ↓
createAgentSession({ cwd, model, tools, sessionManager: SessionManager.inMemory(cwd), ... })
    ↓
session.prompt(instruction)
    ↓
Pi 自己执行 LLM/tool-call/结果循环
    ↓
session.getLastAssistantText()
    ↓
提取最终 JSON → strict Zod parse
```

实现必须在 `finally` 中执行 `session.dispose()`；超时或 AbortSignal 触发时也必须清理 session。Fixer 和 Reviewer 的 session id 必须不同。不得通过 session 文件、全局状态或复用历史 transcript 泄漏其他 Bug 的上下文。

### 5.3 OpenAI-compatible provider

`PiAgentRunner` 应创建隔离的 `ModelRuntime`，动态注册一个内部 provider（例如 `llmbugfix`）：

- `baseUrl` 使用 `LLM_ENDPOINT_URL`。
- `apiKey` 使用 `LLM_API_KEY`（可为空），按 provider 的 auth header 约定发送。
- API 使用 Pi 支持的 `openai-completions`（若 endpoint 明确要求 responses，需显式配置而非猜测）。
- model id 使用 `LLM_MODEL`，并提供合理的 context window/max tokens/cost metadata。

不要依赖或修改服务器用户的 `~/.pi` models、settings、extensions 或 credentials 文件。Provider 注册失败、模型不存在、endpoint 非 2xx、响应不符合 Pi 预期时，应返回脱敏错误并让 pipeline 进入失败状态。

### 5.4 资源隔离与显式上下文

通过 SDK 的 `ResourceLoader` 和 settings 选项显式控制资源：

- extensions、skills、prompts、themes、agents files 默认返回空集合。
- 不自动发现用户目录、仓库 `.pi` 目录或其他环境的 context/skills。
- Fixer 所需 environment Markdown、Skill 和附件派生文本由 Orchestrator 读取后通过 `FixerInput`/prompt 显式传入。
- Reviewer 只接收 BugFixTask、profile、diff、filesChanged、deterministic validation 和安全说明；不接收 Reporter 对话中的无关原文。
- session settings 使用 in-memory/显式设置，避免读取用户全局配置；允许 compaction/retry 但必须受 timeout 约束。

Prompt 中的 safety 文本（禁止 push、merge、deploy、生产访问和不必要的依赖下载）是行为指导，不是 sandbox。实现不得把它当作安全边界（详见第 10 节）。

## 6. Tool 白名单

每个 session 创建时必须显式传入工具列表，不能使用 Pi 默认工具集合：

| Agent | 允许工具 | 禁止工具/能力 |
| --- | --- | --- |
| Fixer | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` | 通过 prompt 禁止 push/merge/deploy/生产访问；不允许修改 worktree 之外的项目文件。 |
| Reviewer | `read`, `grep`, `find`, `ls` | 不得有 `edit`、`write`、`bash`，不得修改文件或执行任意命令。 |

Reviewer 的只读约束必须由 SDK 工具列表强制实现，而不是只写在 prompt 中。测试应直接断言 session options 的工具集合。

## 7. Agent 输入和输出 contract

### 7.1 Fixer 输入

Fixer 只接收当前 job 的：

- `safety` 指令。
- `BugFixTask`（严格按 `BugFixTaskSchema`）。
- 已解析的 environment profile。
- profile Markdown/Skill 的路径和内容。
- 附件的 id、提取文本或分析结果；不传未处理的二进制内容。
- 当前 worktree `cwd`。

Fixer 必须先理解问题，再在 worktree 内复现、定位并修复；是否修改代码由 Agent 决定，但最终必须输出机器可解析结果。Agent 自报“测试通过”不替代 Orchestrator 的 deterministic validation。

### 7.2 Reviewer 输入

Reviewer 接收 `BugFixTask`、profile、当前 diff、filesChanged、安全说明和已经执行的 `DeterministicValidation`。Reviewer 不应重新相信 Fixer 的自然语言总结，也不能从全局 session 获取其他上下文。

### 7.3 最终 JSON

`session.getLastAssistantText()` 的最终 assistant 文本必须包含且只应解析为一个结果对象。允许实现剥离单个 Markdown ```json 围栏，但不能从任意工具输出、多个 JSON 或模糊自然语言中猜结果。解析后使用严格 schema；`bugKey` 必须等于当前任务。

Fixer 结果必须符合 `AgentFixResultSchema.strict()`：

```json
{
  "bugKey": "BUG-000001",
  "status": "fixed",
  "confidence": 0.0,
  "summary": "...",
  "rootCause": "...",
  "reproduced": true,
  "regressionTestAdded": false,
  "filesChanged": ["src/example.ts"],
  "riskNotes": [],
  "blockedReason": null,
  "missingInformation": []
}
```

`status` 可为 `fixed`、`blocked`、`not_reproducible`、`failed`；confidence 必须在 0 到 1 之间。Reviewer 结果必须符合 `ReviewResultSchema.strict()`：

```json
{
  "verdict": "approve",
  "bugAddressed": true,
  "regressionRisk": "low",
  "summary": "...",
  "findings": []
}
```

`verdict` 只能是 `approve`/`reject`，`regressionRisk` 只能是 `low`/`medium`/`high`。解析、schema 校验或 bugKey 校验失败都必须阻断后续 validation/commit/push，并写入脱敏的失败 artifact。

## 8. Worker 与流水线接线

启动 bootstrap 必须实例化并注入：

```text
parseConfig
  → openDatabase / SQLiteBugRepository
  → 单一 JobQueue（process lock）
  → EnvironmentResolver
  → RepoManager
  → EnvironmentRunner
  → PiAgentRunner（LLM 配置）
  → Validator
  → Orchestrator.start()
  → BugApiServer.listen()
```

提交接口只负责持久化 Bug 和 enqueue；worker 负责消费，不应在 HTTP 请求中同步执行修复。每个 job 继续遵守 WP05 的状态和 gate：

- profile/repository/environment 准备失败：不调用 Fixer，进入 `ENVIRONMENT_FAILED` 或 `BLOCKED`。
- Fixer 非 `fixed` 或输出无效：进入 `FIX_FAILED`。
- deterministic validation 失败：进入 `VALIDATION_FAILED`，不调用 Reviewer。
- Reviewer 非 approve、`bugAddressed=false` 或风险 high：进入 `REVIEW_REJECTED`，不得 commit/push。
- 仅 review gate 通过后才按既有 dry-run/commit/push 逻辑进入 `FIX_READY`/`READY_FOR_HUMAN_REVIEW`。

每个 pipeline 必须继续记录开始/结束时间、阶段状态、严格校验后的 Agent 输出或错误；API、队列和 worker 的启动日志要能区分“真实 worker 已启用”“fake/local 模式”和“配置错误”。第一版不要求把 Pi 的内部 session id 持久化到领域表。

## 9. 超时、取消和错误处理

- Fixer 和 Reviewer 分别使用 `FIXER_TIMEOUT_MS`、`REVIEWER_TIMEOUT_MS`；不要用一个无限等待的 Promise 包裹 Agent。
- timeout 调用 Pi session `abort()`，停止等待、dispose session，并让 Orchestrator 对 job 执行现有 fail/状态转换；不能继续 validation 或 push。
- API 关闭、SIGINT/SIGTERM 必须先停止新 job polling，并等待当前 job 完成或触发 Agent timeout 后再关闭 queue/database。第一版的 queue cancel 不承诺抢占正在进行的 Pi tool call。
- endpoint 错误、鉴权错误、模型输出无效、Pi tool error、超时和取消都要有稳定的错误分类；对外和日志只展示脱敏消息，不包含 API key、完整 prompt 或敏感附件。
- Job heartbeat 必须覆盖长时间 Fixer/Reviewer 调用；stale recovery 不能让同一 job 同时运行两个 Agent。

## 10. 第一版 Bash 风险与后续约束

第一版按产品决策允许 Fixer 使用 Pi 内置 `bash`，但**不提供真正的 sandbox**。Pi 的 bash 不会自动经过现有 Validator 的受限 `CommandRunner`；因此 prompt 中的“禁止 network/push/merge/deploy”不是强制隔离。若 Agent 恶意或误判，理论上可能访问网络、读取 worker 进程可见的主机文件/secret、修改 worktree 外文件或执行破坏性命令。

因此第一版必须明确标注为受信环境试运行：

- 只在专用机器、专用低权限账号和非生产 repository 上启用真实 worker。
- 不在 worker 环境变量中放入不必要的生产凭据；API key 只用于 LLM provider。
- 继续使用 RepoManager 的 repository/worktree/branch/remote allowlist，Reviewer 仍严格只读。
- 保留每次命令/Agent/job 的 timeout、取消、artifact 和审计记录；不能因没有 sandbox 而删除这些控制。
- 文档、启动日志或运维说明必须显示“Pi bash sandbox 未启用”的警告。

后续版本必须将 Pi bash 放入真实执行隔离（容器、VM、受限 runner 或等价 execution policy），限制网络、filesystem、CPU/memory、进程和 secret；完成前不得把未知/不受信 repository 交给自动 Fixer。此项是明确的后续安全门槛，不阻塞本工作包第一版验收。

## 11. 验收标准

### 11.1 配置与 Intake

- [ ] 只配置 `LLM_ENDPOINT_URL`、`LLM_MODEL`、可选 `LLM_API_KEY` 和 `INTAKE_CONFIG_PATH`（加上已批准 repository/profile 配置）即可启动真实模式。
- [ ] Intake 实际向该 endpoint 的 `/chat/completions` 请求，并将 Markdown 规则纳入上下文；没有硬编码问题清单替代 Markdown。
- [ ] 追问可让测试者提供项目/模块；提交结果包含明确且唯一的 `environmentProfileId`。
- [ ] 未知/歧义项目模块、绝对路径、任意 Git URL 或 path traversal 永远不能产生可执行 job。
- [ ] API key 不出现在日志、错误、prompt、数据库和 artifact 中。

### 11.2 Pi Adapter

- [ ] package 使用 `@earendil-works/pi-coding-agent@0.84.4`，Node 版本满足 SDK 要求。
- [ ] `PiSdk.run()` 不再存在；Orchestrator 仅依赖 `AgentRunner`，`FakePiRunner` 测试仍可用。
- [ ] Fixer/Reviewer 使用 `createAgentSession`、`session.prompt`、`session.getLastAssistantText`，每次为独立 in-memory session。
- [ ] Pi loop/tool calls 由 SDK 完成；仓库没有第二套手写 function-calling loop。
- [ ] Fixer 工具集合准确为 `read/grep/find/ls/edit/write/bash`；Reviewer 准确为 `read/grep/find/ls`。
- [ ] 全局 Pi extensions/skills/prompts/themes/agents/context 未被自动加载；provider/settings 使用隔离配置。
- [ ] 有效结果通过 strict Zod contract，非法 JSON、额外字段、多个结果对象、错误 bugKey 均阻断 pipeline。
- [ ] timeout 调用 abort；timeout、异常和正常完成都调用 session dispose，并保留 pipeline/result artifact。

### 11.3 Worker 闭环

- [ ] `pnpm dev` 在真实配置下同时启动 API 和单 worker；提交的 job 能被 claim，不会永久停在 queue。
- [ ] API/worker 复用同一 queue lock；任意时刻最多一个 pipeline job RUNNING。
- [ ] environment fail、Fixer fail/timeout、validation fail、Reviewer reject/high risk 均不 commit/push，并进入可查询状态。
- [ ] Reviewer 无写权限；review gate 通过前不会调用 commit/push。
- [ ] SIGINT/SIGTERM 能停止 polling，等待当前受 timeout 约束的 job，并在其结束后释放 queue/database 资源。
- [ ] 未配置 LLM 时的 local/fake 模式行为诚实可见，不误报“已自动修复”。

### 11.4 回归与构建

- [ ] Pi runner 单元测试使用 fake session factory 或 mock SDK，不依赖外网和真实 API key。
- [ ] OpenAI-compatible Intake 使用注入 fetch 验证 URL、system context 与结果 contract；Pi provider 使用真实隔离 ModelRuntime 加载测试，但单测不访问真实 endpoint。
- [ ] 测试断言两个 in-memory session manager 不同、cwd/tool 白名单不同、资源 loader 为空、session dispose 被调用。
- [ ] 项目/模块 profile 映射有唯一、未知、歧义、路径穿越测试。
- [ ] 有一条使用 FakePiRunner 的 queue → orchestrator 集成测试，以及一条配置真实 Pi runner 但 mock endpoint 的接线测试。
- [ ] `pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm lint` 和 `git diff --check` 通过。

## 12. 实现边界与建议文件

- `packages/pi-runner/**`：真实 Pi SDK provider/session/resource loader、超时取消、结果提取和测试 seam。
- `packages/intake-agent/**`：读取 Intake Markdown 并将其传入已有 OpenAI-compatible Intake Adapter。
- `packages/environment-resolver/**`、`config/environments.yaml`：项目/模块 alias 到 profile/repository 的受信映射及校验。
- `apps/bug-api/src/local-server.ts` 或独立 bootstrap：根据配置接线 API、queue、Orchestrator 和优雅 shutdown。
- `apps/orchestrator/**`：仅在需要接入生命周期/heartbeat 时调整；保留 AgentRunner 依赖倒置。

任何超出上述边界的领域模型、UI 或数据库变更，都必须说明兼容性和迁移影响，并补相应测试。
