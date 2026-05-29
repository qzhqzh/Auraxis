# PR Draft: Internal Tool Runtime MVP Checkpoint

## Title
feat: add internal tool runtime MVP

## Summary
- Adds the embeddable Vue assistant demo flow with signed host-token auth, conversation/message persistence, and streaming replies.
- Adds task-routed DeepSeek model access for router, chat, summary, and response composition.
- Adds Router + Policy Gate + Internal Tool Runtime for the first diagnostic tool: `system.check_status`.
- Adds ToolCall persistence, agent traces, latency metrics, conversation summary/windowing, and Context Builder.
- Adds read-only demo console for tools, conversations, messages, traces, summary, and message-linked traces.
- Improves demo/LAN testing, user isolation, unsupported reminder handling, and widget scroll behavior.

## Why
This PR establishes the Auraxis MVP runtime checkpoint: a controlled assistant workflow that can authenticate host users, maintain isolated conversations, route intents, execute an authorized internal tool, persist audit/debug records, and compose user-facing replies from tool observations without exposing arbitrary tool execution.

## Key Changes
- Gateway
  - Conversation/message APIs with ownership by `appId + tenantId + externalUserId`.
  - `messages:stream` SSE orchestration for router, tool, model, summary, and response composition phases.
  - `ModelTask` profiles for `router`, `chat`, `summary`, and `response_compose`.
  - `system.check_status` internal diagnostic tool with permission checks and ToolCall records.
  - Agent traces for router/tool/model/summary phases with latency and stream metrics.
  - Context Builder from app instructions, page context, conversation summary, and recent messages.
  - Conversation Summary + recent-message windowing.

- Vue/demo
  - Vue assistant widget bootstrap, conversation restore, streaming replies, and scroll-to-latest behavior.
  - Local demo host with dev token issuance and LAN-friendly Gateway URL derivation.
  - Read-only dev console with tools, conversations, messages, traces, summary, and message-to-trace association.

- Safety/UX
  - Unsupported memory/reminder requests return deterministic unsupported-capability text.
  - Summary refresh no longer blocks SSE `done`.
  - Tool response composition falls back to deterministic formatting if model compose fails.

## Testing
- `docker compose exec -T gateway bun run test:gateway` — 25 pass, 0 fail
- `docker compose exec -T gateway bun run typecheck` — passed
- `docker compose exec -T gateway bun --cwd packages/vue build` — passed during widget validation

## Notes
- MCP runtime is not included in this PR.
- Dynamic tool configuration UI/API is not included in this PR.
- Next recommended branch: extract a formal `ToolObservation` abstraction for internal tools and future MCP tools.
