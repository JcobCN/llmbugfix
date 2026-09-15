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
- 非 dry-run 模式只允许推送 `ai/*` 分支，并要求 `origin` 主机在 allow-list 中；推送目标是自己账号（`GITLAB_ACCOUNT`，默认 `codigger-llm`）在 `GITLAB_URL` GitLab 上的同名私有镜像仓库，仓库不存在时自动创建，PAT 优先取自 `~/.git-credentials`，缺失时用 `GITLAB_PASSWORD` 自动生成并写回；推送也不会创建 MR 或合并。
- Intake 模型只负责提取事实、补问和整理草稿，不负责诊断根因、修改代码或运行命令。对于未配置的项目，Intake 可以收集远程 Git 地址并提出 Profile proposal；只有测试人员显式确认提交后，服务才会 clone 仓库并生成可执行 Profile。

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
| `PI_FIXER_MAX_TURNS` | `80` | Fixer 最大 Agent turn 数；达到后只发送一次收尾提交提示 |
| `PI_FIXER_MAX_TOOL_CALLS` | `240` | Fixer 最大 tool execution 数 |
| `PI_FIXER_MAX_REPEATED_TOOL_CALLS` | `4` | 连续相同 tool 调用阈值 |
| `PI_FIXER_CLOSEOUT_GRACE_MS` | `15000` | 预算触发后收尾提交的短宽限期 |
| `PI_REVIEWER_MAX_TURNS` / `PI_REVIEWER_MAX_TOOL_CALLS` | `80` / `240` | Reviewer 对应 Agent loop 上限 |
| `PI_REVIEWER_MAX_REPEATED_TOOL_CALLS` / `PI_REVIEWER_CLOSEOUT_GRACE_MS` | `4` / `15000` | Reviewer 对应重复调用和收尾宽限期 |
| `ENVIRONMENT_TIMEOUT_MS` | `600000` | 宿主传给环境执行器的命令超时，10 分钟 |
| `PIPELINE_TIMEOUT_MS` | `5400000` | 流程总超时，90 分钟（由宿主负责传递/监管） |
| `LLM_ENDPOINT_URL` | 空 | OpenAI-compatible base URL；与 `LLM_MODEL` 同时配置后启用真实 Intake 和 Pi worker |
| `LLM_MODEL` | 空 | endpoint 提供的模型 id |
| `LLM_API_KEY` | 空 | 可选 endpoint credential；不得写入 prompt、日志或产物 |
| `INTAKE_LLM_TIMEOUT_MS` | `60000` | Intake 和 Document Reconciler 的 LLM 请求超时，60 秒；必须是正整数 |
| `PI_SANDBOX_PROFILE` | 空 | 外部宿主/容器隔离配置名称；未设置时真实 Pi worker fail-closed，不会启动 |
| `INTAKE_CONFIG_PATH` | `config/bug-intake.md` | 测试人员必须提供的信息和追问规则 |
| `ENVIRONMENT_CONFIG_PATH` | 未配置（可选） | 可选的静态 Profile 目录；不配置时使用 Intake 确认后生成的 Profile |
| `LLM_HOST` | `disabled://local` | 宿主构造 Intake LLM 适配器时使用的内部地址；禁用值不会发请求 |
| `VISION_HOST` | `disabled://local` | 宿主构造视觉适配器时使用的内部地址；禁用值不会发请求 |
| `GIT_HOST` | `localhost` | Git 目标标识；非禁用主机必须通过 allow-list |
| `GIT_ALLOWED_HOSTS` | `localhost` | 逗号分隔的 Git 主机白名单 |
| `GITLAB_URL` | `http://172.29.100.126` | 自己账号私有镜像仓库所在的 GitLab 地址（见 `docs/gitlab-private-repo-api.md`）；设为空字符串则回退推送到 origin |
| `GITLAB_ACCOUNT` | `codigger-llm` | 私有镜像仓库所属账号；PAT 优先从 `~/.git-credentials` 读取 |
| `GITLAB_PASSWORD` | `Engine#llm` | 仅在 `~/.git-credentials` 没有 PAT 时，通过 Web 登录自动生成 PAT 并写回凭据文件 |

