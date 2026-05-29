import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'bun:test'

import type { FastifyInstance } from 'fastify'

import { signHostToken } from '../src/auth.js'
import type { AppConfig } from '../src/config.js'
import { buildServer } from '../src/server.js'

const secret = '12345678901234567890123456789012'

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  databaseUrl: 'postgres://auraxis:change-me-local-dev@postgres:5432/auraxis',
  deepSeekBaseUrl: 'https://api.deepseek.com',
  deepSeekModel: 'deepseek-v4-flash',
  modelProfiles: {
    router: {
      provider: 'deepseek',
      model: 'deepseek-v4-flash'
    },
    chat: {
      provider: 'deepseek',
      model: 'deepseek-v4-pro'
    }
  },
  hostTokenIssuer: 'auraxis-dev-host',
  hostTokenSecret: secret
}

async function withServer(run: (server: FastifyInstance) => Promise<void>) {
  const server = buildServer(config)
  await server.ready()

  try {
    await run(server)
  } finally {
    await server.close()
  }
}

function createToken(overrides: Partial<Parameters<typeof signHostToken>[0]> = {}) {
  const now = Math.floor(Date.now() / 1000)

  return signHostToken(
    {
      app_id: 'clinical-report',
      external_user_id: 'u_001',
      display_name: 'Zhang San',
      tenant_id: 'hospital_a',
      roles: ['report_viewer'],
      permissions: ['assistant:chat'],
      iat: now,
      exp: now + 300,
      issuer: config.hostTokenIssuer,
      ...overrides
    },
    secret
  )
}

test('accepts a valid signed host token', async () => {
  await withServer(async (server) => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: `Bearer ${createToken()}`,
        'x-auraxis-app-id': 'clinical-report'
      }
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      identity: {
        appId: 'clinical-report',
        externalUserId: 'u_001',
        displayName: 'Zhang San',
        tenantId: 'hospital_a',
        roles: ['report_viewer'],
        permissions: ['assistant:chat']
      }
    })
  })
})

test('rejects an expired token', async () => {
  await withServer(async (server) => {
    const now = Math.floor(Date.now() / 1000)
    const response = await server.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: `Bearer ${createToken({ iat: now - 600, exp: now - 1 })}`,
        'x-auraxis-app-id': 'clinical-report'
      }
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), {
      error: 'HOST_TOKEN_EXPIRED',
      message: 'Host token has expired.'
    })
  })
})

test('rejects a token for the wrong app', async () => {
  await withServer(async (server) => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: `Bearer ${createToken({ app_id: 'other-app' })}`,
        'x-auraxis-app-id': 'clinical-report'
      }
    })

    assert.equal(response.statusCode, 403)
    assert.deepEqual(response.json(), {
      error: 'HOST_TOKEN_APP_ID_MISMATCH',
      message: 'Host token app_id does not match request app.'
    })
  })
})

test('rejects a token with an invalid signature', async () => {
  await withServer(async (server) => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: `Bearer ${signHostToken(
          {
            app_id: 'clinical-report',
            external_user_id: 'u_001',
            roles: [],
            permissions: [],
            exp: Math.floor(Date.now() / 1000) + 300,
            issuer: config.hostTokenIssuer
          },
          '00000000000000000000000000000000'
        )}`,
        'x-auraxis-app-id': 'clinical-report'
      }
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), {
      error: 'HOST_TOKEN_SIGNATURE_INVALID',
      message: 'Host token signature is invalid.'
    })
  })
})

test('rejects a token with missing required claims', async () => {
  await withServer(async (server) => {
    const now = Math.floor(Date.now() / 1000)
    const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const mutatedPayload = Buffer.from(
      JSON.stringify({
        app_id: 'clinical-report',
        roles: [],
        permissions: [],
        iat: now,
        exp: now + 300,
        issuer: config.hostTokenIssuer
      })
    ).toString('base64url')
    const unsignedToken = encodedHeader + '.' + mutatedPayload
    const signature = createHmac('sha256', secret).update(unsignedToken).digest('base64url')
    const malformedToken = unsignedToken + '.' + signature

    const response = await server.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: {
        authorization: 'Bearer ' + malformedToken,
        'x-auraxis-app-id': 'clinical-report'
      }
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), {
      error: 'HOST_TOKEN_CLAIMS_INVALID',
      message: 'Host token claims are invalid.'
    })
  })
})
