import assert from 'node:assert/strict'
import { test } from 'bun:test'

import { createDeepSeekModelProvider } from '../src/model.js'

const modelProfiles = {
  router: {
    provider: 'deepseek' as const,
    model: 'deepseek-v4-flash'
  },
  chat: {
    provider: 'deepseek' as const,
    model: 'deepseek-v4-pro'
  }
}

test('deepseek model provider uses configured request shape and streams text deltas', async () => {
  const originalFetch = globalThis.fetch
  const chunks: string[] = []
  let requestUrl = ''
  let requestBody = ''
  let authorization = ''

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBody = String(init?.body ?? '')
    authorization = String((init?.headers as Record<string, string>)?.authorization ?? '')

    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
              'data: [DONE]\n\n'
          )
        )
        controller.close()
      }
    })

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream'
      }
    })
  }) as typeof fetch

  try {
    const provider = createDeepSeekModelProvider({
      deepSeekApiKey: 'test-key',
      deepSeekBaseUrl: 'https://api.deepseek.test',
      deepSeekModel: 'deepseek-v4-flash',
      modelProfiles
    })

    for await (const chunk of provider.streamChat({
      task: 'chat',
      traceId: 'trace-1',
      userId: 'user-1',
      messages: [{ role: 'user', content: 'Hi' }]
    })) {
      chunks.push(chunk)
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requestUrl, 'https://api.deepseek.test/chat/completions')
  assert.equal(authorization, 'Bearer test-key')
  assert.deepEqual(JSON.parse(requestBody), {
    model: 'deepseek-v4-pro',
    stream: true,
    messages: [{ role: 'user', content: 'Hi' }],
    user: 'user-1'
  })
  assert.deepEqual(chunks, ['Hello', ' world'])
})

test('deepseek model provider uses router profile for json generation', async () => {
  const originalFetch = globalThis.fetch
  let requestBody = ''

  globalThis.fetch = (async (_input, init) => {
    requestBody = String(init?.body ?? '')

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: 'general_chat',
                confidence: 0.9,
                requires_tool: false,
                candidate_tools: [],
                entities: {}
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      }
    )
  }) as typeof fetch

  try {
    const provider = createDeepSeekModelProvider({
      deepSeekApiKey: 'test-key',
      deepSeekBaseUrl: 'https://api.deepseek.test',
      deepSeekModel: 'deepseek-v4-flash',
      modelProfiles
    })

    const payload = await provider.generateJson({
      task: 'router',
      traceId: 'trace-1',
      messages: [{ role: 'system', content: 'Route this.' }]
    })

    assert.deepEqual(payload, {
      intent: 'general_chat',
      confidence: 0.9,
      requires_tool: false,
      candidate_tools: [],
      entities: {}
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(JSON.parse(requestBody), {
    model: 'deepseek-v4-flash',
    response_format: {
      type: 'json_object'
    },
    messages: [{ role: 'system', content: 'Route this.' }]
  })
})

test('deepseek model provider falls back to default model for unconfigured tasks', () => {
  const provider = createDeepSeekModelProvider({
    deepSeekApiKey: 'test-key',
    deepSeekBaseUrl: 'https://api.deepseek.test',
    deepSeekModel: 'deepseek-v4-flash',
    modelProfiles
  })

  assert.deepEqual(provider.getProfile('summary'), {
    provider: 'deepseek',
    model: 'deepseek-v4-flash'
  })
})
