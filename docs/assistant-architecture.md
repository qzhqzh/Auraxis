# Auraxis 智能客服助手架构设计

## 1. 项目定位

Auraxis 是一个可嵌入任意前端系统的智能客服助手运行时。第一阶段面向客服问答、业务信息查询和历史对话记录分析；后续逐步扩展到工单创建、用户确认后的数据修改、MCP 工具调用、多业务系统接入与运营分析。

核心目标不是做一个单纯聊天框，而是提供一套可复用的 AI Assistant Runtime：

- 可挂载到 Vue、React、原生 HTML 或 iframe 场景。
- 后端统一接入 DeepSeek API。
- 支持对话状态管理、意图推测、实体抽取、工具调用和审计。
- 初期工具以只读查询为主，避免 AI 直接修改业务数据。
- 后续通过用户确认、权限校验和审计日志支持数据变更。

## 2. 总体架构

```text
任意业务前端 / Vue 项目
  ↓
Assistant Widget SDK / Web Component / iframe
  ↓
Assistant Gateway
  ↓
DeepSeek Adapter + Tool Runtime + MCP Client
  ↓
业务系统 API / MCP Servers / 数据库 / 知识库 / 工单系统
```

后端的 Assistant Gateway 是系统核心。DeepSeek 只负责推理和语言生成，不能直接操作业务数据库。所有业务查询、权限判断、数据修改、日志记录都必须由后端控制。

## 3. 前端接入设计

### 3.1 Vue 优先兼容

当前项目重点兼容 Vue 前端。建议提供两个形态：

1. Vue 组件：适合自有系统深度集成。
2. Web Component / JS SDK：适合未来挂载到任意前端。

Vue 使用方式示例：

```vue
<template>
  <AuraxisAssistant
    app-id="clinical-report"
    :user="currentUser"
    :page-context="pageContext"
    :enable-screenshot="true"
  />
</template>
```

SDK 使用方式示例：

```html
<script src="https://cdn.example.com/auraxis-widget.js"></script>
<script>
  Auraxis.init({
    appId: 'clinical-report',
    userId: 'u_001',
    token: 'temporary-user-token',
    position: 'bottom-right',
    enableScreenshot: true
  })
</script>
```

### 3.2 前端 Widget 责任边界

前端 Widget 只负责交互和展示，不负责复杂 AI 编排。

主要能力：

- 聊天气泡与聊天窗口。
- 文本输入、快捷问题、附件上传。
- SSE 或 WebSocket 流式接收回复。
- 展示 Markdown、卡片、表格、表单、确认操作卡片。
- 获取当前页面 URL、标题、路由参数和页面上下文。
- 可选获取当前屏幕截图。
- 通过 postMessage 或事件系统和宿主页面交互。

## 4. 当前屏幕截图能力

### 4.1 需求价值

屏幕截图能力适合客服排障场景，例如：

- 用户说“这个页面报错了”，助手可以结合截图理解问题。
- 用户不会描述具体按钮或位置时，截图可以补充上下文。
- 客服后台可以把截图和对话绑定，辅助人工接管。

### 4.2 实现方式

建议第一版使用前端截图库，例如 html2canvas，将当前页面渲染为图片，再上传到后端。

```text
用户点击截图按钮
  ↓
Widget 调用截图能力
  ↓
生成 PNG / JPEG / WebP
  ↓
上传到 Assistant Gateway
  ↓
作为 Message Attachment 存储
  ↓
AI 对话时引用截图摘要或图片链接
```

### 4.3 设计注意事项

- 截图必须由用户主动触发，默认不自动截图。
- 截图前需要提示用户可能包含敏感信息。
- 支持用户裁剪或确认后再上传。
- 对跨域 iframe、canvas、视频区域可能无法完整截图，需要降级处理。
- 后端保存截图时应绑定 conversation_id、message_id、user_id、source_url。
- 长期存储需要设置过期策略，避免敏感图片无限保留。

### 4.4 截图消息结构

```json
{
  "type": "screenshot",
  "conversation_id": "conv_001",
  "message_id": "msg_001",
  "file_url": "https://cdn.example.com/screenshots/xxx.png",
  "source_url": "https://app.example.com/report/123",
  "viewport": {
    "width": 1440,
    "height": 900,
    "device_pixel_ratio": 2
  }
}
```

