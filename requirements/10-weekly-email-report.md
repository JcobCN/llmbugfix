# WP10：每周 Bug 修复邮件汇总

> 状态：实施规格
>
> 本工作包在现有 SQLite Bug 事件与本地服务上增加独立的周报生成和 SMTPS 发送能力。不改变 Bug 状态机、修复流水线或 Dashboard 业务语义。

## 1. 目标与结果

当邮件配置完整时，本地服务必须在每周六 09:00（`Asia/Shanghai`）生成并发送本周 Bug 修复情况汇总：

```text
SQLite bug_events / bug_reports
    ↓
按本周修复流水线进展选取 Bug 并去重
    ↓
按发送时的最新状态分类并生成 text/html
    ↓
smtps://mail.onecloud.cn:465
    ↓
配置的一个或多个收件人
```

- 统计区间是当周周一 00:00 至周六 09:00，区间为左闭右开 `[start, end)`。
- 上周或更早提交的 Bug，只要本周统计区间内发生了修复流水线进展，也必须纳入。
- 没有任何符合条件的 Bug 时仍发送邮件，正文明确显示“本周无 Bug 修复进展”。
- 服务启动时仅检查最近一期已到期周报；该周期没有任何发送记录时才发送。每期最多进行一次真实 SMTP 尝试，失败或发送中断后不自动重试，下一周的新周报仍正常发送。

## 2. 范围与非目标

### 2.1 范围

- 增加周报配置解析和启动校验。
- 增加邮件发送 Adapter、周报查询/生成服务、可注入时钟和调度器。
- 增加 SQLite 周报发送记录，用于互斥 claim、一次性发送审计和防止正常重启重复发送。
- 在本地服务 bootstrap 中接线调度器，并纳入 `SIGINT`/`SIGTERM` 优雅停止流程。

### 2.2 非目标

- 不增加网页邮箱配置页面、收件人管理或邮件历史页面。
- 不从用户的 Bug 描述、附件或对话中读取邮箱凭据或收件人。
- 不发送原始日志、错误栈、附件或 diff，不增加 LLM 生成邮件内容。
- SMTP 接受邮件后若应用未能确认结果，系统无法严格判断收件方是否已收到。为避免自动重复邮件，本工作包采用“每期最多一次真实 SMTP 尝试”的语义，可能需要人工核实这种歧义结果。

## 3. 配置契约

### 3.1 环境变量

```dotenv
WEEKLY_EMAIL_SMTP_URL=smtps://mail.onecloud.cn:465
WEEKLY_EMAIL_USERNAME=sender@example.com
WEEKLY_EMAIL_PASSWORD=secret
WEEKLY_EMAIL_RECIPIENTS=owner@example.com,team@example.com
WEEKLY_EMAIL_ALLOW_INSECURE_TLS=false
```

| 配置 | 要求 |
| --- | --- |
| `WEEKLY_EMAIL_SMTP_URL` | 可省略并使用 `smtps://mail.onecloud.cn:465` 默认值；若显式配置，值必须与该 URL 完全一致。不允许 `smtp:`、STARTTLS 降级、其他主机或端口。 |
| `WEEKLY_EMAIL_USERNAME` | 必填且必须是合法邮箱地址；同时用作 SMTP 登录账号、信封发件人和 `From` 地址。 |
| `WEEKLY_EMAIL_PASSWORD` | 必填的 SMTP 密码。不得出现在日志、错误响应、数据库、artifact、邮件正文或测试快照中。 |
| `WEEKLY_EMAIL_RECIPIENTS` | 必填；逗号分隔的一个或多个邮箱地址。解析时 trim、拒绝空项、按不区分大小写去重并对每项做邮箱校验。 |
| `WEEKLY_EMAIL_ALLOW_INSECURE_TLS` | 可选，默认 `false`，仅接受精确值 `true`/`false`。设为 `true` 时关闭 SMTP 证书和主机名校验，只允许隔离内网人工验收，启动必须输出明显警告，禁止用于生产。 |

