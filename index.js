/**
 * dsh-connect-cursor-pro — bundle entry (Host half).
 *
 * Mounts the locally logged-in Cursor models into DSH's model picker:
 *   1. registers the CursorAdapter on the `cursor` provider route
 *   2. declares `cursor` as a configurable provider (Settings -> Models)
 *   3. registers model discovery so the catalog refreshes into the picker
 *   4. refreshes the catalog asynchronously (never blocks startup)
 *
 * It also serves a tiny read-only JSON API for the browser settings page
 * (`GET /status`, `POST /refresh`) when a web server is present. The payload
 * never carries the access token.
 *
 * @module dsh-connect-cursor-pro
 */
import { CursorAdapter, CURSOR_PROVIDER } from './lib/adapter.js'
import { catalog } from './lib/models.js'
import { probeCredential, setCredentialsService, describeRef, applyRef } from './lib/auth.js'
import { configure } from './lib/settings.js'

export const name = 'dsh-connect-cursor-pro'

/** `llm` is the only hard requirement; credentials is read opportunistically. */
export const inject = ['llm']

/**
 * Best-effort resolution of the DSH session's working directory, which is where
 * Cursor's file tools should read/write. Live sessions expose `header.cwd`;
 * fall back to the explicit env override, then the host cwd.
 */
function resolveWorkspaceRoot(ctx, sessionId) {
  try {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const list = sessions?.list?.() || []
    if (Array.isArray(list) && list.length) {
      const match = sessionId != null ? list.find((s) => s?.id === sessionId || s?.sessionId === sessionId) : undefined
      const session = match || list[0]
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd) return cwd
    }
  } catch {
    /* sessions service unavailable — fall through */
  }
  return process.env.CURSOR_WORKSPACE || process.cwd()
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = configure(config)
  const optional = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const resolveWorkspace = (sessionId) => resolveWorkspaceRoot(ctx, sessionId) || settings.workspaceRoot
  settings.workspaceRoot = resolveWorkspace()
  const adapter = new CursorAdapter({ attachments: optional('attachments'), resolveWorkspace })
  const credentials = optional('credentials')
  setCredentialsService(credentials)

  // Read-only diagnostics snapshot; the token itself is never stored here.
  const status = { credential: { ok: false, reason: 'not probed yet' }, models: [], refreshedAt: null }

  /** Probe the credential and refresh the model catalog; returns the snapshot. */
  async function refreshStatus() {
    const probe = await probeCredential()
    status.credential = probe.ok
      ? { ok: true, source: probe.credential.source, expiresAtMs: probe.credential.expiresAtMs ?? null }
      : { ok: false, reason: probe.reason }
    try {
      const models = await catalog(true)
      status.models = models
        .filter((m) => settings.includeHidden || !m.hidden)
        .map((m) => ({ id: m.id, name: m.display || m.id, context: m.context || 0, hidden: m.hidden }))
    } catch {
      status.models = []
    }
    status.refreshedAt = Date.now()
    return status
  }

  // 1. Register the adapter on the `cursor` route.
  const disposeAdapter = ctx.llm.registerAdapter([CURSOR_PROVIDER], adapter)

  // 2. Declare a configurable provider (Settings -> Models shows the `cursor` row).
  const ns = ctx.fiber?.entry?.options?.id ?? name
  const disposeProvider = ctx.llm.registerConfigurableProviders?.([
    { provider: CURSOR_PROVIDER, displayName: 'Cursor', settingsNs: ns, settingsPath: [] },
  ])

  // 3. Model discovery: refresh the live catalog for the picker.
  const disposeDiscovery = ctx.llm.registerModelDiscovery?.(ns, async () => {
    const models = await catalog(true)
    return models
      .filter((m) => settings.includeHidden || !m.hidden)
      .map((m) => ({ id: m.id, name: m.display || m.id, contextWindow: m.context || undefined }))
  })

  // 4. Browser settings page API (optional; absent in headless compositions).
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/api/dsh-connect-cursor-pro', handler }),
      'dsh-connect-cursor-pro: api routes',
    )
  })

  /** Read a small JSON request body. */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 1e6) req.destroy(new Error('body too large'))
      })
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  /** HTTP handler for `/api/dsh-connect-cursor-pro/*`. */
  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/dsh-connect-cursor-pro/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      if (method === 'GET' && routePath === '/status') {
        return send(200, {
          credential: status.credential,
          models: status.models,
          diagnostics: {
            clientVersion: settings.clientVersion,
            apiBase: settings.apiBase,
            agentHost: settings.agentHost,
            multiTurn: settings.multiTurn,
            tools: settings.tools,
            workspaceRoot: settings.workspaceRoot,
            refreshedAt: status.refreshedAt,
          },
        })
      }
      if (method === 'POST' && routePath === '/refresh') {
        return send(200, await refreshStatus())
      }
      if (method === 'GET' && routePath === '/credentials') {
        return send(200, {
          accessToken: await describeRef('CURSOR_ACCESS_TOKEN'),
          apiKey: await describeRef('CURSOR_API_KEY'),
        })
      }
      if (method === 'POST' && routePath === '/credentials') {
        const body = await readJsonBody(req)
        if ('accessToken' in body) await applyRef('CURSOR_ACCESS_TOKEN', body.accessToken ? String(body.accessToken).trim() : '')
        if ('apiKey' in body) await applyRef('CURSOR_API_KEY', body.apiKey ? String(body.apiKey).trim() : '')
        await refreshStatus()
        return send(200, {
          accessToken: await describeRef('CURSOR_ACCESS_TOKEN'),
          apiKey: await describeRef('CURSOR_API_KEY'),
        })
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      return send(500, { error: error?.message || String(error) })
    }
  }

  // 5. Async initial refresh (non-blocking startup).
  ;(async () => {
    try {
      await refreshStatus()
      if (status.credential.ok) {
        ctx.logger?.info?.(`dsh-connect-cursor-pro: catalog refreshed (${status.models.length} models, client ${settings.clientVersion})`)
      } else {
        ctx.logger?.warn?.(`dsh-connect-cursor-pro: ${status.credential.reason}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-connect-cursor-pro: ${error?.message || error}`)
    }
  })()

  return () => {
    disposeDiscovery?.()
    disposeProvider?.()
    disposeAdapter()
  }
}

export { CURSOR_PROVIDER, CursorAdapter }
