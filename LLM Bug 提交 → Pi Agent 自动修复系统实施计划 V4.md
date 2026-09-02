# LLM Bug 提交 → Pi Agent 自动修复系统实施计划 V4

# 0. 项目目标

实现一套适用于公司内网、单机部署的 Bug 提交与自动修复系统。

测试人员不再通过 Jira 提交 Bug，而是通过 LLM 交互式 Bug 提交页面，用自然语言描述问题。

系统通过多轮对话尽可能收集能够帮助 Coding Agent 定位和修复问题的信息，并最终生成结构化 Bug Report。

Bug 提交完成后，由单任务 Orchestrator 串行调用 Pi Agent 进行代码分析、修改、验证和独立 Review。

最终代码提交到私有 GitLab 的独立 `ai/*` Branch。

系统不创建 Merge Request，不自动 Merge，不自动 Deploy。

总体流程：

```text
测试人员
   │
   ▼
Bug Chat Web UI
   │
   ▼
Bug Intake LLM
   │
   ├── 理解自然语言
   ├── 提取已有信息
   ├── 判断 Frontend / Backend
   ├── 动态追问
   ├── 收集日志 / HAR / JSON
   ├── 接收截图
   ├── 可选调用 Vision Provider
   ├── 计算信息完整度
   └── 生成结构化 BugReport
              │
              ▼
        测试人员确认
              │
              ▼
            SQLite
              │
              ▼
           Bug Queue
              │
        单任务串行执行
              │
              ▼
       Environment Resolver
              │
       ┌──────┴──────┐
       │             │
   Frontend       Backend
   Template       Template
       │             │
       └──────┬──────┘
              ▼
          Pi Fixer
              │
              ▼
     Deterministic Validator
              │
              ▼
       Independent Reviewer
              │
              ▼
           Git Commit
              │
              ▼
     Push GitLab ai/* Branch
              │
              ▼
   READY_FOR_HUMAN_REVIEW
```

---

# 1. 部署约束

系统运行环境：

```text
单机部署
公司内网
无法访问公网
本地或内网 LLM
单 Agent 任务执行
私有 GitLab
```

系统设计不得依赖：

```text
公网搜索
公网 API
GitHub
Jira
云数据库
云对象存储
外部 Embedding Service
外部 OCR Service
外部 Vision API
```

所有核心能力必须能够在纯内网环境工作。

---

# 2. MVP 基础设施

第一版仅依赖：

```text
Node.js Application
SQLite
Local Filesystem
Internal LLM API
Pi Agent
Git CLI
Frontend / Backend Runtime
```

明确不引入：

```text
PostgreSQL
MySQL
Redis
BullMQ
MinIO
Kafka
RabbitMQ
Elasticsearch
```

原因：

```text
单机
+
低并发
+
Agent concurrency = 1
```

不需要分布式基础设施。

---

# 3. 数据库

使用：

```text
SQLite
```

建议数据库：

```text
data/bug-agent.db
```

启动时设置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

推荐使用：

```text
better-sqlite3
```

或者项目统一 ORM：

```text
Drizzle ORM + SQLite
```

优先推荐：

```text
Drizzle ORM
```

方便：

```text
Schema
Migration
TypeScript 类型
```

---

# 4. 本地文件目录

运行目录：

```text
data/
├── bug-agent.db
│
├── attachments/
│   ├── BUG-000001/
│   ├── BUG-000002/
│   └── ...
│
├── agent-results/
│   ├── BUG-000001/
│   └── ...
│
├── worktrees/Qwen3.8-27B_IQ3
│   ├── BUG-000001/
│   └── ...
│
└── logs/
```

SQLite 保存：

```text
Bug
Conversation
Message
附件 Metadata
任务状态
Agent Result Metadata
EventQwen3.8-27B_IQ3
```

本地文件系统保存：

```text
Screenshot
Log
HAR
JSON
TXT
Video
Agent Result
Diff
Validation Log
```

禁止把大型二进制文件直接写入 SQLite。

---

# 5. 系统模块

建议项目结构：

```text
bug-agent-platform/
├── apps/
│   ├── bug-web/
│   │
│   ├── bug-api/
│   │
│   └── orchestrator/
│
├── packages/
│   ├── bug-domain/
│   ├── bug-repository/
│   ├── intake-agent/
│   ├── intake-policy/
│   ├── attachment-service/
│   ├── vision-provider/
│   ├── environment-resolver/
│   ├── job-queue/
│   ├── repo-manager/
│   ├── pi-runner/
│   ├── validator/
│   └── shared/
│
├── environments/
│   ├── frontend/
│   └── backend/
│
├── .pi/
│   └── skills/
│
├── config/
│   └── environments.yaml
│
├── data/
│
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

# 6. Bug 生命周期

状态：

```text
DRAFT
  │
  ▼
COLLECTING
  │
  ▼
READY_FOR_CONFIRMATION
  │
  ▼
SUBMITTED
  │
  ▼
TRIAGING
  │
  ├─────────────┐
  ▼             ▼
QUEUED       NEEDS_INFO
  │
  ▼
PREPARING_ENV
  │
  ▼
FIXING
  │
  ▼
VALIDATING
  │
  ▼
REVIEWING
  │
  ├──────────────┐
  ▼              ▼
FIX_READY     FIX_FAILED
  │
  ▼
PUSHING
  │
  ▼
READY_FOR_HUMAN_REVIEW
```

附加状态：

```text
BLOCKED
CANCELLED
REJECTED
ENVIRONMENT_FAILED
VALIDATION_FAILED
REVIEW_REJECTED
PUSH_FAILED
```

---

# 7. Bug ID

使用：

```text
BUG-000001
BUG-000002
BUG-000003
```

数据库内部：

```text
UUID
```

用户和 Git 使用：

```text
BUG-xxxxxx
```

Git Branch：

```text
ai/BUG-000123-login-loading
```

Commit：

```text
fix(BUG-000123): resolve login loading issue
```

---

# 8. Bug 核心分类

需要区分两个完全不同的维度。

## 8.1 Bug Type

```ts
type BugType =
  | "functional"
  | "ui"
  | "api"
  | "crash"
  | "performance"
  | "data"
  | "permission"
  | "compatibility"
  | "network"
  | "concurrency"
  | "unknown";