`WEEKLY_EMAIL_USERNAME`、`WEEKLY_EMAIL_PASSWORD` 和 `WEEKLY_EMAIL_RECIPIENTS` 全部未配置时，周报功能禁用，启动日志必须明确说明“每周邮件未启用”。`WEEKLY_EMAIL_SMTP_URL` 和 `WEEKLY_EMAIL_ALLOW_INSECURE_TLS` 单独配置不触发启用。三个启用配置只提供了一部分、任一值为空、收件人无效、SMTP URL 非法或 TLS 开关不是精确布尔值时，应快速启动失败，不得静默禁用或降级。

### 3.2 SMTP 安全与超时

- 生产 Adapter 使用 Node.js 生态成熟的 SMTP 库，通过 lockfile 锁定实际依赖版本；不手写 SMTP 协议状态机。
- 465 端口必须从建连开始使用 TLS，默认开启服务器证书和主机名验证。仅当显式设置 `WEEKLY_EMAIL_ALLOW_INSECURE_TLS=true` 时，才允许对隔离内网人工验收设置 `rejectUnauthorized: false`；该模式必须输出明显警告，不能作为生产默认或通过全局 `NODE_TLS_REJECT_UNAUTHORIZED=0` 开启。
- 连接、认证和发送必须有有界 timeout；超时和 SMTP 错误必须转换为不含凭据、收件人全量地址或服务器原始响应的可诊断错误。
- SMTP 库只能在邮件 Adapter 包内使用；周报服务和调度器仅依赖 `MailSender` 接口。

## 4. 统计口径与分类

### 4.1 时间边界

- 所有周边界按 IANA 时区 `Asia/Shanghai` 计算，不得使用主机默认时区。持久化和 SQL 比较继续使用带 offset 的 ISO 8601 时间。
- 周报的 `periodStart` 是当周周一 00:00:00，`periodEnd` 是同周周六 09:00:00。
- 查询使用 `created_at >= periodStart AND created_at < periodEnd`，因此精确发生在周六 09:00 的事件不属于本期。周六 09:00 至周日的进展不纳入任何周报，这是本工作包明确的产品口径。

### 4.2 入选条件

只使用 `bug_events.created_at` 判断 Bug 是否在本周有修复进展，不得使用 `bug_reports.updated_at`、会话更新或附件更新代替。本期至少发生过一次以下目标状态事件的 Bug 入选：

```text
QUEUED, NEEDS_INFO, PREPARING_ENV, FIXING, FIX_CANDIDATE,
VALIDATING, REVIEWING, FIX_READY, FIX_FAILED, PUSHING,
READY_FOR_HUMAN_REVIEW, BLOCKED, CANCELLED, REJECTED,
ENVIRONMENT_FAILED, VALIDATION_FAILED, REVIEW_REJECTED, PUSH_FAILED
```

- `DRAFT`、`COLLECTING`、`READY_FOR_CONFIRMATION`、`SUBMITTED` 和 `TRIAGING` 本身不计为修复流水线进展。
- 同一 Bug 在本期内有多个事件时只展示一次，最近进展时间取本期内最后一个入选事件的 `created_at`。
- 分类使用生成邮件快照时 `bug_reports.status` 的最新值，而不是本期最后一个事件的历史状态。

### 4.3 分类规则

| 分类 | 状态 |
| --- | --- |
| 修复成功 | `FIX_READY`、`READY_FOR_HUMAN_REVIEW` |
| 失败/阻塞 | `FIX_FAILED`、`ENVIRONMENT_FAILED`、`VALIDATION_FAILED`、`REVIEW_REJECTED`、`PUSH_FAILED`、`BLOCKED`、`REJECTED`、`CANCELLED` |
| 处理中 | `QUEUED`、`NEEDS_INFO`、`PREPARING_ENV`、`FIXING`、`FIX_CANDIDATE`、`VALIDATING`、`REVIEWING`、`PUSHING` |

若入选 Bug 的最新状态不在上表中，生成应以可诊断的 contract 错误失败，不得将其静默遗漏或猜测分类。

## 5. 邮件内容契约

