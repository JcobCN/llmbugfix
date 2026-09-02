# WP02：Bug Intake、API 与 Chat UI（Phase 3–6）

## 目标

提供自然语言采访、可编辑 Bug Draft、最多三问的自适应追问、完整度评分、用户确认提交和基础 Web UI。

## 文件所有权

- `packages/intake-agent/**`
- `packages/intake-policy/**`
- `apps/bug-api/**`（附件与 orchestrator 路由由对应工作包补充）
- `apps/bug-web/**`（Dashboard 页面由 WP06 补充）

## 必须实现

- `IntakeModel.complete()` Adapter，Fake 与 OpenAI-compatible 内网 HTTP 实现；严格 JSON + Zod。
- system prompt 包含无公网、不得虚构、敏感信息、截图能力声明、最多三问等 V4 规则。
- 每轮输入是 current draft + relevant recent messages + latest message，不能只依赖全量聊天。
- DeepPartial 字段合并；数组与嵌套对象策略明确；检测冲突并保留用户手改值优先级。
- 基于 target/bug type 的问题策略；已回答/unknown/不可获得字段不得重复问。
- 完整度五维 25/30/15/20/10，建议阈值 65，但允许用户强制确认；严重不足进入 NEEDS_INFO。
- API 覆盖 conversation create/message/get/draft/submit、bugs list/detail/retry/cancel、environments list 的契约。
- 提交必须显式确认、生成 BugReport + Job；重复提交幂等。
- Web：左 Chat、右实时 Draft；字段编辑、target/profile 选择、完整度、提交预览与确认。
- UI 具备 loading/error/empty 状态和基本响应式布局。

## 验收

- Fake Intake 可完成完整对话；每轮问题数 0–3。
- 用户手动修正 target 后后续轮次不被低置信模型覆盖。
- 未确认不能生成正式 Bug/Job；确认后 API 返回 bugKey。
- score <65 仍可提交但路由符合 NEEDS_INFO 规则。
- API 集成测试和关键 UI 测试通过。

