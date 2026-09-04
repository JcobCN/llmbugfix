# WP08：Intake 提交闭环与反馈体验

> 状态：新增实施规格
>
> 本文档补充 WP07 的 Intake 页面交互，解决“提交成功后反馈不明显、去向不明确、页面仍像可继续编辑”的产品断层。
>
> **冲突优先级：本文档仅覆盖 `requirements/07-conversational-intake-redesign.md` 中与提交反馈、页面导航和提交后 UI 状态有关的描述；Chat、Markdown 对账、revision/hash/CAS 与后端提交语义仍以 WP07 为准。**

---

## 1. 产品目标

用户点击“确认提交”后，必须在当前页面清楚地知道：

- 提交是否成功。
- 生成了哪个 Bug Key。
- Bug 当前处于什么状态。
- 完整度是多少。
- 接下来可以去哪里查看，或者如何创建下一份报告。

成功提交不是一次短暂 toast，而是 Intake 流程的明确终态。页面必须从“收集中”收敛到“已提交”，不得仍表现为可继续编辑和重复提交。

目标流程：

```text
Chat + Markdown 收集
        ↓
确认提交（pending）
        ↓
服务端返回 bugKey / status / completeness
        ↓
持久成功结果卡片
        ↓
查看 Bug 详情 / 前往 Dashboard / 创建新报告
```

---

## 2. 范围与非目标

### 2.1 本工作包范围

- Intake 首页顶部导航。
- 页面初始化、处理中、可编辑、提交失败、提交成功等状态的清晰反馈。
- 提交成功结果卡片。
- 提交后编辑器和 Chat 的只读/禁用语义。
- 到 Bug 详情页、Dashboard、新报告入口的导航。
- 与上述行为对应的 Web 回归测试。

### 2.2 非目标

- 不修改 BugReport、Conversation、Queue 或 Pipeline 状态机。
- 不启动 repair worker。
- 不接入真实 LLM、Vision、Git 或远程服务。
- 不实现认证、RBAC 或新的路由框架。
- 不为了本工作包引入前端框架或第三方 UI 依赖。
- 不自动跳转到详情页；用户应先看到明确的成功结果。

---

## 3. 页面状态模型

Intake 页至少必须区分以下状态：

| 状态 | Header/主要反馈 | 可编辑性 | 允许操作 |
| --- | --- | --- | --- |
| `loading` | “正在创建会话…” | 禁用 | 等待或重试 |
| `ready` | “可继续补充” | Chat 与 Markdown 可编辑 | 发送、保存、确认提交 |
| `busy` | “处理中…”或“正在提交…” | 临时禁用 | 等待当前请求结束 |
| `error` | 可见错误信息 | 非终态错误应恢复可编辑 | 重试原操作 |
| `submitted` | 持久成功结果卡片 | Chat 与 Markdown 只读/禁用 | 查看详情、Dashboard、新报告 |

要求：

- 初始化失败时不得永久停留在 Loading；必须显示错误和显式“重试加载”操作。
- 请求进行中必须防止重复发送或重复提交。
- 提交失败后不得清空用户输入或伪装成成功；应恢复到可继续修正的状态。
- 提交成功后，即使通用 `finally` 逻辑执行，也不得把 Header 恢复成 `Ready`。
- `submitted` 是当前 conversation 的客户端终态；不得再调用 message、document save 或 submit API。

---

## 4. 顶部导航

Intake 首页 Header 必须包含：

- 当前产品/页面名称。
- 当前流程状态。
- 可直接访问 `/dashboard` 的 Dashboard 链接。

导航必须在桌面和移动布局中可见、可聚焦，并具有可理解的文本标签；不得只使用无辅助文本的图标。

---

## 5. 提交前交互

### 5.1 确认动作

- “确认提交”保持为明确的主操作。
- 点击后必须先 flush 未保存 Markdown，再调用 submit API。
- 浏览器确认提示应说明该操作会创建正式 Bug，而不是只说笼统的 “Review”。
- 提交期间按钮文案或页面状态必须显示“正在提交…”。
- 所有可能触发重复请求的按钮在 pending 期间禁用。

### 5.2 错误反馈

- 普通 API 错误显示服务端消息，并恢复发送/提交能力。
- Markdown revision/reconciliation conflict 继续遵守 WP07：保留本地内容、显示冲突提示并提供载入服务端版本的操作。
- 错误区域必须可见，不能只依赖 console。

---

## 6. 提交成功结果卡片

提交 API 成功返回后，在 Intake 主区域中展示持久的成功卡片。卡片至少包含：

- 明确标题：“Bug 已提交”。
- `bugKey`，例如 `BUG-000001`。
- 当前 `status`。
- `completeness.score`，以 `n/100` 或 `n%` 表示。
- 一句与状态相符的下一步解释。

状态解释至少覆盖：

