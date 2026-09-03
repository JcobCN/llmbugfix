# WP07：Conversational-First Bug Intake 重构实施设计

> 状态：新增实施规格
>
> 本文档用于修正现有 V4 / WP02 在 Bug Intake 交互层面的产品偏差。
>
> **冲突优先级：当本文档与 `LLM Bug 提交 → Pi Agent 自动修复系统实施计划 V4.md`、`requirements/02-intake-ui-api.md` 中关于 Intake UI、Draft 编辑方式、用户输入路径的描述冲突时，以本文档为准。**
>
> 本文档只重定义 Intake 交互与其必要的 API/模型适配，不推翻现有 BugReport、Conversation、Completeness、附件、Queue、Orchestrator、Pi、Validation 等后端架构。

---

## 1. 产品目标

系统的 Bug 提交入口必须是 **Conversational-First**。

用户不需要理解 Bug schema，也不需要手工填写 Title、Execution Target、Actual Behavior、Expected Behavior、Reproduction Steps、Environment 等字段。

正常使用路径必须是：

```text
用户自然语言描述问题
        ↓
Intake LLM 理解并抽取信息
        ↓
更新内部 Canonical Bug Draft
        ↓
自动生成/刷新 Bug 文档预览
        ↓
判断还缺哪些关键内容
        ↓
通过聊天继续追问
        ↓
信息足够后提示用户确认
        ↓
用户确认提交
        ↓
生成正式 BugReport + Job
```

核心产品原则：

```text
Chat 是输入界面。
Bug Document 是输出界面。
BugReport Schema 是内部机器数据结构。
```

禁止把结构化 BugReport schema 直接暴露成主要用户填写表单。

---

## 2. 非目标

本工作包不负责：

- 重写 Orchestrator。
- 重写 Queue。
- 修改 Fixer / Reviewer pipeline。
- 修改 Git push / worktree / validator 设计。
- 接入真实 Pi SDK。
- 接入真实生产 LLM 凭据。
- 实现 GitLab MR / merge / deploy。
- 实现认证、RBAC、审计、限流。
- 将 Markdown 作为唯一事实源。

本次改造的目标是纠正 Intake UX 和其数据流，不扩大到生产化基础设施。

---

## 3. 关键设计决定

### 3.1 用户不填表

默认 Bug Intake 页面不得要求用户填写以下字段：

- title
- executionTarget
- environmentProfileId
- actualBehavior
- expectedBehavior
- reproduction.steps
- environment
- evidence metadata
- severity
- impact
- regression

上述信息必须优先通过对话由 Intake Agent 自动抽取。

用户可以：

- 输入自然语言。
- 粘贴错误信息、日志、Stack Trace。
- 上传附件。
- 回答 LLM 的追问。
- 明确纠正 LLM 的理解，例如“不是后端问题，是前端页面”。
- 最后确认或继续补充。

用户不应该为了完成正常流程去操作 schema 字段。

### 3.2 保留内部严格结构化模型

`BugReportSchema`、`BugReportDraftSchema` 和内部 JSON 数据模型继续保留。

原因：

- Environment Resolver 需要稳定的 `executionTarget` / `environmentProfileId`。
- Completeness Policy 需要确定字段。
- Orchestrator 需要稳定的 `BugFixTask`。
- Dashboard / 搜索 / 状态流转需要机器可读字段。
- 避免后续每一步重新让 LLM 从 Markdown 解析业务字段。

因此：

```text
用户输入：自然语言
内部事实源：BugReportDraft JSON
用户展示：Bug Document（Markdown 风格渲染）
```

Markdown 是 presentation / export representation，不是 canonical storage。

### 3.3 Bug 文档默认只读

本工作包的默认实现中，右侧 Bug Document 预览为只读。

如果用户发现内容错误，应通过聊天纠正，例如：

```text
用户：不是 Chrome，是 Edge 126。
```

Intake Agent 应更新内部 Draft，右侧文档自动刷新。

**不要求实现字段级手动编辑器。**