## 5. 对话状态管理

### 5.1 Conversation

Conversation 表示一次完整会话。

建议字段：

- id
- app_id
- user_id
- visitor_id
- source_url
- status: open / waiting / resolved / handoff / closed
- summary
- created_at
- updated_at

### 5.2 Message

Message 记录用户、助手、系统和工具消息。

建议字段：

- id
- conversation_id
- role: user / assistant / system / tool
- content
- content_type: text / card / form / image / file / screenshot
- structured_payload
- metadata
- token_usage
- model_name
- created_at

### 5.3 ConversationState

ConversationState 记录当前对话进度，避免每次都依赖完整历史消息。

示例：

```json
{
  "current_intent": "query_report_status",
  "stage": "waiting_for_report_id",
  "entities": {
    "report_id": null
  },
  "slots": {
    "report_id": {
      "required": true,
      "value": null
    }
  },
  "pending_action_id": null,
  "confidence": 0.78
}
```

## 6. 意图推测与路由

意图识别建议采用多层机制，而不是完全依赖一次大模型自由回答。

```text
用户输入
  ↓
规则预判
  ↓
DeepSeek Router Call
  ↓
实体抽取与置信度判断
  ↓
权限判断
  ↓
工具选择或普通回答
```

第一阶段支持的意图：

- faq_answer：常见问题回答。
- business_query：业务信息查询。
- troubleshooting：问题排查。
- create_ticket：创建工单。
- summarize_history：总结历史对话。
- handoff_human：转人工。
- smalltalk：普通闲聊。
- unknown：无法判断。

Router Call 输出建议固定为 JSON：

```json
{
  "intent": "business_query",
  "entities": {
    "sample_id": "S20260523001"
  },
  "confidence": 0.91,
  "requires_tool": true,
  "candidate_tools": ["sample.get_status"]
}
```

## 7. 工具扩展机制

### 7.1 工具系统目标

工具系统必须具备扩展性。第一阶段主要做只读查询，后续扩展到创建、修改和复杂工作流。

工具不应该暴露裸 SQL，也不应该让 AI 直接访问数据库。工具应该是业务语义能力，例如：

- sample.get_status
- report.get_detail
- ticket.search
- knowledge.search
- pipeline.get_error_summary

### 7.2 工具注册表

建议设计 Tool Registry，用 JSON Schema 描述工具输入输出。

```json
{
  "name": "report.get_detail",
  "type": "internal",
  "description": "查询报告详情，只读工具",
  "risk_level": "read_only",
  "input_schema": {
    "type": "object",
    "properties": {
      "report_id": {
        "type": "string"
      }
    },
    "required": ["report_id"]
  }
}
```

### 7.3 工具风险分级

- read_only：只读查询，可直接执行。
- create：创建数据，例如创建工单，需要记录日志。
- update：修改数据，必须用户确认。
- destructive：删除或批量操作，需要强确认和管理员权限。

第一版只实现 read_only 和少量 create。

## 8. MCP 与内置工具的关系

MCP 和内置工具不冲突，建议保留双轨能力。

### 8.1 双轨模型

```text
Tool Runtime
├── Internal Tools：系统内置工具，直接调用 Django Service 或内部 API
└── MCP Tools：通过 MCP Client 调用外部 MCP Server
```

AI 不应该随意选择不可控工具。后端需要根据意图、权限、风险等级和工具可用性做最终路由。

### 8.2 工具选择原则

建议规则：

1. 同一个业务能力如果内置工具更稳定，优先内置工具。
2. MCP 用于连接外部系统、知识库、文件系统或跨项目工具。
3. 查询类能力可以同时开放 internal 和 MCP，但需要统一返回格式。
4. 修改类能力必须经过后端 PendingAction 和权限校验，不能直接由 MCP 执行最终变更。

### 8.3 是否让 AI 自选工具

可以让 AI 提出 candidate_tools，但最终执行权在后端。

```text
AI 建议调用工具
  ↓
Tool Orchestrator 校验工具是否存在、是否启用、用户是否有权限、风险等级是否允许
  ↓
执行工具或要求用户确认
```