```

用于决定：

```text
测试人员应该被问什么问题
```

---

## 8.2 Execution Target

```ts
type ExecutionTarget =
  | "frontend"
  | "backend"
  | "unknown";
```

用于决定：

```text
Agent 应该进入哪个代码库
如何准备运行环境
如何启动项目
如何执行测试
```

两者不能混用。

例如：

```text
Bug Type:
functional

Execution Target:
frontend
```

或者：

```text
Bug Type:
functional

Execution Target:
backend
```

---

# 9. BugReport 数据模型

```ts
interface BugReport {
  id: string;

  bugKey: string;

  title: string;

  productArea: string | null;
  component: string | null;

  bugType: BugType;

  executionTarget:
    | "frontend"
    | "backend"
    | "unknown";

  environmentProfileId:
    | string
    | null;

  severity:
    | "low"
    | "medium"
    | "high"
    | "critical"
    | "unknown";

  actualBehavior: string;

  expectedBehavior:
    | string
    | null;

  reproduction: {
    reproducible:
      | boolean
      | null;

    frequency:
      | "always"
      | "often"
      | "sometimes"
      | "rare"
      | "once"
      | "unknown";

    prerequisites: string[];

    steps: string[];

    testData: string[];
  };

  environment: {
    environmentName:
      | string
      | null;

    appVersion:
      | string
      | null;

    buildNumber:
      | string
      | null;

    commitSha:
      | string
      | null;

    frontend?: {
      route:
        | string
        | null;

      browser:
        | string
        | null;

      browserVersion:
        | string
        | null;

      os:
        | string
        | null;

      resolution:
        | string
        | null;
    };

    backend?: {
      service:
        | string
        | null;

      endpoint:
        | string
        | null;

      method:
        | string
        | null;

      statusCode:
        | number
        | null;
    };

    additionalInfo:
      Record<string, string>;
  };

  evidence: {
    errorMessages: string[];

    stackTraces: string[];

    logs: AttachmentRef[];

    screenshots: AttachmentRef[];

    videos: AttachmentRef[];

    networkTraces: AttachmentRef[];

    jsonFiles: AttachmentRef[];

    otherFiles: AttachmentRef[];
  };

  impact: {
    affectedUsers:
      | string
      | null;

    scope:
      | "single_user"
      | "some_users"
      | "all_users"
      | "unknown";

    blocksTesting:
      | boolean
      | null;

    workaroundExists:
      | boolean
      | null;

    workaround:
      | string
      | null;
  };

  regression: {
    isRegression:
      | boolean
      | null;

    lastKnownGoodVersion:
      | string
      | null;

    suspectedVersion:
      | string
      | null;
  };

  observations: string[];

  reporterHypotheses: string[];

  reporter: {
    userId: string;
    displayName: string;
  };

  intake: {
    completenessScore: number;

    confidence: number;

    missingInformation: string[];

    conversationId: string;

    llmSummary: string;
  };

  createdAt: string;

  updatedAt: string;
}
```

---

# 10. Bug 提交 UI

推荐桌面布局：

```text
┌──────────────────────────────┬────────────────────────┐
│                              │ 当前 Bug Draft        │
│                              │                        │
│                              │ 类型       functional │
│        LLM Chat              │ 执行目标   frontend   │
│                              │ 模块       Login      │
│                              │ Actual     ✓          │
│                              │ Expected   ✓          │
│                              │ Repro      △          │
│                              │ Environment ✓         │
│                              │ Evidence    △         │
│                              │                        │
│                              │ 完整度 76%             │
│                              │                        │
│                              │ [确认提交]             │
└──────────────────────────────┴────────────────────────┘
```

核心原则：

```text
Chat 负责交流

Bug Draft 负责显示系统理解结果
```

不能只有聊天窗口。

---

# 11. 第一轮问题

点击：

```text
提交 Bug
```

系统问：

> 请直接描述你遇到的问题。可以告诉我你做了什么、发生了什么异常，以及正常情况下你期望看到什么。暂时不需要整理格式。

不要先要求填写表单。

---

# 12. LLM Intake Agent 职责

Intake Agent 只负责：

```text
理解描述
提取字段
识别缺失信息
设计下一轮问题
生成 BugReport
```

禁止：

```text
修改代码
启动 Pi Fixer
执行 Git
判断 Root Cause
联网搜索
访问公网
```

---

# 13. 动态追问原则

每轮：

```text
最多 1～3 个问题
```

优先级：

```text
1. 问题到底是什么
2. 怎么复现
3. 预期是什么
4. Frontend / Backend
5. 在什么版本和环境发生
6. 有什么直接错误证据
7. 是否 Regression
8. 影响范围
9. Workaround
```

不要为了字段完整度机械追问。

---

# 14. Frontend / Backend 判断

LLM 可以根据用户描述自动推测：

```text
frontend
backend
unknown
```

但是如果置信度不足：

必须询问测试人员。

例如：

> 这个问题主要表现为网页界面上的异常，还是后台接口/服务返回异常？

UI 可以提供：

```text
[前端]
[后端]
[不确定]
```

该字段非常重要，因为后续决定执行环境。

---

# 15. Frontend Bug 重点提问

Frontend 优先收集：

```text
页面 / Route
触发操作
浏览器
浏览器版本
操作系统
实际 UI 行为
预期 UI 行为
Console Error
Network Error
版本
复现频率
```

例如：

```text
Route:
/orders/123

Browser:
Chrome 128

Actual:
点击 Refund 后按钮一直 Loading

Console:
TypeError: Cannot read properties of undefined
```

---

# 16. Backend Bug 重点提问

Backend 优先：

```text
Service
API Endpoint
HTTP Method
Request
Response
HTTP Status
Stack Trace
Service Log
版本
测试数据
复现频率
```

例如：

```text
Service:
order-service

Endpoint:
POST /api/orders

Actual:
HTTP 500

Expected:
HTTP 400

Error:
ArithmeticException
```

---

# 17. Reproduction Steps

LLM 必须尽量整理：

```text
Prerequisite

Step 1
Step 2
Step 3

