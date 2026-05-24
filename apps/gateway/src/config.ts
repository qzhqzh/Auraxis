import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  DEEPSEEK_MODEL: z.string().default('deepseek-v4-flash'),
  DEEPSEEK_API_KEY: z.string().optional(),
  HOST_TOKEN_ISSUER: z.string().default('auraxis-dev-host'),
  HOST_TOKEN_SECRET: z.string().min(32).optional()
})

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  databaseUrl: string
  deepSeekBaseUrl: string
  deepSeekModel: string
  deepSeekApiKey?: string
  hostTokenIssuer: string
  hostTokenSecret?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env)

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    deepSeekBaseUrl: parsed.DEEPSEEK_BASE_URL,
    deepSeekModel: parsed.DEEPSEEK_MODEL,
    deepSeekApiKey: parsed.DEEPSEEK_API_KEY || undefined,
    hostTokenIssuer: parsed.HOST_TOKEN_ISSUER,
    hostTokenSecret: parsed.HOST_TOKEN_SECRET || undefined
  }
}
