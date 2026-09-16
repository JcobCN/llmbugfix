# LLM Bugfix REST API v1：Agent 接入文档

本文面向调用 LLM Bugfix Gateway 的自动化 Agent。契约基于提交
`8767d91e8b2795e537b0897da634821344d74b6f`，用于提交异步 Bug 修复或开发任务、跟踪进度并读取结构化结果。

服务同时提供机器可读的 OpenAPI 3.1 契约：

```http
GET /openapi.json
```

## 1. 接入约定

- 默认地址：`http://127.0.0.1:8033`。实际部署地址和端口以运行环境为准。
- API 前缀：`/api/v1`。
- 请求和响应使用 JSON；提交任务时应发送 `Content-Type: application/json`。
- 当前版本没有鉴权、限流、Webhook 或 SSE。不要将未鉴权的服务直接暴露到不可信网络。
- 任务是异步执行的。`POST /tasks` 只持久化并入队，不会在该 HTTP 请求中等待 clone、LLM、测试或 push。
- 所有资源 ID 都是 UUID；所有时间都是带时区的 ISO 8601 字符串。
- 创建请求采用严格 schema：除 `environment` 的内部键值外，未声明字段会被拒绝。
- 仓库 URL、任务描述、错误信息中不得放置 Token、密码、Cookie、API Key 或私钥。

端点总览：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/tasks` | 创建异步任务 |
| `GET` | `/api/v1/tasks` | 分页列出任务 |
| `GET` | `/api/v1/tasks/{taskId}` | 查询任务当前状态 |
| `GET` | `/api/v1/tasks/{taskId}/events` | 增量读取任务事件 |
| `GET` | `/api/v1/tasks/{taskId}/result` | 读取终态结果 |
| `POST` | `/api/v1/tasks/{taskId}/cancel` | 取消排队中或运行中的任务 |
| `POST` | `/api/v1/tasks/{taskId}/retry` | 重试失败任务 |
| `GET` | `/api/v1/capabilities` | 查询后端能力和健康状态 |
| `GET` | `/openapi.json` | 获取完整 OpenAPI 3.1 文档 |

## 2. Agent 推荐调用流程

1. 可选调用 `GET /api/v1/capabilities`，确认存在满足任务类型、执行目标、质量等级和能力提示的可用后端。
2. 为一次逻辑提交生成稳定且唯一的 `Idempotency-Key`，并在网络超时重试时复用同一个 key 和同一份请求数据。
3. 调用 `POST /api/v1/tasks`，保存响应中的 `taskId`、`links` 和 `Location`。
4. 使用 `/events?after=<sequence>` 增量获取事件，或使用任务详情轮询当前状态。建议指数退避并设置最大间隔，不要高频空轮询。
5. 当任务状态为 `succeeded`、`failed` 或 `cancelled` 时，调用 `/result` 获取结构化终态结果。
6. 只有在 `failed` 状态下才可显式调用 `/retry`；不要自动无限重试。

必须按 HTTP 状态码判断 `/result`：`202` 表示尚未完成，`200` 才表示已返回终态结果。

## 3. 创建任务

```http
POST /api/v1/tasks
Content-Type: application/json
Idempotency-Key: <1 至 200 字符的稳定键>
```

`Idempotency-Key` 必填，不得包含 CR/LF。键建议包含调用方、业务对象和操作，例如
`agent-a:issue-1842:fix:v1`。

- 同一个 key 和相同语义的请求再次提交：返回原任务，`idempotent: true`。
- 同一个 key 对应不同请求：返回 `409 IDEMPOTENCY_CONFLICT`。
- JSON 对象字段顺序不影响幂等判断。
- 若请求是否成功未知，例如客户端在收到响应前超时，应原样重试，不要生成新 key。

### 3.1 公共字段

| 字段 | 必填 | 类型/约束 | 说明 |
| --- | --- | --- | --- |
| `taskType` | 是 | `bugfix` \| `development` | 任务类型 |
| `title` | 是 | 非空字符串，最多 500 字符 | 简明任务标题 |
| `executionTarget` | 是 | `frontend` \| `backend` | 执行目标 |
| `repository` | 是 | object | Git 仓库信息 |
| `repository.cloneUrl` | 是 | 字符串，最多 2048 字符 | HTTP(S)、`ssh://` 或 scp 风格 SSH remote |
| `repository.baseBranch` | 否 | 合法 Git 分支名，最多 255 字符 | 默认 `main` |
| `routing` | 否 | object | 调度要求；省略时使用默认值 |
| `routing.priority` | 否 | `high` \| `normal` \| `low` | 默认 `normal` |
| `routing.capabilityHints` | 否 | 最多 16 个规范化标签 | 默认 `[]`；格式 `^[a-z0-9][a-z0-9+._-]*$`，单项最多 64 字符 |
| `routing.quality` | 否 | `standard` \| `high` | 默认 `standard` |

