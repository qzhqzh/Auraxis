import { sql } from 'drizzle-orm'

import type { createDatabaseClient } from './db/client.js'

export const systemCheckStatusTool = {
  name: 'system.check_status',
  version: '1.0.0',
  type: 'internal' as const,
  description: 'Checks Auraxis runtime status for gateway and database diagnostics.',
  riskLevel: 'diagnostic' as const,
  enabled: true,
  requiredPermissions: ['tool:system.check_status'],
  timeoutMs: 5000,
  maxOutputChars: 4000,
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['gateway', 'database', 'all']
      }
    },
    required: ['target'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      target: { type: 'string' },
      summary: { type: 'string' },
      checks: { type: 'array' }
    },
    required: ['ok', 'target', 'summary', 'checks']
  }
}

export const internalTools = [systemCheckStatusTool]

export type SystemCheckTarget = 'gateway' | 'database' | 'all'

export type SystemCheckOutput = {
  ok: boolean
  target: SystemCheckTarget
  summary: string
  checks: Array<{
    name: 'gateway' | 'database'
    ok: boolean
    summary: string
    details?: Record<string, unknown>
  }>
}

export function normalizeSystemCheckTarget(value: string | undefined): SystemCheckTarget {
  if (value === 'gateway' || value === 'database' || value === 'all') {
    return value
  }

  return 'all'
}

export function canExecuteTool(permissions: string[], tool: { requiredPermissions: string[] }) {
  return tool.requiredPermissions.every((permission) => permissions.includes(permission))
}

export async function runSystemCheckStatus(
  db: ReturnType<typeof createDatabaseClient>['db'],
  target: SystemCheckTarget,
  gatewayVersion: string
): Promise<SystemCheckOutput> {
  const checks: SystemCheckOutput['checks'] = []

  if (target === 'gateway' || target === 'all') {
    checks.push({
      name: 'gateway',
      ok: true,
      summary: `Gateway is running version ${gatewayVersion}.`,
      details: {
        version: gatewayVersion,
        time: new Date().toISOString()
      }
    })
  }

  if (target === 'database' || target === 'all') {
    try {
      await db.execute(sql`select 1`)
      checks.push({
        name: 'database',
        ok: true,
        summary: 'Database query succeeded.'
      })
    } catch (error) {
      checks.push({
        name: 'database',
        ok: false,
        summary: 'Database query failed.',
        details: {
          message: error instanceof Error ? error.message : 'Unknown database error.'
        }
      })
    }
  }

  const ok = checks.every((check) => check.ok)

  return {
    ok,
    target,
    summary: ok ? 'System status check completed successfully.' : 'System status check found a problem.',
    checks
  }
}

export function formatSystemCheckResult(output: SystemCheckOutput) {
  const checkLines = output.checks.map((check) => `${check.ok ? 'OK' : 'FAIL'} ${check.name}: ${check.summary}`)

  return [`系统状态检查完成：${output.ok ? '正常' : '存在异常'}`, ...checkLines].join('\n')
}
