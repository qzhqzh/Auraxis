import cors from '@fastify/cors'
import { and, asc, eq, sql } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import { z } from 'zod'

import { HostTokenError, authenticateHostRequest } from './auth.js'
import type { AssistantUserIdentity } from './auth.js'
import type { AppConfig } from './config.js'
import {
  appendAssistantMessage,
  appendConversationMessage,
  createConversation,
  getConversationMessages,
  getConversationSummary,
  listConversations,
  updateConversationSummary
} from './conversations.js'
import { createDatabaseClient } from './db/client.js'
import * as schema from './db/schema.js'
import { createDeepSeekModelProvider, ModelProvider, ModelProviderError } from './model.js'
import type { ModelMessage } from './model.js'
import { createModelIntentRouter, IntentRouter, shouldAskRouteFollowUp } from './router.js'
import {
  canExecuteTool,
  formatSystemCheckResult,
  internalTools,
  normalizeSystemCheckTarget,
  runSystemCheckStatus,
  systemCheckStatusTool
} from './tools.js'

const GATEWAY_VERSION = '0.1.0'
const RECENT_CONTEXT_MESSAGE_LIMIT = 20
const SUMMARY_REFRESH_MESSAGE_THRESHOLD = 12
const SUMMARY_REFRESH_MESSAGE_INTERVAL = 6
const MAX_SUMMARY_CHARS = 4000
const createConversationSchema = z
  .object({
    pageTitle: z.string().min(1).optional(),
    sourceUrl: z.string().url().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    initialMessage: z.string().min(1).optional()
  })
  .strict()
const appendMessageSchema = z
  .object({
    content: z.string().min(1)
  })
  .strict()

type BuildServerOptions = {
  modelProvider?: ModelProvider
  intentRouter?: IntentRouter
}

type TraceStatus = 'started' | 'succeeded' | 'failed'

type WriteTraceInput = {
  traceId: string
  appId: string
  conversationId?: string
  messageId?: string
  phase: string
  status: TraceStatus
  payload?: Record<string, unknown>
  error?: Record<string, unknown>
  startedAt?: Date
  durationMs?: number
}

function errorPayload(error: unknown) {
  return {
    message: error instanceof Error ? error.message : 'Unknown error.'
  }
}

async function writeAgentTrace(db: ReturnType<typeof createDatabaseClient>['db'], input: WriteTraceInput) {
  await db.insert(schema.agentTraces).values({
    traceId: input.traceId,
    appId: input.appId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    phase: input.phase,
    status: input.status,
    payload: input.payload,
    error: input.error,
    startedAt: input.startedAt ?? new Date(),
    finishedAt: input.status === 'started' ? undefined : new Date(),
    durationMs: input.durationMs
  })
}

function matchConversationOwner(identity: { appId: string; tenantId?: string; externalUserId: string }, conversationId: string) {
  return and(
    eq(schema.conversations.id, conversationId),
    eq(schema.conversations.appId, identity.appId),
    eq(schema.conversations.externalUserId, identity.externalUserId),
    identity.tenantId ? eq(schema.conversations.tenantId, identity.tenantId) : sql`${schema.conversations.tenantId} is null`
  )
}

function isUnsupportedReminderRequest(content: string) {
  const normalizedContent = content.toLowerCase()
  const asksToRemember = /记住|记得|提醒|remind|remember/.test(normalizedContent)
  const hasReminderTime = /周末|明天|后天|今天|今晚|早上|下午|晚上|星期|周[一二三四五六日天]|点|分钟|小时|weekend|tomorrow/.test(normalizedContent)

  return asksToRemember && hasReminderTime
}

function unsupportedReminderMessage() {
  return '我现在还没有长期记忆、定时提醒或主动推送功能，所以不能真正保存这件事，也不能在周末自动提醒你。当前对话里我可以继续参考你刚刚说的内容；如果要做可持久提醒，需要后续接入受控的 reminder/memory 工具。'
}

