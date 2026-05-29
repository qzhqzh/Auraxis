# Codex Handoff

Last updated: 2026-05-29

## Current Branch

- Branch: `feat/15-internal-tool-runtime`
- Working tree should be clean before the next task starts.
- Do not commit `.env`; it contains local DeepSeek credentials and is gitignored.

## Recent Progress

Recent commits, newest first:

- `80e4b6b feat: compose tool responses with model`
  - Tool results keep raw ToolCall/tool trace output, while user-facing text is generated with `ModelTask.response_compose`.
  - Compose failure falls back to the previous deterministic formatter and records `model:failed`.
- `d07d63a feat: build model context from app and page data`
  - Router and chat now share a Context Builder output: app instructions, page context, conversation summary, and recent messages.
  - App instructions can come from `assistant_apps.settings.appInstructions`, `instructions`, or `assistantInstructions`.
- `678d249 fix: do not block chat done on summary`
  - SSE `done` is sent before background summary refresh, so the user can continue asking without waiting for summary generation.
- `37389ef docs: update handoff for summary windowing`
  - Updated architecture and handoff docs after summary/windowing landed.
- `2e7e468 fix: scroll assistant to latest messages`
  - The Vue widget scrolls the messages container to the newest message after restoring history, opening the panel, sending, streaming deltas, and final message reload.
- `b0bdace feat: link console traces to messages`
  - The demo console now shows traces under the message with the matching `messageId`, while retaining the raw All Traces table.
- `f74940a feat: show conversation summary in console`
  - The demo console shows the selected conversation's read-only summary.
- `d8125e8 feat: add conversation summary windowing`
  - Chat context now uses `conversations.summary` plus the latest 20 messages.
  - Long conversations refresh summary through `ModelTask.summary`; summary trace phases are recorded.
- `e0149ae fix: avoid unsupported reminder promises`
  - Reminder/memory requests get a deterministic unsupported-capability response instead of a misleading promise.
- `d3be174 fix: isolate demo console users`
  - Demo host and console support `?user=...` and preserve per-user conversation isolation.
- `2aa313f fix: support lan demo access`
  - Demo host can bind to `0.0.0.0`; browser Gateway URL derives from the request hostname.
- `aa6d295 docs: record e2e tool validation`
  - Recorded API-level tool validation in this handoff.
- `159218f docs: align tool runtime architecture`
  - `docs/assistant-architecture.md` now uses the current `system_check_status` / `system.check_status` internal tool terminology.
  - `docs/codex-handoff.md` now frames the branch as an MVP runtime checkpoint and asks for product direction before more feature work.
- `2cc7c82 refactor: extract internal tool runtime`
  - `system.check_status` metadata, permission checking, target normalization, executor, and result formatting now live in `apps/gateway/src/tools.ts`.
  - `server.ts` still owns request orchestration, ToolCall persistence, trace writing, SSE events, and assistant message writes.
  - Added focused `apps/gateway/test/tools.test.ts` coverage for the runtime boundary.
- `380fc70 docs: update handoff after trace console`
  - Updated this handoff after the console latency display work.
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
  - Router receives the same Context Builder output as chat: app instructions, page context, summary, and recent messages.
- Tool runtime flow:
  - internal tool metadata and executor helpers live in `apps/gateway/src/tools.ts`.
  - `GET /v1/tools` returns `internalTools`.
  - `server.ts` handles policy outcome, ToolCall persistence, trace writing, SSE, and assistant message persistence.
  - successful tool results are composed through `ModelTask.response_compose`; compose failure falls back to deterministic formatting.
- Model flow:
  - chat replies stream through `ModelProvider.streamChat({ task: 'chat' })`.
  - chat context is built from Context Builder system context plus the latest 20 messages.
  - Context Builder includes app instructions, page context, conversation summary, and recent messages.
  - long conversations refresh summary through `ModelProvider.generateJson({ task: 'summary' })`.
  - model traces include `task`, `provider`, `model`, `firstDeltaMs`, `deltaCount`, `contentLength`, and `durationMs`.
  - summary traces record `summary:succeeded` or `summary:failed` without interrupting the user reply.
