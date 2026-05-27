import cors from '@fastify/cors'
import { and, asc, eq, sql } from 'drizzle-orm'
import Fastify from 'fastify'
import type { FastifyReply } from 'fastify'
import { z } from 'zod'

import { HostTokenError, authenticateHostRequest } from './auth.js'
import type { AppConfig } from './config.js'
import {
  appendAssistantMessage,
  appendConversationMessage,
  createConversation,
  getConversationMessages,
  listConversations
} from './conversations.js'
import { createDatabaseClient } from './db/client.js'
import * as schema from './db/schema.js'
import { createDeepSeekModelProvider, ModelProvider, ModelProviderError } from './model.js'
import { createDeepSeekIntentRouter, IntentRouter, shouldAskRouteFollowUp } from './router.js'

const GATEWAY_VERSION = '0.1.0'
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

const systemCheckStatusTool = {
  name: 'system.check_status',
  version: '1.0.0',
  type: 'internal' as const,
  description: 'Checks Auraxis runtime status for gateway and database diagnostics.',
  riskLevel: 'diagnostic' as const,
  enabled: true,
  requiredPermissions: ['tool:system.check_status'],
  timeoutMs: 5000,
  maxOutputChars: 4000,
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['gateway', 'database', 'all']
      }
    },
    required: ['target'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      target: { type: 'string' },
      summary: { type: 'string' },
      checks: { type: 'array' }
    },
    required: ['ok', 'target', 'summary', 'checks']
  }
}

type SystemCheckTarget = 'gateway' | 'database' | 'all'

type SystemCheckOutput = {
  ok: boolean
  target: SystemCheckTarget
  summary: string
  checks: Array<{
    name: 'gateway' | 'database'
    ok: boolean
    summary: string
    details?: Record<string, unknown>
  }>
}

function normalizeSystemCheckTarget(value: string | undefined): SystemCheckTarget {
  if (value === 'gateway' || value === 'database' || value === 'all') {
    return value
  }

  return 'all'
}

function canExecuteSystemCheck(permissions: string[]) {
  return systemCheckStatusTool.requiredPermissions.every((permission) => permissions.includes(permission))
}

async function runSystemCheckStatus(
  db: ReturnType<typeof createDatabaseClient>['db'],
  target: SystemCheckTarget
): Promise<SystemCheckOutput> {
  const checks: SystemCheckOutput['checks'] = []

  if (target === 'gateway' || target === 'all') {
    checks.push({
      name: 'gateway',
      ok: true,
      summary: `Gateway is running version ${GATEWAY_VERSION}.`,
      details: {
        version: GATEWAY_VERSION,
        time: new Date().toISOString()
      }
    })
  }

  if (target === 'database' || target === 'all') {
    try {
      await db.execute(sql`select 1`)
      checks.push({
        name: 'database',
        ok: true,
        summary: 'Database query succeeded.'
      })
    } catch (error) {
      checks.push({
        name: 'database',
        ok: false,
        summary: 'Database query failed.',
        details: {
          message: error instanceof Error ? error.message : 'Unknown database error.'
        }
      })
    }
  }

  const ok = checks.every((check) => check.ok)

  return {
    ok,
    target,
    summary: ok ? 'System status check completed successfully.' : 'System status check found a problem.',
    checks
  }
}

function formatSystemCheckResult(output: SystemCheckOutput) {
  const checkLines = output.checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.summary}`)

  return [`系统状态检查完成：${output.ok ? '正常' : '存在异常'}`, ...checkLines].join('\n')
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
  const intentRouter = options.intentRouter ?? createDeepSeekIntentRouter(config)

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
        tools: [systemCheckStatusTool]
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
        messages: history.map((message) => ({
          role: message.role,
          content: message.content
        }))
      })

      await writeAgentTrace(db, {
        traceId: userMessage.traceId,
        appId: identity.appId,
        conversationId: params.conversationId,
        messageId: userMessage.id,
        phase: 'router',
        status: 'succeeded',
        payload: { route },
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

      if (route.requiresTool && route.candidateTools.includes(systemCheckStatusTool.name)) {
        const target = normalizeSystemCheckTarget(route.entities.target)
        const input = { target }
        const startedAt = Date.now()

        if (!canExecuteSystemCheck(identity.permissions)) {
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

        const output = await runSystemCheckStatus(db, target)
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
      const modelStartedAt = Date.now()

      try {
        for await (const chunk of modelProvider.streamChat({
          messages: history.map((message) => ({
            role: message.role,
            content: message.content
          })),
          traceId: userMessage.traceId,
          userId: identity.externalUserId
        })) {
          assistantContent += chunk
          reply.raw.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`)
        }

        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'model',
          status: 'succeeded',
          payload: { model: config.deepSeekModel, contentLength: assistantContent.length },
          durationMs: Date.now() - modelStartedAt
        })

        await appendAssistantMessage(db, identity, params.conversationId, {
          content: assistantContent
        })

        reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
      } catch (error) {
        await writeAgentTrace(db, {
          traceId: userMessage.traceId,
          appId: identity.appId,
          conversationId: params.conversationId,
          messageId: userMessage.id,
          phase: 'model',
          status: 'failed',
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