仓库约束：

- 支持 `https://host/group/repo.git`、`http://...`、`ssh://git@host/group/repo.git` 和 `git@host:group/repo.git`。
- 拒绝本地路径、`file://`、HTTP(S) URL 内嵌用户名/密码、SSH 密码和缺少仓库路径的 URL。
- 部署方可能配置仓库 host allow-list；不在白名单中的地址返回 `REPOSITORY_HOST_NOT_ALLOWED`。
- `baseBranch` 不能以 `-` 开头，不能包含空白、控制字符、`..`、`@{`、`//` 或 Git ref 禁止字符。

### 3.2 Bug 修复任务

除公共字段外还需要：

| 字段 | 必填 | 类型/约束 |
| --- | --- | --- |
| `actualBehavior` | 是 | 非空字符串，最多 50000 字符 |
| `expectedBehavior` | 是 | 非空字符串，最多 50000 字符 |
| `reproductionSteps` | 是 | 1 至 100 项；每项非空且最多 10000 字符 |
| `errorMessages` | 否 | 最多 100 项；每项最多 50000 字符 |
| `stackTraces` | 否 | 最多 100 项；每项最多 50000 字符 |
| `environment` | 否 | 任意 JSON object，用于补充版本、浏览器等环境事实 |

示例：

```json
{
  "taskType": "bugfix",
  "title": "修复登录按钮点击无响应",
  "executionTarget": "frontend",
  "repository": {
    "cloneUrl": "https://git.example.test/team/project.git",
    "baseBranch": "main"
  },
  "actualBehavior": "点击登录按钮后页面无响应，控制台出现 TypeError。",
  "expectedBehavior": "登录成功后进入首页。",
  "reproductionSteps": [
    "打开登录页",
    "输入有效账号和密码",
    "点击登录按钮"
  ],
  "errorMessages": ["TypeError: handler is undefined"],
  "stackTraces": ["at submit (src/login.ts:10:2)"],
  "environment": {
    "browser": "Chromium 128",
    "appVersion": "2.4.1"
  },
  "routing": {
    "priority": "high",
    "capabilityHints": ["typescript", "react.ui"],
    "quality": "high"
  }
}
```

### 3.3 开发任务

除公共字段外还需要：

| 字段 | 必填 | 类型/约束 |
| --- | --- | --- |
| `objective` | 是 | 非空字符串，最多 50000 字符 |
| `requirements` | 是 | 1 至 100 项；每项非空且最多 10000 字符 |
| `acceptanceCriteria` | 是 | 1 至 100 项；每项非空且最多 10000 字符 |
| `constraints` | 否 | 最多 100 项；每项最多 10000 字符 |
| `nonGoals` | 否 | 最多 100 项；每项最多 10000 字符 |

示例：

```json
{
  "taskType": "development",
  "title": "增加 CSV 导出接口",
  "executionTarget": "backend",
  "repository": {
    "cloneUrl": "git@git.example.test:team/project.git"
  },
  "objective": "将当前筛选结果导出为 CSV。",
  "requirements": [
    "沿用当前列表筛选条件",
    "正确转义逗号、双引号和换行"
  ],
  "acceptanceCriteria": [
    "下载文件可被标准 CSV 解析器读取",
    "导出数据与当前筛选结果一致"
  ],
  "constraints": ["不得改变现有 JSON 接口行为"],
  "nonGoals": ["不提供电子表格样式"],
  "routing": {
    "priority": "normal",
    "capabilityHints": ["typescript"],
    "quality": "standard"
  }
}
```

### 3.4 成功响应

返回 `202 Accepted`，并设置：

```http
Location: /api/v1/tasks/550e8400-e29b-41d4-a716-446655440000
```

响应体：

```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "taskKey": "BUG-000123",
  "taskType": "bugfix",
  "title": "修复登录按钮点击无响应",
  "executionTarget": "frontend",
  "status": "queued",
  "stage": "queued",
  "createdAt": "2026-09-16T02:30:00.000Z",
  "updatedAt": "2026-09-16T02:30:00.000Z",
  "links": {
    "self": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000",
    "events": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/events",
    "result": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/result"
  },
  "idempotent": false
}
```

`taskKey` 是便于人工识别的 `BUG-` 编号；后续 REST 路径应使用 UUID 格式的 `taskId`。

