import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core'

export const conversationStatus = pgEnum('conversation_status', ['open', 'resolved', 'closed'])
export const messageRole = pgEnum('message_role', ['user', 'assistant', 'system', 'tool'])
export const messageContentType = pgEnum('message_content_type', ['text', 'tool_result', 'error'])
export const toolType = pgEnum('tool_type', ['internal', 'script'])
export const toolRiskLevel = pgEnum('tool_risk_level', ['read_only', 'diagnostic', 'create', 'update', 'destructive'])
export const toolCallStatus = pgEnum('tool_call_status', ['pending', 'running', 'succeeded', 'failed', 'denied', 'timeout'])
export const traceStatus = pgEnum('trace_status', ['started', 'succeeded', 'failed'])

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}

export const assistantApps = pgTable(
  'assistant_apps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: varchar('app_id', { length: 120 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => [uniqueIndex('assistant_apps_app_id_idx').on(table.appId)]
)

export const assistantAppKeys = pgTable(
  'assistant_app_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    assistantAppId: uuid('assistant_app_id')
      .notNull()
      .references(() => assistantApps.id),
    keyId: varchar('key_id', { length: 120 }).notNull(),
    secretHash: text('secret_hash').notNull(),
    issuer: varchar('issuer', { length: 200 }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    index('assistant_app_keys_app_idx').on(table.assistantAppId),
    uniqueIndex('assistant_app_keys_key_id_idx').on(table.keyId)
  ]
)

export const assistantUserIdentities = pgTable(
  'assistant_user_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: varchar('app_id', { length: 120 }).notNull(),
    tenantId: varchar('tenant_id', { length: 120 }),
    externalUserId: varchar('external_user_id', { length: 200 }).notNull(),
    displayName: varchar('display_name', { length: 200 }),
    roles: jsonb('roles').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    permissions: jsonb('permissions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex('assistant_user_identities_user_idx').on(table.appId, table.tenantId, table.externalUserId),
    index('assistant_user_identities_app_idx').on(table.appId)
  ]
)

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: varchar('app_id', { length: 120 }).notNull(),
    tenantId: varchar('tenant_id', { length: 120 }),
    externalUserId: varchar('external_user_id', { length: 200 }),
    visitorId: varchar('visitor_id', { length: 200 }),
    sourceUrl: text('source_url'),
    pageTitle: text('page_title'),
    status: conversationStatus('status').notNull().default('open'),
    summary: text('summary'),
    traceId: uuid('trace_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    ...timestamps
  },
  (table) => [
    index('conversations_app_user_idx').on(table.appId, table.tenantId, table.externalUserId),
    index('conversations_trace_idx').on(table.traceId),
    index('conversations_status_idx').on(table.status)
  ]
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    role: messageRole('role').notNull(),
    content: text('content').notNull(),
    contentType: messageContentType('content_type').notNull().default('text'),
    structuredPayload: jsonb('structured_payload').$type<Record<string, unknown>>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    tokenUsage: jsonb('token_usage').$type<Record<string, unknown>>(),
    modelName: varchar('model_name', { length: 120 }),
    traceId: uuid('trace_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index('messages_conversation_idx').on(table.conversationId),
    index('messages_trace_idx').on(table.traceId),
    index('messages_created_at_idx').on(table.createdAt)
  ]
)

export const conversationStates = pgTable('conversation_states', {
  conversationId: uuid('conversation_id')
    .primaryKey()
    .references(() => conversations.id),
  currentIntent: varchar('current_intent', { length: 120 }),
  stage: varchar('stage', { length: 120 }),
  entities: jsonb('entities').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  pendingToolCallId: uuid('pending_tool_call_id'),
  confidence: real('confidence'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const toolDefinitions = pgTable(
  'tool_definitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 160 }).notNull(),
    version: varchar('version', { length: 40 }).notNull(),
    type: toolType('type').notNull(),
    description: text('description').notNull(),
    riskLevel: toolRiskLevel('risk_level').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    requiredPermissions: jsonb('required_permissions').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    timeoutMs: integer('timeout_ms').notNull().default(5000),
    maxOutputChars: integer('max_output_chars').notNull().default(4000),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>().notNull(),
    examples: jsonb('examples').$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
    ...timestamps
  },
  (table) => [
    uniqueIndex('tool_definitions_name_version_idx').on(table.name, table.version),
    index('tool_definitions_enabled_idx').on(table.enabled)
  ]
)

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    messageId: uuid('message_id').references(() => messages.id),
    traceId: uuid('trace_id').notNull(),
    appId: varchar('app_id', { length: 120 }).notNull(),
    tenantId: varchar('tenant_id', { length: 120 }),
    externalUserId: varchar('external_user_id', { length: 200 }),
    toolName: varchar('tool_name', { length: 160 }).notNull(),
    toolVersion: varchar('tool_version', { length: 40 }).notNull(),
    riskLevel: toolRiskLevel('risk_level').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    output: jsonb('output').$type<Record<string, unknown>>(),
    status: toolCallStatus('status').notNull().default('pending'),
    errorCode: varchar('error_code', { length: 120 }),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true })
  },
  (table) => [
    index('tool_calls_conversation_idx').on(table.conversationId),
    index('tool_calls_trace_idx').on(table.traceId),
    index('tool_calls_tool_idx').on(table.toolName, table.toolVersion),
    index('tool_calls_status_idx').on(table.status)
  ]
)

export const agentTraces = pgTable(
  'agent_traces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    traceId: uuid('trace_id').notNull(),
    appId: varchar('app_id', { length: 120 }).notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    messageId: uuid('message_id').references(() => messages.id),
    phase: varchar('phase', { length: 120 }).notNull(),
    status: traceStatus('status').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    error: jsonb('error').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms')
  },
  (table) => [
    index('agent_traces_trace_idx').on(table.traceId),
    index('agent_traces_conversation_idx').on(table.conversationId),
    index('agent_traces_phase_idx').on(table.phase)
  ]
)
