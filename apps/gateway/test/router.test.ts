import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'bun:test'

import { createDeepSeekIntentRouter, shouldAskRouteFollowUp } from '../src/router.js'

const config = {
  deepSeekApiKey: 'test-key',
  deepSeekBaseUrl: 'https://api.deepseek.com',
  deepSeekModel: 'deepseek-v4-flash'
}

afterEach(() => {
  mock.restore()
})

test('intent router returns rule match for gateway status questions', async () => {
  const router = createDeepSeekIntentRouter({
    ...config,
    deepSeekApiKey: undefined
  })

  const route = await router.route({
    latestMessage: '帮我看看 gateway 的状态',
    messages: [
      {
        role: 'user',
        content: '帮我看看 gateway 的状态'
      }
    ]
  })

  assert.equal(route.intent, 'demo_check_status')
  assert.equal(route.requiresTool, true)
  assert.deepEqual(route.candidateTools, ['demo.check_status'])
  assert.equal(route.source, 'rule')
})

test('intent router falls back to general chat when deepseek json is invalid', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: 'not-json'
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
  ) as typeof fetch

  try {
    const router = createDeepSeekIntentRouter(config)
    const route = await router.route({
      latestMessage: '你好',
      messages: [
        {
          role: 'user',
          content: '你好'
        }
      ]
    })

    assert.equal(route.intent, 'general_chat')
    assert.equal(route.source, 'fallback')
    assert.equal(shouldAskRouteFollowUp(route), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
