# LLM Bugfix V4 使用说明

本文档说明当前仓库中已经实现的离线优先 Bug 提交、队列编排和修复验证能力，以及部署时需要由宿主应用补齐的部分。

## 1. 适用范围与系统边界

系统将测试人员的自然语言描述整理为结构化 Bug，保存到 SQLite，然后把信息完整的报告放入单任务队列。编排器依次准备环境、运行修复 Agent、执行确定性校验、进行审查，并在安全条件满足时生成修复结果。

当前实现的边界如下：

- 数据库是本地 SQLite（WAL、外键和 5 秒 busy timeout），附件和 Agent 产物写入本地文件系统。
- 默认 `DRY_RUN=true`，会执行到审查和 `FIX_READY`，不会提交或推送 Git。
- 真实 Pi 由 `@earendil-works/pi-coding-agent` 驱动；`AgentRunner` 仍是编排边界，`FakePiRunner` 仅用于离线测试。
- 图片识别默认是禁用适配器；内部视觉服务必须显式注入，并且只能使用私有网络地址。
- 没有 GitLab API、Merge Request、自动合并、自动部署或生产环境访问能力。
- 非 dry-run 模式只允许推送 `ai/*` 分支，并要求 `origin` 主机在 allow-list 中；推送也不会创建 MR 或合并。
- Intake 模型只负责提取事实、补问和整理草稿，不负责诊断根因、修改代码或运行命令。

## 2. 前置条件

建议使用以下版本：

- Node.js >= 22.19（Pi SDK 的最低要求）
- pnpm >= 9
- Git >= 2.30（只有编排和需要本地仓库时才必需）

安装依赖需要已有的 pnpm store。项目按离线方式设计，推荐：

```bash
pnpm install --offline --frozen-lockfile
```

如果本机没有缓存依赖，离线安装会失败；不要为了启动系统临时连接公共网络。

## 3. 配置

复制示例并按部署环境编辑：

```bash
cp .env.example .env
```

主要变量如下：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DATABASE_PATH` | `data/bugfix.sqlite` | SQLite 文件；父目录会自动创建 |
| `DATA_ROOT` | `data` | 附件、锁文件、worktree 和 Agent 结果的根目录 |
| `MAX_ATTACHMENT_BYTES` | `52428800` | 宿主接线到 `AttachmentService` 的文件上限，50 MiB |
| `LOG_LEVEL` | `info` | `fatal/error/warn/info/debug/trace/silent` |
| `DRY_RUN` | `true` | 安全开关；设为 `false` 才允许进入 Git 推送阶段 |
| `FIXER_TIMEOUT_MS` | `2700000` | 宿主/Agent 适配器使用的修复器超时，45 分钟 |
| `REVIEWER_TIMEOUT_MS` | `900000` | 宿主/Agent 适配器使用的审查器超时，15 分钟 |
| `ENVIRONMENT_TIMEOUT_MS` | `600000` | 宿主传给环境执行器的命令超时，10 分钟 |
| `PIPELINE_TIMEOUT_MS` | `5400000` | 流程总超时，90 分钟（由宿主负责传递/监管） |
| `LLM_ENDPOINT_URL` | 空 | OpenAI-compatible base URL；与 `LLM_MODEL` 同时配置后启用真实 Intake 和 Pi worker |
| `LLM_MODEL` | 空 | endpoint 提供的模型 id |
| `LLM_API_KEY` | 空 | 可选 endpoint credential；不得写入 prompt、日志或产物 |
| `PI_SANDBOX_PROFILE` | 空 | 外部宿主/容器隔离配置名称；未设置时真实 Pi worker fail-closed，不会启动 |
| `INTAKE_CONFIG_PATH` | `config/bug-intake.md` | 测试人员必须提供的信息和追问规则 |
| `ENVIRONMENT_CONFIG_PATH` | `config/environments.yaml` | 项目/模块到受批准 repository/profile 的映射 |
| `LLM_HOST` | `disabled://local` | 宿主构造 Intake LLM 适配器时使用的内部地址；禁用值不会发请求 |
| `VISION_HOST` | `disabled://local` | 宿主构造视觉适配器时使用的内部地址；禁用值不会发请求 |
| `GIT_HOST` | `localhost` | Git 目标标识；非禁用主机必须通过 allow-list |
| `GIT_ALLOWED_HOSTS` | `localhost` | 逗号分隔的 Git 主机白名单 |

