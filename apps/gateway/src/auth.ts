import { createHmac, timingSafeEqual } from 'node:crypto'

import type { FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { AppConfig } from './config.js'

export type AssistantUserIdentity = {
  appId: string
  externalUserId: string
  tenantId?: string
  displayName?: string
  roles: string[]
  permissions: string[]
}

const hostTokenHeaderSchema = z.object({
  alg: z.literal('HS256'),
  typ: z.literal('JWT')
})

const hostTokenClaimsSchema = z.object({
  app_id: z.string().min(1),
  external_user_id: z.string().min(1),
  tenant_id: z.string().min(1).optional(),
  display_name: z.string().min(1).optional(),
  roles: z.array(z.string()).default([]),
  permissions: z.array(z.string()).default([]),
  iat: z.number().int().nonnegative().optional(),
  exp: z.number().int().positive(),
  issuer: z.string().min(1)
})

export type HostTokenClaims = z.infer<typeof hostTokenClaimsSchema>

export class HostTokenError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message)
  }
}

type VerifyHostTokenOptions = {
  secret?: string
  expectedAppId: string
  expectedIssuer: string
  now?: Date
}

function encodeBase64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

function decodeBase64UrlJson(value: string) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new HostTokenError('Host token payload is malformed.', 401, 'HOST_TOKEN_MALFORMED')
  }
}

function parseTokenHeader(input: unknown) {
  const parsedHeader = hostTokenHeaderSchema.safeParse(input)

  if (!parsedHeader.success) {
    throw new HostTokenError('Host token header is invalid.', 401, 'HOST_TOKEN_HEADER_INVALID')
  }

  return parsedHeader.data
}

function parseTokenClaims(input: unknown) {
  const parsedClaims = hostTokenClaimsSchema.safeParse(input)

  if (!parsedClaims.success) {
    throw new HostTokenError('Host token claims are invalid.', 401, 'HOST_TOKEN_CLAIMS_INVALID')
  }

  return parsedClaims.data
}

function createSignature(unsignedToken: string, secret: string) {
  return createHmac('sha256', secret).update(unsignedToken).digest('base64url')
}

function readBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization

  if (!authorization) {
    throw new HostTokenError('Missing authorization header.', 401, 'HOST_TOKEN_MISSING')
  }

  const [scheme, token] = authorization.split(' ')

  if (scheme !== 'Bearer' || !token) {
    throw new HostTokenError('Authorization header must use Bearer token.', 401, 'HOST_TOKEN_MALFORMED')
  }

  return token
}

export function signHostToken(claims: HostTokenClaims, secret: string) {
  const parsedClaims = parseTokenClaims(claims)
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = encodeBase64Url(JSON.stringify(parsedClaims))
  const unsignedToken = `${header}.${payload}`
  const signature = createSignature(unsignedToken, secret)

  return `${unsignedToken}.${signature}`
}

export function verifyHostToken(token: string, options: VerifyHostTokenOptions) {
  if (!options.secret) {
    throw new HostTokenError('Host token secret is not configured.', 500, 'HOST_TOKEN_SECRET_MISSING')
  }

  const parts = token.split('.')

  if (parts.length !== 3) {
    throw new HostTokenError('Host token must contain 3 parts.', 401, 'HOST_TOKEN_MALFORMED')
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const unsignedToken = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = createSignature(unsignedToken, options.secret)
  const signatureBuffer = Buffer.from(encodedSignature)
  const expectedSignatureBuffer = Buffer.from(expectedSignature)

  if (
    signatureBuffer.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
  ) {
    throw new HostTokenError('Host token signature is invalid.', 401, 'HOST_TOKEN_SIGNATURE_INVALID')
  }

  parseTokenHeader(decodeBase64UrlJson(encodedHeader))
  const claims = parseTokenClaims(decodeBase64UrlJson(encodedPayload))

  if (claims.issuer !== options.expectedIssuer) {
    throw new HostTokenError('Host token issuer is invalid.', 401, 'HOST_TOKEN_ISSUER_INVALID')
  }

  if (claims.app_id !== options.expectedAppId) {
    throw new HostTokenError('Host token app_id does not match request app.', 403, 'HOST_TOKEN_APP_ID_MISMATCH')
  }

  const now = Math.floor((options.now ?? new Date()).getTime() / 1000)

  if (claims.exp <= now) {
    throw new HostTokenError('Host token has expired.', 401, 'HOST_TOKEN_EXPIRED')
  }

  return claims
}

export function toAssistantUserIdentity(claims: HostTokenClaims): AssistantUserIdentity {
  return {
    appId: claims.app_id,
    externalUserId: claims.external_user_id,
    tenantId: claims.tenant_id,
    displayName: claims.display_name,
    roles: claims.roles,
    permissions: claims.permissions
  }
}

export function authenticateHostRequest(request: FastifyRequest, config: AppConfig) {
  const appIdHeader = request.headers['x-auraxis-app-id']
  const appId = Array.isArray(appIdHeader) ? appIdHeader[0] : appIdHeader

  if (!appId) {
    throw new HostTokenError('Missing x-auraxis-app-id header.', 400, 'APP_ID_MISSING')
  }

  const token = readBearerToken(request)
  const claims = verifyHostToken(token, {
    secret: config.hostTokenSecret,
    expectedAppId: appId,
    expectedIssuer: config.hostTokenIssuer
  })

  return toAssistantUserIdentity(claims)
}
