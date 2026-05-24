# Auraxis 智能客服助手架构设计

## 1. 项目定位

Auraxis 是一个可嵌入业务前端的智能客服助手运行时。第一版只面向 Vue 系统，目标是先完成一个可安装、可对话、可识别意图并调用受控工具的最小闭环。

长期目标仍然是 AI Assistant Runtime，但第一版不做通用前端 SDK、截图、工单、MCP、数据修改和完整运营后台。

第一版核心目标：

- Vue 项目可以快速安装并挂载助手组件。
- 用户在原系统登录后，助手能识别不同用户并隔离会话。
- 助手支持 DeepSeek 流式对话。
- 助手能识别一个测试意图，调用一个后端注册的示例脚本工具，并把结果返回给用户。
- 所有模型请求、工具调用和关键错误都有日志，方便调试。

系统边界：

- 前端 Widget 只负责交互展示，不做复杂 AI 编排。
- DeepSeek 只负责推理和语言生成，不直接访问数据库或执行业务动作。
- 工具执行权永远在 Auraxis Gateway 后端，不交给模型。
- 第一版工具只允许只读或测试类动作，不做 create_ticket、数据修改、批量操作和删除。

## 2. 外部架构参考与取舍

当前主流 agent 架构的共同点不是“让模型完全自治”，而是把模型放进一个可控运行时里：有明确状态、有工具权限、有审计、有失败恢复边界。

参考资料：

- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 强调先使用简单、可组合的 workflow，只有在确实需要模型动态决策时再增加 agent 复杂度。
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) 的关键经验是：子代理要职责单一，并且每个代理只给必要工具权限。
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions) 的关键经验是：工具调用需要 allow / deny / runtime approval 这类权限闸门。
- [LangGraph durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution) 的关键经验是：长流程和人工确认需要 checkpoint、thread_id、幂等和可恢复执行。
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/) 的关键经验是：LLM 调用、工具调用、handoff、guardrail 都应该能 trace。
- [OpenAI Agents SDK guardrails](https://openai.github.io/openai-agents-python/guardrails/) 的关键经验是：输入、输出、工具调用都可以有 guardrail，工具 guardrail 应该贴近每个工具本身。
- [Model Context Protocol](https://github.com/modelcontextprotocol/modelcontextprotocol) 适合作为后续连接外部工具和系统的标准协议，但不应成为第一版的核心复杂度。
- [DeepSeek API Docs](https://api-docs.deepseek.com/) 当前支持 OpenAI/Anthropic 兼容 API。DeepSeek 文档显示 `deepseek-chat` 和 `deepseek-reasoner` 将在 2026-07-24 废弃，第一版不要硬编码旧模型名，默认用可配置的 `deepseek-v4-flash` 或 `deepseek-v4-pro`。

对 Auraxis 的取舍：

- 第一版采用“受控 agentic workflow”，不是全自治 agent。
- 不引入大型 agent framework 作为核心依赖，先用清晰的自研 Orchestrator 实现可观测、可调试的最小闭环。
- 借鉴 LangGraph 的状态/trace/checkpoint 思路，但第一版只实现轻量状态表和 trace_id，不做复杂图执行引擎。
- 借鉴 Claude Code 的权限模型：模型可以提出工具候选，最终执行必须经过后端 policy gate。
- MCP 作为第二阶段之后的工具接入方式，第一版只实现 Internal Tool Runtime 和一个注册脚本工具。

## 3. 技术栈决策

推荐第一版技术栈：

- 前端：Vue 3 + Vite + TypeScript。
- 包管理：bun。
- 后端：Node.js 22 + TypeScript + Fastify。
- 数据库：PostgreSQL。
- ORM / SQL：Drizzle ORM。
- 流式输出：SSE 优先，WebSocket 后续按需要补。
- LLM：DeepSeek Chat Completions，通过 `ModelProvider` 适配层访问。
- Schema：Zod 作为代码内校验源，必要时导出 JSON Schema 给工具注册和模型工具描述。
- 本地开发：docker-compose，数据库数据用 bind mount，不用 docker volume。

选型理由：

- Vue 前端和 Gateway 后端都用 TypeScript，减少上下文切换。
- Fastify 足够轻，适合流式接口、插件化中间件和 schema 校验。
- Drizzle 比完整重型 ORM 更贴近 SQL，后续排查权限、会话、工具调用日志会更直接。
- 第一版流程简单，直接调用 DeepSeek API 比引入 LangGraph / Agents SDK 更容易调试。

暂不选择：

- Python + FastAPI + LangGraph：适合复杂长流程，但第一版会增加语言栈和框架复杂度。
- NestJS：结构强，但第一版偏重，容易提前引入过多模块边界。
- 完整 MCP Runtime：方向正确，但第一版只需要验证一个内置脚本工具。

## 4. 总体架构

```text
原有 Vue 业务系统
  ↓
@auraxis/vue 组件
  ↓
Auraxis Gateway API / SSE
  ↓
Auth & App Resolver
  ↓
Conversation Service
  ↓
Agent Orchestrator
  ├── Router: 意图识别
  ├── Policy Gate: 工具权限和风险校验
  ├── Tool Runtime: 内置工具 / 注册脚本
  ├── Model Provider: DeepSeek
  └── Trace Logger: 消息、工具、错误、耗时
  ↓
PostgreSQL / 业务 API / 受控脚本
```

Agent Orchestrator 第一版固定流程：

1. 读取 app、用户、会话和页面上下文。
2. 写入用户 Message。
3. 规则预判是否命中测试脚本意图。
4. 未命中时调用 DeepSeek Router，要求输出结构化 JSON。
5. Router 给出 intent、confidence、candidate_tools。
6. Policy Gate 校验 app 是否启用该工具、用户是否有权限、工具风险等级是否允许。
7. Tool Runtime 执行工具，记录 ToolCall。
8. Response Composer 调用 DeepSeek 生成面向用户的回复，或直接把工具结果格式化返回。
9. 通过 SSE 返回流式内容。
10. 写入 assistant Message 和 trace。

第一版不做多代理并行。后续可以拆出 Router Agent、Tool Agent、Summary Agent、Support Analyst Agent，但每个代理必须有独立 prompt、工具权限和 trace。

## 5. 前端接入设计

### 5.1 第一版只支持 Vue

第一版只提供 Vue 组件包：

```vue
<template>
  <AuraxisAssistant
    app-id="clinical-report"
    :get-auth-token="getAuraxisToken"
    :page-context="pageContext"
    position="bottom-right"
  />
</template>
```

宿主系统需要提供 `getAuraxisToken`：

```ts
async function getAuraxisToken() {
  const res = await fetch('/api/auraxis/token')
  return await res.text()
}
```

后续阶段再考虑：

- Web Component。
- iframe 模式。
- React 包。
- CDN 方式 JS SDK。

### 5.2 前端 Widget 责任边界

第一版能力：

- 聊天气泡与聊天窗口。
- 文本输入。
- SSE 流式接收回复。
- Markdown 文本展示。
- 当前页面 URL、标题、路由参数和业务页面上下文透传。
- 会话列表最小能力：当前用户能恢复自己的最近会话。

第一版不做：

- 截图。
- 附件上传。
- 表单确认卡片。
- 工单卡片。
- 复杂后台客服工作台。

## 6. 鉴权与原系统账号关系

鉴权本质上是 Auraxis 和原有业务系统之间确认“当前使用助手的人是谁、属于哪个应用、拥有哪些权限”。

第一版不要求 Auraxis 自己做登录系统，也不保存原系统密码。生产接入时，用户仍然先登录原有业务系统，原系统后端再给前端签发一个短期 Auraxis token。

推荐流程：

```text
用户登录原有业务系统
  ↓
原系统前端加载 Auraxis Vue 组件
  ↓
组件调用原系统后端 /api/auraxis/token
  ↓
原系统后端生成短期 signed host token
  ↓
组件带 token 请求 Auraxis Gateway
  ↓
Auraxis Gateway 校验签名、app_id、过期时间、issuer
  ↓
映射为 AssistantUserIdentity
```

token 建议包含：

```json
{
  "app_id": "clinical-report",
  "external_user_id": "u_001",
  "display_name": "张三",
  "tenant_id": "hospital_a",
  "roles": ["report_viewer"],
  "permissions": ["assistant:chat", "tool:demo.check_status"],
  "iat": 1780000000,
  "exp": 1780000300,
  "issuer": "clinical-report-system"
}
```

关键原则：

- 生产环境需要原系统账号或至少稳定的 `external_user_id`，否则无法做多用户隔离和审计。
- Auraxis 不接收原系统密码，不直接复用原系统 cookie。
- token 必须短期有效，建议 5 到 15 分钟。
- Gateway 每次工具调用都要重新检查 app、user、permission，不只在建立会话时检查一次。
- 开发模式可以支持匿名 `visitor_id`，但只能访问 demo app 和 demo tool。
- 如果原系统没有后端，只能做匿名体验版，不适合接入业务工具。

第一版 AssistantUserIdentity：

```ts
type AssistantUserIdentity = {
  appId: string
  externalUserId: string
  tenantId?: string
  displayName?: string
  roles: string[]
  permissions: string[]
}
```

## 7. 对话与状态管理

### 7.1 Conversation

Conversation 表示一次完整会话。

建议字段：

- id
- app_id
- tenant_id
- external_user_id
- visitor_id
- source_url
- page_title
- status: open / resolved / closed
- summary
- trace_id
- created_at
- updated_at

### 7.2 Message

Message 记录用户、助手、系统和工具消息。

建议字段：

- id
- conversation_id
- role: user / assistant / system / tool
- content
- content_type: text / tool_result / error
- structured_payload
- metadata
- token_usage
- model_name
- trace_id
- created_at

### 7.3 ConversationState

ConversationState 记录当前对话进度，避免每次都依赖完整历史消息。

```json
{
  "current_intent": "demo_check_status",
  "stage": "answered",
  "entities": {},
  "pending_tool_call_id": null,
  "confidence": 0.91
}
```

第一版只保存必要状态，不做长期用户记忆。

## 8. 意图推测与路由

第一版采用规则 + LLM Router 的组合。

```text
用户输入
  ↓
轻量规则匹配
  ↓
DeepSeek Router JSON 输出
  ↓
置信度判断
  ↓
Policy Gate
  ↓
普通回答或工具调用
```

第一版意图：

- general_chat：普通客服问答或闲聊。
- demo_check_status：测试脚本工具意图。
- unknown：无法判断。

第二阶段再增加：

- business_query。
- troubleshooting。
- summarize_history。
- create_ticket。
- handoff_human。

Router 输出：

```json
{
  "intent": "demo_check_status",
  "entities": {
    "target": "gateway"
  },
  "confidence": 0.92,
  "requires_tool": true,
  "candidate_tools": ["demo.check_status"]
}
```

Router 规则：

- confidence 低于阈值时不执行工具，先追问。
- candidate_tools 只是模型建议，不是执行授权。
- 工具参数必须由后端 schema 校验通过后才能执行。
- 模型输出 JSON 失败时降级为普通对话或追问，不直接执行任何工具。

## 9. 工具扩展机制

### 9.1 工具系统目标

工具是后端注册的业务能力，不是模型自由生成的代码。

第一版只实现：

- Internal Tool Runtime。
- 一个注册脚本工具。
- read_only / diagnostic 风险等级。
- ToolCall 日志。

后续再增加：

- create_ticket 作为 create 风险等级工具。
- update / destructive 工具。
- PendingAction 用户确认。
- MCP Client。

### 9.2 ToolDefinition

工具定义必须同时服务模型、后端校验和审计。

```json
{
  "name": "demo.check_status",
  "version": "1.0.0",
  "type": "script",
  "description": "运行受控的系统状态检查脚本，返回测试状态信息。",
  "risk_level": "diagnostic",
  "enabled": true,
  "required_permissions": ["tool:demo.check_status"],
  "timeout_ms": 5000,
  "max_output_chars": 4000,
  "input_schema": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "enum": ["gateway", "database", "demo"]
      }
    },
    "required": ["target"],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "target": { "type": "string" },
      "summary": { "type": "string" },
      "details": { "type": "object" }
    },
    "required": ["ok", "target", "summary"]
  },
  "examples": [
    {
      "user": "帮我检查一下系统状态",
      "input": { "target": "gateway" }
    }
  ]
}
```

### 9.3 ToolCall

每次工具调用都要记录。

建议字段：

- id
- conversation_id
- message_id
- trace_id
- app_id
- tenant_id
- external_user_id
- tool_name
- tool_version
- risk_level
- input
- output
- status: pending / running / succeeded / failed / denied / timeout
- error_code
- error_message
- duration_ms
- created_at
- finished_at

### 9.4 Policy Gate

工具执行前必须经过 Policy Gate。

校验项：

- 工具是否存在。
- 工具是否启用。
- 当前 app 是否允许使用该工具。
- 当前用户 token 是否包含 required_permissions。
- risk_level 是否允许自动执行。
- input 是否通过 schema 校验。
- 是否超过 rate limit。
- 是否超过并发限制。

第一版自动执行范围：

- read_only。
- diagnostic。

第一版拒绝范围：

- create。
- update。
- destructive。
- 未注册工具。
- 模型生成的任意 shell 命令。

### 9.5 Script Tool 规则

示例脚本工具用于验证“识别意图 -> 执行工具 -> 返回结果”的闭环，但不能变成任意命令执行器。

规则：

- 脚本必须在 ToolDefinition 中注册。
- 模型只能选择工具名和结构化参数，不能生成命令行。
- 后端用固定 command、固定 cwd、固定 env allowlist 执行脚本。
- 参数只通过 JSON schema 传入，不拼接未经校验的字符串。
- 设置 timeout、max_output_chars、max_stderr_chars。
- stdout / stderr 都要截断后入库。
- exit code 非 0 时返回工具失败，不让模型宣称成功。

第一版示例：

```text
用户：“帮我检查一下助手服务状态”
  ↓
Router: intent=demo_check_status, candidate_tools=["demo.check_status"]
  ↓
Policy Gate: permission ok, risk diagnostic
  ↓
Tool Runtime: 执行 scripts/demo_check_status
  ↓
ToolCall: succeeded
  ↓
Assistant: “检查完成，Gateway 正常，数据库连接正常。”
```

## 10. DeepSeek 接入层

DeepSeek API 通过 ModelProvider 间接调用，避免业务代码绑定具体模型。

职责：

- API Key 管理。
- 模型选择。
- OpenAI/Anthropic 兼容 API 适配。
- SSE 流式输出。
- 超时、重试和错误处理。
- JSON 输出校验。
- token 统计。
- prompt 模板版本管理。
- trace_id 注入。

建议接口：

```ts
type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

type ModelProvider = {
  streamChat(input: {
    model: string
    messages: ModelMessage[]
    responseFormat?: 'text' | 'json'
    traceId: string
    userId?: string
  }): AsyncIterable<string>
}
```

第一版默认模型配置放在环境变量，不写死在代码里：

- `DEEPSEEK_API_KEY`
- `DEEPSEEK_BASE_URL`
- `DEEPSEEK_MODEL`

## 11. MVP 边界

### 11.1 第一版包含

- `@auraxis/vue` Vue 组件。
- Gateway API。
- 原系统 signed host token 鉴权。
- 多用户会话隔离。
- Conversation / Message 存储。
- DeepSeek 流式对话。
- Router JSON 意图识别。
- ToolDefinition 注册。
- Policy Gate。
- 一个 demo script tool。
- ToolCall 日志。
- trace_id 贯穿请求、模型调用和工具调用。
- docker-compose 本地开发环境。

### 11.2 第一版不做

- Web Component。
- React。
- iframe。
- CDN JS SDK。
- 当前屏幕截图。
- 附件上传。
- create_ticket。
- 数据修改。
- PendingAction。
- MCP Client。
- 大规模知识库。
- 完整人工客服工作台。
- 多租户计费。
- 复杂运营分析。

### 11.3 后续阶段

第二阶段：

- 截图和附件上传。
- 简单后台会话查看。
- Conversation Summary。
- create_ticket 工具。

第三阶段：

- PendingAction。
- 用户确认卡片。
- AuditLog。
- update 类工具。

第四阶段：

- MCP Client。
- 外部 MCP Server 接入。
- 工具市场或工具包管理。
- 更复杂的多代理协作。

## 12. 推荐数据表

第一版最小表：

- AssistantApp
- AssistantAppKey
- AssistantUserIdentity
- Conversation
- Message
- ConversationState
- ToolDefinition
- ToolCall
- AgentTrace

第二阶段增加：

- MessageAttachment
- ConversationSummary
- Feedback

第三阶段增加：

- PendingAction
- AuditLog
- KnowledgeDocument
- UserMemory

第一版可以不建 UserMemory。用户偏好和业务事实不要混在一起，避免后续权限和隐私问题。

## 13. API 草案

第一版 Gateway API：

- `POST /v1/conversations`
- `GET /v1/conversations`
- `GET /v1/conversations/:conversationId/messages`
- `POST /v1/conversations/:conversationId/messages:stream`
- `GET /v1/tools`
- `GET /v1/health`

宿主系统需要实现：

- `GET /api/auraxis/token`

Vue 组件只拿宿主系统签发的短期 token，不直接读取用户密码或业务系统 session cookie。

## 14. 推荐开发顺序与验证方式

1. 建 monorepo 与 docker-compose。
   验证方式：`bun install`、数据库容器启动、Gateway health check 通过。

2. 建数据库 schema 和迁移。
   验证方式：能创建 AssistantApp、Conversation、Message、ToolDefinition、ToolCall。

3. 实现 signed host token 鉴权。
   验证方式：有效 token 通过，过期 token、错误 app_id、错误签名被拒绝。

4. 实现 Conversation / Message API。
   验证方式：两个不同用户创建的会话互相不可见。

5. 实现 Vue 组件基础 UI。
   验证方式：示例 Vue app 安装组件后能打开聊天框、发送消息、显示流式回复。

6. 实现 DeepSeek ModelProvider。
   验证方式：普通问题能通过 SSE 流式返回，Message 入库。

7. 实现 Router JSON 意图识别。
   验证方式：“检查助手状态”类问题稳定输出 `demo_check_status`。

8. 实现 Tool Runtime 和 demo script tool。
   验证方式：命中意图后执行注册脚本，返回结构化结果，ToolCall 入库。

9. 实现 Policy Gate。
   验证方式：缺少 `tool:demo.check_status` 权限时工具被拒绝，且不会执行脚本。

10. 补 trace 和错误日志。
    验证方式：一次用户请求能串起 conversation_id、message_id、trace_id、tool_call_id。

## 15. 第一版验收标准

第一版完成标准：

- 一个已有 Vue 应用可以通过本地包或私有包安装 `@auraxis/vue`。
- 宿主 Vue 页面挂载 `<AuraxisAssistant />` 后出现可用聊天入口。
- 用户 A 和用户 B 使用不同 token 时，会话和消息互相隔离。
- 普通问题能走 DeepSeek 流式回复。
- 用户提出测试脚本相关问题时，Router 能识别意图。
- 后端只执行注册过的 demo script tool，不执行模型生成的任意命令。
- demo script tool 的执行结果返回给用户。
- ToolCall 表记录工具名、输入、输出、状态、耗时和错误。
- 无权限、过期 token、跨用户读取会话都会被拒绝。
- 本地开发可以用 docker-compose 一键启动依赖服务。

验收用例：

```text
用户 A: “帮我检查一下助手服务状态”
期望：
1. Router 输出 demo_check_status。
2. Policy Gate 允许 demo.check_status。
3. scripts/demo_check_status 被执行。
4. 用户看到脚本结果。
5. ToolCall 状态为 succeeded。
6. 用户 B 看不到用户 A 的会话。
```

## 16. 核心原则

- 第一版只做 Vue，不做通用前端形态。
- 第一版只做受控工具，不做 create_ticket 和数据修改。
- 模型不直接访问数据库。
- 模型不直接执行 shell 命令。
- 模型只提出候选工具，后端决定是否执行。
- 工具必须结构化注册。
- 工具输入输出必须 schema 校验。
- 所有工具调用必须记录。
- 权限判断必须绑定 app、user、tenant 和 tool。
- 业务状态以业务系统为准，AI 只负责解释和辅助。
- 能用简单 workflow 解决时，不引入复杂多代理。

## 17. 当前待确认问题

这些问题不阻塞文档设计，但会影响第一版实现细节：

1. 原有 Vue 系统是否一定有后端可以签发 `/api/auraxis/token`？
2. Auraxis 组件是先用本地 workspace 包接入，还是需要一开始就发布到私有 npm？
3. demo script tool 是运行在 Auraxis Gateway 容器内，还是需要调用宿主系统已有脚本？
4. 第一版是否需要保留最小会话历史侧栏，还是只恢复当前会话即可？
5. DeepSeek 默认模型使用 `deepseek-v4-flash` 还是 `deepseek-v4-pro`？
