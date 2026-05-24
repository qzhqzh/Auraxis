import { randomUUID } from 'node:crypto'

import { loadConfig } from '../config.js'
import { createDatabaseClient } from './client.js'
import { assistantApps, conversations, messages, toolCalls, toolDefinitions } from './schema.js'

const config = loadConfig()
const { db, pool } = createDatabaseClient(config)
const suffix = randomUUID().slice(0, 8)
const appId = `smoke-${suffix}`
const externalUserId = `smoke-user-${suffix}`
const tenantId = 'smoke-tenant'
const traceId = randomUUID()
const toolName = `smoke.check_status.${suffix}`

try {
  const [app] = await db
    .insert(assistantApps)
    .values({
      appId,
      name: 'Auraxis Smoke App'
    })
    .returning({ id: assistantApps.id })

  const [conversation] = await db
    .insert(conversations)
    .values({
      appId,
      tenantId,
      externalUserId,
      sourceUrl: 'http://localhost/smoke',
      pageTitle: 'Smoke Check',
      traceId
    })
    .returning({ id: conversations.id })

  const [message] = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      role: 'user',
      content: 'Smoke check message',
      traceId
    })
    .returning({ id: messages.id })

  const [toolDefinition] = await db
    .insert(toolDefinitions)
    .values({
      name: toolName,
      version: '1.0.0',
      type: 'script',
      description: 'Smoke check diagnostic tool definition.',
      riskLevel: 'diagnostic',
      requiredPermissions: ['tool:demo.check_status'],
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['demo'] }
        },
        required: ['target'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' }
        },
        required: ['ok', 'summary']
      }
    })
    .returning({ id: toolDefinitions.id })

  const [toolCall] = await db
    .insert(toolCalls)
    .values({
      conversationId: conversation.id,
      messageId: message.id,
      traceId,
      appId,
      tenantId,
      externalUserId,
      toolName,
      toolVersion: '1.0.0',
      riskLevel: 'diagnostic',
      input: { target: 'demo' },
      output: { ok: true, summary: 'Smoke check completed.' },
      status: 'succeeded',
      durationMs: 1,
      finishedAt: new Date()
    })
    .returning({ id: toolCalls.id })

  console.log(
    JSON.stringify(
      {
        ok: true,
        appId: app.id,
        conversationId: conversation.id,
        messageId: message.id,
        toolDefinitionId: toolDefinition.id,
        toolCallId: toolCall.id,
        traceId
      },
      null,
      2
    )
  )
} finally {
  await pool.end()
}
