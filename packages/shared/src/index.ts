export type AssistantUserIdentity = {
  appId: string
  externalUserId: string
  tenantId?: string
  displayName?: string
  roles: string[]
  permissions: string[]
}

export type ToolRiskLevel = 'read_only' | 'diagnostic' | 'create' | 'update' | 'destructive'

export type ToolDefinition = {
  name: string
  version: string
  type: 'internal' | 'script'
  description: string
  riskLevel: ToolRiskLevel
  enabled: boolean
  requiredPermissions: string[]
  timeoutMs: number
  maxOutputChars: number
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
}

export type HealthResponse = {
  status: 'ok'
  service: 'auraxis-gateway'
  version: string
  time: string
}