`packages/shared` 的 `parseConfig()` 解析基础存储配置；`pnpm dev` 的 bootstrap 读取其余变量并接线真实 Adapter。`ENVIRONMENT_CONFIG_PATH` 不是动态流程的前置条件：省略它时，服务仍可使用确认后写入 `DATA_ROOT/generated-environments.yaml` 的 Profile。不要把密码、Token、Cookie、API key 或私钥写入 `.env` 以外的 Bug 描述、附件、Profile、日志和产物。

### 环境 Profile 配置

Profile 有两个来源：

1. 可选的静态目录，例如 `config/environments.yaml`。只有设置 `ENVIRONMENT_CONFIG_PATH`（或由宿主显式传入其他目录）时才需要维护它；其中的 `repository` 是服务端已有的本地 Git checkout，仍可使用 `${VARIABLE}` 占位符。
2. 动态生成目录 `DATA_ROOT/generated-environments.yaml`。真实 Intake 从对话中收集项目名、frontend/backend 目标、HTTPS/SSH clone URL 和（可选）默认分支。测试人员确认提交后，服务调用 `git clone` 到 `DATA_ROOT/repositories/<generated-id>`，然后将本地 checkout、原始 `repoUrl`、分支和可选命令写入该文件。

因此，动态流程不需要预先配置 `ENVIRONMENT_CONFIG_PATH`，也不需要 `E2E_FRONTEND_REPOSITORY`、`FRONTEND_MAIN_REPOSITORY` 或 `BACKEND_MAIN_REPOSITORY`。测试人员不应提交 filesystem path；远程 URL 是对话中唯一需要提供的仓库定位信息。生成的 Profile 至少包含 `id`、`name`、`target`（`frontend`/`backend`）和服务端本地 `repository`；`defaultBranch` 未提供时使用 `main`。静态和动态 Profile 会合并加载，Profile id 必须唯一。

## 4. 安装后的构建与校验

在当前目录执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

注意：根目录 `pnpm build` 会先用 `tsc --noEmit` 检查整个仓库的类型，再由 esbuild 将服务打包到根目录 `dist/`，并复制 Web 静态资源。`src/` 中不会再产生 JavaScript、声明文件或 source map。部署或运行前仍应先执行该命令。

构建后的目录结构为：

```text
dist/
├── local-server.mjs
├── local-server.mjs.map
└── public/
```

`apps/*` 和 `packages/*` 都是仅供本仓库使用的 private workspace，用于划分代码和内部依赖，不提供独立发布、独立构建或直接 Node 导入接口。

提交部署前应四项均通过。测试包含 API、附件、状态机、队列、环境解析、验证器、Git 管理器以及使用 fake 依赖的 pipeline E2E；它们不证明真实 Pi、内部 LLM、视觉服务、凭据、远程网络、GitLab 或生产部署可用。

## 5. 启动和部署方式

`dist/` 是统一的编译产物目录，但不是可单独复制运行的完整部署包。esbuild 会将仓库内部 workspace 打入 `local-server.mjs`，同时保留 `better-sqlite3`、Pi SDK、Pino、Zod 等第三方依赖在运行时从 `node_modules` 加载。部署环境还必须提供配置、环境变量以及可写的 `DATA_ROOT`；启用真实 Intake 时还需要能读取 `INTAKE_CONFIG_PATH` 指向的 Markdown。除非这些路径都使用绝对路径重新配置，否则应从仓库根目录启动。

生产式启动使用：

```bash
pnpm start
```

该命令先重新进行类型检查和 esbuild 构建，再执行 `node dist/local-server.mjs`。如果部署流程已经完成 `pnpm build`，也可以在仓库根目录直接执行后一个命令。

### 5.1 启动 UI/API-only 模式

仓库提供了一个仅用于本地验证的启动入口。它会启用 SQLite、附件、本地单任务队列和三个页面，但不会启动修复 Worker，也不会调用 LLM、视觉服务、Git 或网络服务。这样可以安全验证“创建会话 → 编辑/提交 Bug → Dashboard 查看队列”的完整 UI/API 流程。

```bash
cp .env.example .env
pnpm install --offline --frozen-lockfile
pnpm dev
```

浏览器打开 `http://127.0.0.1:8033/`；Dashboard 是 `http://127.0.0.1:8033/dashboard`，健康检查是 `http://127.0.0.1:8033/api/health/ready`。首次启动会在 `DATA_ROOT`（默认 `data/`）创建 SQLite 数据库、附件目录和队列锁文件。使用 `Ctrl+C` 正常停止，会释放锁文件。可通过 `PORT=3000 pnpm dev` 改端口；默认监听地址为 `127.0.0.1`，如需监听所有地址，使用 `pnpm dev -- --host`（监听 `0.0.0.0`）。当前 API 尚未实现认证授权，暴露到局域网前请确认网络可信。

