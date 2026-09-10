# Web 页面端到端测试流程

本流程验证部署在 `kfjllm` 上的真实 Web 页面和真实聊天接口。测试入口是 `http://kfjllm:8033`；不要用本地 mock 或仅调用服务层测试代替浏览器检查。

## 前置条件

1. 登录测试机并进入项目目录：`ssh kfjllm`，然后 `cd ~/prj/llmbugfix`。
2. 加载 Node 运行环境并启动开发服务：

   ```bash
   source ~/.nvm/nvm.sh
   pnpm dev --host
   ```

   服务监听 `0.0.0.0:8033`。可通过 `curl http://127.0.0.1:8033/api/health` 检查服务端健康状态。
3. 从执行测试的环境访问 `http://kfjllm:8033/`，应返回 `200` 和 HTML 页面。若 SSH 机器本地访问正常、映射地址无法连接，应先排查端口映射与网络，而不是修改页面代码。
4. 测试使用正常的缺陷描述，且不要包含 token、cookie、密码或真实账号密码。

## 推荐：Playwright MCP

当前会话提供 Playwright MCP 时，优先使用它执行下面的操作：

1. 打开 `http://kfjllm:8033/`，等待页面完成创建会话。
2. 断言页面包含 Chat、消息输入框、发送按钮、Markdown 编辑区、完整度和同步状态。
3. 在聊天框输入：

   ```text
   登录页点击登录按钮后停在当前页面并显示网络错误，预期跳转首页。
   ```

4. 点击“发送”，等待助手回复或页面错误提示出现。
5. 验证：
   - 页面不显示错误提示；
   - 聊天记录新增一条用户消息和一条助手消息；
   - 助手问题按对象渲染为可读文本，不出现 schema/Zod 校验错误；
   - 完整度大于 `0`；
   - Markdown 自动更新，状态显示 `synced`。
6. 打开 `/dashboard`，等待列表加载完成，确认无页面错误且 Bug 表格正常出现。

保存截图、页面快照和网络响应作为失败时的证据。成功测试不需要保留浏览器 profile。

## Playwright MCP 不可用时：Firefox BiDi 备用方案

当当前会话没有 Playwright MCP、也未安装 Playwright 时，可以使用系统 Firefox 的 WebDriver BiDi 验证真实 DOM 和点击行为。

1. 使用隔离 profile 启动无头 Firefox。Snap 启动器可能无法访问 `/tmp` profile；此时使用 Firefox 的实际二进制：

   ```bash
   /snap/firefox/8863/usr/lib/firefox/firefox \
     --headless --new-instance \
     --profile /tmp/llmbugfix-firefox-profile \
     --remote-debugging-port 9222 \
     --remote-allow-hosts 127.0.0.1,localhost \
     --remote-allow-origins http://localhost \
     http://kfjllm:8033/
   ```

2. WebDriver BiDi 的连接地址是 `ws://127.0.0.1:9222/session`，不是 `/`。先发送 `session.new`，再用 `browsingContext.getTree` 取得页面 context。
3. 使用 `script.evaluate` 读取 DOM、给 `#message` 赋值、派发 `input` 事件并点击 `#send`。轮询页面，直到状态恢复为可继续补充并且新增用户和助手消息，或 `#error` 显示内容。
4. 读取 `#score`、`#document-sync-state`、`#markdown-editor` 和 `#messages`，按上一节验收条件判断。
5. 用 `browsingContext.navigate` 打开 `http://kfjllm:8033/dashboard`；等待客户端数据加载后检查表格和错误区域。
6. 结束 BiDi session，停止 Firefox，并删除只为测试创建的 `/tmp/llmbugfix-firefox-*` 文件和目录。

## 提交按钮的边界

“确认提交”会创建正式 Bug。当前测试机可能启用了真实 repair worker，提交还可能触发仓库拉取、修复和队列任务。因此常规 UI 回归测试只覆盖到发送、Markdown 同步和 Dashboard。

只有在 `DRY_RUN` 或独立测试数据库、队列和环境配置已确认的情况下，才测试“确认提交”。该场景应额外验证成功卡片、Bug Key 链接、Dashboard 条目和没有意外启动真实修复任务。

## Repair Worker 全流程测试（含提交）

测试目标：验证从对话、提交到 Pi fixer 修复、reviewer 评审、git push 的完整链路。在 `kfjllm` 上通过 API 执行（等价于 Web 页面操作）。

### 前置配置

1. `.env` 关键项：

   ```bash
   DRY_RUN=true                 # 首轮验证保持 true；push 测试才改 false
   GIT_ALLOWED_HOSTS=localhost  # push 测试时需加入目标 Git 仓库主机
   PI_SANDBOX_PROFILE=local-dev
   ```

2. 仓库准备：若目标仓库已在 `data/repositories/<checkout-id>` 存在（origin 匹配），提交时复用，不会重新 clone。checkout-id 规则为 `remote-` + sha256(`target\0repoUrl`) 前 16 位。

### 执行步骤