## 4. 查询任务

```http
GET /api/v1/tasks/{taskId}
```

成功返回 `200` 和任务资源。任务资源字段与创建响应相同，但不包含 `idempotent`。

### 状态与阶段

`status` 是 Agent 判断生命周期的稳定字段：

| `status` | 含义 | 是否终态 |
| --- | --- | --- |
| `queued` | 已受理，等待调度或准备执行 | 否 |
| `running` | 正在执行某个流水线阶段 | 否 |
| `succeeded` | 已完成，可读取结果 | 是 |
| `failed` | 执行失败，可人工决定是否重试 | 是 |
| `cancelled` | 已取消 | 是 |

`stage` 提供更细进度：

`queued`、`preparing_environment`、`fixing`、`validating`、`reviewing`、`pushing`、`ready`、`human_review`、`failed`、`cancelled`。

Agent 应以 `status` 判断终态，以 `stage` 展示进度；不要自行从阶段推断新的状态。

## 5. 列出任务

```http
GET /api/v1/tasks?status=running&taskType=bugfix&limit=20&cursor=<opaque>
```

查询参数：

| 参数 | 约束 | 默认值 |
| --- | --- | --- |
| `status` | `queued`、`running`、`succeeded`、`failed`、`cancelled` | 不筛选 |
| `taskType` | `bugfix`、`development` | 不筛选 |
| `limit` | 1 至 100 的整数 | 20 |
| `cursor` | 服务端返回的不透明字符串 | 无 |

响应：

```json
{
  "data": [
    {
      "taskId": "550e8400-e29b-41d4-a716-446655440000",
      "taskKey": "BUG-000123",
      "taskType": "bugfix",
      "title": "修复登录按钮点击无响应",
      "executionTarget": "frontend",
      "status": "running",
      "stage": "validating",
      "createdAt": "2026-09-16T02:30:00.000Z",
      "updatedAt": "2026-09-16T02:34:00.000Z",
      "links": {
        "self": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000",
        "events": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/events",
        "result": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/result"
      }
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIuLi4ifQ",
  "hasMore": true
}
```

分页规则：

- `hasMore: true` 时，把 `nextCursor` 原样传给下一次请求。
- cursor 与生成它时的 `status`、`taskType` 筛选条件绑定；更改筛选条件后必须从第一页重新查询。
- 不要解析、修改或长期构造 cursor。
- `hasMore: false` 时 `nextCursor` 为 `null`。

## 6. 增量读取事件

```http
GET /api/v1/tasks/{taskId}/events?after=0&limit=100
```

| 参数 | 约束 | 默认值 |
| --- | --- | --- |
| `after` | 大于等于 0 的安全整数，只返回 `sequence > after` 的事件 | 0 |
| `limit` | 1 至 100 的整数 | 20 |

响应：

```json
{
  "data": [
    {
      "eventId": "9ab0dcb5-0fc8-49bf-8e42-61ef0a93ccea",
      "sequence": 7,
      "taskId": "550e8400-e29b-41d4-a716-446655440000",
      "type": "task.stage_changed",
      "status": "running",
      "stage": "validating",
      "occurredAt": "2026-09-16T02:34:00.000Z",
      "data": {}
    }
  ],
  "nextAfter": 7,
  "hasMore": false
}
```

事件类型：

