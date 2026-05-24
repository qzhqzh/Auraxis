import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, isNull } from 'drizzle-orm'

import type { AssistantUserIdentity } from './auth.js'
import * as schema from './db/schema.js'
import type { createDatabaseClient } from './db/client.js'

type Database = ReturnType<typeof createDatabaseClient>['db']

export type CreateConversationInput = {
  pageTitle?: string
  sourceUrl?: string
  metadata?: Record<string, unknown>
  initialMessage?: string
}

export type AppendMessageInput = {
  content: string
}

function matchConversationOwner(identity: AssistantUserIdentity) {
  return and(
    eq(schema.conversations.appId, identity.appId),
    eq(schema.conversations.externalUserId, identity.externalUserId),
    identity.tenantId ? eq(schema.conversations.tenantId, identity.tenantId) : isNull(schema.conversations.tenantId)
  )
}

export async function createConversation(
  db: Database,
  identity: AssistantUserIdentity,
  input: CreateConversationInput
) {
  const traceId = randomUUID()

  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(schema.conversations)
      .values({
        appId: identity.appId,
        tenantId: identity.tenantId,
        externalUserId: identity.externalUserId,
        pageTitle: input.pageTitle,
        sourceUrl: input.sourceUrl,
        traceId,
        metadata: input.metadata ?? {}
      })
      .returning({
        id: schema.conversations.id,
        appId: schema.conversations.appId,
        tenantId: schema.conversations.tenantId,
        externalUserId: schema.conversations.externalUserId,
        sourceUrl: schema.conversations.sourceUrl,
        pageTitle: schema.conversations.pageTitle,
        status: schema.conversations.status,
        createdAt: schema.conversations.createdAt,
        updatedAt: schema.conversations.updatedAt
      })

    if (input.initialMessage) {
      await tx.insert(schema.messages).values({
        conversationId: conversation.id,
        role: 'user',
        content: input.initialMessage,
        traceId
      })
    }

    return conversation
  })
}

export async function listConversations(db: Database, identity: AssistantUserIdentity) {
  return db
    .select({
      id: schema.conversations.id,
      appId: schema.conversations.appId,
      tenantId: schema.conversations.tenantId,
      externalUserId: schema.conversations.externalUserId,
      sourceUrl: schema.conversations.sourceUrl,
      pageTitle: schema.conversations.pageTitle,
      status: schema.conversations.status,
      createdAt: schema.conversations.createdAt,
      updatedAt: schema.conversations.updatedAt
    })
    .from(schema.conversations)
    .where(matchConversationOwner(identity))
    .orderBy(desc(schema.conversations.updatedAt), desc(schema.conversations.createdAt))
}

export async function appendConversationMessage(
  db: Database,
  identity: AssistantUserIdentity,
  conversationId: string,
  input: AppendMessageInput
) {
  const [conversation] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId), matchConversationOwner(identity)))
    .limit(1)

  if (!conversation) {
    return null
  }

  const traceId = randomUUID()
  const [message] = await db
    .insert(schema.messages)
    .values({
      conversationId,
      role: 'user',
      content: input.content,
      traceId
    })
    .returning({
      id: schema.messages.id,
      conversationId: schema.messages.conversationId,
      role: schema.messages.role,
      content: schema.messages.content,
      contentType: schema.messages.contentType,
      structuredPayload: schema.messages.structuredPayload,
      metadata: schema.messages.metadata,
      tokenUsage: schema.messages.tokenUsage,
      modelName: schema.messages.modelName,
      traceId: schema.messages.traceId,
      createdAt: schema.messages.createdAt
    })

  return message
}

export async function getConversationMessages(db: Database, identity: AssistantUserIdentity, conversationId: string) {
  const [conversation] = await db
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.id, conversationId), matchConversationOwner(identity)))
    .limit(1)

  if (!conversation) {
    return null
  }

  return db
    .select({
      id: schema.messages.id,
      conversationId: schema.messages.conversationId,
      role: schema.messages.role,
      content: schema.messages.content,
      contentType: schema.messages.contentType,
      structuredPayload: schema.messages.structuredPayload,
      metadata: schema.messages.metadata,
      tokenUsage: schema.messages.tokenUsage,
      modelName: schema.messages.modelName,
      traceId: schema.messages.traceId,
      createdAt: schema.messages.createdAt
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt))
}