- `QUEUED`：已进入本地修复队列；本地 `pnpm dev` 模式没有 repair worker 时，必须诚实说明报告会停留在队列中，不得暗示正在自动修复。
- `NEEDS_INFO`：报告已创建，但信息仍不充分；引导用户查看详情，而不是显示“已排队修复”。
- 其他状态：显示原始状态，并使用中性的“可在详情页查看最新进度”描述。

成功卡片必须提供以下操作：

1. “查看 Bug 详情”：链接到 `/bugs/<encoded bugKey>`。
2. “前往 Dashboard”：链接到 `/dashboard`。
3. “创建新报告”：进入 `/` 并创建新的 conversation；可以用普通导航刷新页面，不要求单页重置。

Bug Key 自身也应是可访问的详情链接。所有链接必须使用返回值动态生成，不得猜测编号。

---

## 7. 提交后的页面收敛

提交成功后必须：

- 将 Chat textarea 设为 disabled 或 readonly。
- 将 Markdown editor 设为 readonly。
- 禁用发送、继续补充和确认提交按钮。
- 清除任何待执行的自动保存 timer。
- 不再因 editor input 或通用 busy 状态更新触发保存。
- 保留当前对话、最终 Markdown 和完整度供用户复核。
- Header 显示包含 Bug Key 的已提交状态。

按钮可隐藏，也可保留为禁用状态；若保留，必须清楚表明当前报告已提交。结果卡片的三个导航操作必须保持可用。

---

## 8. 可访问性与响应式要求

- 成功卡片使用可识别的 `role="status"` 或等价语义；失败反馈使用 `role="alert"` 或等价语义。
- 键盘用户可以访问 Dashboard 和所有成功后操作。
- focus 样式不得被移除。
- 成功卡片在窄屏下纵向排列操作，不产生水平溢出。
- 不能只靠红/绿颜色表达状态，必须同时显示文字。

---

## 9. 实现边界

- 优先修改 `apps/bug-web/src/index.ts` 与对应测试。
- 现有 submit API 已返回 `bugKey`、`status`、`completeness` 和 `document`，Web 应直接消费这些字段。
- 只有确认 API 契约无法满足上述展示时才允许修改 Bug API，并必须补充 API 测试。
- 保持当前 dependency-free HTML/CSS/JavaScript 实现，不引入新的运行时依赖。
- TypeScript 源码是实现源；仓库已跟踪的生成 `.js`、`.d.ts`、source map 必须通过现有 build 流程同步。

---

## 10. 验收标准

### 10.1 初始化与基础导航

- [ ] 页面加载时显示明确初始化状态。
- [ ] 创建 conversation 成功后进入 ready 状态。
- [ ] 创建失败后显示错误和“重试加载”，不再永久 Loading。
- [ ] Header 存在可访问的 Dashboard 链接。
- [ ] 页面所有内联脚本可以被 JavaScript parser 成功解析。

### 10.2 提交过程

- [ ] 点击确认提交会先 flush Markdown。
- [ ] pending 期间显示“正在提交”且禁止重复请求。
- [ ] 提交失败保留用户输入并恢复操作。
- [ ] reconciliation/revision conflict 不丢失本地 Markdown。

### 10.3 提交成功

- [ ] 页面持久显示“Bug 已提交”。
- [ ] 正确显示 API 返回的 Bug Key、status、completeness score。
- [ ] Bug Key 与“查看 Bug 详情”均指向正确的动态详情 URL。
- [ ] 提供 Dashboard 与创建新报告入口。
- [ ] Chat 和 Markdown 进入只读/禁用状态。
- [ ] 清除自动保存 timer，后续操作不再调用 conversation 写 API。
- [ ] `QUEUED` 与 `NEEDS_INFO` 使用不同且准确的说明。

### 10.4 回归

- [ ] WP07 的 Chat、Markdown autosave、flush、conflict recovery 行为保持不变。
- [ ] `pnpm build` 通过。
- [ ] `pnpm test` 全量通过。
- [ ] `git diff --check` 通过。

---

## 11. 建议测试场景

1. 渲染 HTML 后提取每个 inline script，并用 JavaScript parser 验证语法。
2. 断言 Header 包含 `/dashboard` 导航。
3. 断言成功卡片初始隐藏，并具有 status 语义。
4. 模拟 `QUEUED` submit response，断言 Bug Key、状态、分数、详情链接和本地队列说明。
5. 模拟 `NEEDS_INFO` submit response，断言不会显示“已进入修复队列”。
6. 提交成功后触发发送、提交或 editor input，断言不会再产生写请求。
7. submit API 返回错误，断言 Markdown 内容保留且操作恢复。
8. 初始化 API 返回错误，断言 Loading 被替换成可重试错误态。

测试不得访问公网，也不得依赖真实 LLM 或 repair worker。