这样既保留 AI 的灵活性，也避免工具调用失控。

## 9. DeepSeek 接入层

DeepSeek API 应该通过 Model Adapter 间接调用，避免业务代码绑定具体模型。

职责：

- API Key 管理。
- 模型选择。
- 流式输出。
- 超时、重试和错误处理。
- JSON 输出校验。
- token 统计。
- prompt 模板版本管理。

建议抽象：

```python
class LLMProvider:
    def chat(self, messages, tools=None, stream=False):
        raise NotImplementedError

class DeepSeekProvider(LLMProvider):
    pass
```

## 10. 数据修改与确认机制

后续支持数据修改时，必须使用 PendingAction。

```text
用户提出修改诉求
  ↓
AI 识别意图和目标数据
  ↓
后端查询当前状态
  ↓
生成修改计划
  ↓
前端展示确认卡片
  ↓
用户确认
  ↓
后端权限校验
  ↓
执行业务服务
  ↓
记录审计日志
  ↓
回复执行结果
```

AI 不能直接宣称修改成功。最终回复必须以后端执行结果为准。

PendingAction 建议字段：

- id
- conversation_id
- user_id
- action_type
- target_type
- target_id
- before_data
- after_data
- status: pending / confirmed / cancelled / executed / failed
- risk_level
- expires_at
- created_at
- confirmed_at
- executed_at

## 11. 历史对话记录分析

历史分析分三层：

### 11.1 单次会话摘要

会话结束后生成摘要，包括：

- 用户问题。
- 主要意图。
- 涉及实体。
- 是否解决。
- 调用过哪些工具。
- 是否需要人工跟进。

### 11.2 用户级记忆

记录用户偏好，但不要把业务事实写入 AI 记忆。

例如：

```json
{
  "reply_style": "简短直接",
  "technical_level": "developer",
  "frequent_topics": ["报告查询", "流程排障", "工单创建"]
}
```

### 11.3 全局客服运营分析

统计：

- 高频问题。
- 未解决问题。
- 转人工比例。
- 平均解决时间。
- 工具调用成功率。
- 常见错误。
- 知识库缺口。

## 12. 推荐核心数据表

第一阶段建议至少包含：

- AssistantApp
- Conversation
- Message
- MessageAttachment
- ConversationState
- ToolDefinition
- ToolCall
- ConversationSummary

第二阶段增加：

- PendingAction
- AuditLog
- UserMemory
- Feedback
- KnowledgeDocument

## 13. MVP 边界

第一阶段目标：

> 完成一个 Vue 可接入的智能客服助手，支持 DeepSeek 流式对话、会话记录、意图识别、只读工具查询、截图上传和后台对话查看。

第一阶段包含：

- Vue Widget。
- Web Component 包装层。
- Conversation / Message 存储。
- DeepSeek API 接入。
- Router Call 意图识别。
- 只读 Tool Registry。
- Internal Tool Runtime。
- 可选 MCP Client 接口预留。
- 当前页面截图上传。
- ToolCall 日志。
- Conversation Summary。

第一阶段不做：

- AI 直接修改业务数据。
- 批量操作。
- 复杂多租户计费。
- 大规模知识库训练。
- 完整人工客服工作台。

## 14. 推荐开发顺序

1. Vue Widget 基础聊天 UI。
2. 后端 Conversation / Message API。
3. DeepSeek Adapter 与流式回复。
4. 意图识别 Router Call。
5. Tool Registry 与只读内部工具。
6. ToolCall 日志。
7. 当前屏幕截图上传。
8. Conversation Summary。
9. MCP Client 预留与简单 MCP 查询工具。
10. PendingAction 与确认卡片。
11. 权限系统与审计日志。
12. 后台运营分析。

## 15. 核心原则

- 模型不直接访问数据库。
- 模型不直接执行数据修改。
- 工具必须结构化注册。
- 初期工具只做只读查询。
- MCP 与内置工具双轨共存，但统一经过 Tool Orchestrator。
- 所有工具调用都必须记录。
- 截图必须用户主动触发，并允许确认后上传。
- 业务状态以业务数据库为准，AI 记忆只保存偏好和摘要。
- 修改类操作必须经过用户确认、权限校验和审计日志。