Actual Result
```

不得自行虚构步骤。

如果整理了用户的自然语言：

必须允许用户修正。

---

# 18. Reproduction Frequency

记录：

```text
always
often
sometimes
rare
once
unknown
```

需要询问：

> 这个问题现在每次都能复现，还是偶尔出现？

---

# 19. Expected Behavior

尽量获得：

```text
正常情况下应该发生什么？
```

缺失时主动询问。

---

# 20. Regression

优先询问：

> 这个功能以前正常吗？

如果：

```text
是
```

继续获取：

```text
最后正常版本
最早异常版本
```

这对 Agent 查看：

```text
git log
git diff
git bisect
```

非常有价值。

---

# 21. Attachment 系统

第一版支持：

```text
PNG
JPG
JPEG
WEBP

TXT
LOG
JSON
HAR

MP4
```

视频第一版仅保存，不要求自动解析。

文件保存在：

```text
data/attachments/<BUG-ID>/
```

---

# 22. AttachmentRef

```ts
interface AttachmentRef {
  id: string;

  filename: string;

  mimeType: string;

  size: number;

  relativePath: string;

  sha256: string;

  extractedText:
    | string
    | null;

  analysisStatus:
    | "not_required"
    | "pending"
    | "completed"
    | "unsupported"
    | "failed";

  analysisResult:
    | string
    | null;
}
```

---

# 23. 图片能力设计

必须保留完整图片上传能力。

但是：

```text
Image Upload
```

和：

```text
Image Understanding
```

是两个独立能力。

系统不能假设当前 LLM 支持图片。

---

# 24. Vision Provider 抽象

定义：

```ts
interface VisionProvider {
  isAvailable(): Promise<boolean>;

  analyzeImage(
    input: {
      filePath: string;
      prompt: string;
    }
  ): Promise<VisionAnalysis>;
}
```

结果：

```ts
interface VisionAnalysis {
  description: string;

  visibleText: string[];

  observations: string[];

  confidence: number;
}
```

---

# 25. 无 Vision 模型时

配置：

```env
VISION_ENABLED=false
```

系统行为：

```text
图片正常上传
图片正常保存
Bug 正常提交
```

但是：

```text
不调用图像分析
```

Intake Agent 只知道：

```text
用户上传了截图
```

不能声称已经理解图片。

此时自动追问：

> 截图已保存，但当前环境没有配置图片识别模型。请补充说明截图中最关键的异常。如果里面有错误提示文字，也请直接粘贴出来。

---

# 26. 配置 Vision 模型时

如果未来配置：

```env
VISION_ENABLED=true
```

并提供内网 Vision Provider：

```text
Screenshot
   ↓
Vision Provider
   ↓
description
visibleText
observations
   ↓
Intake LLM
```

无需修改 Bug Intake 主流程。

只替换：

```text
VisionProvider
```

实现。

---

# 27. 可选 OCR

OCR 也实现为独立 Adapter。

```ts
interface OcrProvider {
  isAvailable(): Promise<boolean>;

  extractText(
    filePath: string
  ): Promise<string[]>;
}
```

可以：

```text
VISION_ENABLED=false

OCR_ENABLED=true
```

流程：

```text
图片
 ↓
OCR
 ↓
截图中的文字
 ↓
Text LLM
```

OCR 不能替代真正视觉理解。

---

# 28. 图片分析安全原则

任何 Vision/OCR 输出都属于：

```text
Machine Observation
```

不能当成测试人员明确确认的事实。

Bug Report 可以分别保存：

```text
reporterObservations
machineObservations
```

Fix Agent 应知道来源。

---

# 29. 无网络约束

三个 Agent：

```text
Intake Agent
Fixer Agent
Reviewer Agent
```

都假设：

```text
Internet Access = Disabled
```

系统 Prompt 中明确：

```text
This environment has no Internet access.

Do not attempt to:

- search the web
- access public documentation
- call public APIs
- download external dependencies
- fetch packages from the public Internet

Use only:

- provided bug information
- repository contents
- local documentation
- installed dependencies
- configured internal services
- local runtime
- local test results
```

---

# 30. 项目本地知识

由于无法联网，每个代码库应该尽量包含：

```text
README.md
AGENTS.md
docs/
```

建议至少描述：

```text
项目结构
依赖
启动方式
环境变量
测试方式
Lint
Build
本地服务依赖
注意事项
```

Environment Template 可以引用这些文档。

---

# 31. Environment Profile

运行环境不能完全交给 Agent 临时猜。

定义：

```ts
interface EnvironmentProfile {
  id: string;

  name: string;

  type:
    | "frontend"
    | "backend";

  repository: string;

  baseBranch: string;

  instructions: string[];

  skillPaths: string[];

  documentationPaths: string[];

  setupCommands: string[];

  validationCommands: string[];

  runtime?: {
    startCommand: string;

    stopCommand?: string;

    healthCheck?: string;

    startupTimeoutSeconds: number;
  };
}
```

---

# 32. Environment Template 配置

创建：

```text
config/environments.yaml
```

例如：

```yaml
profiles:

  frontend-main:
    name: Main Frontend
    type: frontend

    repository: /repos/frontend
    baseBranch: main

    skills:
      - .pi/skills/frontend-runtime/SKILL.md
      - .pi/skills/frontend-testing/SKILL.md

    docs:
      - AGENTS.md
      - docs/development.md
      - docs/testing.md

    setup:
      - pnpm install --offline

    runtime:
      start: pnpm dev
      healthCheck: http://127.0.0.1:3000
      startupTimeoutSeconds: 120

    validation:
      - pnpm lint
      - pnpm typecheck
      - pnpm test
      - pnpm build


  backend-main:
    name: Main Backend
    type: backend

    repository: /repos/backend
    baseBranch: main

    skills:
      - .pi/skills/backend-runtime/SKILL.md
      - .pi/skills/backend-testing/SKILL.md

    docs:
      - AGENTS.md
      - docs/local-development.md

    setup:
      - ./scripts/setup-local.sh

    runtime:
      start: ./gradlew bootRun
      healthCheck: http://127.0.0.1:8080/health
      startupTimeoutSeconds: 180

    validation:
      - ./gradlew test
