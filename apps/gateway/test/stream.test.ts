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
const testModelProfile = { provider: 'deepseek' as const, model: 'test-model' }

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

function createToken(appId: string, externalUserId: string, tenantId = 'hospital_a', permissions = ['assistant:chat']) {
  const now = Math.floor(Date.now() / 1000)

  return signHostToken(
    {
      app_id: appId,
      external_user_id: externalUserId,
      display_name: externalUserId,
      tenant_id: tenantId,
      roles: ['report_viewer'],
      permissions,
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
    await db.execute(sql`delete from agent_traces where app_id = ${appId}`)
    await db.execute(sql`delete from tool_calls where app_id = ${appId}`)
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
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return {
        intent: 'general_chat',
        confidence: 0.9,
        requires_tool: false,
        candidate_tools: [],
        entities: {}
      }
    },
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

      const tracesResponse = await server.inject({
        method: 'GET',
        url: `/v1/conversations/${conversationId}/traces`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(tracesResponse.statusCode, 200)
      const traces = tracesResponse.json().traces as Array<{ phase: string; status: string; payload?: Record<string, unknown> }>
      assert.deepEqual(
        traces.map((trace) => `${trace.phase}:${trace.status}`),
        ['router:succeeded', 'model:succeeded']
      )
      const modelPayload = traces[1]?.payload as { contentLength?: number; deltaCount?: number; firstDeltaMs?: number } | undefined
      assert.equal(modelPayload?.contentLength, 'Hello world'.length)
      assert.equal(modelPayload?.deltaCount, 2)
      assert.equal(typeof modelPayload?.firstDeltaMs, 'number')
    })
  } finally {
    await cleanupAppData(appId)
  }
})

test('message stream sends summary plus recent message window to chat model', async () => {
  const appId = `stream-window-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  let chatMessages: Array<{ role: string; content: string }> = []
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return { summary: 'unused' }
    },
    async *streamChat(input) {
      chatMessages = input.messages
      yield 'windowed reply'
    }
  }
  const intentRouter: IntentRouter = {
    async route() {
      return {
        intent: 'general_chat',
        entities: {},
        confidence: 0.9,
        requiresTool: false,
        candidateTools: [],
        source: 'rule'
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
            pageTitle: 'Window Test'
          }
        })
        assert.equal(createResponse.statusCode, 201)
        const conversationId = createResponse.json().conversation.id as string

        const { db, pool } = createDatabaseClient(config)
        try {
          await db.execute(sql`update conversations set summary = 'Earlier summary for windowing.' where id = ${conversationId}`)
        } finally {
          await pool.end()
        }

        for (let index = 1; index <= 25; index += 1) {
          const appendResponse = await server.inject({
            method: 'POST',
            url: `/v1/conversations/${conversationId}/messages`,
            headers: {
              authorization: `Bearer ${token}`,
              'x-auraxis-app-id': appId
            },
            payload: {
              content: `history ${index}`
            }
          })
          assert.equal(appendResponse.statusCode, 201)
        }

        const streamResponse = await server.inject({
          method: 'POST',
          url: `/v1/conversations/${conversationId}/messages:stream`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          },
          payload: {
            content: 'current message'
          }
        })

        assert.equal(streamResponse.statusCode, 200)
        assert.equal(chatMessages.length, 21)
        assert.equal(chatMessages[0]?.role, 'system')
        assert.match(chatMessages[0]?.content ?? '', /Earlier summary for windowing/)
        assert.equal(chatMessages[1]?.content, 'history 7')
        assert.equal(chatMessages.at(-1)?.content, 'current message')
        assert.equal(chatMessages.some((message) => message.content === 'history 1'), false)
      },
      intentRouter
    )
  } finally {
    await cleanupAppData(appId)
  }
})

test('message stream refreshes conversation summary after long chats without blocking done', async () => {
  const appId = `stream-summary-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  let summaryTaskUsed = false
  let releaseSummary: () => void = () => undefined
  const summaryRelease = new Promise<void>((resolve) => {
    releaseSummary = resolve
  })
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson(input) {
      summaryTaskUsed = input.task === 'summary'
      await summaryRelease
      return { summary: 'User has been discussing a long support case.' }
    },
    async *streamChat() {
      yield 'summary reply'
    }
  }
  const intentRouter: IntentRouter = {
    async route() {
      return {
        intent: 'general_chat',
        entities: {},
        confidence: 0.9,
        requiresTool: false,
        candidateTools: [],
        source: 'rule'
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
            pageTitle: 'Summary Test'
          }
        })
        assert.equal(createResponse.statusCode, 201)
        const conversationId = createResponse.json().conversation.id as string

        for (let index = 1; index <= 11; index += 1) {
          const appendResponse = await server.inject({
            method: 'POST',
            url: `/v1/conversations/${conversationId}/messages`,
            headers: {
              authorization: `Bearer ${token}`,
              'x-auraxis-app-id': appId
            },
            payload: {
              content: `prior message ${index}`
            }
          })
          assert.equal(appendResponse.statusCode, 201)
        }

        const streamResponse = await server.inject({
          method: 'POST',
          url: `/v1/conversations/${conversationId}/messages:stream`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          },
          payload: {
            content: 'trigger summary'
          }
        })

        assert.equal(streamResponse.statusCode, 200)
        assert.match(streamResponse.body, /event: done/)
        assert.equal(summaryTaskUsed, true)

        const { db, pool } = createDatabaseClient(config)
        try {
          const beforeRelease = await db.execute(sql`select summary from conversations where id = ${conversationId}`)
          assert.equal(beforeRelease.rows[0]?.summary, null)

          releaseSummary()

          let summary = null
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const result = await db.execute(sql`select summary from conversations where id = ${conversationId}`)
            summary = result.rows[0]?.summary ?? null
            if (summary === 'User has been discussing a long support case.') {
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          assert.equal(summary, 'User has been discussing a long support case.')
        } finally {
          await pool.end()
        }

        const tracesResponse = await server.inject({
          method: 'GET',
          url: `/v1/conversations/${conversationId}/traces`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          }
        })
        assert.equal(tracesResponse.statusCode, 200)
        const traces = tracesResponse.json().traces as Array<{ phase: string; status: string; payload?: Record<string, unknown> }>
        assert.deepEqual(
          traces.map((trace) => `${trace.phase}:${trace.status}`),
          ['router:succeeded', 'model:succeeded', 'summary:succeeded']
        )
        assert.equal((traces[2]?.payload as { task?: string } | undefined)?.task, 'summary')
      },
      intentRouter
    )
  } finally {
    releaseSummary()
    await cleanupAppData(appId)
  }
})