`pnpm dev` 使用 esbuild 打包并监听 TypeScript 源码；每次成功重建会自动重启本地 Node 服务。esbuild 只负责快速转换，不做完整类型检查，因此提交前仍应运行 `pnpm typecheck`、`pnpm test` 和 `pnpm build`。`pnpm start` 会完成类型检查和生产打包，然后运行 `dist/local-server.mjs`，适合一次性手工验证。每次启动保留本地 `data/` 中的记录。若需要全新演示数据，请在服务停止后自行换一个 `DATA_ROOT`，例如 `DATA_ROOT=tmp-demo pnpm dev`。

### 5.2 启动真实 Intake 和 Pi worker

在 `.env` 中补齐以下值：

```dotenv
LLM_ENDPOINT_URL=http://your-endpoint/v1
LLM_MODEL=your-model
LLM_API_KEY=
INTAKE_LLM_TIMEOUT_MS=60000
INTAKE_CONFIG_PATH=config/bug-intake.md
# Optional: load a pre-registered static profile catalog.
# ENVIRONMENT_CONFIG_PATH=config/environments.yaml

DRY_RUN=true
PI_SANDBOX_PROFILE=external-container-or-host-profile
```

然后仍然只运行 `pnpm dev`。设置 `LLM_ENDPOINT_URL` 和 `LLM_MODEL` 后，启动入口会把同一个 endpoint 接给真实 Intake、Pi Fixer 和 Pi Reviewer，并加载 Intake Markdown。未设置 `ENVIRONMENT_CONFIG_PATH` 也可以启动；测试人员在 Intake 中提供远程 Git clone URL 并确认提交后，服务会将仓库 clone 到 `DATA_ROOT/repositories`，再生成 `DATA_ROOT/generated-environments.yaml`。已有静态 Profile 会和生成的 Profile 一起加载。静态 Profile 中的本地 repository 若不存在、不是 Git checkout 或占位符无法解析，会阻止对应流程；动态 clone 失败时提交返回错误，不会创建可执行 Bug。

`PI_SANDBOX_PROFILE` 只控制真实 Pi 修复 worker 是否启用：它必须代表宿主已经实际配置的容器、VM、seccomp/AppArmor 或等效隔离。没有它时，真实 Intake 仍可用于对话和生成 Profile，但 Pi 修复 worker 保持关闭，提交的报告停留在本地队列。系统不需要也不会读取 `E2E_FRONTEND_REPOSITORY`、`FRONTEND_MAIN_REPOSITORY` 或 `BACKEND_MAIN_REPOSITORY` 来完成动态流程。

Endpoint 必须兼容 OpenAI Chat Completions，并支持 tool calls/function calling；Pi 负责完整的 Agent/tool loop。Fixer 可使用 `read/grep/find/ls/edit/write/bash`，另有宿主注册的 `submit_fix_result` 结构化完成 tool；Reviewer 只有 `read/grep/find/ls`。两者使用独立的内存 session，不读取服务器用户的全局 Pi extensions、skills、prompts 或 context。Fixer 的成功 tool 调用是权威结果，之后的普通散文不会降级成功；endpoint 仍必须支持 tool calls，只有本轮支持 tools 但没有调用完成 tool 时才允许兼容 fallback，且仍要求单一严格 JSON。宿主只对 `riskNotes`、`missingInformation` 的 string/空字符串做有限 wire 修复并记录 `contract_repaired`，不会从散文抽取 JSON。

Pi 的内置 `bash` 本身不是系统级 sandbox；Prompt 中的“禁止网络、push、deploy”也只是行为约束。`PI_SANDBOX_PROFILE` 是一个部署声明，不会自行创建隔离：宿主必须实际以受限容器、VM、seccomp/AppArmor 或等效机制运行 worker。未设置时入口 fail-closed，不启动真实 worker。保持 `DRY_RUN=true` 只会禁止最后的 commit/push，并不会替代宿主隔离。

## 6. 测试人员提交 Bug

页面或 API 的完整流程如下：