```

---

# 33. Environment Template 与 Skill

Environment Profile 负责：

```text
机器可执行配置
```

例如：

```text
Repo
Branch
Command
Health Check
Validation
```

Skill / Markdown 负责：

```text
Agent 应该如何理解和操作环境
```

二者必须分离。

不要把所有运行环境知识硬编码在 TypeScript。

---

# 34. Environment Skill

例如：

```text
.pi/skills/frontend-runtime/SKILL.md
```

内容示例：

```text
# Frontend Runtime

This repository is the main frontend application.

## Runtime

Use:
pnpm dev

The application listens on:
http://127.0.0.1:3000

## Testing

Prefer targeted tests first.

Use:
pnpm test <relevant-test>

Do not change package versions unless required.

## Browser Testing

Playwright is installed locally.

Use existing Playwright test utilities.

Do not attempt to install browser packages from the Internet.
```

---

# 35. Backend Skill

```text
.pi/skills/backend-runtime/SKILL.md
```

描述：

```text
如何启动服务

本地依赖是什么

如何调用 API

测试数据如何准备

日志在哪里

如何停止服务

哪些服务不能访问
```

---

# 36. Environment Resolver

实现：

```ts
interface EnvironmentResolver {
  resolve(
    bug: BugReport
  ): Promise<EnvironmentProfile>;
}
```

流程：

```text
BugReport
   │
executionTarget
   │
environmentProfileId?
   │
   ├── YES → 直接加载 Profile
   │
   └── NO
        │
        ▼
   根据配置匹配
```

如果存在多个 Profile 无法判断：

```text
BLOCK
```

不要让 Fixer Agent随意选择代码仓库。

---

# 37. Profile 选择方式

Bug Intake 可以生成建议：

```text
executionTarget = frontend
environmentProfileId = frontend-main
```

测试人员确认 Bug 时：

右侧 Draft 显示：

```text
执行环境：
Main Frontend
```

允许修改。

如果只有：

```text
一个 Frontend
一个 Backend
```

则可以自动映射。

---

# 38. Environment 准备责任

Orchestrator 负责：

```text
加载 Environment Profile
创建 Worktree
准备环境
启动 Runtime
执行 Health Check
```

Fixer Agent 负责：

```text
根据 Skill 和 Markdown
理解项目如何工作
```

不要让 Fixer Agent 自己决定：

```text
clone 哪个 repo
运行哪个基础 setup
应该 push 到哪个 remote
```

---

# 39. Frontend Environment

第一版 Frontend Profile 应支持：

```text
Node.js
pnpm/npm/yarn
TypeScript
Unit Test
Lint
Build
```

推荐预留：

```text
Playwright
```

接口。

因为即使 Text LLM 不支持图片：

Playwright 仍然可以提供：

```text
DOM
URL
Console
Network
HTTP Response
Element State
Browser Error
```

大量可验证信息。

---

# 40. Backend Environment

第一版 Backend Profile 应支持：

```text
启动服务
Health Check
API Request
Unit Test
Integration Test
Log
```

具体技术栈由 Markdown / Skill 描述。

例如：

```text
Java
Go
Node.js
Python
```

Environment Resolver 不应该硬编码语言逻辑。

---

# 41. Bug Intake System Prompt

核心：

```text
You are an internal software bug intake assistant.

Your job is to interview a software tester and produce
an engineering-quality BugReport that another coding
agent can use to investigate and fix the defect.

This environment has no Internet access.

Do not attempt to search the web.

Rules:

1. Extract information already provided.
2. Never ask again for information already answered.
3. Ask at most 3 questions per turn.
4. Prioritize reproduction information.
5. Separate actual behavior from expected behavior.
6. Identify whether the issue primarily belongs to
   frontend or backend.
7. If uncertain, ask the tester.
8. Never invent reproduction steps.
9. Never invent environment information.
10. Preserve exact errors where useful.
11. Distinguish facts from reporter hypotheses.
12. Encourage useful logs or HAR files when relevant.
13. Screenshots may be uploaded.
14. Never assume screenshots were understood unless
    image analysis results were explicitly provided.
15. If no image analysis provider is available, ask
    the tester to describe the important visual details.
16. Never request passwords, tokens, cookies,
    API keys or private credentials.
17. Allow the tester to answer "unknown".
18. Do not repeatedly ask for unavailable information.
19. Before submission, show the reconstructed report.
20. Submission requires tester confirmation.
```

---

# 42. Intake 每轮输出

LLM 返回严格 JSON：

```ts
interface IntakeTurnResult {
  fieldUpdates:
    DeepPartial<BugReport>;

  observations: string[];

  reporterHypotheses: string[];

  contradictions: {
    field: string;
    previousValue: unknown;
    newValue: unknown;
  }[];

  possibleSensitiveData: boolean;

  executionTargetConfidence:
    number;

  questions: {
    field: string;
    text: string;

    importance:
      | "critical"
      | "high"
      | "medium"
      | "low";
  }[];

  readyForConfirmation:
    boolean;
}
```

必须进行：

```text
Zod Validation
```

---

# 43. Conversation State

```ts
interface BugConversation {
  id: string;

  reporterId: string;

  status:
    | "active"
    | "awaiting_confirmation"
    | "submitted"
    | "abandoned";

  draft:
    Partial<BugReport>;

  completeness:
    CompletenessEvaluation;

  createdAt: string;

  updatedAt: string;
}
```

每轮：

```text
User Message
↓
Save Message
↓
Load Current Draft
↓
Load Recent Conversation
↓
Call Intake LLM
↓
Validate JSON
↓
Merge Draft
↓
Evaluate Completeness
↓
Persist
↓
Return Assistant Questions
```

---

# 44. 不依赖 LLM Memory

禁止：

```text
只把全部聊天记录传给 LLM
然后依赖模型记忆
```

必须传：

```text
Current Bug Draft
+
Relevant Conversation
+
Latest User Message
```

数据库中的结构化 Draft 才是事实源。

---

# 45. 信息完整度

```ts
interface CompletenessEvaluation {
  score: number;

  dimensions: {
    problem: number;
    reproduction: number;
    environment: number;
    evidence: number;
    impact: number;
  };

  missingCriticalInformation:
    string[];

  recommendedQuestions:
    string[];