直接编辑生成文档可以作为后续增强能力，但不得成为本工作包验收依赖。

### 3.4 不允许“聊天 + 表单双主入口”

以下交互属于错误实现：

```text
左边聊天
右边 Title input / select / textarea / Save Draft
```

因为这会让用户同时承担两套输入协议，并把 schema 暴露成产品操作模型。

右侧应该是报告预览，而不是表单。

---

## 4. 目标页面布局

桌面端推荐：

```text
┌──────────────────────────────┬──────────────────────────────┐
│ Chat                         │ Bug Report                   │
│                              │                              │
│ AI: 请直接描述你遇到的问题。 │ # 登录后仍停留在登录页        │
│                              │                              │
│ User: 输入正确账号密码...    │ ## Actual Behavior           │
│                              │ ...                          │
│ AI: 登录请求返回什么状态码？ │                              │
│                              │ ## Expected Behavior         │
│ User: 500                    │ ...                          │
│                              │                              │
│ [输入消息..................] │ ## Reproduction              │
│ [附件]                [发送] │ 1. ...                       │
│                              │                              │
│                              │ ## Environment               │
│                              │ ...                          │
│                              │                              │
│                              │ ## Missing Information       │
│                              │ - backend error detail       │
│                              │                              │
│                              │ Completeness: 82%            │
│                              │                              │
│                              │ [继续补充] [确认提交]          │
└──────────────────────────────┴──────────────────────────────┘
```

移动端：

```text
Chat
↓
Bug Report preview
↓
Confirmation controls
```

但 Chat composer 应始终容易访问。

---

## 5. Bug Document 规范

右侧文档必须由当前 `BugReportDraft` 确定性渲染，不允许每次展示时再调用 LLM。

推荐渲染结构：

```md
# <Title 或“未命名问题”>

## Actual Behavior
<actualBehavior 或“尚未确认”>

## Expected Behavior
<expectedBehavior 或“尚未确认”>

## Reproduction
1. ...
2. ...

## Environment
- Target: ...
- Environment: ...
- Browser: ...
- Service: ...
- Version: ...

## Evidence
- Error: ...
- Stack Trace: ...
- Attachments: ...

## Regression
...

## Impact
...

## Missing Information
- ...
```

### 5.1 展示规则

- 不存在的非关键 section 可以隐藏。
- `Actual Behavior`、`Expected Behavior`、`Reproduction`、`Missing Information` 应优先可见。
- `Missing Information` 必须来自 `CompletenessEvaluation` / Intake policy，不得凭 UI 自己猜。
- 已知为 unknown / unavailable 的信息不能错误显示为“仍需回答”，除非 policy 明确判定仍为关键阻塞。
- 文档不得虚构信息。
- 文档必须区分 reporter observation 和 reporter hypothesis。
- 图片未经过 Vision 时不得显示为“已识别图片内容”。

### 5.2 渲染实现

建议新增纯函数，例如：

```ts
renderBugDocument(draft, completeness): string
```

返回 Markdown 字符串或安全的 view model。

要求：

- deterministic
- 无网络
- 无 LLM 调用
- 可单元测试
- 不拼接未经转义的 HTML

如果 UI 直接渲染 Markdown，必须使用安全渲染方式；当前依赖栈若没有 Markdown renderer，可以先以安全 text / semantic HTML 的方式实现，不要求为了 Markdown 引入新依赖。

---

## 6. Intake Agent 行为要求

现有 `IntakeModel.complete()` Adapter 架构继续保留。

每一轮仍采用：

```text
current draft
+ relevant recent messages
+ latest user message
```

而不是只传完整聊天记录。

### 6.1 Agent 必须完成的工作

每轮对话：

1. 从 latest message 中抽取新事实。
2. 更新 `fieldUpdates`。
3. 保留已有、未被明确否定的事实。
4. 检测与当前 draft 的冲突。
5. 识别用户是在“补充信息”还是“纠正之前理解”。
6. 更新 observation / hypothesis 区分。
7. 判断敏感信息风险。
8. 根据最新 draft 判断下一批最有价值问题。
9. 每轮最多问 3 个问题。
10. 信息足够时停止无意义追问，进入确认阶段。

