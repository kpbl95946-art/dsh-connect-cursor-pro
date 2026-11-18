/**
 * Cursor credential resolution: reuse the local Cursor desktop / CLI login.
 *
 * Sources, in priority order (all read-only; nothing writes Cursor's files):
 *   1. `CURSOR_ACCESS_TOKEN` environment variable
 *   2. desktop app `state.vscdb` (SQLite `cursorAuth/accessToken`) — primary
 *   3. CLI `auth.json` (macOS/Linux `~/.config/cursor/`, Windows `%APPDATA%\Cursor\`)
 *   4. `CURSOR_API_KEY` (`crsr_` prefix, exchanged for a short-lived token)
 *
 * The token is a JWT; its `exp` is decoded to flag expiry (Cursor tokens last
 * about an hour and are refreshed by the running desktop app). This plugin
 * never self-renews; an expired token asks the user to reopen Cursor.
 *
 * @module dsh-connect-cursor-pro/auth
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settings } from './settings.js'
import { decryptSafeStorage } from './safestorage.js'

/** DSH credentials service, wired in `apply()`; resolves env-var-shaped refs. */
let credentialsService = null
export function setCredentialsService(svc) {
  credentialsService = svc
}

/**
 * Resolve a `CURSOR_*` credential reference. Prefers the DSH credentials seam
 * (which layers the managed credential store over the process environment),
 * then falls back to a raw `process.env` read.
 * @param {string} name
 * @returns {Promise<string | undefined>}
 */
async function resolveRef(name) {
  if (credentialsService) {
    try {
      const hit = await credentialsService.resolve(name)
      if (hit?.value) return hit.value
    } catch {
      /* fall back to process.env */
    }
  }
  return process.env[name] || undefined
}

/** Describe a `CURSOR_*` reference for the settings page (never the value). */
export async function describeRef(name) {
  if (credentialsService) {
    try {
      const d = await credentialsService.describe(name)
      return { configured: d.configured, source: d.source, writable: d.writable }
    } catch {
      /* fall through */
    }
  }
  const envValue = process.env[name]
  return { configured: Boolean(envValue), source: envValue ? 'env' : undefined, writable: !envValue }
}

/** Write/clear a `CURSOR_*` reference through the credentials seam. */
export async function applyRef(name, value) {
  if (!credentialsService) throw new Error('credentials service unavailable')
  if (value) await credentialsService.set(name, value)
  else await credentialsService.unset(name)
}

/** Desktop app "User" data roots by platform. */
const CURSOR_USER_DIRS = [
  join(homedir(), 'Library', 'Application Support', 'Cursor', 'User'), // macOS
  join(process.env.APPDATA || '', 'Cursor', 'User'), // Windows
  join(homedir(), '.config', 'Cursor', 'User'), // Linux
].filter((dir) => dir && !dir.startsWith('Cursor') && !dir.startsWith('globalStorage'))

/** Decode a JWT `exp` epoch-seconds; undefined on failure. */
function jwtExp(jwt) {
  try {
    const part = jwt.split('.')[1]
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4)
    const body = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    return JSON.parse(body.toString('utf8')).exp
  } catch {
    return undefined
  }
}

/** JWT `exp` as epoch-milliseconds; undefined when absent. */
function expMs(jwt) {
  const exp = jwtExp(jwt)
  return exp === undefined ? undefined : exp * 1000
}

/** Whether a JWT expires within `skewMs` (or is unreadable). */
export function isExpiring(jwt, skewMs = 300_000) {
  const exp = jwtExp(jwt)
  if (exp === undefined) return true
  return exp * 1000 - Date.now() < skewMs
}

/** Load `node:sqlite`; throws a readable error when unavailable (Node < 22.5). */
function loadNodeSqlite() {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) throw new Error('node:sqlite unavailable (need Node 22.5+); use CLI login or CURSOR_API_KEY')
  return sqlite
}