  readyForSubmission:
    boolean;
}
```

评分建议：

```text
Problem           25
Reproduction      30
Environment       15
Evidence          20
Impact            10
```

---

# 46. Ready Threshold

建议：

```text
score >= 65
```

即可建议用户提交。

但是：

```text
不强制达到 65
```

如果测试人员确认：

仍然允许正式创建 Bug。

但是信息严重不足的 Bug：

```text
SUBMITTED
↓
NEEDS_INFO
```

而不是进入自动修复。

---

# 47. Submission Preview

提交前展示：

```text
Title

Execution Target

Environment Profile

Component

Actual Behavior

Expected Behavior

Reproduction

Frequency

Version

Environment

Error Messages

Evidence

Regression

Impact

Missing Information
```

按钮：

```text
[确认提交]

[继续补充]

[修改信息]

[取消]
```

---

# 48. 用户手动修正 Draft

右侧 Bug Draft 中：

结构化字段应该可以编辑。

例如：

```text
Execution Target:
frontend
```

如果错误：

测试人员可修改：

```text
backend
```

修改后：

```text
写入 Draft
```

下一轮 LLM 使用最新值。

---

# 49. 数据库表

SQLite 至少：

```text
users

bug_conversations

conversation_messages

bug_reports

bug_attachments

bug_events

jobs

agent_runs
```

---

# 50. jobs 表作为 Queue

不使用 Redis。

```text
jobs
```

字段：

```text
id
bug_id
status
priority
attempt
created_at
started_at
finished_at
heartbeat_at
error
```

状态：

```text
QUEUED
RUNNING
COMPLETED
FAILED
CANCELLED
```

---

# 51. Queue Worker

任何时间：

```text
最多一个 RUNNING
```

获取任务：

```sql
SELECT *
FROM jobs
WHERE status = 'QUEUED'
ORDER BY priority ASC, created_at ASC
LIMIT 1;
```

通过 SQLite Transaction 原子更新：

```text
QUEUED
→
RUNNING
```

---

# 52. Single Worker

MVP 严格：

```text
concurrency = 1
```

任何时候：

```text
BUG-101
↓
完成
↓
BUG-102
↓
完成
↓
BUG-103
```

禁止多个 Fixer 并行。

---

# 53. Global Lock

单机环境可以使用：

```text
Process Lock
+
SQLite Worker State
```

例如：

```text
data/orchestrator.lock
```

启动 Orchestrator 时尝试创建排他锁。

已有有效 Worker：

```text
直接拒绝第二个 Orchestrator
```

无需 Redis Distributed Lock。

---

# 54. Crash Recovery

Worker 启动时：

查询：

```text
RUNNING jobs
```

如果：

```text
heartbeat 超过阈值
```

标记：

```text
INTERRUPTED
```

然后根据配置：

```text
重新 QUEUE
```

或者：

```text
需要人工 Retry
```

MVP 默认：

```text
需要人工 Retry
```

避免重复消耗算力。

---

# 55. BugFixTask

Bug Submit 后生成：

```ts
interface BugFixTask {
  bugKey: string;

  title: string;

  executionTarget:
    | "frontend"
    | "backend";

  environmentProfileId: string;

  actualBehavior: string;

  expectedBehavior:
    | string
    | null;

  reproductionSteps:
    string[];

  prerequisites:
    string[];

  environment:
    Record<string, unknown>;

  errorMessages:
    string[];

  stackTraces:
    string[];

  attachments:
    AttachmentRef[];

  lastKnownGoodVersion:
    | string
    | null;

  failingVersion:
    | string
    | null;

  reporterObservations:
    string[];

  reporterHypotheses:
    string[];

  machineObservations:
    string[];

  missingInformation:
    string[];

  completenessScore:
    number;
}
```

---

# 56. Fixer 不默认读取完整聊天

默认提供：

```text
BugFixTask
+
附件
+
Environment Profile
+
Skill
+
相关 Markdown
```

不默认提供：

```text
整个 Conversation
```

避免模型 Context 污染。

可以保留工具：

```text
bug_get_conversation
```

供 Agent 在确实需要时读取。

---

# 57. Agent Environment Context

启动 Pi Agent 前：

Environment Resolver 加载：

```text
Environment Profile
+
Skill Files
+
Documentation
```

例如：

```text
BUG-123
↓
frontend-main
↓
.pi/skills/frontend-runtime/SKILL.md
↓
AGENTS.md
↓
docs/testing.md
↓
Pi Fixer
```

---

# 58. Git Worktree

每个 Bug：

```text
data/worktrees/BUG-000123/
```

Branch：

```text
ai/BUG-000123-login-loading
```

创建：

```bash
git fetch origin main

git worktree add \
  data/worktrees/BUG-000123 \
  -b ai/BUG-000123-login-loading \
  origin/main
```

---

# 59. 无公网依赖安装

Environment Template 必须考虑离线。

Frontend：

```text
pnpm install --offline
```

或者：

```text
node_modules 已预置
```

Backend：

可能使用：

```text
内部 Maven Registry
本地 Gradle Cache
内部 PyPI
本地 Go Module Cache
```

系统不得默认外网依赖可下载。

---

# 60. Environment Preparation

流程：

```text
Load Profile
↓
Prepare Worktree
↓
Load Skills
↓
Load Docs
↓
Execute Setup Commands
↓
Start Runtime if required
↓
Health Check
↓
ENV_READY
```

失败：

```text
ENVIRONMENT_FAILED
```

禁止直接进入 Fixer。

---

# 61. Fixer Agent

接口：

```ts
interface AgentRunner {
  runFixer(
    input: FixerInput
  ): Promise<AgentFixResult>;

  runReviewer(
    input: ReviewerInput
  ): Promise<ReviewResult>;
}
```

Pi SDK 必须封装在：

```text
pi-runner
```

业务逻辑不能直接依赖 Pi SDK。

---

# 62. Fixer Prompt 基本规则

```text
You are fixing exactly one internal software bug.

This environment has no Internet access.

Use only:

- provided bug context
- repository files
- local documentation
- configured skills
- installed dependencies
- local runtime
- local logs

Rules:

