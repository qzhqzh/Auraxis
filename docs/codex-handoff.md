# Codex Handoff

Last updated: 2026-05-29

## Current Branch

- Branch: `feat/15-internal-tool-runtime`
- Working tree should be clean before the next task starts.
- Do not commit `.env`; it contains local DeepSeek credentials and is gitignored.

## Recent Progress

Recent commits, newest first:

- `33d05a6 feat: show trace latency in demo console`
  - `apps/demo/console.html` now renders compact trace latency summaries from existing trace payloads.
  - Slow phases are highlighted at 3000ms/8000ms, and model traces show derived first-token/API vs streaming/output latency hints.
  - The console remains read-only; no dynamic tool configuration was added.
- `cd0ff52 feat: trace model stream latency`
  - `model` phase traces now include `firstDeltaMs`, `deltaCount`, and `contentLength`.
  - `docs/assistant-architecture.md` documents the current ModelProvider shape and trace metrics.
- `dda0a38 feat: skip router for obvious chat`
  - Obvious casual chat such as greetings skips the Router model and routes as `general_chat` by rule.
- `51f55a8 feat: route models by task`
  - Model access is now task-based through `ModelTask` / `ModelProvider.getProfile(task)`.
  - Router JSON uses `task: 'router'`; chat streaming uses `task: 'chat'`.
  - `.env.example` and `docker-compose.yml` support `DEEPSEEK_MODEL_ROUTER` and `DEEPSEEK_MODEL_CHAT`.
- `856b03e fix: update conversation activity on messages`
  - Appending user or assistant messages updates conversation activity for list ordering.
- `5cb4bd6 feat: add demo dev console`
  - `apps/demo/console.html` is a read-only development observation panel.
- `166eb07 feat: add agent trace logging`
  - `agent_traces` records router/tool/model phases and exposes trace query API.
- `9ee512d feat: add system status tool`
  - First formal internal tool is `system.check_status`.
- `5d87090 feat: add local demo host`
  - `apps/demo` can simulate a host Vue app and issue local dev tokens.

## Current Runtime Capabilities

- Vue widget can connect to Gateway, create/list conversations, and stream assistant replies.
- Gateway uses signed host tokens for host identity.
- Conversation/message data is stored in PostgreSQL.
- Router flow:
  - system status questions match a rule and call `system.check_status` when permitted.
  - obvious casual chat skips the Router model.
  - other messages call DeepSeek JSON Router through `ModelProvider.generateJson({ task: 'router' })`.
- Model flow:
  - chat replies stream through `ModelProvider.streamChat({ task: 'chat' })`.
  - model traces include `task`, `provider`, `model`, `firstDeltaMs`, `deltaCount`, `contentLength`, and `durationMs`.
- Development console is read-only and consumes existing API endpoints:
  - `GET /v1/tools`
  - `GET /v1/conversations`
  - `GET /v1/conversations/:conversationId/messages`
  - `GET /v1/conversations/:conversationId/traces`
  - Trace rows show compact latency summaries for `phase`, `status`, `durationMs`, `task`, `model`, `firstDeltaMs`, `deltaCount`, and `contentLength`.

## Local Startup

Default workflow uses Docker Compose.

```bash
docker compose up -d gateway
```

Gateway is usually available at:

```text
http://127.0.0.1:${GATEWAY_PORT:-3000}
```

In the current local `.env`, `GATEWAY_PORT` has been used as `3010` in recent validation.

Health check:

```bash
curl http://127.0.0.1:3010/v1/health
```

Demo host, when needed:

```bash
DEMO_PORT=5174 bun run dev:demo
```

Then open:

```text
http://127.0.0.1:5174/
http://127.0.0.1:5174/console.html
```

## Environment Notes

Relevant DeepSeek variables:

```text
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_MODEL_ROUTER=deepseek-v4-flash
DEEPSEEK_MODEL_CHAT=deepseek-v4-pro
DEEPSEEK_API_KEY=...
```

A local API key may already exist in `.env`, copied from `~/.claude/settings.ds.json`. Do not print or commit it.

## Verification Commands

Run these after code changes:

```bash
docker compose exec -T gateway bun run test:gateway
docker compose exec -T gateway bun run typecheck
```

Latest verified results before this handoff:

- `test:gateway`: 18 pass, 0 fail
- `typecheck`: passed
- Demo console validation:
  - `GET http://127.0.0.1:5174/console.html`: HTTP 200
  - inline module script syntax check: passed
  - Playwright browser validation was not available because Chrome was missing in the MCP environment.
- Earlier real trace validation for `你好你好` showed:
  - router: `source: rule`, `durationMs: 0`
  - model: `task: chat`, `model: deepseek-v4-pro`, with `firstDeltaMs`, `deltaCount`, and `contentLength`

## Recommended Next Task

Next recommended task: continue the Internal Tool Runtime backend path, without adding dynamic tool configuration UI.

Keep scope small and backend-only:

- Extract the currently inlined `system.check_status` definition, permission check, and executor into a small internal runtime boundary.
- Preserve the existing public API and SSE behavior:
  - `GET /v1/tools` returns the same tool metadata shape.
  - tool execution still records `tool_calls` and `agent_traces`.
  - missing `tool:system.check_status` still denies execution and does not run the tool.
- Add focused tests for the runtime boundary or keep existing stream tests passing if behavior is unchanged.

Do not start dynamic ToolDefinition editing in the UI yet. Tool config needs backend API and policy design first.

## Suggested Prompt For The Next Codex

Use this when opening a new Codex session:

```text
你在 /home/zhuqin/star/app/Auraxis 工作。请先阅读 docs/codex-handoff.md、docs/development.md、docs/assistant-architecture.md，并按 EchoMe/AGENTS 约定先查相关记忆。当前分支是 feat/15-internal-tool-runtime，最近已完成 ModelTask 模型路由、问候跳过 Router、model trace latency 展示。下一步请按 handoff 文档推进：继续 Internal Tool Runtime 后端路径，把当前内联的 system.check_status 定义、权限判断和执行逻辑抽成小的内部 runtime 边界，保持现有 API/SSE/ToolCall/trace 行为不变，不做动态工具配置 UI。改动前先简短说明思路，完成后运行 docker compose exec -T gateway bun run test:gateway 和 docker compose exec -T gateway bun run typecheck，最后 conventional commit。
```

## Guardrails

- Do not delete database migration files.
- Do not hardcode secrets or API keys.
- Do not commit `.env`.
- Do not change public API response structures unless backward compatible.
- Do not introduce dependencies without explaining why.
- Keep changes narrowly tied to the current task.
- Prefer Docker Compose for local development.
- Frontend package/build tooling uses bun.