- `task.created`
- `task.queued`
- `task.started`
- `task.stage_changed`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.retry_requested`

游标规则：

- 每次成功读取后，将本地 `after` 更新为非空的 `nextAfter`。
- `hasMore: true` 表示还有事件可立即继续拉取。
- 没有新事件时 `data` 为空；保留当前游标并退避后再查。
- 事件的 `data` 是扩展对象。Agent 不应依赖未在本文或 OpenAPI 中定义的内部键。

## 7. 获取任务结果

```http
GET /api/v1/tasks/{taskId}/result
```

### 7.1 未完成：`202 Accepted`

```json
{
  "task": {
    "taskId": "550e8400-e29b-41d4-a716-446655440000",
    "taskKey": "BUG-000123",
    "taskType": "bugfix",
    "title": "修复登录按钮点击无响应",
    "executionTarget": "frontend",
    "status": "running",
    "stage": "fixing",
    "createdAt": "2026-09-16T02:30:00.000Z",
    "updatedAt": "2026-09-16T02:32:00.000Z",
    "links": {
      "self": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000",
      "events": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/events",
      "result": "/api/v1/tasks/550e8400-e29b-41d4-a716-446655440000/result"
    }
  },
  "result": null
}
```

### 7.2 已完成：`200 OK`

```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "succeeded",
  "completedAt": "2026-09-16T02:40:00.000Z",
  "fix": {
    "status": "fixed",
    "confidence": 0.93,
    "summary": "修复了登录提交处理器绑定。",
    "rootCause": "组件重构后事件处理器引用失效。",
    "filesChanged": ["LoginForm.tsx", "LoginForm.test.tsx"],
    "riskNotes": ["需关注旧版浏览器的提交流程。"]
  },
  "validation": {
    "passed": true,
    "summary": "定向测试通过。",
    "commands": ["pnpm test --filter login"],
    "results": [
      {
        "command": "pnpm test --filter login",
        "exitCode": 0,
        "passed": true,
        "output": "1 test passed"
      }
    ]
  },
  "review": {
    "verdict": "approve",
    "addressed": true,
    "regressionRisk": "low",
    "summary": "变更范围集中，未发现阻塞问题。",
    "findings": []
  },
  "delivery": {
    "type": "patch",
    "pushed": false,
    "branch": null,
    "commitSha": null,
    "diff": "@@ ..."
  },
  "error": null
}
```

结果说明：

- `status` 只能是 `succeeded`、`failed` 或 `cancelled`。
- `fix`、`validation`、`review`、`delivery`、`error` 都可能为 `null`，Agent 必须做空值处理。
- `fix.status`：`fixed`、`blocked`、`not_reproducible`、`failed` 或开发任务使用的 `completed`。
- `fix.confidence` 范围为 0 至 1。
- `review.verdict`：`approve` 或 `reject`；`regressionRisk`：`low`、`medium` 或 `high`。
- dry-run 成功时，`delivery.type` 为 `patch`，`pushed: false`，分支和提交 SHA 为 `null`。
- 实际推送成功时，`delivery.type` 为 `git_branch`，`pushed: true`，并返回 `branch` 和 `commitSha`。
- 失败结果通常通过 `error.code` 和 `error.message` 描述原因；不要从自然语言摘要猜测机器状态。
- 结果会过滤模型原始输出、服务端绝对路径、内部 endpoint 和凭据，不应期待这些信息存在。

## 8. 取消与重试

### 8.1 取消

```http
POST /api/v1/tasks/{taskId}/cancel
```

- 仅 `queued` 或 `running` 任务可请求取消。
- 成功返回 `200` 和更新后的任务资源，通常为 `status: cancelled`、`stage: cancelled`。
- 已终止或当前阶段无法安全取消时返回 `409 TASK_NOT_CANCELLABLE`。
- 请求体可省略。

### 8.2 重试

```http
POST /api/v1/tasks/{taskId}/retry
```

- 仅 `failed` 任务可重试；`succeeded` 和 `cancelled` 不能通过此接口重试。
- 成功返回 `202` 和已重新排队的任务资源。
- 状态不允许或底层任务无法重新入队时返回 `409 TASK_NOT_RETRYABLE`。
- 重试沿用同一个 `taskId`，后续继续读取该任务的详情、事件和结果。
- 请求体可省略。

## 9. 查询后端能力

```http
GET /api/v1/capabilities
```

示例：

```json
{
  "dispatcher": {
    "loaded": true,
    "backendCount": 1,
    "health": [
      {
        "backendId": "primary",
        "status": "closed",
        "consecutiveFailures": 0,
        "openedAt": null,
        "retryAt": null,
        "inFlight": 0
      }
    ]
  },
  "capabilities": [
    {
      "id": "primary",
      "roles": ["intake", "fixer", "reviewer"],
      "taskTypes": ["bugfix", "development"],
      "targets": ["frontend", "backend"],
      "capabilities": ["typescript", "react.ui"],
      "qualityTiers": ["standard", "high"],
      "maxConcurrency": 2,
      "enabled": true,
      "draining": false,
      "status": "closed"
    }
  ]
}
```

`status` 是断路器状态：`closed` 表示正常闭合、可用，`open` 表示暂时阻断，`half_open` 表示正在探测恢复。Agent 选择能力时还应检查：

- `enabled` 必须为 `true`；
- `draining` 应为 `false`；
- `taskTypes` 包含目标任务类型；
- `targets` 包含 `executionTarget`；
- `qualityTiers` 包含请求质量等级；
- `capabilities` 覆盖请求的全部 `capabilityHints`。

`dispatcher` 在未接入调度器的嵌入式部署中可能省略，Agent 必须允许响应只包含
`{"capabilities":[]}`。能力列表为空表示当前没有对外声明可用后端。能力状态可能随时间变化，不能把该响应永久缓存。
该接口只用于发现能力；提交任务时不能指定后端 ID，`routing` 仅表达要求，由服务端选择实际后端。

## 10. 错误格式与处理建议

v1 API 的错误统一为：

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request does not satisfy the external task contract",
    "details": {
      "issues": [
        {
          "path": ["title"],
          "message": "Too small: expected string to have >=1 characters"
        }
      ]
    }
  },
  "requestId": "df4dd78d-09de-4100-b39a-d70e937d905c"
}
```

