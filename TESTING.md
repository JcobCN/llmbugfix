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

## 2026-09-06 已执行记录

对 `http://kfjllm:8033` 的实际 Firefox BiDi 测试已通过：

- 首页成功创建会话并渲染聊天、Markdown、完整度和同步状态；
- 发送上述缺陷描述后，页面新增用户和助手消息，没有错误提示；
- 完整度更新为 `65`，Markdown 更新为结构化报告，状态为 `synced`；
- Dashboard 客户端数据加载成功，显示 Bug 表格且没有错误；
- 未点击“确认提交”，以避免在已启用 repair worker 的测试机上创建真实修复任务。
