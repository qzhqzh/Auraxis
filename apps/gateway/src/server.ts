import cors from '@fastify/cors'
import Fastify from 'fastify'

import type { AppConfig } from './config.js'

const GATEWAY_VERSION = '0.1.0'

export function buildServer(config: AppConfig) {
  const server = Fastify({
    logger: {
      level: config.logLevel
    }
  })

  server.register(cors, {
    origin: true
  })

  server.get('/', async () => ({
    service: 'auraxis-gateway',
    health: '/v1/health'
  }))

  server.get('/v1/health', async () => ({
    status: 'ok',
    service: 'auraxis-gateway',
    version: GATEWAY_VERSION,
    time: new Date().toISOString()
  }))

  return server
}