1. `POST /api/bugs/conversations` 创建会话。服务会返回会话 ID，并发送首条提示。
2. 将复现过程、实际结果、期望结果和环境发到 `POST /api/bugs/conversations/:id/messages`，请求体为 `{ "content": "..." }`。Intake 会在缺少项时继续追问；如果项目没有现成 Profile，它会询问项目的 HTTPS/SSH Git clone URL、前端/后端目标以及已知的默认分支。每轮最多补问 3 个问题；可以明确回答 `unknown`/“不确定”，系统不会无限重复追问。
3. 通过 `GET /api/bugs/conversations/:id/draft` 查看草稿，或用 `PATCH /api/bugs/conversations/:id/draft` 编辑。可传 `{ "draft": { ... }, "userEditedFields": ["title", "reproduction.steps"] }`；人工编辑字段会覆盖后续 Intake 模型更新。
4. 页面显示完整性评分和缺失项。只有权威完整度判定 `readyForConfirmation: true`、评分至少 65 且没有关键缺失时，确认提交按钮才可用；缺少信息时仍停留在当前会话，可继续对话或编辑 Markdown。
5. 展示草稿预览后，使用 `POST /api/bugs/conversations/:id/submit`，请求必须含 `{ "confirm": true }` 或 `{ "confirmed": true }`。没有显式确认会返回 400。
6. 成功提交会生成类似 `BUG-000001` 的 Key，状态依次经过收集/确认/提交/分诊并变为 `QUEUED`，且若队列已注入则创建唯一 Job。若服务端发现 Intake 未达标，返回 HTTP 422、稳定错误码 `INTAKE_INCOMPLETE`，并返回最新 `completeness`/`draft`；不会创建 Bug 或 Job，会话保持 active，可补充后再次提交。重复提交成功会话是幂等的。

### 项目仓库与动态 Profile

远程仓库地址只应在 Intake 对话中提供，例如 `https://git.example.test/team/storefront.git` 或 `git@git.example.test:team/storefront.git`；不要提供服务主机上的本地路径。LLM 只会把这些信息整理为待确认的 Profile proposal，不会在每条消息到达时执行 clone。收到 `confirm: true`/`confirmed: true` 的提交后，服务才会：

1. 校验并 clone 远程仓库到 `${DATA_ROOT}/repositories` 下的独立目录；
2. 生成并持久化 `${DATA_ROOT}/generated-environments.yaml`；
3. 将生成的 Profile id 写入 Bug，并由后续 Orchestrator 使用该本地 checkout 创建 worktree。

若 clone 失败，提交接口返回 `REPOSITORY_CLONE_FAILED`，应先修正 URL、网络或凭据后重新提交/继续会话。生成 Profile 的 `setupCommands`、`validationCommands` 和 runtime 配置可以为空；它们不会被 LLM 凭空编造。命令为空时，环境阶段不执行预设 setup/validation，Pi Fixer 可根据仓库内容选择合适的检查，Pi Reviewer 再结合 diff、证据和检查结果做审查；这不能保证任意项目都能自动启动、复现或验证。

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
- `/bugs/:id` 使用 `renderDetailHtml(id)`，通过 `GET /api/bugs/:id` 加载摘要、复现、环境、证据、附件、会话消息、进度、修复、验证、审查和分支/提交信息。详情页默认以 Markdown 文档形式展示报告（面向测试人员，数据来自响应中的 `document` 字段），页面右上角的“开发视图（结构化数据）”按钮可切换回结构化数据视图供开发人员查看细节。
- `GET /api/bugs/:id/progress` 返回当前状态、全部 Job 和最新 Job。
- `GET /api/bugs/:id/artifacts` 返回当前可读产物文件名和内容；尚未运行到的阶段返回空或缺失是正常现象。
- `GET /api/environments` 返回已加载 Profile（包括静态目录和确认提交后生成的 Profile）。
- `GET /api/ops/jobs` 返回队列 Job；响应明确标记 `automaticRetry: false`。

健康检查：`GET /api/health/live`（别名 `/api/health`、`/healthz`）表示进程存活；`GET /api/health/ready`（别名 `/readyz`）检查数据库，未注入队列时会标记 `queue: not_configured`。就绪检查失败时不要把流量切入该实例。

## 8. 编排生命周期

提交阶段：

```text
DRAFT → COLLECTING → READY_FOR_CONFIRMATION → SUBMITTED → TRIAGING
                                                         └→ QUEUED
```

Worker 成功路径：

