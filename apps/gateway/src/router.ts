import type { ModelMessage, ModelProvider } from './model.js'

const ROUTER_CONFIDENCE_THRESHOLD = 0.6

export type AssistantIntent = 'general_chat' | 'system_check_status' | 'unknown'

export type RouteDecision = {
  intent: AssistantIntent
  entities: Record<string, string>
  confidence: number
  requiresTool: boolean
  candidateTools: string[]
  source: 'rule' | 'model' | 'fallback'
}

export type RouteInput = {
  latestMessage: string
  messages: ModelMessage[]
}

export type IntentRouter = {
  route(input: RouteInput): Promise<RouteDecision>
}

type DeepSeekRoutePayload = {
  intent?: string
  entities?: Record<string, string>
  confidence?: number
  requires_tool?: boolean
  candidate_tools?: string[]
}

function createFallbackDecision(): RouteDecision {
  return {
    intent: 'general_chat',
    entities: {},
    confidence: ROUTER_CONFIDENCE_THRESHOLD,
    requiresTool: false,
    candidateTools: [],
    source: 'fallback'
  }
}

function normalizeIntent(intent?: string): AssistantIntent {
  if (intent === 'general_chat' || intent === 'system_check_status' || intent === 'unknown') {
    return intent
  }

  return 'unknown'
}

function normalizeRoutePayload(payload: DeepSeekRoutePayload): RouteDecision {
  return {
    intent: normalizeIntent(payload.intent),
    entities: payload.entities ?? {},
    confidence: typeof payload.confidence === 'number' ? Math.max(0, Math.min(1, payload.confidence)) : 0,
    requiresTool: payload.requires_tool === true,
    candidateTools: Array.isArray(payload.candidate_tools) ? payload.candidate_tools.filter((value): value is string => typeof value === 'string') : [],
    source: 'model'
  }
}

function matchRuleIntent(content: string): RouteDecision | null {
  const normalizedContent = content.toLowerCase()
  const asksStatus = /status|状态|健康|health/.test(normalizedContent)
  const mentionsGateway = /gateway|网关/.test(normalizedContent)
  const mentionsDatabase = /database|postgres|db|数据库/.test(normalizedContent)
  const mentionsSystem = /system|系统|auraxis|服务/.test(normalizedContent)

  if (asksStatus && (mentionsGateway || mentionsDatabase || mentionsSystem)) {
    return {
      intent: 'system_check_status',
      entities: {
        target: mentionsGateway ? 'gateway' : mentionsDatabase ? 'database' : 'all'
      },
      confidence: 0.96,
      requiresTool: true,
      candidateTools: ['system.check_status'],
      source: 'rule'
    }
  }

  return null
}

function buildRouterPrompt(input: RouteInput): string {
  const recentMessages = input.messages
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n')

  return [
    'You are an intent router for Auraxis.',
    'Return strict JSON only.',
    'Supported intents: general_chat, system_check_status, unknown.',
    'Schema:',
    '{"intent":"general_chat|system_check_status|unknown","entities":{},"confidence":0,"requires_tool":false,"candidate_tools":[]}',
    'Rules:',
    '- general_chat: normal Q&A or casual chat.',
    '- system_check_status: the user wants to check Auraxis system status, especially gateway or database status.',
    '- unknown: intent is unclear.',
    '- candidate_tools is advisory only.',
    '- confidence must be between 0 and 1.',
    `Conversation:\n${recentMessages}`,
    `Latest user message:\n${input.latestMessage}`
  ].join('\n')
}

export function shouldAskRouteFollowUp(route: RouteDecision): boolean {
  return route.source !== 'fallback' && route.confidence < ROUTER_CONFIDENCE_THRESHOLD
}

export function createModelIntentRouter(modelProvider: ModelProvider): IntentRouter {
  return {
    async route(input) {
      const ruleMatch = matchRuleIntent(input.latestMessage)

      if (ruleMatch) {
        return ruleMatch
      }

      try {
        const payload = await modelProvider.generateJson({
          task: 'router',
          traceId: 'router',
          messages: [
            {
              role: 'system',
              content: buildRouterPrompt(input)
            }
          ]
        })

        return normalizeRoutePayload(payload as DeepSeekRoutePayload)
      } catch {
        return createFallbackDecision()
      }
    }
  }
}