/** ItemTable.value may be a JSON-quoted string or a raw token. */
function extractToken(raw) {
  if (!raw || typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** Read the desktop app's `state.vscdb` access/refresh tokens (decrypting safe-storage). */
async function readStateVscdb() {
  for (const userDir of CURSOR_USER_DIRS) {
    const db = join(userDir, 'globalStorage', 'state.vscdb')
    if (!existsSync(db)) continue
    try {
      const { DatabaseSync } = loadNodeSqlite()
      const database = new DatabaseSync(db, { readOnly: true })
      const rows = database.prepare("SELECT value FROM ItemTable WHERE key = ?").all('cursorAuth/accessToken')
      const refreshRows = database.prepare("SELECT value FROM ItemTable WHERE key = ?").all('cursorAuth/refreshToken')
      database.close()
      const rawAccess = extractToken(rows[0]?.value)
      const rawRefresh = extractToken(refreshRows[0]?.value)
      const accessToken = rawAccess ? await decryptSafeStorage(rawAccess) : undefined
      const refreshToken = rawRefresh ? await decryptSafeStorage(rawRefresh) : undefined
      if (accessToken) return { accessToken, refreshToken, source: 'state.vscdb', path: db }
    } catch {
      /* SQLite unavailable or decryption failed: fall through to the next source */
    }
  }
  return undefined
}

/** CLI `auth.json` candidate paths. */
function cliAuthPaths() {
  const out = [join(homedir(), '.config', 'cursor', 'auth.json')]
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'Cursor', 'auth.json'))
  return out
}

/** Read the CLI `auth.json` (decrypting safe-storage). */
async function readCliAuth() {
  for (const path of cliAuthPaths()) {
    if (!existsSync(path)) continue
    try {
      const json = JSON.parse(readFileSync(path, 'utf8'))
      const rawAccess = json.accessToken || json.access_token
      if (rawAccess) {
        const accessToken = await decryptSafeStorage(String(rawAccess))
        return { accessToken, refreshToken: json.refreshToken, source: 'cli-auth', path }
      }
    } catch {
      /* skip a corrupt auth.json */
    }
  }
  return undefined
}

/** Exchange a `crsr_` API key for a short-lived access token. */
async function exchangeApiKey(key) {
  const response = await fetch(`${settings.apiBase}/auth/exchange_user_api_key`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`API key exchange failed: HTTP ${response.status} ${response.statusText}`)
  }
  const parsed = await response.json()
  if (!parsed.accessToken) throw new Error('API key exchange failed: missing accessToken')
  return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, source: 'api-key' }
}

/**
 * Resolve the current Cursor credential.
 * @param {{allowApiKey?: boolean}} [options]
 * @returns {Promise<{accessToken: string, refreshToken?: string, source: string, path?: string, expiresAtMs?: number}>}
 * @throws {Error} when no credential exists
 */
export async function resolveCredential(options = {}) {
  const envToken = await resolveRef('CURSOR_ACCESS_TOKEN')
  if (envToken) {
    return { accessToken: envToken, source: 'env', expiresAtMs: expMs(envToken) }
  }
  const fromDb = await readStateVscdb()
  if (fromDb) return { ...fromDb, expiresAtMs: expMs(fromDb.accessToken) }
  const fromCli = await readCliAuth()
  if (fromCli) return { ...fromCli, expiresAtMs: expMs(fromCli.accessToken) }
  if (options.allowApiKey !== false) {
    const apiKey = await resolveRef('CURSOR_API_KEY')
    if (apiKey) {
      const exchanged = await exchangeApiKey(apiKey)
      return { ...exchanged, expiresAtMs: expMs(exchanged.accessToken) }
    }
  }
  throw new Error(
    'No Cursor login found. Install and sign in to the Cursor desktop app, or set CURSOR_API_KEY (crsr_ prefix).',
  )
}

/**
 * Probe credential availability without throwing.
 * @returns {Promise<{ok: boolean, credential?: object, reason?: string}>}
 */
export async function probeCredential() {
  try {
    const credential = await resolveCredential()
    if (credential.expiresAtMs && credential.expiresAtMs <= Date.now()) {
      return { ok: false, credential, reason: 'token expired; reopen the Cursor desktop app' }
    }
    return { ok: true, credential }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