```text
QUEUED → PREPARING_ENV → FIXING → VALIDATING → REVIEWING → FIX_READY
                                                                  └→ PUSHING → READY_FOR_HUMAN_REVIEW
```

环境准备包括可选的 setup 命令、runtime start 和 health check。Profile 没有 setup 命令时不会执行预设安装；没有 validation 命令时确定性验证列表为空。Pi Fixer 仍可在仓库中检查并运行其认为合适的检查，Pi Reviewer 根据只读的仓库、diff、证据和 validation 结果审查；这只是 Agent 的判断能力，不是对启动、复现或修复成功的保证。配置了 `validationCommands` 时，验证器按顺序执行，不通过即 `VALIDATION_FAILED`。审查必须 approve、确认 Bug 已解决且回归风险不能为 high；否则为 `REVIEW_REJECTED`。dry-run 在 `FIX_READY` 完成队列 Job；非 dry-run 才进入受保护的 `PUSHING`。

失败状态包括 `ENVIRONMENT_FAILED`、`FIX_FAILED`、`FIX_CANDIDATE`、`VALIDATION_FAILED`、`REVIEW_REJECTED`、`PUSH_FAILED` 和 `BLOCKED`。Fixer 超时或完成报告格式失败但留下非空 diff 时进入 `FIX_CANDIDATE`：它不是成功，也不会自动 push；候选会保存 `candidate.json`（base commit、patch SHA/大小/原因）和 `diff.patch`，后续人工 retry 在精确 base 上恢复 patch，再继续 validation/reviewer gate。无 diff 的 Fixer 失败仍为 `FIX_FAILED`。队列 Job 自身状态为 `QUEUED → RUNNING → COMPLETED/FAILED`，取消为 `CANCELLED`；心跳过期的 RUNNING Job 被标为 `INTERRUPTED`，不会自动重试。

## 9. 增加 Environment Profile、Markdown 和 Skill

通常不需要手工新增 Profile：真实 Intake 会从测试人员收集远程 Git URL，在确认提交后生成 Profile。若需要预注册项目或补充长期维护的文档/技能，可以维护可选的静态 `config/environments.yaml`：

1. 在静态目录的 `environments` 数组新增唯一 `id`、`name`、`target`、服务端已有的本地 `repository` 和分支；设置 `ENVIRONMENT_CONFIG_PATH` 后才会加载该目录。
2. 在仓库根目录下创建 Profile 文档，例如 `environments/my-app/ENVIRONMENT.md` 和 `environments/my-app/TESTING.md`，在 Profile 的 `markdown` 数组填相对路径。
3. 在 `.pi/skills/<name>/SKILL.md` 创建技能规则，在 Profile 的 `skills` 数组填相对路径。当前解析器要求路径为相对路径、文件存在、真实路径仍位于配置 root 内，单文件默认不超过 256 KiB。
4. `setupCommands`、`validationCommands` 和 runtime 命令只允许简单 argv；命令会拒绝 shell 元字符，不要写 `;`、管道、重定向、反引号或 `$()`。依赖安装应使用已有缓存的离线模式。动态生成 Profile 的这些命令可以为空。
5. 通过 `GET /api/environments` 确认静态和动态 Profile 是否已加载；同一 target 有多个候选时，在 Bug 草稿中明确 `environmentProfileId`，但正常动态流程由服务自动写入生成的 Profile id。

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

只接受失败终态（包括 `FIX_CANDIDATE`）或 `FAILED`/`INTERRUPTED` Job，并明确返回 `automatic: false`。候选 retry 不重新运行 Fixer，也不依赖旧 worktree：worker 验证候选 metadata、patch hash/大小和 base commit 后，在新 worktree 使用 `git apply --check --binary` 再应用；任何不匹配都 fail-closed。修复前应先处理根因（例如 Profile 路径、依赖缓存、验证命令或 allow-list），确认 worktree/锁文件状态后再重试。对排队或安全运行阶段可使用：

```http
POST /api/bugs/BUG-000001/cancel
```

运行中的安全阶段是“请求中断”；不安全阶段返回 409 和 `cancellable:false`。不要手动删除仍被活动 Worker 所有的 worktree 或 lock 文件。

## 11. 产物与审计

每个流程写入 `${DATA_ROOT}/agent-results/<BUG-KEY>/`。API 会读取并返回以下 9 类标准文件（缺失表示该阶段尚未完成）：

