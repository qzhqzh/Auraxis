import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'bun:test'

import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { signHostToken } from '../src/auth.js'
import type { AppConfig } from '../src/config.js'
import { createDatabaseClient } from '../src/db/client.js'
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
  modelProfiles: {
    router: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash'
    },
    chat: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro'
    }
  },
  hostTokenIssuer: 'auraxis-dev-host',
  hostTokenSecret: secret
}

async function withServer(run: (server: FastifyInstance) => Promise<void>) {
  const server = buildServer(config)
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

test('conversation endpoints isolate data by authenticated user', async () => {
  const appId = `conversation-test-${randomUUID()}`
  const userAToken = createToken(appId, 'user-a')
  const userBToken = createToken(appId, 'user-b')

  await cleanupAppData(appId)

  try {
    await withServer(async (server) => {
      const createResponse = await server.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${userAToken}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          pageTitle: 'Clinical Report',
          sourceUrl: 'https://example.com/reports/123',
          initialMessage: 'Check this report'
        }
      })

      assert.equal(createResponse.statusCode, 201)
      const createdConversation = createResponse.json().conversation as { id: string; appId: string; externalUserId: string }

      assert.equal(createdConversation.appId, appId)
      assert.equal(createdConversation.externalUserId, 'user-a')

      const appendResponse = await server.inject({
        method: 'POST',
        url: `/v1/conversations/${createdConversation.id}/messages`,
        headers: {
          authorization: `Bearer ${userAToken}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          content: 'Follow up question'
        }
      })

      assert.equal(appendResponse.statusCode, 201)
      assert.equal(appendResponse.json().message.content, 'Follow up question')

      const listOwnResponse = await server.inject({
        method: 'GET',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${userAToken}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(listOwnResponse.statusCode, 200)
      const ownConversations = listOwnResponse.json().conversations as Array<{ id: string }>
      assert.equal(ownConversations.length, 1)
      assert.equal(ownConversations[0]?.id, createdConversation.id)

      const ownMessagesResponse = await server.inject({
        method: 'GET',
        url: `/v1/conversations/${createdConversation.id}/messages`,
        headers: {
          authorization: `Bearer ${userAToken}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(ownMessagesResponse.statusCode, 200)
      const ownMessages = ownMessagesResponse.json().messages as Array<{ role: string; content: string }>
      assert.equal(ownMessages.length, 2)
      assert.equal(ownMessages[0]?.role, 'user')
      assert.equal(ownMessages[0]?.content, 'Check this report')
      assert.equal(ownMessages[1]?.content, 'Follow up question')

      const listOtherResponse = await server.inject({
        method: 'GET',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${userBToken}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(listOtherResponse.statusCode, 200)
      assert.deepEqual(listOtherResponse.json(), {
        conversations: []
      })

      const otherAppendResponse = await server.inject({
        method: 'POST',
        url: `/v1/conversations/${createdConversation.id}/messages`,
        headers: {
          authorization: `Bearer ${userBToken}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          content: 'Intrude'
        }
      })

      assert.equal(otherAppendResponse.statusCode, 404)
      assert.deepEqual(otherAppendResponse.json(), {
        error: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation was not found.'
      })

      const otherMessagesResponse = await server.inject({
        method: 'GET',
        url: `/v1/conversations/${createdConversation.id}/messages`,
        headers: {
          authorization: `Bearer ${userBToken}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(otherMessagesResponse.statusCode, 404)
      assert.deepEqual(otherMessagesResponse.json(), {
        error: 'CONVERSATION_NOT_FOUND',
        message: 'Conversation was not found.'
      })
    })
  } finally {
    await cleanupAppData(appId)
  }
})


test('conversation list orders by latest message activity', async () => {
  const appId = `conversation-order-${randomUUID()}`
  const token = createToken(appId, 'user-a')

  await cleanupAppData(appId)

  try {
    await withServer(async (server) => {
      const firstResponse = await server.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          pageTitle: 'First Conversation'
        }
      })
      const firstId = firstResponse.json().conversation.id as string

      await new Promise((resolve) => setTimeout(resolve, 10))

      const secondResponse = await server.inject({
        method: 'POST',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          pageTitle: 'Second Conversation'
        }
      })
      const secondId = secondResponse.json().conversation.id as string

      const initialListResponse = await server.inject({
        method: 'GET',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(initialListResponse.statusCode, 200)
      let conversations = initialListResponse.json().conversations as Array<{ id: string }>
      assert.equal(conversations[0]?.id, secondId)

      await new Promise((resolve) => setTimeout(resolve, 10))

      const appendResponse = await server.inject({
        method: 'POST',
        url: `/v1/conversations/${firstId}/messages`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        },
        payload: {
          content: 'Make first active again'
        }
      })

      assert.equal(appendResponse.statusCode, 201)

      const refreshedListResponse = await server.inject({
        method: 'GET',
        url: '/v1/conversations',
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(refreshedListResponse.statusCode, 200)
      conversations = refreshedListResponse.json().conversations as Array<{ id: string }>
      assert.equal(conversations[0]?.id, firstId)
    })
  } finally {
    await cleanupAppData(appId)
  }
})