function toModelMessages(messages: Array<{ role: ModelMessage['role']; content: string }>): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }))
}

function buildChatContext(summary: string, history: Array<{ role: ModelMessage['role']; content: string }>): ModelMessage[] {
  const recentMessages = toModelMessages(history.slice(-RECENT_CONTEXT_MESSAGE_LIMIT))
  const trimmedSummary = summary.trim()

  if (!trimmedSummary) {
    return recentMessages
  }

  return [
    {
      role: 'system',
      content: `Conversation summary so far:\n${trimmedSummary}`
    },
    ...recentMessages
  ]
}

function buildSummaryContext(summary: string, history: Array<{ role: ModelMessage['role']; content: string }>): ModelMessage[] {
  const messages = buildChatContext(summary, history)

  return [
    {
      role: 'system',
      content: 'Summarize the conversation for future assistant context. Return strict JSON with a single string field named summary. Preserve durable user goals, decisions, constraints, and unresolved questions. Do not invent facts.'
    },
    ...messages
  ]
}

function shouldRefreshConversationSummary(messageCount: number, currentSummary: string) {
  if (messageCount < SUMMARY_REFRESH_MESSAGE_THRESHOLD) {
    return false
  }

  return !currentSummary.trim() || messageCount % SUMMARY_REFRESH_MESSAGE_INTERVAL === 0
}

function parseSummaryPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object' || !('summary' in payload)) {
    return null
  }

  const summary = (payload as { summary?: unknown }).summary

  if (typeof summary !== 'string') {
    return null
  }

  const trimmedSummary = summary.trim()

  return trimmedSummary ? trimmedSummary.slice(0, MAX_SUMMARY_CHARS) : null
}