### 6.2 明确纠正优先

由于不再依赖表单手改，必须确保用户通过聊天表达的纠正可以覆盖旧值。

示例：

```text
旧 draft.executionTarget = backend
用户：我刚才说错了，这个其实只发生在前端页面，接口本身是正常的。
```

下一轮 draft 必须允许变为：

```json
{
  "executionTarget": "frontend"
}
```

不能因为旧字段已存在就永远禁止修改。

因此现有 `manualFields` / `userEditedFields` 机制不能再作为正常交互正确性的核心依赖。

### 6.3 冲突处理

当用户的新描述与旧 Draft 冲突：

- 明确纠正语义：采用新值。
- 语义不明确：不得静默覆盖关键字段，应由 Agent 提问确认。
- 保留 contradiction metadata 供测试与可观测性使用。

推荐 Agent reply 示例：

```text
你刚才说这是后端 API 问题，但现在又说接口正常、只有页面异常。
我会先按“前端问题”整理。如果这不对，请告诉我。
```

或在低置信场景直接确认。

---

## 7. 问题策略要求

保留现有 `questionStrategy()` / `evaluateCompleteness()` 的分层设计，但需要检查其是否适配 Conversational-First。

### 7.1 不重复提问

以下情况视为已回答：

- 字段存在明确值。
- 用户明确回答 unknown / 不知道 / 无法获得。
- 用户明确表示不存在，例如“没有报错”。

不得形成：

```text
AI：有日志吗？
User：没有。
AI：有日志吗？
```

### 7.2 追问必须面向人类

问题文本不得暴露 schema field name。

错误：

```text
请补充 environment.backend.endpoint。
```

正确：

```text
这个请求对应哪个 API 地址？如果知道的话，也请告诉我 HTTP Method 和返回状态码。
```

### 7.3 优先级

正常情况下优先收集：

1. 实际发生什么。
2. 正常应该发生什么。
3. 如何复现。
4. 哪一类执行环境/目标代码可能相关。
5. 高价值证据。

低价值 metadata 不得阻塞聊天体验。

---

## 8. Environment Profile 的处理

用户不应被要求从下拉框选择 `environmentProfileId` 作为正常流程的一部分。

目标行为：

- Agent 从用户语言中识别 environment / product / target 信息。
- 系统基于已知信息尝试匹配 profile。
- 无法可靠匹配时，可以通过自然语言追问。
- 如果系统仍无法唯一匹配，则保持 null / unknown，最终根据 completeness / routing 进入 NEEDS_INFO，而不是要求用户操作内部 profile ID。

本工作包可采用最小实现：

- 保留 `environmentProfileId` 字段。
- 移除 Intake 页面上的 profile `<select>`。
- 不强制本工作包实现复杂自动 profile resolver。
- 如果当前 Agent 无法生成有效 profile id，则保持 null。

后续可单独增强自然语言 → environment profile mapping。

---

## 9. API 设计

现有 Conversation API 主体应尽量保持兼容。

### 9.1 保留

```text
POST /api/bugs/conversations
POST /api/bugs/conversations/:id/messages
GET  /api/bugs/conversations/:id
GET  /api/bugs/conversations/:id/draft
POST /api/bugs/conversations/:id/submit
```

附件相关 API 保持不变。

### 9.2 Draft PATCH 的定位调整

现有：

```text
PATCH /api/bugs/conversations/:id/draft
```

本工作包中：

- 可以暂时保留以兼容旧 client / 测试 / 管理工具。
- 新 Intake Web UI 不得调用它作为正常用户路径。
- 不得再依赖用户手动保存 Draft 才能完成 Bug。
- 后续若无其他消费者，可另开清理任务删除或限制为 admin/internal 功能。

### 9.3 Message response

`POST .../messages` 返回值必须足够一次刷新：

- messages
- draft
- completeness
- conversation status
- turn metadata