test('message stream does not promise unsupported reminders or memory', async () => {
  const appId = `unsupported-reminder-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return {
        intent: 'general_chat',
        confidence: 0.9,
        requires_tool: false,
        candidate_tools: [],
        entities: {}
      }
    },
    async *streamChat() {
      yield 'should-not-run'
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
          pageTitle: 'Unsupported Reminder Test'
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
          content: '记住提醒我周末去买菜'
        }
      })

      assert.equal(streamResponse.statusCode, 200)
      assert.match(streamResponse.body, /没有长期记忆、定时提醒或主动推送功能/)
      assert.match(streamResponse.body, /event: done/)
      assert.doesNotMatch(streamResponse.body, /should-not-run/)
      assert.doesNotMatch(streamResponse.body, /我会记住/)

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
      assert.equal(messages[1]?.role, 'assistant')
      assert.match(messages[1]?.content ?? '', /没有长期记忆、定时提醒或主动推送功能/)

      const tracesResponse = await server.inject({
        method: 'GET',
        url: `/v1/conversations/${conversationId}/traces`,
        headers: {
          authorization: `Bearer ${token}`,
          'x-auraxis-app-id': appId
        }
      })

      assert.equal(tracesResponse.statusCode, 200)
      const traces = tracesResponse.json().traces as Array<{ phase: string; status: string; payload?: Record<string, unknown> }>
      assert.deepEqual(
        traces.map((trace) => `${trace.phase}:${trace.status}`),
        ['router:succeeded', 'model:succeeded']
      )
      assert.deepEqual(traces[1]?.payload, { skipped: true, reason: 'unsupported_reminder_memory' })
    })
  } finally {
    await cleanupAppData(appId)
  }
})

test('message stream route asks a follow-up when router confidence is low', async () => {
  const appId = `stream-follow-up-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return {
        intent: 'general_chat',
        confidence: 0.9,
        requires_tool: false,
        candidate_tools: [],
        entities: {}
      }
    },
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


test('tools endpoint lists system check tool for authenticated users', async () => {
  const appId = `tools-list-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return {
        intent: 'general_chat',
        confidence: 0.9,
        requires_tool: false,
        candidate_tools: [],
        entities: {}
      }
    },
    async *streamChat() {
      yield 'unused'
    }
  }

  await withServer(provider, async (server) => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/tools',
      headers: {
        authorization: `Bearer ${token}`,
        'x-auraxis-app-id': appId
      }
    })

    assert.equal(response.statusCode, 200)
    const tools = response.json().tools as Array<{ name: string; riskLevel: string; requiredPermissions: string[] }>
    assert.equal(tools[0]?.name, 'system.check_status')
    assert.equal(tools[0]?.riskLevel, 'diagnostic')
    assert.deepEqual(tools[0]?.requiredPermissions, ['tool:system.check_status'])
  })
})

test('message stream executes system check tool and records tool call', async () => {
  const appId = `system-check-${randomUUID()}`
  const token = createToken(appId, 'user-a', 'hospital_a', ['assistant:chat', 'tool:system.check_status'])
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return {
        intent: 'general_chat',
        confidence: 0.9,
        requires_tool: false,
        candidate_tools: [],
        entities: {}
      }
    },
    async *streamChat() {
      yield 'should-not-run'
    }
  }
  const intentRouter: IntentRouter = {
    async route() {
      return {
        intent: 'system_check_status',
        entities: {
          target: 'gateway'
        },
        confidence: 0.96,
        requiresTool: true,
        candidateTools: ['system.check_status'],
        source: 'rule'
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
            pageTitle: 'Tool Test'
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
            content: '检查 gateway 状态'
          }
        })

        assert.equal(streamResponse.statusCode, 200)
        assert.match(streamResponse.body, /event: tool/)
        assert.match(streamResponse.body, /system\.check_status/)
        assert.match(streamResponse.body, /系统状态检查完成：正常/)
        assert.doesNotMatch(streamResponse.body, /should-not-run/)

        const { db, pool } = createDatabaseClient(config)

        try {
          const calls = await db.execute(sql`select tool_name, status, input from tool_calls where app_id = ${appId}`)
          assert.equal(calls.rows.length, 1)
          assert.equal(calls.rows[0]?.tool_name, 'system.check_status')
          assert.equal(calls.rows[0]?.status, 'succeeded')
          assert.deepEqual(calls.rows[0]?.input, { target: 'gateway' })
        } finally {
          await pool.end()
        }

        const tracesResponse = await server.inject({
          method: 'GET',
          url: `/v1/conversations/${conversationId}/traces`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          }
        })

        assert.equal(tracesResponse.statusCode, 200)
        const traces = tracesResponse.json().traces as Array<{ phase: string; status: string; payload?: Record<string, unknown> }>
        assert.deepEqual(
          traces.map((trace) => `${trace.phase}:${trace.status}`),
          ['router:succeeded', 'tool:succeeded']
        )
        assert.equal((traces[1]?.payload as { toolName?: string } | undefined)?.toolName, 'system.check_status')
      },
      intentRouter
    )
  } finally {
    await cleanupAppData(appId)
  }
})

test('message stream denies system check without permission', async () => {
  const appId = `system-check-denied-${randomUUID()}`
  const token = createToken(appId, 'user-a')
  const provider: ModelProvider = {
    getProfile() {
      return testModelProfile
    },
    async generateJson() {
      return {
        intent: 'general_chat',
        confidence: 0.9,
        requires_tool: false,
        candidate_tools: [],
        entities: {}
      }
    },
    async *streamChat() {
      yield 'should-not-run'
    }
  }
  const intentRouter: IntentRouter = {
    async route() {
      return {
        intent: 'system_check_status',
        entities: {
          target: 'gateway'
        },
        confidence: 0.96,
        requiresTool: true,
        candidateTools: ['system.check_status'],
        source: 'rule'
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
            pageTitle: 'Tool Denied Test'
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
            content: '检查 gateway 状态'
          }
        })

        assert.equal(streamResponse.statusCode, 200)
        assert.match(streamResponse.body, /status":"denied/)
        assert.match(streamResponse.body, /没有权限执行 system\.check_status/)
        assert.doesNotMatch(streamResponse.body, /should-not-run/)

        const { db, pool } = createDatabaseClient(config)

        try {
          const calls = await db.execute(sql`select tool_name, status, error_code from tool_calls where app_id = ${appId}`)
          assert.equal(calls.rows.length, 1)
          assert.equal(calls.rows[0]?.tool_name, 'system.check_status')
          assert.equal(calls.rows[0]?.status, 'denied')
          assert.equal(calls.rows[0]?.error_code, 'TOOL_PERMISSION_DENIED')
        } finally {
          await pool.end()
        }

        const tracesResponse = await server.inject({
          method: 'GET',
          url: `/v1/conversations/${conversationId}/traces`,
          headers: {
            authorization: `Bearer ${token}`,
            'x-auraxis-app-id': appId
          }
        })

        assert.equal(tracesResponse.statusCode, 200)
        const traces = tracesResponse.json().traces as Array<{ phase: string; status: string; error?: Record<string, unknown> }>
        assert.deepEqual(
          traces.map((trace) => `${trace.phase}:${trace.status}`),
          ['router:succeeded', 'tool:failed']
        )
        assert.equal((traces[1]?.error as { code?: string } | undefined)?.code, 'TOOL_PERMISSION_DENIED')
      },
      intentRouter
    )
  } finally {
    await cleanupAppData(appId)
  }
})
