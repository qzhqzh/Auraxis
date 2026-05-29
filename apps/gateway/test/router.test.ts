import assert from 'node:assert/strict'
import { test } from 'bun:test'

import type { ModelProvider } from '../src/model.js'
import { createModelIntentRouter, shouldAskRouteFollowUp } from '../src/router.js'

function createProvider(generateJson: () => Promise<unknown>): ModelProvider {
  return {
    getProfile() {
      return {
        provider: 'deepseek',
        model: 'deepseek-v4-flash'
      }
    },
    async *streamChat() {},
    generateJson
  }
}

test('intent router returns rule match for gateway status questions', async () => {
  let modelCalled = false
  const router = createModelIntentRouter(createProvider(async () => {
    modelCalled = true
    return {}
  }))

  const route = await router.route({
    latestMessage: '帮我看看 gateway 的状态',
    messages: [
      {
        role: 'user',
        content: '帮我看看 gateway 的状态'
      }
    ]
  })

  assert.equal(route.intent, 'system_check_status')
  assert.equal(route.requiresTool, true)
  assert.deepEqual(route.candidateTools, ['system.check_status'])
  assert.equal(route.source, 'rule')
  assert.equal(modelCalled, false)
})

test('intent router skips model routing for obvious greetings', async () => {
  let modelCalled = false
  const router = createModelIntentRouter(createProvider(async () => {
    modelCalled = true
    return {}
  }))

  const route = await router.route({
    latestMessage: '你好你好',
    messages: [
      {
        role: 'user',
        content: '你好你好'
      }
    ]
  })

  assert.equal(route.intent, 'general_chat')
  assert.equal(route.requiresTool, false)
  assert.equal(route.source, 'rule')
  assert.equal(modelCalled, false)
})

test('intent router falls back to general chat when router model fails', async () => {
  const router = createModelIntentRouter(createProvider(async () => {
    throw new Error('router failed')
  }))

  const route = await router.route({
    latestMessage: '帮我分析一下这段内容',
    messages: [
      {
        role: 'user',
        content: '帮我分析一下这段内容'
      }
    ]
  })

  assert.equal(route.intent, 'general_chat')
  assert.equal(route.source, 'fallback')
  assert.equal(shouldAskRouteFollowUp(route), false)
})
