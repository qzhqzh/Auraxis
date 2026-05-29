import type { AppConfig } from './config.js'

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export type ModelTask = 'router' | 'chat' | 'tool_arguments' | 'summary' | 'response_compose' | 'long_context'

export type ModelProfile = {
  provider: 'deepseek'
  model: string
}

export type ModelRegistry = Partial<Record<ModelTask, ModelProfile>>

export type StreamChatInput = {
  task?: ModelTask
  messages: ModelMessage[]
  traceId: string
  userId?: string
}

export type GenerateJsonInput = {
  task?: ModelTask
  messages: ModelMessage[]
  traceId: string
}

export type ModelProvider = {
  getProfile(task: ModelTask): ModelProfile
  streamChat(input: StreamChatInput): AsyncIterable<string>
  generateJson(input: GenerateJsonInput): Promise<unknown>
}

type DeepSeekJsonResponse = {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

type DeepSeekChunk = {
  choices?: Array<{
    delta?: {
      content?: string
    }
  }>
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message)
  }
}

function resolveProfile(config: Pick<AppConfig, 'deepSeekModel' | 'modelProfiles'>, task: ModelTask): ModelProfile {
  return config.modelProfiles[task] ?? {
    provider: 'deepseek',
    model: config.deepSeekModel
  }
}

function mapMessages(messages: ModelMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }))
}

export function createDeepSeekModelProvider(config: Pick<AppConfig, 'deepSeekApiKey' | 'deepSeekBaseUrl' | 'deepSeekModel' | 'modelProfiles'>): ModelProvider {
  return {
    getProfile(task) {
      return resolveProfile(config, task)
    },

    async *streamChat(input) {
      if (!config.deepSeekApiKey) {
        throw new ModelProviderError('DeepSeek API key is not configured.', 500, 'MODEL_PROVIDER_NOT_CONFIGURED')
      }

      const profile = resolveProfile(config, input.task ?? 'chat')
      const response = await fetch(`${config.deepSeekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.deepSeekApiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: profile.model,
          stream: true,
          messages: mapMessages(input.messages),
          user: input.userId
        })
      })

      if (!response.ok || !response.body) {
        throw new ModelProviderError('DeepSeek request failed.', 502, 'MODEL_PROVIDER_REQUEST_FAILED')
      }

      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader()

      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        buffer += value
        const segments = buffer.split('\n\n')
        buffer = segments.pop() ?? ''

        for (const segment of segments) {
          for (const line of segment.split('\n')) {
            const trimmedLine = line.trim()

            if (!trimmedLine.startsWith('data:')) {
              continue
            }

            const data = trimmedLine.slice(5).trim()

            if (!data || data === '[DONE]') {
              continue
            }

            let chunk: DeepSeekChunk

            try {
              chunk = JSON.parse(data) as DeepSeekChunk
            } catch {
              continue
            }

            const content = chunk.choices?.[0]?.delta?.content

            if (content) {
              yield content
            }
          }
        }
      }
    },

    async generateJson(input) {
      if (!config.deepSeekApiKey) {
        throw new ModelProviderError('DeepSeek API key is not configured.', 500, 'MODEL_PROVIDER_NOT_CONFIGURED')
      }

      const profile = resolveProfile(config, input.task ?? 'router')
      const response = await fetch(`${config.deepSeekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.deepSeekApiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: profile.model,
          response_format: {
            type: 'json_object'
          },
          messages: mapMessages(input.messages)
        })
      })

      if (!response.ok) {
        throw new ModelProviderError('DeepSeek JSON request failed.', 502, 'MODEL_PROVIDER_JSON_REQUEST_FAILED')
      }

      let payload: DeepSeekJsonResponse

      try {
        payload = (await response.json()) as DeepSeekJsonResponse
      } catch {
        throw new ModelProviderError('DeepSeek JSON response is malformed.', 502, 'MODEL_PROVIDER_JSON_RESPONSE_MALFORMED')
      }

      const content = payload.choices?.[0]?.message?.content

      if (!content) {
        throw new ModelProviderError('DeepSeek JSON response is empty.', 502, 'MODEL_PROVIDER_JSON_RESPONSE_EMPTY')
      }

      try {
        return JSON.parse(content) as unknown
      } catch {
        throw new ModelProviderError('DeepSeek JSON content is invalid.', 502, 'MODEL_PROVIDER_JSON_CONTENT_INVALID')
      }
    }
  }
}
