import cors from '@fastify/cors'
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
import { createDeepSeekModelProvider, ModelProvider, ModelProviderError } from './model.js'

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

      reply.hijack()
      reply.raw.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8'
      })

      let assistantContent = ''

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

        await appendAssistantMessage(db, identity, params.conversationId, {
          content: assistantContent
        })

        reply.raw.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`)
      } catch (error) {
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