1. Work only inside the provided worktree.
2. Follow the Environment Profile.
3. Follow the provided Skills.
4. Read repository instructions before editing.
5. Reproduce the bug when practical.
6. Prefer a regression test.
7. Make the smallest safe change.
8. Do not modify unrelated code.
9. Do not weaken tests.
10. Do not download dependencies from the Internet.
11. Do not search the web.
12. Do not access production systems.
13. Do not deploy.
14. Do not push.
15. Do not merge.
16. Return structured result.
```

---

# 63. Agent Structured Result

保存：

```text
.agent/result.json
```

至少：

```ts
interface AgentFixResult {
  bugKey: string;

  status:
    | "fixed"
    | "blocked"
    | "not_reproducible"
    | "failed";

  confidence: number;

  summary: string;

  rootCause:
    | string
    | null;

  reproduced: boolean;

  regressionTestAdded: boolean;

  filesChanged: string[];

  riskNotes: string[];

  blockedReason:
    | string
    | null;

  missingInformation:
    string[];
}
```

必须 Zod 校验。

---

# 64. Deterministic Validation

根据 Environment Profile 执行：

```text
validationCommands
```

Frontend 可能：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Backend 可能：

```text
./gradlew test
```

或者：

```text
go test ./...
```

Orchestrator 自己执行。

不能相信：

```text
Agent 声称测试通过
```

---

# 65. Frontend Runtime Verification

如果 Profile 配置浏览器测试：

允许：

```text
Playwright
```

即使无 Vision LLM：

可以验证：

```text
DOM
Text
Visible State
URL
Console
Network
HTTP Response
Element State
```

第一版 Playwright 作为：

```text
可选能力
```

不是强制。

---

# 66. Independent Reviewer

Fixer 完成后：

创建新的 Pi Session。

Reviewer 输入：

```text
BugFixTask

Git Diff

Changed Files

Validation Result

Environment Profile
```

禁止传：

```text
Fixer 内部推理历史
```

---

# 67. Reviewer Gate

只有：

```text
verdict == approve

AND

bugAddressed == true

AND

regressionRisk != high
```

才允许：

```text
Commit
Push
```

---

# 68. Git 操作边界

Agent 禁止：

```text
git push
git merge
git force-push
git remote
```

Orchestrator 负责：

```text
Commit
Push
```

---

# 69. GitLab

私有 GitLab 只作为：

```text
Git Remote
```

不使用：

```text
GitLab REST API
GitLab GraphQL API
```

不创建：

```text
Merge Request
Comment
Approval
```

---

# 70. Git Push

Reviewer 通过后：

```bash
git push \
  -u origin \
  ai/BUG-000123-login-loading