- 主题固定为 `[LLMBugFix] Bug 修复周报 YYYY-MM-DD ~ YYYY-MM-DD`，两个日期分别为 `periodStart` 和 `periodEnd` 的 `Asia/Shanghai` 日期。
- 每封邮件同时提供 UTF-8 `text/plain` 和 `text/html` alternative，两种格式必须表达相同数据。
- 顶部包含统计区间、修复成功数、失败/阻塞数和处理中数。三个分类按“最近进展时间降序、Bug Key 升序”排序。
- 每个 Bug 包含：Bug Key、标题、项目/模块（`productArea`/`component`）、执行目标、当前状态、最近进展时间和可用的摘要。
- 摘要仅可使用已通过领域 schema 的 `intake.llmSummary`、Agent 修复摘要或结构化失败原因；最多 500 个 Unicode 字符，超出后明确截断。不得读取原始日志、错误栈、diff、附件内容或未校验 artifact 作为邮件内容。
- HTML 内容必须转义所有来自 Bug 的文本，不得插入任意 HTML、外部图片、跟踪像素或脚本。
- 没有 Bug 时三类计数均为 0，且正文显示“本周无 Bug 修复进展”。

## 6. 公共接口与数据流

### 6.1 稳定接口

实现必须保持以下依赖方向，具体类名可与现有 package 命名保持一致：

```ts
interface MailSender {
  send(message: {
    from: string;
    to: readonly string[];
    subject: string;
    text: string;
    html: string;
    messageId: string;
  }, signal?: AbortSignal): Promise<void>;
}

interface WeeklyReportClock {
  now(): Date;
}

interface WeeklyReportService {
  generate(periodStart: string, periodEnd: string): WeeklyBugReport;
}
```

- SMTP Adapter 实现 `MailSender`；测试使用 fake sender，不访问真实网络。
- Scheduler 依赖可注入时钟、发送记录 repository、`WeeklyReportService` 和 `MailSender`，不直接拼 SQL、SMTP 或 HTML。
- 周报的 schema/type 通过 package `src/index.ts` 导出，禁止跨 package 深层导入。

### 6.2 生成快照

调度器必须在同一数据库读事务中获取入选事件、Bug 最新状态和发送记录 claim 所需数据，以生成稳定快照。后续状态变更不得改变已 claim 邮件的内容或 Message-ID。

## 7. 持久化与交付语义

SQLite 增加 `weekly_report_deliveries` 表，至少包含：

| 字段 | 要求 |
| --- | --- |
| `id` | UUID 主键。 |
| `period_start` / `period_end` | 带 offset ISO 8601；`period_start` 必须有唯一约束。 |
| `status` | `PENDING` / `SENDING` / `SENT` / `FAILED`。 |
| `attempt_count` | 非负整数，每次真实发送前原子加一。 |
| `message_id` | 由周期起点确定性生成并唯一，用于该周期的一次性发送审计。 |
| `report_snapshot` | 已校验的结构化周报 JSON，不包含凭据或原始敏感内容。 |
| `next_attempt_at` | 兼容保留字段；一次性投递语义下始终为 `NULL`。 |
| `last_error` | 脱敏、截断后的错误，成功后为 null。 |
| `claimed_at` / `sent_at` / `created_at` / `updated_at` | 调度、恢复和审计时间。 |

- 建表/迁移必须可重复执行，并保留现有数据。
- 到达发送时间后，调度器仅在 `period_start` 尚无记录时，在事务中创建快照并原子 claim 为 `SENDING`，`attempt_count` 固定为 1。
- 成功后写入 `SENT` 和 `sent_at`。已是 `SENT` 的周期不得再次发送。
- 失败后写入 `FAILED` 和脱敏 `last_error`，`next_attempt_at` 保持 `NULL`。不安排退避、进程内重试或跨重启重试。
- 任何既有记录（包括 `FAILED`、`SENDING`、`SENT` 和兼容保留的 `PENDING`）都不得再次 claim。进程中断遗留的 `SENDING` 是终态，不做过期恢复或重发。
- 启动和计划唤醒只计算最近一期已到期周期；若该周期已有记录则不发送。旧周失败不会阻塞下一周创建并发送新的周期记录，更早的遗漏周期不批量补发。
- SMTP 在接受邮件后如果连接中断，应用无法判定对端是否已接收；系统仍不重试，以减少自动重复邮件。该限制必须记录在 README/运维说明中。