Web 不应为了更新 report 再发多次不必要请求。

### 9.4 Submit

提交必须继续满足：

- explicit confirmation
- idempotent
- 生成正式 `BugReport`
- 根据 completeness 进入 QUEUED 或 NEEDS_INFO
- 有 queue 时创建 Job

新 UI 提交时不应从 DOM 重新构造一份 draft。

**提交使用服务端当前 conversation.draft 作为事实源。**

也就是说新 UI 推荐发送：

```json
{
  "confirm": true
}
```

而不是：

```json
{
  "confirm": true,
  "draft": { "...": "从表单重新拼出来" }
}
```

服务端可以暂时兼容 body.draft，但新的正常路径不得依赖它。

---

## 10. Web UI 改造要求

目标文件主要为：

```text
apps/bug-web/src/index.ts
```

以及对应测试。

### 10.1 删除 Intake 表单交互

从新 Intake UI 中移除：

- Execution target select
- Environment profile select
- Title input
- Actual behavior textarea
- Expected behavior textarea
- Reproduction steps textarea
- Save draft button
- 从这些 DOM 字段构造 `draft()` 的代码
- `userEditedFields` 提交流程

Dashboard / Bug Detail 不在此限制内。

### 10.2 保留

- Chat history
- Message composer
- Send action
- Loading state
- Error state
- Empty/loading conversation state
- Completeness indicator
- Missing information
- Bug report preview
- Explicit confirm submit
- Responsive layout

### 10.3 新增/强化

Intake 页面应至少有：

- 明确标题：Bug Intake / Report a Bug 等。
- Chat panel。
- 自动生成的 Bug Report panel。
- Completeness score。
- Missing information list。
- “继续补充”语义提示。
- “确认提交”按钮。
- 当尚不适合确认时，UI 可以降低确认按钮强调度，但不能通过表单逼用户补字段。

### 10.4 Confirmation UX

达到 `readyForConfirmation` 时，Chat assistant 应给出明确确认提示，例如：

```text
我已经整理好了当前 Bug 报告。右侧是我理解的内容。
如果内容正确，可以确认提交；如果有任何错误，直接在聊天里告诉我需要修改什么。
```

如果用户仍有缺失信息但系统允许强制提交：

- UI 必须清楚显示 Missing Information。
- 用户仍可以显式确认。
- 后端继续根据 policy 决定 QUEUED / NEEDS_INFO。

---

## 11. Fake Intake 要求

Fake model 不能仅仅为了测试表单而存在。

它必须能支持最基本的 conversational-first 自动化测试：

输入：

```text
登录页面点击登录后仍停留在原页面，应该进入首页。
```

Fake 至少应该能抽取：

- title
- actualBehavior
- expectedBehavior
- executionTarget（如果语言足够明确）

并触发剩余关键问题。

不要求 Fake 具备真实 LLM 水平，但测试不能通过“用户填右侧表单”绕过 intake agent。

---

## 12. System Prompt 调整

保留现有安全规则，并补充以下产品规则：

```text
- The reporter interacts through conversation, not by filling a schema form.
- Maintain the structured Bug Draft from natural-language conversation.
- When the reporter corrects a previously extracted fact, update the draft accordingly.
- Do not ask the reporter to provide internal field names or schema values.
- Ask for human-understandable facts only.
- The structured draft is internal state; the reporter sees a generated bug report representation.
```

中文语义要求等价。

---

## 13. 数据模型改动原则

### 13.1 默认不新增数据库表

当前：

- `bug_conversations`
- `conversation_messages`
- `BugReportDraft`
- `CompletenessEvaluation`

已经足够支撑本轮改造。

不得因为 UI 重构而无必要迁移数据库。

### 13.2 可选新增类型

如果实现上有帮助，可以新增纯展示类型，例如：

```ts
interface BugDocumentView {
  title: string;
  markdown: string;
  completeness: CompletenessEvaluation;
}
```

但它不能成为新的业务事实源。

---

## 14. 与现有代码的兼容策略

### 应保留

