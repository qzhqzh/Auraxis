import type { AppConfig } from './config.js'

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export type StreamChatInput = {
  messages: ModelMessage[]
  traceId: string
  userId?: string
}

export type ModelProvider = {
  streamChat(input: StreamChatInput): AsyncIterable<string>
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

export function createDeepSeekModelProvider(config: Pick<AppConfig, 'deepSeekApiKey' | 'deepSeekBaseUrl' | 'deepSeekModel'>): ModelProvider {
  return {
    async *streamChat(input) {
      if (!config.deepSeekApiKey) {
        throw new ModelProviderError('DeepSeek API key is not configured.', 500, 'MODEL_PROVIDER_NOT_CONFIGURED')
      }

      const response = await fetch(`${config.deepSeekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.deepSeekApiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: config.deepSeekModel,
          stream: true,
          messages: input.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
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
    }
  }
}