`packages/shared` 的 `parseConfig()` 解析基础存储配置；`pnpm dev` 的 bootstrap 读取其余变量并接线真实 Adapter。不要把密码、Token、Cookie、API key 或私钥写入 `.env` 以外的 Bug 描述、附件、Profile、日志和产物。

### 环境 Profile 配置

`config/environments.yaml` 的 Profile 路径按 `EnvironmentResolver` 的 `rootDir` 解析，默认是宿主进程当前目录。示例中的：

```yaml
repository: "${FRONTEND_MAIN_REPOSITORY}"
```

会从服务进程环境变量读取。比如在 `.env` 中设置 `FRONTEND_MAIN_REPOSITORY=/srv/repos/frontend`。变量缺失、目录不存在、不是 Git repository 或不在批准 roots 内时，真实 worker 模式会启动失败。测试人员只选择 Profile 的 id/name，不提交 filesystem path。Profile 至少需要 `id`、`name`、`target`（`frontend`/`backend`）和 `repository`；`defaultBranch` 默认是 `main`。

## 4. 安装后的构建与校验

在当前目录执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

如需检查各个已声明 workspace 包自己的构建脚本，可额外执行：

```bash
pnpm -r build
```

注意：根目录 `pnpm build` 是本仓库的完整源码校验和本地启动产物准备步骤；它会同步每个运行时 workspace（包括 `apps/orchestrator`）的 JavaScript、声明和 source map 到 `dist/`。部署或运行前仍应先执行该命令。

提交部署前应四项均通过。测试包含 API、附件、状态机、队列、环境解析、验证器、Git 管理器以及使用 fake 依赖的 pipeline E2E；它们不证明真实 Pi、内部 LLM、视觉服务、凭据、远程网络、GitLab 或生产部署可用。

## 5. 启动和部署方式

### 5.1 启动 UI/API-only 模式

仓库提供了一个仅用于本地验证的启动入口。它会启用 SQLite、附件、本地单任务队列和三个页面，但不会启动修复 Worker，也不会调用 LLM、视觉服务、Git 或网络服务。这样可以安全验证“创建会话 → 编辑/提交 Bug → Dashboard 查看队列”的完整 UI/API 流程。

```bash
cp .env.example .env
pnpm install --offline --frozen-lockfile
pnpm dev
```

浏览器打开 `http://127.0.0.1:8033/`；Dashboard 是 `http://127.0.0.1:8033/dashboard`，健康检查是 `http://127.0.0.1:8033/api/health/ready`。首次启动会在 `DATA_ROOT`（默认 `data/`）创建 SQLite 数据库、附件目录和队列锁文件。使用 `Ctrl+C` 正常停止，会释放锁文件。可通过 `PORT=3000 pnpm dev` 改端口；默认监听地址为 `127.0.0.1`，如需监听所有地址，使用 `pnpm dev -- --host`（监听 `0.0.0.0`）。当前 API 尚未实现认证授权，暴露到局域网前请确认网络可信。

`pnpm dev` 使用 esbuild 打包并监听 TypeScript 源码；每次成功重建会自动重启本地 Node 服务，通常不需要等待完整 TypeScript 编译。它只负责快速转换，不做完整类型检查；提交前仍应运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。`pnpm start` 保持为完整 `tsc` 构建后启动的验证命令，适合一次性手工验证。每次启动保留本地 `data/` 中的记录。若需要全新演示数据，请在服务停止后自行换一个 `DATA_ROOT`，例如 `DATA_ROOT=tmp-demo pnpm dev`。

### 5.2 启动真实 Intake 和 Pi worker

在 `.env` 中补齐以下值：