```text
packages/bug-domain
BugReportSchema
BugReportDraftSchema
BugConversation
ConversationMessage
CompletenessEvaluation
packages/intake-agent
packages/intake-policy
Conversation API
Attachment API
Bug submit / queue logic
```

### 应修改

```text
apps/bug-web Intake 页面
Intake 对“用户纠正”的覆盖行为
相关 API 测试
Intake Agent tests
UI tests
文档
```

### 暂时保留但降级为兼容能力

```text
PATCH conversation draft
manualFields / userEditedFields
```

如果 Agent 确认代码中没有其他消费者，可以在本工作包中清理 `manualFields`；否则保留兼容，但新 UI 不得调用。

---

## 15. 状态流

Conversation：

```text
active
  ↓
awaiting_confirmation
  ↓
submitted
```

如果用户在 awaiting_confirmation 时继续聊天：

```text
awaiting_confirmation
  ↓ user sends correction/addition
active or awaiting_confirmation
```

状态应根据更新后的 completeness 重新计算，不能因为曾经达到 65 分就永久锁定确认状态。

提交后 conversation 不应再被正常 Intake UI 修改。

---

## 16. 典型交互场景

### Case A：一次描述已足够

```text
User:
前端登录页，Chrome 126。输入正确账号密码后点击登录，请求返回 200，
但页面仍停在 /login。正常应该跳到 /home。每次都能复现，Console 没报错。
```

系统应：

- 自动抽取主要字段。
- 生成文档。
- 如果 completeness 达标，不应为了凑问题继续问无关字段。
- 提示用户确认。

### Case B：信息不足

```text
User:
登录坏了。
```

系统应优先问：

- 实际发生什么。
- 预期什么。
- 如何复现。

不得显示一排输入框让用户自己填写。

### Case C：用户纠正

```text
User:
是后端接口 500。
...
User:
我确认了一下，刚才看错了。接口其实 200，是前端没有跳转。
```

系统应更新已有 Draft，而不是因为字段已填写而忽略新信息。

### Case D：unknown

```text
AI: 浏览器 Console 有报错吗？
User: 我拿不到 Console，没有权限。
```

系统不得下一轮继续问同一个问题。

### Case E：确认前发现错误

```text
User:
右边版本写错了，不是 2.3.1，是 2.3.7。
```

系统应通过聊天更新文档，然后再次等待确认。

---

## 17. 测试要求

### 17.1 Intake Agent 单元测试

至少增加/修改测试覆盖：

1. 自然语言能更新 draft。
2. 用户明确纠正旧字段时可以覆盖。
3. unknown 不重复问。
4. 每轮最多 3 问。
5. 不要求 `userEditedFields` 才能纠正 draft。
6. readyForConfirmation 正确变化。

### 17.2 Policy 测试

覆盖：

- missing information。
- explicit unknown。
- frontend/backend adaptive questions。
- 完整度达到阈值后不继续无意义追问。

### 17.3 API 集成测试

至少增加一个完整对话测试：

```text
create conversation
→ send natural-language description
→ send answers/correction
→ GET conversation verifies generated draft
→ submit { confirm: true }
→ verify BugReport created
→ verify no client-supplied draft required
```

另加：

- 未 confirm 不可提交。
- 重复 submit 幂等。
- correction 后 server-side draft 是最新值。

### 17.4 Web UI 测试

必须断言 Intake 页面：

存在：

- Chat
- report preview
- completeness
- missing information
- confirm submit

不存在作为正常 Intake 控件的：

- title input
- target select
- profile select
- actual textarea
- expected textarea
- reproduction textarea
- Save draft

如果当前仓库尚无可运行 DOM/browser 测试框架，可使用 HTML 输出断言作为最低标准，不要求本工作包新增大型前端框架。

### 17.5 回归测试

必须保证现有：

- domain
- repository
- attachment
- vision
- queue
- pipeline E2E

测试继续通过。

---

## 18. 验收标准

本工作包只有在以下条件全部满足时才算完成。

### UX