`details` 可省略。记录问题时应保留 `requestId`，但不要在日志中附带敏感请求内容。

| HTTP | `error.code` | 含义与 Agent 动作 |
| --- | --- | --- |
| 400 | `INVALID_JSON` | JSON 语法错误；修正序列化逻辑后再提交 |
| 400 | `INVALID_REQUEST` | 字段、枚举、长度、分页参数等不符合契约；读取 `details.issues` 修正请求 |
| 400 | `MISSING_IDEMPOTENCY_KEY` | 缺少幂等键；生成稳定 key 后重试 |
| 400 | `INVALID_IDEMPOTENCY_KEY` | key 为空、过长或含换行；修正后重试 |
| 400 | `INVALID_CURSOR` | cursor 无效或与筛选条件不匹配；从第一页重新获取 |
| 400 | `REPOSITORY_URL_INVALID` | 仓库对象或 URL 不合法；改用允许的远程 Git URL |
| 400 | `REPOSITORY_HOST_NOT_ALLOWED` | host 不在部署白名单；不要绕过，交由运维配置或改用批准仓库 |
| 400 | `INVALID_BASE_BRANCH` | 分支名不符合 Git ref 规则；修正分支名 |
| 404 | `TASK_NOT_FOUND` | `taskId` 不存在；停止轮询并检查持久化的 ID |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一 key 被用于不同请求；不要盲目换 key，应先确认原任务和业务意图 |
| 409 | `TASK_NOT_CANCELLABLE` | 当前状态或阶段不可取消；重新查询任务状态 |
| 409 | `TASK_NOT_RETRYABLE` | 任务不是失败态或无法重新入队；重新查询并人工处理 |
| 503 | `QUEUE_UNAVAILABLE` | 队列或数据库暂时不可用；使用同一 key 和相同请求进行有限退避重试 |
| 500 | `INTERNAL_ERROR` | 服务端内部错误；有限退避重试，持续失败时携带 `requestId` 上报 |

不支持的方法返回 `405`；不存在的 v1 路由返回 `404`。两者的错误码均为 `INVALID_REQUEST`。

建议只对网络错误、`503` 和少量 `500` 做有上限的指数退避；不要自动重试确定性的 `400`/`409`。创建请求的任何安全重试都必须复用原 `Idempotency-Key` 和原请求语义。

## 11. 最小 curl 示例

```bash
BASE_URL=http://127.0.0.1:8033

curl -i -X POST "$BASE_URL/api/v1/tasks" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: agent-a:issue-1842:fix:v1' \
  --data '{
    "taskType":"bugfix",
    "title":"修复登录按钮",
    "executionTarget":"frontend",
    "repository":{"cloneUrl":"https://git.example.test/team/project.git","baseBranch":"main"},
    "actualBehavior":"点击后无响应",
    "expectedBehavior":"进入首页",
    "reproductionSteps":["打开登录页","点击登录"]
  }'

curl "$BASE_URL/api/v1/tasks/<taskId>"
curl "$BASE_URL/api/v1/tasks/<taskId>/events?after=0&limit=100"
curl "$BASE_URL/api/v1/tasks/<taskId>/result"
```

## 12. Agent 实现检查清单

- 为每次逻辑创建持久化一个幂等键，超时重试时不换 key。
- 区分 `taskId`（API 路径 UUID）和 `taskKey`（人工可读编号）。
- 对创建请求只发送契约字段，并在客户端先校验枚举和数组长度。
- 不解析列表 cursor；事件只使用服务返回的 `nextAfter`。
- 对轮询做退避，并在三种终态后停止常规状态轮询。
- 根据 `/result` 的 HTTP `202/200` 分支解析不同响应体。
- 对结果中的五个可空字段做空值处理。
- 不自动无限 retry，不尝试绕过仓库 host 白名单。
- 日志中保留 `requestId`、`taskId` 和状态码，但对仓库凭据和任务内容做脱敏。
- 启动时或契约升级后读取 `/openapi.json`；若本文与运行中服务不一致，以该部署返回的 OpenAPI 和实际状态码为准。
