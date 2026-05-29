import assert from 'node:assert/strict'
import { test } from 'bun:test'

import {
  canExecuteTool,
  formatSystemCheckResult,
  normalizeSystemCheckTarget,
  runSystemCheckStatus,
  systemCheckStatusTool
} from '../src/tools.js'

test('system check target defaults to all for unsupported values', () => {
  assert.equal(normalizeSystemCheckTarget('gateway'), 'gateway')
  assert.equal(normalizeSystemCheckTarget('database'), 'database')
  assert.equal(normalizeSystemCheckTarget('all'), 'all')
  assert.equal(normalizeSystemCheckTarget('unknown'), 'all')
  assert.equal(normalizeSystemCheckTarget(undefined), 'all')
})

test('tool permission check requires every declared permission', () => {
  assert.equal(canExecuteTool(['assistant:chat', 'tool:system.check_status'], systemCheckStatusTool), true)
  assert.equal(canExecuteTool(['assistant:chat'], systemCheckStatusTool), false)
})

test('system check runtime executes selected checks', async () => {
  let databaseQueryCount = 0
  const db = {
    execute: async () => {
      databaseQueryCount += 1
      return []
    }
  }

  const gatewayOnly = await runSystemCheckStatus(db as never, 'gateway', '0.1.test')
  assert.equal(gatewayOnly.ok, true)
  assert.equal(gatewayOnly.target, 'gateway')
  assert.deepEqual(
    gatewayOnly.checks.map((check) => check.name),
    ['gateway']
  )
  assert.equal(databaseQueryCount, 0)

  const all = await runSystemCheckStatus(db as never, 'all', '0.1.test')
  assert.equal(all.ok, true)
  assert.deepEqual(
    all.checks.map((check) => check.name),
    ['gateway', 'database']
  )
  assert.equal(databaseQueryCount, 1)
  assert.match(formatSystemCheckResult(all), /OK gateway/)
  assert.match(formatSystemCheckResult(all), /OK database/)
})
