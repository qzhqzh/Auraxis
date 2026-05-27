import { createHmac } from 'node:crypto'
import { normalize, resolve } from 'node:path'

const ROOT_DIR = resolve(import.meta.dir, '../..')
const DEMO_DIR = resolve(import.meta.dir)
const PORT = Number(process.env.DEMO_PORT ?? 5173)

type DevEnv = {
  GATEWAY_PORT?: string
  HOST_TOKEN_ISSUER?: string
  HOST_TOKEN_SECRET?: string
}

function parseDotEnv(input: string): DevEnv {
  return Object.fromEntries(
    input
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=')
        return index === -1 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)]
      })
  )
}

async function loadDevEnv() {
  const file = Bun.file(resolve(ROOT_DIR, '.env'))
  const fromFile = (await file.exists()) ? parseDotEnv(await file.text()) : {}

  return {
    gatewayPort: process.env.GATEWAY_PORT ?? fromFile.GATEWAY_PORT ?? '3000',
    hostTokenIssuer: process.env.HOST_TOKEN_ISSUER ?? fromFile.HOST_TOKEN_ISSUER ?? 'auraxis-dev-host',
    hostTokenSecret: process.env.HOST_TOKEN_SECRET ?? fromFile.HOST_TOKEN_SECRET
  }
}

function encodeBase64Url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

function signHostToken(claims: Record<string, unknown>, secret: string) {
  const header = encodeBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = encodeBase64Url(JSON.stringify(claims))
  const unsignedToken = `${header}.${payload}`
  const signature = createHmac('sha256', secret).update(unsignedToken).digest('base64url')

  return `${unsignedToken}.${signature}`
}

function contentType(pathname: string) {
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8'
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8'
  if (pathname.endsWith('.map')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function resolveStaticPath(pathname: string) {
  if (pathname === '/') {
    return resolve(DEMO_DIR, 'index.html')
  }

  const normalizedPath = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const isWorkspaceAsset = normalizedPath.startsWith('/packages/') || normalizedPath.startsWith('/node_modules/')

  if (!isWorkspaceAsset) {
    const demoPath = resolve(DEMO_DIR, `.${normalizedPath}`)

    if (demoPath.startsWith(DEMO_DIR)) {
      return demoPath
    }
  }

  const absolutePath = resolve(ROOT_DIR, `.${normalizedPath}`)

  if (!absolutePath.startsWith(ROOT_DIR)) {
    return null
  }

  const allowed =
    absolutePath.startsWith(resolve(ROOT_DIR, 'packages/vue/dist')) ||
    absolutePath.startsWith(resolve(ROOT_DIR, 'node_modules/vue/dist'))

  return allowed ? absolutePath : null
}

const env = await loadDevEnv()

if (!env.hostTokenSecret || env.hostTokenSecret.length < 32) {
  throw new Error('HOST_TOKEN_SECRET must be configured with at least 32 characters for the demo host.')
}

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/dev-token') {
      const now = Math.floor(Date.now() / 1000)
      const user = url.searchParams.get('user') || 'demo-user'
      const token = signHostToken(
        {
          app_id: 'demo-app',
          external_user_id: user,
          tenant_id: 'demo-tenant',
          display_name: user === 'demo-user' ? 'Demo User' : user,
          roles: ['tester'],
          permissions: ['assistant:chat', 'tool:system.check_status'],
          iat: now,
          exp: now + 15 * 60,
          issuer: env.hostTokenIssuer
        },
        env.hostTokenSecret
      )

      return new Response(token, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8'
        }
      })
    }

    if (url.pathname === '/demo-config.js') {
      const gatewayBaseUrl = `${url.protocol}//${url.hostname}:${env.gatewayPort}`
      return new Response(`window.__AURAXIS_DEMO__ = ${JSON.stringify({ gatewayBaseUrl })};\n`, {
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/javascript; charset=utf-8'
        }
      })
    }

    const path = resolveStaticPath(url.pathname)

    if (!path) {
      return new Response('Not found', { status: 404 })
    }

    const file = Bun.file(path)

    if (!(await file.exists())) {
      return new Response('Not found', { status: 404 })
    }

    return new Response(file, {
      headers: {
        'content-type': contentType(path)
      }
    })
  }
})

console.log(`Auraxis demo host listening at http://127.0.0.1:${PORT}`)
