import type { AppConfig } from './config.js'
import type { ModelMessage } from './model.js'

const ROUTER_CONFIDENCE_THRESHOLD = 0.6

export type AssistantIntent = 'general_chat' | 'demo_check_status' | 'unknown'

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

type DeepSeekRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
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
  if (intent === 'general_chat' || intent === 'demo_check_status' || intent === 'unknown') {
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

  if (asksStatus && mentionsGateway) {
    return {
      intent: 'demo_check_status',
      entities: {
        target: 'gateway'
      },
      confidence: 0.96,
      requiresTool: true,
      candidateTools: ['demo.check_status'],
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
    'Supported intents: general_chat, demo_check_status, unknown.',
    'Schema:',
    '{"intent":"general_chat|demo_check_status|unknown","entities":{},"confidence":0,"requires_tool":false,"candidate_tools":[]}',
    'Rules:',
    '- general_chat: normal Q&A or casual chat.',
    '- demo_check_status: the user wants to check demo system status, especially gateway status.',
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

export function createDeepSeekIntentRouter(
  config: Pick<AppConfig, 'deepSeekApiKey' | 'deepSeekBaseUrl' | 'deepSeekModel'>
): IntentRouter {
  return {
    async route(input) {
      const ruleMatch = matchRuleIntent(input.latestMessage)

      if (ruleMatch) {
        return ruleMatch
      }

      if (!config.deepSeekApiKey) {
        return createFallbackDecision()
      }

      const response = await fetch(`${config.deepSeekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.deepSeekApiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: config.deepSeekModel,
          response_format: {
            type: 'json_object'
          },
          messages: [
            {
              role: 'system',
              content: buildRouterPrompt(input)
            }
          ]
        })
      })

      if (!response.ok) {
        return createFallbackDecision()
      }

      let payload: DeepSeekRouterResponse

      try {
        payload = (await response.json()) as DeepSeekRouterResponse
      } catch {
        return createFallbackDecision()
      }

      const content = payload.choices?.[0]?.message?.content

      if (!content) {
        return createFallbackDecision()
      }

      try {
        return normalizeRoutePayload(JSON.parse(content) as DeepSeekRoutePayload)
      } catch {
        return createFallbackDecision()
      }
    }
  }
}