async function refreshConversationSummary(input: {
  db: ReturnType<typeof createDatabaseClient>['db']
  modelProvider: ModelProvider
  identity: AssistantUserIdentity
  conversationId: string
  messageId: string
  traceId: string
  currentSummary: string
  history: Array<{ role: ModelMessage['role']; content: string }>
}) {
  if (!shouldRefreshConversationSummary(input.history.length, input.currentSummary)) {
    return
  }

  const startedAt = Date.now()
  const profile = input.modelProvider.getProfile('summary')

  try {
    const payload = await input.modelProvider.generateJson({
      task: 'summary',
      messages: buildSummaryContext(input.currentSummary, input.history),
      traceId: input.traceId
    })
    const summary = parseSummaryPayload(payload)

    if (!summary) {
      throw new Error('Summary model returned an invalid payload.')
    }

    await updateConversationSummary(input.db, input.identity, input.conversationId, summary)

    await writeAgentTrace(input.db, {
      traceId: input.traceId,
      appId: input.identity.appId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      phase: 'summary',
      status: 'succeeded',
      payload: {
        task: 'summary',
        model: profile.model,
        provider: profile.provider,
        messageCount: input.history.length,
        summaryLength: summary.length,
        previousSummary: Boolean(input.currentSummary.trim())
      },
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    await writeAgentTrace(input.db, {
      traceId: input.traceId,
      appId: input.identity.appId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      phase: 'summary',
      status: 'failed',
      payload: {
        task: 'summary',
        model: profile.model,
        provider: profile.provider,
        messageCount: input.history.length,
        previousSummary: Boolean(input.currentSummary.trim())
      },
      error: errorPayload(error),
      durationMs: Date.now() - startedAt
    })
  }
}

function sendHostTokenError(reply: FastifyReply, error: HostTokenError) {
  return reply.status(error.statusCode).send({
    error: error.code,
    message: error.message
  })
}

function sendModelProviderError(reply: FastifyReply, error: ModelProviderError) {
  return reply.status(error.statusCode).send({
    error: error.code,
    message: error.message
  })
}

export function buildServer(config: AppConfig, options: BuildServerOptions = {}) {
  const server = Fastify({
    logger: {
      level: config.logLevel
    }
  })
  const { db, pool } = createDatabaseClient(config)
  const modelProvider = options.modelProvider ?? createDeepSeekModelProvider(config)
  const intentRouter = options.intentRouter ?? createModelIntentRouter(modelProvider)

  server.register(cors, {
    origin: true
  })

  server.addHook('onClose', async () => {
    await pool.end()
  })

  server.get('/', async () => ({
    service: 'auraxis-gateway',
    health: '/v1/health'
  }))

  server.get('/v1/health', async () => ({
    status: 'ok',
    service: 'auraxis-gateway',
    version: GATEWAY_VERSION,
    time: new Date().toISOString()
  }))

  server.get('/v1/auth/me', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)

      return {
        identity
      }
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })


  server.get('/v1/tools', async (request, reply) => {
    try {
      authenticateHostRequest(request, config)

      return {
        tools: internalTools
      }
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })

  server.post('/v1/conversations', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)
      const parsedBody = createConversationSchema.safeParse(request.body ?? {})

      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'CONVERSATION_CREATE_INVALID',
          message: 'Conversation payload is invalid.'
        })
      }

      const conversation = await createConversation(db, identity, parsedBody.data)

      return reply.status(201).send({
        conversation
      })
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })

  server.get('/v1/conversations', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)
      const conversations = await listConversations(db, identity)

      return {
        conversations
      }
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })

  server.post('/v1/conversations/:conversationId/messages', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)
      const params = request.params as { conversationId: string }
      const parsedBody = appendMessageSchema.safeParse(request.body ?? {})

      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'MESSAGE_CREATE_INVALID',
          message: 'Message payload is invalid.'
        })
      }

      const message = await appendConversationMessage(db, identity, params.conversationId, parsedBody.data)

      if (!message) {
        return reply.status(404).send({
          error: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation was not found.'
        })
      }

      return reply.status(201).send({
        message
      })
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })

  server.post('/v1/conversations/:conversationId/messages:stream', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)
      const params = request.params as { conversationId: string }
      const parsedBody = appendMessageSchema.safeParse(request.body ?? {})

      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'MESSAGE_CREATE_INVALID',
          message: 'Message payload is invalid.'
        })
      }

      const userMessage = await appendConversationMessage(db, identity, params.conversationId, parsedBody.data)

      if (!userMessage) {
        return reply.status(404).send({
          error: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation was not found.'
        })
      }

      const history = await getConversationMessages(db, identity, params.conversationId)

      if (!history) {
        return reply.status(404).send({
          error: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation was not found.'
        })
      }

      const conversationSummary = await getConversationSummary(db, identity, params.conversationId)

      if (conversationSummary === null) {
        return reply.status(404).send({
          error: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation was not found.'
        })
      }

      const origin = request.headers.origin

      reply.hijack()
      reply.raw.writeHead(200, {
        'access-control-allow-origin': origin ?? '*',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        vary: 'Origin'
      })

      const routerStartedAt = Date.now()
      const route = await intentRouter.route({
        latestMessage: parsedBody.data.content,
        messages: toModelMessages(history)
      })

      const routerProfile = route.source === 'model' ? modelProvider.getProfile('router') : undefined

      await writeAgentTrace(db, {
        traceId: userMessage.traceId,
        appId: identity.appId,
        conversationId: params.conversationId,
        messageId: userMessage.id,
        phase: 'router',
        status: 'succeeded',
        payload: {
          route,
          task: routerProfile ? 'router' : undefined,
          model: routerProfile?.model,
          provider: routerProfile?.provider
        },
        durationMs: Date.now() - routerStartedAt
      })

      reply.raw.write(`event: route\ndata: ${JSON.stringify(route)}\n\n`)

      if (shouldAskRouteFollowUp(route)) {
        const followUpMessage = '我还不能稳定判断你的意图。你是想普通咨询，还是想检查 gateway 的状态？'

        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'model',
          status: 'succeeded',
          payload: { skipped: true, reason: 'route_follow_up' },
          durationMs: 0
        })

        await appendAssistantMessage(db, identity, params.conversationId, {
          content: followUpMessage
        })

        reply.raw.write(`data: ${JSON.stringify({ delta: followUpMessage })}\n\n`)
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        reply.raw.end()
        return reply
      }

      if (isUnsupportedReminderRequest(parsedBody.data.content)) {
        const message = unsupportedReminderMessage()

        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'model',
          status: 'succeeded',
          payload: { skipped: true, reason: 'unsupported_reminder_memory' },
          durationMs: 0
        })

        await appendAssistantMessage(db, identity, params.conversationId, {
          content: message
        })

        reply.raw.write(`data: ${JSON.stringify({ delta: message })}\n\n`)
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        reply.raw.end()
        return reply
      }

      if (route.requiresTool && route.candidateTools.includes(systemCheckStatusTool.name)) {
        const target = normalizeSystemCheckTarget(route.entities.target)
        const input = { target }
        const startedAt = Date.now()

        if (!canExecuteTool(identity.permissions, systemCheckStatusTool)) {
          const deniedMessage = '你当前没有权限执行 system.check_status。'

          await db.insert(schema.toolCalls).values({
            conversationId: params.conversationId,
            messageId: userMessage.id,
            traceId: userMessage.traceId,
            appId: identity.appId,
            tenantId: identity.tenantId,
            externalUserId: identity.externalUserId,
            toolName: systemCheckStatusTool.name,
            toolVersion: systemCheckStatusTool.version,
            riskLevel: systemCheckStatusTool.riskLevel,
            input,
            status: 'denied',
            errorCode: 'TOOL_PERMISSION_DENIED',
            errorMessage: deniedMessage,
            durationMs: Date.now() - startedAt,
            finishedAt: new Date()
          })

          await writeAgentTrace(db, {
            traceId: userMessage.traceId,
            appId: identity.appId,
            conversationId: params.conversationId,
            messageId: userMessage.id,
            phase: 'tool',
            status: 'failed',
            payload: { toolName: systemCheckStatusTool.name, input, toolStatus: 'denied' },
            error: { code: 'TOOL_PERMISSION_DENIED', message: deniedMessage },
            durationMs: Date.now() - startedAt
          })

          await appendAssistantMessage(db, identity, params.conversationId, {
            content: deniedMessage
          })

          reply.raw.write(`event: tool\ndata: ${JSON.stringify({ name: systemCheckStatusTool.name, status: 'denied' })}\n\n`)
          reply.raw.write(`data: ${JSON.stringify({ delta: deniedMessage })}\n\n`)
          reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: false })}\n\n`)
          reply.raw.end()
          return reply
        }

        const output = await runSystemCheckStatus(db, target, GATEWAY_VERSION)
        const statusMessage = formatSystemCheckResult(output)

        await db.insert(schema.toolCalls).values({
          conversationId: params.conversationId,
          messageId: userMessage.id,
          traceId: userMessage.traceId,
          appId: identity.appId,
          tenantId: identity.tenantId,
          externalUserId: identity.externalUserId,
          toolName: systemCheckStatusTool.name,
          toolVersion: systemCheckStatusTool.version,
          riskLevel: systemCheckStatusTool.riskLevel,
          input,
          output,
          status: output.ok ? 'succeeded' : 'failed',
          durationMs: Date.now() - startedAt,
          finishedAt: new Date()
        })

        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'tool',
          status: output.ok ? 'succeeded' : 'failed',
          payload: { toolName: systemCheckStatusTool.name, input, output },
          durationMs: Date.now() - startedAt
        })

        await appendAssistantMessage(db, identity, params.conversationId, {
          content: statusMessage
        })

        reply.raw.write(`event: tool\ndata: ${JSON.stringify({ name: systemCheckStatusTool.name, status: output.ok ? 'succeeded' : 'failed', output })}\n\n`)
        reply.raw.write(`data: ${JSON.stringify({ delta: statusMessage })}\n\n`)
        reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: output.ok })}\n\n`)
        reply.raw.end()
        return reply
      }

      let assistantContent = ''
      let firstDeltaMs: number | undefined
      let deltaCount = 0
      const modelStartedAt = Date.now()

      try {
        for await (const chunk of modelProvider.streamChat({
          task: 'chat',
          messages: buildChatContext(conversationSummary, history),
          traceId: userMessage.traceId,
          userId: identity.externalUserId
        })) {
          if (firstDeltaMs === undefined) {
            firstDeltaMs = Date.now() - modelStartedAt
          }

          deltaCount += 1
          assistantContent += chunk
          reply.raw.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`)
        }

        const chatProfile = modelProvider.getProfile('chat')

        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'model',
          status: 'succeeded',
          payload: {
            task: 'chat',
            model: chatProfile.model,
            provider: chatProfile.provider,
            firstDeltaMs: firstDeltaMs ?? null,
            deltaCount,
            contentLength: assistantContent.length
          },
          durationMs: Date.now() - modelStartedAt
        })

        await appendAssistantMessage(db, identity, params.conversationId, {
          content: assistantContent
        })

        await refreshConversationSummary({
          db,
          modelProvider,
          identity,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          traceId: userMessage.traceId,
          currentSummary: conversationSummary,
          history: [
            ...history,
            {
              role: 'assistant',
              content: assistantContent
            }
          ]
        })

        reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
      } catch (error) {
        const chatProfile = modelProvider.getProfile('chat')

        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'model',
          status: 'failed',
          payload: {
            task: 'chat',
            model: chatProfile.model,
            provider: chatProfile.provider,
            firstDeltaMs: firstDeltaMs ?? null,
            deltaCount,
            contentLength: assistantContent.length
          },
          error: errorPayload(error),
          durationMs: Date.now() - modelStartedAt
        })

        if (error instanceof ModelProviderError) {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: error.code, message: error.message })}\n\n`)
        } else {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: 'MODEL_PROVIDER_STREAM_FAILED', message: 'Assistant reply failed.' })}\n\n`)
        }
      }

      reply.raw.end()
      return reply
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      if (error instanceof ModelProviderError) {
        return sendModelProviderError(reply, error)
      }

      throw error
    }
  })

  server.get('/v1/conversations/:conversationId/traces', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)
      const params = request.params as { conversationId: string }
      const [conversation] = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(matchConversationOwner(identity, params.conversationId))
        .limit(1)

      if (!conversation) {
        return reply.status(404).send({
          error: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation was not found.'
        })
      }

      const traces = await db
        .select({
          id: schema.agentTraces.id,
          traceId: schema.agentTraces.traceId,
          conversationId: schema.agentTraces.conversationId,
          messageId: schema.agentTraces.messageId,
          phase: schema.agentTraces.phase,
          status: schema.agentTraces.status,
          payload: schema.agentTraces.payload,
          error: schema.agentTraces.error,
          startedAt: schema.agentTraces.startedAt,
          finishedAt: schema.agentTraces.finishedAt,
          durationMs: schema.agentTraces.durationMs
        })
        .from(schema.agentTraces)
        .where(and(eq(schema.agentTraces.appId, identity.appId), eq(schema.agentTraces.conversationId, params.conversationId)))
        .orderBy(asc(schema.agentTraces.startedAt))

      return {
        traces
      }
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })

  server.get('/v1/conversations/:conversationId/messages', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)
      const params = request.params as { conversationId: string }
      const messages = await getConversationMessages(db, identity, params.conversationId)

      if (!messages) {
        return reply.status(404).send({
          error: 'CONVERSATION_NOT_FOUND',
          message: 'Conversation was not found.'
        })
      }

      return {
        messages
      }
    } catch (error) {
      if (error instanceof HostTokenError) {
        return sendHostTokenError(reply, error)
      }

      throw error
    }
  })

  return server
}
