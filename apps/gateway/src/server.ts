import cors from '@fastify/cors'
import Fastify from 'fastify'

import { HostTokenError, authenticateHostRequest } from './auth.js'
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

  server.get('/v1/auth/me', async (request, reply) => {
    try {
      const identity = authenticateHostRequest(request, config)

      return {
        identity
      }
    } catch (error) {
      if (error instanceof HostTokenError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message
        })
      }

      throw error
    }
  })

  return server
}