## 8. 调度器生命周期

- 邮件功能启用时，调度器与 API/修复 worker 处于同一本地服务进程，复用同一 SQLite 连接或受控数据库工厂。
- 启动后立即检查最近一期已到期且从未记录的周期，然后计算下一个 `Asia/Shanghai` 周六 09:00；不得依赖操作系统的 crontab。
- 调度等待应使用可取消 timer，不做忙轮询。系统时钟大幅跳变或长时间 suspend 后必须重新检查到期周期。
- shutdown 顺序为停止新的周报 claim、取消当前 SMTP 发送并将其记为 `FAILED`、停止修复 worker、关闭 API，最后释放 queue 和数据库资源。进程异常退出遗留的 `SENDING` 记录保留用于审计，下次启动同样不得重发。
- 周报失败不得导致 API 或 Bug 修复 worker 退出；运行时失败通过脱敏日志和持久化发送状态暴露。

## 9. 测试与验收

### 9.1 配置与内容

- [ ] 三个启用变量都未配置时功能禁用；部分配置、空值、非法邮箱、空收件人项和非法 SMTP URL 启动失败。
- [ ] 收件人 trim、不区分大小写去重；发件人、认证账号和配置值一致。
- [ ] 生成的 text/html 内容字段、计数、排序和编码一致；HTML 转义 Bug 标题和摘要。
- [ ] 密码、原始日志、错误栈、附件和过长摘要不出现在邮件、日志、数据库错误或测试快照中。

### 9.2 统计与时间

- [ ] 使用 fake clock 覆盖周一 00:00、周六 09:00、左闭右开边界、主机处于其他时区和空周。
- [ ] 上周提交但本周有流水线事件的 Bug 被纳入；只更新 `bug_reports.updated_at` 不会被纳入。
- [ ] 同一 Bug 多个事件只显示一次，最近进展时间正确，所有当前状态均映射到唯一分类。

### 9.3 发送、去重与中断

- [ ] 单元和集成测试使用 fake `MailSender`，不连接真实 SMTP。
- [ ] 验证 SMTPS URL、认证参数、TLS 开关、收件人、UTF-8 alternative 和稳定 Message-ID 被正确传给 Adapter。
- [ ] 默认启用 TLS 证书/主机名校验；仅显式配置 `WEEKLY_EMAIL_ALLOW_INSECURE_TLS=true` 时传递 `rejectUnauthorized: false`，并输出启动警告。
- [ ] 首次失败写入 `FAILED`、脱敏错误和 `next_attempt_at=NULL`；同周期在进程内或重启后都不再发送。
- [ ] `period_start` 唯一约束、原子 claim、`FAILED`/中断 `SENDING`/`SENT` 不重发在 SQLite 集成测试中被覆盖。
- [ ] 旧周失败不阻塞下一周的新周报发送。
- [ ] SMTP 超时、认证失败、证书失败和取消的错误均被脱敏，且不会使 API/修复 worker 退出。

### 9.4 执行环境

- [ ] 根目录 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check` 全部通过。
- [ ] 所有构建、类型检查和测试只在 `kfjllm:~/prj/llmbugfix` 执行，并在命令前加载 `~/.bashrc`。
- [ ] 自动测试不使用真实邮箱凭据或访问 `mail.onecloud.cn`；真实 SMTP 连通与投递仅作为显式、人工发起的验收项。

## 10. 实现边界

- 周报查询/生成、Scheduler 和 SMTP Adapter 应放入独立 workspace package，并通过 `src/index.ts` 暴露稳定接口。
- `packages/bug-repository` 管理 `weekly_report_deliveries` 表、迁移和发送记录 repository，周报 package 不自行打开第二个业务数据库。
- `packages/shared` 管理邮件配置 schema 和 secret redaction，现有邮件之外的配置语义保持不变。
- `apps/bug-api/src/local-server.ts` 只负责解析配置、构建依赖和管理生命周期，不在 bootstrap 中实现报表 SQL、模板或 SMTP 协议。
- README 必须记录配置方法、时区/统计边界、每期最多一次尝试且不自动重试、旧周失败不阻塞新周、故障排查和人工 SMTP 验收方法。