```dotenv
LLM_ENDPOINT_URL=http://your-endpoint/v1
LLM_MODEL=your-model
LLM_API_KEY=
INTAKE_CONFIG_PATH=config/bug-intake.md
ENVIRONMENT_CONFIG_PATH=config/environments.yaml

FRONTEND_MAIN_REPOSITORY=/absolute/path/to/frontend-repo
BACKEND_MAIN_REPOSITORY=/absolute/path/to/backend-repo

DRY_RUN=true
PI_SANDBOX_PROFILE=external-container-or-host-profile
```

然后仍然只运行 `pnpm dev`。启动入口会把同一个 endpoint 接给 Intake、Pi Fixer 和 Pi Reviewer，加载 Intake Markdown 与 environment profiles，校验每个 repository 是批准的本地 Git checkout，并在同一进程启动单 worker。任一 LLM 配置只填写一半、Markdown 不可读、Profile 环境变量缺失或 repository 无效都会直接报配置错误，不会静默使用 Fake Agent。

Endpoint 必须兼容 OpenAI Chat Completions，并支持 tool calls/function calling；Pi 负责完整的 Agent/tool loop。Fixer 可使用 `read/grep/find/ls/edit/write/bash`，Reviewer 只有 `read/grep/find/ls`。两者使用独立的内存 session，不读取服务器用户的全局 Pi extensions、skills、prompts 或 context。

Pi 的内置 `bash` 本身不是系统级 sandbox；Prompt 中的“禁止网络、push、deploy”也只是行为约束。`PI_SANDBOX_PROFILE` 是一个部署声明，不会自行创建隔离：宿主必须实际以受限容器、VM、seccomp/AppArmor 或等效机制运行 worker。未设置时入口 fail-closed，不启动真实 worker。保持 `DRY_RUN=true` 只会禁止最后的 commit/push，并不会替代宿主隔离。

## 6. 测试人员提交 Bug

页面或 API 的完整流程如下：

1. `POST /api/bugs/conversations` 创建会话。服务会返回会话 ID，并发送首条提示。
2. 将复现过程、实际结果、期望结果和环境发到 `POST /api/bugs/conversations/:id/messages`，请求体为 `{ "content": "..." }`。每轮最多补问 3 个问题；可以明确回答 `unknown`/“不确定”，系统不会无限重复追问。
3. 通过 `GET /api/bugs/conversations/:id/draft` 查看草稿，或用 `PATCH /api/bugs/conversations/:id/draft` 编辑。可传 `{ "draft": { ... }, "userEditedFields": ["title", "reproduction.steps"] }`；人工编辑字段会覆盖后续 Intake 模型更新。
4. 页面显示完整性评分和缺失项。评分达到 65 才会进入可确认状态；缺少关键事实时会进入 `NEEDS_INFO`，不会排入修复队列。
5. 展示草稿预览后，使用 `POST /api/bugs/conversations/:id/submit`，请求必须含 `{ "confirm": true }` 或 `{ "confirmed": true }`。没有显式确认会返回 400。
6. 成功提交会生成类似 `BUG-000001` 的 Key。信息充分时状态依次经过收集/确认/提交/分诊并变为 `QUEUED`，且若队列已注入则创建 Job；不足时变为 `NEEDS_INFO`。重复提交同一会话是幂等的。

### 附件

附件接口要求先有已创建的 Bug：

```http
POST /api/bugs/BUG-000001/attachments
Content-Type: application/json

{"filename":"screen.png","mimeType":"image/png","data":"<base64>"}
```

支持 `png/jpg/jpeg/webp` 图片、`txt/log` 文本、`json/har` JSON/HAR 和 `mp4`；扩展名必须与 MIME 匹配，默认上限 50 MiB。文本和 JSON 会在保存/提取前脱敏并限制提取大小；文件名和路径会做安全校验。图片没有可用视觉服务时状态为 `unsupported`，页面应要求测试人员补充截图中的关键文字和现象。

## 7. Dashboard、详情和运维 API

宿主挂载页面后：

