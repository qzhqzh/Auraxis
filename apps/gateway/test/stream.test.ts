import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'bun:test'

import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { signHostToken } from '../src/auth.js'
import type { AppConfig } from '../src/config.js'
import { createDatabaseClient } from '../src/db/client.js'
import type { ModelProvider } from '../src/model.js'
import type { IntentRouter } from '../src/router.js'
import { buildServer } from '../src/server.js'

const secret = '12345678901234567890123456789012'

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgres://auraxis:change-me-local-dev@postgres:5432/auraxis',
  deepSeekBaseUrl: 'https://api.deepseek.com',
  deepSeekModel: 'deepseek-v4-flash',
  hostTokenIssuer: 'auraxis-dev-host',
  hostTokenSecret: secret
}

async function withServer(
  modelProvider: ModelProvider,
  run: (server: FastifyInstance) => Promise<void>,
  intentRouter?: IntentRouter
) {
  const server = buildServer(config, { modelProvider, intentRouter })
  await server.ready()

  try {
    await run(server)
  } finally {
    await server.close()
  }
}

function createToken(appId: string, externalUserId: string, tenantId = 'hospital_a') {
  const now = Math.floor(Date.now() / 1000)

  return signHostToken(
    {
      app_id: appId,
      external_user_id: externalUserId,
      display_name: externalUserId,
      tenant_id: tenantId,
      roles: ['report_viewer'],
      permissions: ['assistant:chat'],
      iat: now,
      exp: now + 300,
      issuer: config.hostTokenIssuer
    },
    secret
  )
}

async function cleanupAppData(appId: string) {
  const { db, pool } = createDatabaseClient(config)

  try {
    await db.execute(sql`delete from messages where conversation_id in (select id from conversations where app_id = ${appId})`)
    await db.execute(sql`delete from conversations where app_id = ${appId}`)
  } finally {
    await pool.end()
  }
}

test('message stream route writes user and assistant messages and returns sse chunks', async () => {
  const appId = `stream-test-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  const provider: ModelProvider = {
    async *streamChat() {
      yield 'Hello'
      yield ' world'
    }
  }

  await cleanupAppData(appId)

  try {
    await withServer(provider, async (server) => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          pageTitle: 'Stream Test'
        }
      })

      assert.equal(createResponse.statusCode, 201)
      const conversationId = createResponse.json().conversation.id as string

      const streamResponse = await server.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/messages:stream`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          content: 'Hi assistant'
        }
      })

      assert.equal(streamResponse.statusCode, 200)
      assert.equal(streamResponse.headers['content-type'], 'text/event-stream; charset=utf-8')
      assert.match(streamResponse.body, /event: route/)
      assert.match(streamResponse.body, /data: {"delta":"Hello"}/)
      assert.match(streamResponse.body, /data: {"delta":" world"}/)
      assert.match(streamResponse.body, /event: done/)

      const messagesResponse = await server.inject({
        method: 'GET',
        url: `/v1/conversations/${conversationId}/messages`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(messagesResponse.statusCode, 200)
      const messages = messagesResponse.json().messages as Array<{ role: string; content: string }>
      assert.equal(messages.length, 2)
      assert.equal(messages[0]?.role, 'user')
      assert.equal(messages[0]?.content, 'Hi assistant')
      assert.equal(messages[1]?.role, 'assistant')
      assert.equal(messages[1]?.content, 'Hello world')
    })
  } finally {
    await cleanupAppData(appId)
  }
})

test('message stream route asks a follow-up when router confidence is low', async () => {
  const appId = `stream-follow-up-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  const provider: ModelProvider = {
    async *streamChat() {
      yield 'should-not-run'
    }
  }
  const intentRouter: IntentRouter = {
    async route() {
      return {
        intent: 'unknown',
        entities: {},
        confidence: 0.2,
        requiresTool: false,
        candidateTools: [],
        source: 'model'
      }
    }
  }

  await cleanupAppData(appId)

  try {
    await withServer(
      provider,
      async (server) => {
        const createResponse = await server.inject({
          method: 'POST',
          url: '/v1/conversations',
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          },
          payload: {
            pageTitle: 'Follow Up Test'
          }
        })

        assert.equal(createResponse.statusCode, 201)
        const conversationId = createResponse.json().conversation.id as string

        const streamResponse = await server.inject({
          method: 'POST',
          url: `/v1/conversations/${conversationId}/messages:stream`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          },
          payload: {
            content: '你先帮我处理一下'
          }
        })

        assert.equal(streamResponse.statusCode, 200)
        assert.match(streamResponse.body, /event: route/)
        assert.match(streamResponse.body, /普通咨询，还是想检查 gateway 的状态/)
        assert.doesNotMatch(streamResponse.body, /should-not-run/)

        const messagesResponse = await server.inject({
          method: 'GET',
          url: `/v1/conversations/${conversationId}/messages`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          }
        })

        assert.equal(messagesResponse.statusCode, 200)
        const messages = messagesResponse.json().messages as Array<{ role: string; content: string }>
        assert.equal(messages.length, 2)
        assert.equal(messages[1]?.role, 'assistant')
        assert.match(messages[1]?.content ?? '', /普通咨询，还是想检查 gateway 的状态/)
      },
      intentRouter
    )
  } finally {
    await cleanupAppData(appId)
  }
})