```text
bug.json          fix-task.json       environment.json
agent-result.json candidate.json      validation.json     review.json
git-result.json   pipeline.json       diff.patch
```

实际编排还会写 `environment-run.json` 和（环境成功启动后）`environment-stop.json`，但当前 API 的筛选读取逻辑不把这两个文件列入公开产物响应。JSON 产物记录任务、Agent 结果、候选元数据、验证、审查和 Git 状态；`diff.patch` 是当前 worktree 相对 HEAD 的二进制 diff。候选通过 validation/review 并进入 `FIX_READY` 后，`candidate.json` 会归档为 `candidate-used.json`。文件创建权限为 `0600`，API 读取的单文件上限为 2 MiB。

数据库升级使用 additive SQLite 初始化。升级前备份 `DATABASE_PATH` 和整个 `DATA_ROOT`；不要把附件或产物提交到公共仓库。

## 12. 排障

| 现象 | 检查项 |
| --- | --- |
| 依赖安装失败 | 确认 Node/pnpm 版本和本地 pnpm store；保持 `--offline` 时补齐缓存 |
| API 无法就绪 | 查看 `/api/health/ready`，确认 `DATABASE_PATH` 父目录可写、SQLite 文件未被占用 |
| 提交被拒绝 | 查看 HTTP 422 的 `code=INTAKE_INCOMPLETE`、`completeness.missingCriticalInformation` 和 `draft`；补充会话或编辑 Markdown 后重试 |
| 没有 Bug 进入队列 | 只有 `readyForConfirmation=true`、无关键缺失且 score ≥ 65 才会创建 Bug 并进入 `QUEUED`；未注入 queue 时不会建 Job |
| `No environment profile`/`Ambiguous` | 先调用 `/api/environments` 查看静态/动态 Profile；动态项目应在确认提交后检查 `DATA_ROOT/generated-environments.yaml` 是否已生成，并确认 target 或 `environmentProfileId` 唯一 |
| `REPOSITORY_CLONE_FAILED` | 检查 Intake 中提供的 HTTPS/SSH clone URL、远程仓库可达性和凭据；修正会话后再次显式确认提交 |
| Profile 文件被阻止 | 使用相对路径，确认文件存在、未符号链接到 root 外，且不超过 256 KiB |
| setup/validation 失败 | 查看 `environment-run.json`、`validation.json` 及脱敏日志，单独在 worktree 中复现命令 |
| Job 卡在 RUNNING | 先看 heartbeat；确认旧进程已停止后调用 `/api/ops/recover`，再人工 retry |
| push 被拒绝 | 保持 `DRY_RUN=true` 做验证；确认当前分支是 `ai/*`、origin 存在且主机在 `GIT_ALLOWED_HOSTS` 与 `RepoManager.allowedRemoteHosts` 中；非 dry-run 推送目标是 `GITLAB_URL`（默认 `http://172.29.100.126`）上 `GITLAB_ACCOUNT` 账号的同名私有镜像仓库（不存在时自动创建），检查 `~/.git-credentials` 中的 PAT 是否有效 |
| 图片没有识别结果 | 这是默认 disabled adapter 的预期行为；使用 `/internal/vision/analyze` 前必须注入附件服务和私有视觉 Provider |
| 页面空白/404 | 宿主必须自行挂载三个 `render*Html()` 页面；BugApiServer 本身只提供 API |

日志会做基础脱敏，但脱敏不是绝对保证。提交前清理复制粘贴内容，发现疑似凭据时立即撤销/轮换，并避免在工单、截图、HAR、日志和 Agent prompt 中传播。

## 13. 安全检查清单

- 首次部署保持 `DRY_RUN=true`，只使用临时本地 Git checkout 和测试数据。
- 只向内网/loopback 绑定 API，并在宿主增加认证、授权、CSRF/审计和限流；当前实现没有这些能力。
- 为 `DATA_ROOT/repositories`、`repositoryRoots`、`worktreesRoot`、附件根目录和 Profile root 设置最小权限，避免使用宽泛的文件系统根路径；动态 Intake 提供的远程仓库会直接 clone 到 `DATA_ROOT/repositories`。
- 只允许经过审查的 setup/validation/runtime 命令；命令执行器禁用 shell，并限制 cwd 和输出长度。
- 推送前人工检查 diff、验证结果、审查结果和 `git-result.json`；系统永远不会自动合并、部署或访问生产。