```

Push 前：

```text
assert branch startsWith ai/
```

禁止：

```text
main
master
develop
release/*
```

---

# 71. GitLab Remote 安全

可配置：

```env
GIT_ALLOWED_REMOTE_HOST=gitlab.internal.company.com
```

Push 前：

```bash
git remote get-url origin
```

校验 remote host。

---

# 72. Push 后 Bug 状态

成功：

```text
READY_FOR_HUMAN_REVIEW
```

Bug Detail 显示：

```text
Branch:
ai/BUG-000123-login-loading

Commit:
abc1234

Validation:
PASS

Review:
APPROVED
```

不创建 MR。

---

# 73. Attachments 给 Fixer 的方式

文本附件：

```text
LOG
TXT
JSON
HAR
```

可以解析并提供：

```text
提取文本
+
原始文件路径
```

图片：

如果 Vision 可用：

```text
Vision Result
+
原始图片路径
```

如果 Vision 不可用：

```text
仅原始图片路径
+
测试人员描述
```

Text-only Fixer 不应声称读取了图片视觉内容。

---

# 74. Secret Detection

提交内容和附件解析后至少检测：

```text
Authorization:
Bearer

password=

Cookie:

API Key

Private Key

JWT

AWS Access Key
```

MVP 建议：

```text
落库之前 Redact
```

日志中同样必须脱敏。

---

# 75. Bug Dashboard

需要：

```text
Bug Key
Title
Frontend / Backend
Status
Completeness
Created Time
Fix Branch
```

例如：

```text
BUG-000123
Login loading forever
frontend
FIXING
88%
```

---

# 76. Bug Detail

显示：

```text
Summary

Execution Target

Environment Profile

Reproduction

Environment

Evidence

Attachments

Conversation

Completeness

Agent Status

Fix Result

Validation Result

Review Result

Git Branch
```

---

# 77. API

至少：

```text
POST
/api/bugs/conversations

POST
/api/bugs/conversations/:id/messages

POST
/api/bugs/conversations/:id/attachments

GET
/api/bugs/conversations/:id

PATCH
/api/bugs/conversations/:id/draft

POST
/api/bugs/conversations/:id/submit

GET
/api/bugs

GET
/api/bugs/:id

POST
/api/bugs/:id/retry

POST
/api/bugs/:id/cancel
```

---

# 78. Vision API 内部接口

如果配置：

```text
POST /internal/vision/analyze
```

但是业务层必须依赖：

```text
VisionProvider
```

不能直接耦合某个 Vision 模型。

---

# 79. Environment API

建议：

```text
GET /api/environments
```

返回：

```text
frontend-main
backend-main
```

用于 Bug Draft 选择。

---

# 80. Intake LLM Adapter

同样定义：

```ts
interface IntakeModel {
  complete(
    input: IntakeModelInput
  ): Promise<IntakeTurnResult>;
}
```

不能把系统绑定到某个特定 LLM Server。

配置例如：

```env
LLM_BASE_URL=http://llm.internal/v1
LLM_MODEL=xxx
```

---

# 81. Vision Provider 可选配置

```env
VISION_ENABLED=false

VISION_BASE_URL=
VISION_MODEL=
```

启动时：

```text
VISION_ENABLED=false
```

不要求 Vision 配置。

如果：

```text
VISION_ENABLED=true
```

但 Provider 不可访问：

记录 Warning。

Bug 平台本身仍然应该可以启动。

图片能力降级为：

```text
upload only
```

---

# 82. Environment Profile 不硬编码

增加新项目时：

不应该修改核心 TypeScript。

理想流程：

```text
添加 environments.yaml 配置
+
添加 Skill
+
添加 Markdown
```

即可。

例如未来：

```text
frontend-admin
frontend-user
backend-order
backend-auth
```

都通过模板扩展。

---

# 83. Environment Profile 示例目录

```text
environments/
├── frontend-main/
│   ├── ENVIRONMENT.md
│   └── TESTING.md
│
└── backend-main/
    ├── ENVIRONMENT.md
    └── TESTING.md
```

同时：

```text
.pi/skills/
├── frontend-runtime/
│   └── SKILL.md
│
├── frontend-testing/
│   └── SKILL.md
│
├── backend-runtime/
│   └── SKILL.md
│
└── backend-testing/
    └── SKILL.md
```

---

# 84. Environment Skill 与 Markdown 的定位

Skill：

```text
更偏 Agent 行为规则
```

例如：

```text
如何测试
允许做什么
禁止做什么
定位 Bug 的 SOP
```

Markdown：

```text
更偏项目事实
```

例如：

```text
端口
服务结构
启动命令
依赖
目录
内部架构说明
```

Environment Profile：

```text
更偏机器配置
```

例如：

```text
Repo
Branch
Commands
Health Check
```

三层职责：

```text
Profile
=
机器怎么运行

Markdown
=
项目是什么

Skill
=
Agent 应该怎么做
```

---

# 85. 推荐的最终 Context 组装

Fixer 启动时 Context：

```text
System Safety Rules

+

BugFixTask

+

Environment Profile

+

Environment Markdown

+

Pi Skills

+

Attachment Text / Vision Analysis
```

不要直接拼入：

```text
完整聊天历史
所有系统日志
无关项目文档
```

---

# 86. 第一阶段实施顺序

## Phase 1 — Project Bootstrap

完成：

```text
pnpm workspace
TypeScript
Zod
SQLite
Drizzle
Pino
Vitest
```

Acceptance：

```text
lint
typecheck
test
```

通过。

---

# 87. Phase 2 — Bug Domain

实现：

```text
BugReport
Bug Status
Conversation
Attachment
Job
Agent Run
```

以及 SQLite Schema。

---

# 88. Phase 3 — Bug Chat UI

实现：

```text
Chat UI

Bug Draft

Field Edit

Attachment Upload

Frontend / Backend Selection

Environment Profile Selection
```

先使用 Fake Intake Agent。

---

# 89. Phase 4 — Intake LLM

实现：

```text
IntakeModel Adapter

Prompt

Structured Output

Zod Validation

Field Merge

Contradiction Detection
```

---

# 90. Phase 5 — Adaptive Interview

实现：

```text
Core Questions

Frontend Questions

Backend Questions

API Questions

UI Questions

Crash Questions

Performance Questions
```

---

# 91. Phase 6 — Completeness

实现：

```text
Score

Missing Information

Ready Gate

Submission Preview
```

---

# 92. Phase 7 — Attachment

实现：

```text
Local Filesystem

File Metadata

Text Extraction

JSON

HAR

Secret Detection
```

---

# 93. Phase 8 — Optional Vision

实现：

```text
VisionProvider Interface

DisabledVisionProvider

HTTPVisionProvider
```

默认：

```text
DisabledVisionProvider
```

Acceptance：

无 Vision 配置时图片仍然可以正常上传和提交 Bug。

---

# 94. Phase 9 — Environment Profiles

实现：

```text
environments.yaml

EnvironmentProfile Schema

EnvironmentResolver

Frontend Template

Backend Template

Skill Loader

Markdown Loader
```

---

# 95. Phase 10 — SQLite Job Queue

实现：

```text
Job Table

Enqueue

Single Worker

Job Recovery

Global Process Lock
```

确认：

```text
最多一个 RUNNING job
```

---

# 96. Phase 11 — Repo Manager

实现：

```text
Fetch

Worktree

Branch

Diff

Commit

Push

Cleanup
```

---

# 97. Phase 12 — Environment Preparation

实现：

```text
Setup Commands

Runtime Start

Health Check

Timeout

Runtime Stop
```

---

# 98. Phase 13 — Pi Fixer

实现：

```text
Pi Adapter

Fixer Session

BugFixTask Context

Environment Skill Injection

Structured Result
```

---

# 99. Phase 14 — Validator

实现：

```text
Environment validation commands

Timeout

stdout

stderr

exit code

diff safety
```

---

# 100. Phase 15 — Reviewer

实现：

```text
Independent Session

Bug + Diff + Validation

Structured Review
```

---

# 101. Phase 16 — GitLab Push

实现：

```text
Commit

Safe Branch Check

Remote Host Check

Push ai/*
```

禁止 MR。

---

# 102. Phase 17 — Dashboard

实现：

```text
Bug List

Bug Detail

Conversation

Agent Progress

Validation

Review

Branch
```

---

# 103. Phase 18 — Hardening

实现：

```text
Crash Recovery

Timeout

Secret Redaction

Logging

Retry

Cleanup

Dry Run
```

---

# 104. Dry Run

配置：

```env
DRY_RUN=true
```

允许：

```text
Bug Intake

Queue

Worktree

Environment Setup

Pi Fixer

Validator

Reviewer

Diff
```

禁止：

```text
Git Push
```

建议 Dry Run 不 commit。

---

# 105. Agent Timeout

建议：

```text
Fixer:
45 minutes

Reviewer:
15 minutes

Environment Setup:
10 minutes

Whole Pipeline:
90 minutes
```

可配置。

---

# 106. Job Retry

MVP：

```text
Agent 失败不自动 Retry
```

允许人工点击：

```text
Retry
```

原因：

```text
单机算力有限
自动重复跑可能浪费大量资源
```

---

# 107. Result Artifact

每个 Bug：

```text
data/agent-results/BUG-000123/
```

保存：

```text
bug.json

fix-task.json

environment.json

agent-result.json

validation.json

review.json

diff.patch

git-result.json

pipeline.json
```

---

# 108. 核心安全边界

Intake Agent：

```text
只收集 Bug
```

Fixer Agent：

```text
可以修改 Worktree
不能 Push
不能 Merge
不能 Deploy
```

Reviewer：

```text
只读 Diff 和结果
```

Orchestrator：

```text
可以 Commit
可以 Push ai/*
不能 Merge
不能 Deploy
```

Human：

```text
Review
Merge
Deploy
```

---

# 109. 第一版 Definition of Done

必须满足：

```text
[ ] 单机运行

[ ] 使用 SQLite

[ ] 不依赖 PostgreSQL

[ ] 不依赖 Redis

[ ] 不依赖 MinIO

[ ] 不依赖公网

[ ] 测试人员通过自然语言提交 Bug

[ ] 有 Chat + Bug Draft UI

[ ] LLM 每轮最多追问 3 个问题

[ ] 能区分 Frontend / Backend

[ ] 可以手工修改 Frontend / Backend

[ ] 支持 Environment Profile

[ ] Environment Profile 可以通过配置扩展

[ ] 支持 Skill

[ ] 支持 Markdown Environment Documentation

[ ] Profile / Skill / Markdown 职责分离

[ ] 可以上传截图

[ ] 没有 Vision 模型时截图仍然可以正常上传

[ ] 没有 Vision 模型时系统不能声称识别了图片

[ ] 可以配置 Vision Provider

[ ] Vision Provider 是可选能力

[ ] 支持 Log

[ ] 支持 JSON

[ ] 支持 HAR

[ ] 支持 TXT

[ ] 可以检测 Secret

[ ] 可以提取结构化 BugReport

[ ] 可以计算 Completeness

[ ] 用户确认后才正式提交

[ ] 自动生成 BUG-xxxxxx

[ ] SQLite Job Queue

[ ] 严格单任务执行

[ ] Crash 后可以发现遗留 RUNNING Job

[ ] Environment Resolver 能找到执行模板

[ ] Frontend 有独立环境模板

[ ] Backend 有独立环境模板

[ ] Agent 可以加载对应 Skill

[ ] Agent 可以加载对应 Markdown

[ ] 可以创建 Git Worktree

[ ] Pi Fixer 处理单个 Bug

[ ] Fixer 不访问公网

[ ] Orchestrator 独立执行 Validation

[ ] Reviewer 使用独立 Pi Session

[ ] Validation Fail 不 Push

[ ] Reviewer Reject 不 Push

[ ] 只允许 Push ai/*

[ ] 可以 Push 私有 GitLab

[ ] 不调用 GitLab API

[ ] 不创建 Merge Request

[ ] 不自动 Merge

[ ] 不自动 Deploy

[ ] Bug Detail 可以查看 Branch 和 Commit

[ ] 支持 DRY_RUN
```

---

# 110. 最终技术架构

```text
                       Browser
                          │
                          ▼
                  Bug Web / API
                          │
            ┌─────────────┴─────────────┐
            │                           │
            ▼                           ▼
       Intake LLM                  Attachments
       Text Model                  Local Files
            │                           │
            │                 ┌─────────┴─────────┐
            │                 │                   │
            │                OCR             VisionProvider
            │              optional             optional
            │                 │                   │
            └─────────────────┴─────────┬─────────┘
                                       ▼
                                Structured Bug
                                       │
                                     SQLite
                                       │
                                    Job Queue
                                       │
                                Single Worker
                                       │
                              EnvironmentResolver
                                       │
                         ┌─────────────┴────────────┐
                         │                          │
                    Frontend                     Backend
                     Profile                     Profile
                         │                          │
                     Skill + MD                 Skill + MD
                         │                          │
                         └─────────────┬────────────┘
                                       ▼
                                   Pi Fixer
                                       │
                                   Validator
                                       │
                                   Reviewer
                                       │
                                   Git Commit
                                       │
                                GitLab ai/* Push
                                       │
                                       ▼
                              Human Review / Merge
```

---

# 111. 最终设计原则

整个系统保持：

```text
SQLite
=
唯一业务数据库

Local Filesystem
=
附件与运行产物

Intake LLM
=
Bug 信息采访员

Vision Provider
=
可插拔图片理解能力

Environment Profile
=
机器如何运行项目

Markdown
=
项目环境事实

Pi Skill
=
Agent 如何操作项目

Environment Resolver
=
选择执行环境

SQLite Job Queue
=
单任务任务队列

Pi Fixer
=
代码修复

Validator
=
确定性验证

Reviewer
=
独立语义审查

GitLab ai/* Branch
=
自动化交付终点

Human
=
最终 Merge 权限
```

最重要的两个扩展边界：

```text
图片能力：

Upload
永远存在

Vision
可选
```

以及：

```text
执行环境：

核心代码Qwen3.8-27B_IQ3
不理解具体项目

Environment Profile
+
Skill
+
Markdown

定义项目如何运行
```

这样以后增加新的项目、新的前端、新的后端，原则上都不需要修改 Orchestrator 核心逻辑。

---

# 112. Codex 实施规则

Codex 必须严格遵守：

1. 按 Phase 顺序实施。
2. 每完成一个 Phase 运行相关测试。
3. 测试失败不得进入下一 Phase。
4. 不引入 PostgreSQL。
5. 不引入 Redis。
6. 不引入 MinIO。
7. SQLite 是唯一业务数据库。
8. 附件保存本地文件系统。
9. 所有 LLM 必须通过 Adapter。
10. Vision 必须通过可选 Provider。
11. 无 Vision 时系统必须正常运行。
12. 无公网能力必须作为默认前提。
13. 不实现 Web Search。
14. 不从公网动态下载运行依赖。
15. Frontend / Backend 环境必须模板化。
16. 环境配置必须支持 Skill。
17. 环境配置必须支持 Markdown 文档。
18. 核心代码不得硬编码具体项目运行方式。
19. Queue 使用 SQLite。
20. Worker 并发永远为 1。
21. Pi SDK 必须封装在 `pi-runner`。
22. Fixer 一次只处理一个 Bug。
23. Agent 不允许 Push。
24. Agent 不允许 Merge。
25. Agent 不允许 Deploy。
26. Orchestrator 只能 Push `ai/*`。
27. 不调用 GitLab API。
28. 不创建 Merge Request。
29. 不自动 Merge。
30. 所有 Agent 输出必须使用结构化 Schema 校验。
31. Agent 声称测试成功不能作为 Validation 依据。
32. Validation 必须由 Orchestrator 独立执行。
33. Reviewer 必须使用新的 Agent Session。
34. 任何 Secret 不得出现在日志。
35. 所有外部命令必须有 Timeout 和 Exit Code 检查。
36. Environment Profile、Markdown、Skill 必须保持职责分离。
37. 新增项目环境应优先通过配置和文档完成，而不是修改 Orchestrator 核心代码。