- [ ] 新用户打开 Intake 页面后，第一操作是自然语言聊天，而不是填写字段。
- [ ] 页面不存在用于正常 Bug 提交流程的结构化表单。
- [ ] 用户发送消息后，Bug Report 预览自动更新。
- [ ] 用户不需要点击 Save Draft。
- [ ] 用户可以通过聊天纠正 AI 生成内容。
- [ ] Missing Information 和 completeness 可见。
- [ ] 用户必须显式确认才提交。

### Data

- [ ] Canonical `BugReportDraft` 仍然是服务端事实源。
- [ ] Markdown / report preview 不是数据库事实源。
- [ ] Submit 不依赖浏览器重新构造 Draft。
- [ ] 正式 `BugReport` 仍通过 Zod schema 校验。

### Agent

- [ ] 每轮最多三个问题。
- [ ] 已回答的问题不重复问。
- [ ] unknown / unavailable 不进入死循环。
- [ ] 用户明确纠正可以覆盖旧理解。
- [ ] 不要求用户说 schema field name。

### Engineering

- [ ] 不破坏 Queue / Orchestrator pipeline。
- [ ] 不引入公网依赖。
- [ ] 不为了 UI 重构重做数据库。
- [ ] 新增/修改测试通过。
- [ ] 现有测试套件通过。

---

## 19. 推荐实施顺序

Agent 应按以下顺序实施，不要从 CSS 开始：

### Step 1：锁定 contract

- 更新 Intake tests 表达 conversational-first 行为。
- 增加 correction / submit-without-draft 测试。

### Step 2：修正 Intake 行为

- 确保聊天纠正能更新已有字段。
- 确保 question strategy 不依赖表单手改。
- 必要时调整 system prompt。

### Step 3：调整 submit contract

- 服务端 conversation draft 为 submit 默认事实源。
- body.draft 仅兼容，不再是新 UI 依赖。

### Step 4：实现 Bug Document renderer

- draft + completeness → deterministic report view。
- 增加单测。

### Step 5：重构 Intake Web

- 移除表单。
- 左 Chat + 右 Report。
- 自动刷新。
- 保留 confirmation。

### Step 6：回归

执行仓库已有：

```text
lint
typecheck
test
build
```

以 package.json 实际脚本为准。

---

## 20. 明确禁止 Agent 做的事情

为防止再次偏离产品目标，实施 Agent 不得：

- 用“更漂亮的表单”替代当前表单。
- 把右侧 report 做成一组 input / textarea。
- 要求用户手选 executionTarget 才能提交。
- 要求用户手选 environmentProfileId 才能继续。
- 删除内部 BugReport schema 改成纯 Markdown 数据库。
- 每次显示 report 都重新调用 LLM。
- 为实现 Markdown 展示擅自加入重型前端框架。
- 把 Pipeline / Pi / GitLab 工作混进本工作包。
- 因 Fake 模型能力有限而让测试通过手填 draft 绕过聊天流程。

---

## 21. Agent 完成报告格式

实施 Agent 完成后必须汇报：

1. 修改了哪些文件。
2. 删除了哪些表单交互。
3. Bug Document 如何从 Draft 渲染。
4. 用户聊天纠正旧字段如何实现。
5. Submit 是否完全不依赖 client draft。
6. 新增了哪些测试场景。
7. `lint / typecheck / test / build` 结果。
8. 仍有哪些已知限制。

不能只汇报“页面已改成 Chat”。必须证明数据流和测试也已经迁移为 conversational-first。

---

## 22. 最终产品定义

完成本工作包后，系统 Intake 的定义应是：

> 用户像和工程助手聊天一样描述 Bug；系统持续维护一份内部结构化 BugReport Draft，并实时生成一份人类可读的 Bug 文档。系统主动追问影响定位和修复的关键信息。用户不需要填写结构化表单；如果 AI 理解有误，用户直接在聊天中纠正。用户确认后，服务端基于 canonical draft 生成正式 BugReport，并进入后续自动修复流水线。

一句话约束：

```text
Natural language in → structured state inside → bug document out.
```