- Development console is read-only and consumes existing API endpoints:
  - `GET /v1/tools`
  - `GET /v1/conversations`
  - `GET /v1/conversations/:conversationId/messages`
  - `GET /v1/conversations/:conversationId/traces`
  - Trace rows show compact latency summaries for `phase`, `status`, `durationMs`, `task`, `model`, `firstDeltaMs`, `deltaCount`, and `contentLength`.
  - The selected conversation summary is shown read-only.
  - Messages show their matching traces inline by `messageId`; All Traces remains available as a raw list.
- Vue widget UX:
  - restored conversations and streaming updates scroll the messages container to the latest message.

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

Demo host, when needed locally:

```bash
DEMO_PORT=5174 bun run dev:demo
```

For LAN or remote browser testing, bind the demo host to all interfaces:

```bash
DEMO_HOST=0.0.0.0 DEMO_PORT=5174 bun run dev:demo
```

Then open locally or from another device on the LAN:

```text
http://127.0.0.1:5174/
http://127.0.0.1:5174/console.html
http://<server-lan-ip>:5174/
http://<server-lan-ip>:5174/console.html
```

When opened through a LAN IP, `/demo-config.js` points the browser at `http://<same-hostname>:${GATEWAY_PORT}` for Gateway access.

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

- `test:gateway`: 25 pass, 0 fail
- `typecheck`: passed
- `bun --cwd packages/vue build`: passed
- End-to-end tool validation through demo host and Gateway API:
  - demo host: `DEMO_PORT=5174 bun run dev:demo`
  - Gateway health: HTTP 200, `status: ok`
  - `GET /v1/auth/me`: HTTP 200
  - `GET /v1/tools`: HTTP 200, includes `system.check_status`
  - `POST /v1/conversations`: HTTP 201
  - `POST /v1/conversations/:conversationId/messages:stream` with `帮我检查一下助手服务状态`: HTTP 200
  - SSE events included `route`, `tool`, assistant `data`, and `done`
  - route intent: `system_check_status`, candidate tool: `system.check_status`
  - tool output: gateway ok and database ok
  - messages API returned user + assistant messages
  - traces API returned `router:succeeded` and `tool:succeeded`
- Demo console validation:
  - `GET http://127.0.0.1:5174/console.html`: HTTP 200
  - inline module script syntax check: passed
  - Playwright browser validation was not available because Chrome was missing in the MCP environment.
- Earlier real trace validation for `你好你好` showed:
  - router: `source: rule`, `durationMs: 0`
  - model: `task: chat`, `model: deepseek-v4-pro`, with `firstDeltaMs`, `deltaCount`, and `contentLength`

## Recommended Next Task

The current branch is at a coherent checkpoint for the MVP runtime: auth, conversations, streaming chat, router, one internal diagnostic tool, ToolCall logging, traces, conversation summary/windowing, Context Builder, response composition for tool results, read-only console, LAN demo access, user-isolated demo testing, and API-level validation are in place.

Recommended next action: open a checkpoint PR for this branch before adding MCP, dynamic tool configuration, or multi-step agent loops.

After this checkpoint, the next implementation branch should probably extract a formal `ToolObservation` abstraction for internal tools and future MCP tools.

Do not start dynamic ToolDefinition editing in the UI yet. Tool config needs backend API and policy design first.

## Suggested Prompt For The Next Codex

Use this when opening a new Codex session:

```text
你在 /home/zhuqin/star/app/Auraxis 工作。请先阅读 docs/codex-handoff.md、docs/development.md、docs/assistant-architecture.md，并按 EchoMe/AGENTS 约定先查相关记忆。当前分支是 feat/15-internal-tool-runtime，MVP runtime 已具备 auth、conversation、streaming chat、Router、system.check_status internal tool、ToolCall、agent trace、Conversation Summary + Windowing、Context Builder、response_compose 工具结果回复、只读 console、LAN demo access 和用户隔离 demo 测试，并已通过 API 级验证。当前建议先开 checkpoint PR，不要继续往此分支塞 MCP、动态工具配置或多步 agent loop。若继续开发，下一分支优先抽象 ToolObservation。改动前先简短说明思路，完成后运行 docker compose exec -T gateway bun run test:gateway 和 docker compose exec -T gateway bun run typecheck，最后 conventional commit。
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
