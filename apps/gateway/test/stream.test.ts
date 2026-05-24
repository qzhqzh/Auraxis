import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'bun:test'

import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { signHostToken } from '../src/auth.js'
import type { AppConfig } from '../src/config.js'
import { createDatabaseClient } from '../src/db/client.js'
import type { ModelProvider } from '../src/model.js'
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

async function withServer(modelProvider: ModelProvider, run: (server: FastifyInstance) => Promise<void>) {
  const server = buildServer(config, { modelProvider })
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
      assert.match(streamResponse.body, /data: {\"delta\":\"Hello\"}/)
      assert.match(streamResponse.body, /data: {\"delta\":\" world\"}/)
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