1. 创建会话并多轮对话，补齐信息直到 `readyForConfirmation: true`（完整度需 ≥ 65 且没有关键缺失）。信息要点：问题描述、复现步骤、实际/期望行为、环境（浏览器/系统）、影响范围、仓库 URL、默认分支。未达标时确认提交应被页面禁用；直接调用 API 应返回 422、`code=INTAKE_INCOMPLETE`，不会创建 Bug/Job，会话仍为 active。
2. 提交：`POST /api/bugs/conversations/:id/submit`，body `{"confirm":true}`。响应含 `bugKey`（如 `BUG-000003`）。
3. 轮询 `GET /api/bugs` 观察 bug 状态流转：`QUEUED → PREPARING_ENV → FIXING → VALIDATING → REVIEWING → FIX_READY`（DRY_RUN）或 `→ PUSHING → READY_FOR_HUMAN_REVIEW`（真实 push）。fixer 最长 45 分钟，每 60s 轮询一次即可。
4. 验证产物 `data/agent-results/<BUG-KEY>/`：`bug.json`、`fix-task.json`、`environment-run.json`、`agent-result.json`、`validation.json`、`diff.patch`、`review.json`、`git-result.json`、`pipeline.json`（0600 权限）。
5. 验证 `review.json` 的 verdict 为 `approve`；`diff.patch` 内容与报告的 `filesChanged` 对应。
6. 失败排查：`logs/dev.log` 中 `intake-llm` / `pi-agent` 记录了每次 LLM 交互原文；格式失败会留 `agent-raw-output.txt`，且 diff 非空时保留 worktree 供人工挽救。
7. 重试：`POST /api/bugs/<BUG-KEY>/retry`（仅接受终态失败），会重建 worktree 重跑。

### Push 测试（DRY_RUN=false）

1. `.env` 设置 `DRY_RUN=false`，并把目标仓库主机加入 `GIT_ALLOWED_HOSTS`（如 `GIT_ALLOWED_HOSTS=localhost,172.29.100.126`），重启 dev server。
2. 提交新 Bug 并等待 `READY_FOR_HUMAN_REVIEW`。
3. 验证远端仓库出现 `ai/<BUG-KEY>-<slug>` 分支，commit message 为 `fix(<BUG-KEY>): <标题>`；`git-result.json` 的 `pushed: true` 且有 commitSha。
4. 安全边界：push 只允许 `ai/*` 分支，禁推 main/master/develop；host 不在白名单会 fail-safe 拒绝。
5. 测试后建议删除远端测试分支，并将 `DRY_RUN` 恢复为 `true`。

## 2026-09-06 已执行记录

对 `http://kfjllm:8033` 的实际 Firefox BiDi 测试已通过：

- 首页成功创建会话并渲染聊天、Markdown、完整度和同步状态；
- 发送上述缺陷描述后，页面新增用户和助手消息，没有错误提示；
- 完整度更新为 `65`，Markdown 更新为结构化报告，状态为 `synced`；
- Dashboard 客户端数据加载成功，显示 Bug 表格且没有错误；
- 未点击“确认提交”，以避免在已启用 repair worker 的测试机上创建真实修复任务。

## 2026-09-08 已执行记录（repair worker，DRY_RUN）

- 3 轮对话（store tab 切换无反应）→ 提交 → `BUG-000002` 入队；
- （历史行为）完整度不足时曾创建 `NEEDS_INFO`（BUG-000001，score 61）；当前门禁应改为提交前返回 `INTAKE_INCOMPLETE`，补齐后才创建 Bug 并入队；
- 修复链路走通：FIXING → VALIDATING → REVIEWING → `FIX_READY`，reviewer approve（regressionRisk: low）；
- fixer/reviewer 首次输出夹带散文，回喂校验错误后第二次通过（纠错回路生效）；
- 九件套产物齐全；`DRY_RUN` 下无 commit/push，远端仓库无改动。

## 2026-09-09 已执行记录（push 测试，DRY_RUN=false）

- 复刻同一对话（store tab 切换无反应），3 轮 → score 70 → 提交 → `BUG-000004` 入队；
- 首轮 push 失败：`Remote host is not allowed: 172.29.100.126`；
- 排查发现两个代码 bug：
  1. `packages/repo-manager/src/index.ts` 的 `assertPushSafe` 用 `!this.allowedRemoteHosts.length` 导致空数组时也抛错（其他检查用 `this.allowedRemoteHosts.length &&` 空则跳过）；
  2. `apps/bug-api/src/local-server.ts` 未将 `GIT_ALLOWED_HOSTS` 传给 `RepoManager` 构造函数；
- 修复后重试，Pipeline 走通：QUEUED → FIXING → REVIEWING → PUSHING → `READY_FOR_HUMAN_REVIEW`；
- 远端验证：`refs/heads/ai/BUG-000004-module-tab` 已推送，commit `7bf953f`，message `fix(BUG-000004): 点击 module 分类 tab 切换无反应`；
- `git-result.json`：`pushed: true`，`review.json`：`verdict: approve`；
- 修复了 `Title.ose`（声明+绑定 id）和 `CatalogAnchor.ose`（滚动容器健壮性）。