- `/dashboard` 使用 `renderDashboardHtml()`，通过 `GET /api/bugs` 加载列表，支持 `q`（Key/标题搜索）、`target` 和 `status` 过滤。
- `/bugs/:id` 使用 `renderDetailHtml(id)`，通过 `GET /api/bugs/:id` 加载摘要、复现、环境、证据、附件、会话消息、进度、修复、验证、审查和分支/提交信息。
- `GET /api/bugs/:id/progress` 返回当前状态、全部 Job 和最新 Job。
- `GET /api/bugs/:id/artifacts` 返回当前可读产物文件名和内容；尚未运行到的阶段返回空或缺失是正常现象。
- `GET /api/environments` 返回已加载 Profile。
- `GET /api/ops/jobs` 返回队列 Job；响应明确标记 `automaticRetry: false`。

健康检查：`GET /api/health/live`（别名 `/api/health`、`/healthz`）表示进程存活；`GET /api/health/ready`（别名 `/readyz`）检查数据库，未注入队列时会标记 `queue: not_configured`。就绪检查失败时不要把流量切入该实例。

## 8. 编排生命周期

提交阶段：

```text
DRAFT → COLLECTING → READY_FOR_CONFIRMATION → SUBMITTED → TRIAGING
                                                         ├→ NEEDS_INFO
                                                         └→ QUEUED
```

Worker 成功路径：

```text
QUEUED → PREPARING_ENV → FIXING → VALIDATING → REVIEWING → FIX_READY
                                                                  └→ PUSHING → READY_FOR_HUMAN_REVIEW
```

环境准备包括 setup 命令、可选 runtime start 和 health check。验证器按 Profile 的 `validationCommands` 顺序执行，不通过即 `VALIDATION_FAILED`。审查必须 approve、确认 Bug 已解决且回归风险不能为 high；否则为 `REVIEW_REJECTED`。dry-run 在 `FIX_READY` 完成队列 Job；非 dry-run 才进入受保护的 `PUSHING`。

失败状态包括 `ENVIRONMENT_FAILED`、`FIX_FAILED`、`VALIDATION_FAILED`、`REVIEW_REJECTED`、`PUSH_FAILED` 和 `BLOCKED`。队列 Job 自身状态为 `QUEUED → RUNNING → COMPLETED/FAILED`，取消为 `CANCELLED`；心跳过期的 RUNNING Job 被标为 `INTERRUPTED`，不会自动重试。

## 9. 增加 Environment Profile、Markdown 和 Skill

1. 在 `config/environments.yaml` 的 `environments` 数组新增唯一 `id`、`name`、`target`、实际本地 `repository` 和分支。
2. 在仓库根目录下创建 Profile 文档，例如 `environments/my-app/ENVIRONMENT.md` 和 `environments/my-app/TESTING.md`，在 Profile 的 `markdown` 数组填相对路径。
3. 在 `.pi/skills/<name>/SKILL.md` 创建技能规则，在 Profile 的 `skills` 数组填相对路径。当前解析器要求路径为相对路径、文件存在、真实路径仍位于配置 root 内，单文件默认不超过 256 KiB。
4. `setupCommands`、`validationCommands` 和 runtime 命令只允许简单 argv；命令会拒绝 shell 元字符，不要写 `;`、管道、重定向、反引号或 `$()`。依赖安装应使用已有缓存的离线模式。
5. 重新创建 `EnvironmentResolver` 或调用 `reload()` 后，通过 `GET /api/environments` 确认 Profile；同一 target 必须只有一个可自动匹配 Profile，否则必须在 Bug 草稿中明确 `environmentProfileId`。

Profile 文档应提供事实和验证规则，不应放凭据、秘密、部署命令或生产访问方式。Agent 会收到 Profile、Markdown、Skill 和附件脱敏内容，但安全边界仍由宿主和命令 allow-list 执行。

## 10. 失败恢复、取消与重试

系统不自动重试。先查看 Job 和产物，再由人工决定：

```http
POST /api/ops/recover
Content-Type: application/json

{"staleTimeoutMs":60000}
```

该操作只把心跳过期的 `RUNNING` Job 标为 `INTERRUPTED`，响应中的 `manualRetryRequired` 列出需要人工处理的 Job ID；它不会重新排队。

对失败 Bug 使用：

