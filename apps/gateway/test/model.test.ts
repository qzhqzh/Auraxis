import assert from 'node:assert/strict'
import { test } from 'bun:test'

import { createDeepSeekModelProvider } from '../src/model.js'

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
      deepSeekModel: 'deepseek-v4-flash'
    })

    for await (const chunk of provider.streamChat({
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
    model: 'deepseek-v4-flash',
    stream: true,
    messages: [{ role: 'user', content: 'Hi' }],
    user: 'user-1'
  })
  assert.deepEqual(chunks, ['Hello', ' world'])
})