```http
POST /api/bugs/BUG-000001/retry
```

只接受失败终态或 `FAILED`/`INTERRUPTED` Job，并明确返回 `automatic: false`。修复前应先处理根因（例如 Profile 路径、依赖缓存、验证命令或 allow-list），确认 worktree/锁文件状态后再重试。对排队或安全运行阶段可使用：

```http
POST /api/bugs/BUG-000001/cancel
```

运行中的安全阶段是“请求中断”；不安全阶段返回 409 和 `cancellable:false`。不要手动删除仍被活动 Worker 所有的 worktree 或 lock 文件。

## 11. 产物与审计

每个流程写入 `${DATA_ROOT}/agent-results/<BUG-KEY>/`。API 会读取并返回以下 9 类标准文件（缺失表示该阶段尚未完成）：

```text
bug.json          fix-task.json       environment.json
agent-result.json validation.json     review.json
git-result.json   pipeline.json       diff.patch
```

实际编排还会写 `environment-run.json` 和（环境成功启动后）`environment-stop.json`，但当前 API 的筛选读取逻辑不把这两个文件列入公开产物响应。JSON 产物记录任务、Agent 结果、验证、审查和 Git 状态；`diff.patch` 是当前 worktree 相对 HEAD 的二进制 diff。文件创建权限为 `0600`，API 读取的单文件上限为 2 MiB。

数据库升级使用 additive SQLite 初始化。升级前备份 `DATABASE_PATH` 和整个 `DATA_ROOT`；不要把附件或产物提交到公共仓库。

## 12. 排障

| 现象 | 检查项 |
| --- | --- |
| 依赖安装失败 | 确认 Node/pnpm 版本和本地 pnpm store；保持 `--offline` 时补齐缓存 |
| API 无法就绪 | 查看 `/api/health/ready`，确认 `DATABASE_PATH` 父目录可写、SQLite 文件未被占用 |
| 没有 Bug 进入队列 | 查看提交返回的 `completeness` 和状态；低于 65 会进入 `NEEDS_INFO`，且未注入 queue 时不会建 Job |
| `No environment profile`/`Ambiguous` | 检查 target、唯一匹配关系和 `environmentProfileId`；调用 `/api/environments` 查看已加载配置 |
| Profile 文件被阻止 | 使用相对路径，确认文件存在、未符号链接到 root 外，且不超过 256 KiB |
| setup/validation 失败 | 查看 `environment-run.json`、`validation.json` 及脱敏日志，单独在 worktree 中复现命令 |
| Job 卡在 RUNNING | 先看 heartbeat；确认旧进程已停止后调用 `/api/ops/recover`，再人工 retry |
| push 被拒绝 | 保持 `DRY_RUN=true` 做验证；确认当前分支是 `ai/*`、origin 存在且主机在 `GIT_ALLOWED_HOSTS` 与 `RepoManager.allowedRemoteHosts` 中 |
| 图片没有识别结果 | 这是默认 disabled adapter 的预期行为；使用 `/internal/vision/analyze` 前必须注入附件服务和私有视觉 Provider |
| 页面空白/404 | 宿主必须自行挂载三个 `render*Html()` 页面；BugApiServer 本身只提供 API |

日志会做基础脱敏，但脱敏不是绝对保证。提交前清理复制粘贴内容，发现疑似凭据时立即撤销/轮换，并避免在工单、截图、HAR、日志和 Agent prompt 中传播。

## 13. 安全检查清单

- 首次部署保持 `DRY_RUN=true`，只使用临时本地 Git checkout 和测试数据。
- 只向内网/loopback 绑定 API，并在宿主增加认证、授权、CSRF/审计和限流；当前实现没有这些能力。
- 为 `repositoryRoots`、`worktreesRoot`、附件根目录和 Profile root 设置最小权限，避免使用宽泛的文件系统根路径。
- 只允许经过审查的 setup/validation/runtime 命令；命令执行器禁用 shell，并限制 cwd 和输出长度。
- 推送前人工检查 diff、验证结果、审查结果和 `git-result.json`；系统永远不会自动合并、部署或访问生产。
