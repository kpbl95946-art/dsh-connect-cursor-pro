/**
 * Cursor client-version resolution.
 *
 * The `agent.v1.AgentService/Run` endpoint gates on `x-cursor-client-version`
 * and REJECTS the app's semver (e.g. `3.30.14`) with `ERROR_OUTDATED_CLIENT`.
 * What it accepts is the agent CLI's build tag — `cli-YYYY.MM.DD-<shortsha>`
 * (the old plugin's `cli-2026.08.11-e8db854` is this shape). The agent CLI's
 * version is a sibling directory under the cursor-agent install, and the
 * desktop `product.json` carries a matching build date + commit as a fallback.
 *
 * Priority: env / config -> cursor-agent versions dir -> product.json ->
 * built-in fallback.
 *
 * @module dsh-connect-cursor-pro/version
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Recent known-good CLI build tag (date + short sha shape). */
export const FALLBACK_CLIENT_VERSION = 'cli-2026.11.13-9b1fba9'

/** Cursor app root candidates by platform. */
function appRootCandidates() {
  const out = []
  if (process.platform === 'darwin') {
    out.push('/Applications/Cursor.app/Contents/Resources/app')
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    out.push(join(localAppData, 'Programs', 'cursor', 'resources', 'app'))
    out.push(join(localAppData, 'Programs', 'Cursor', 'resources', 'app'))
  } else {
    for (const root of [
      '/usr/share/cursor/resources/app',
      '/usr/lib/cursor/resources/app',
      '/opt/Cursor/resources/app',
      join(homedir(), '.local', 'share', 'cursor', 'resources', 'app'),
    ]) {
      out.push(root)
    }
  }
  return out
}

/** Derive the app root from the `cursor` binary on PATH. */
function appRootViaWhere() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const out = execFileSync(cmd, ['cursor'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (!first) return undefined
    const appRoot = first.replace(/[\\/]bin[\\/]cursor(\.cmd|\.exe)?$/i, '')
    if (appRoot && appRoot !== first) {
      if (existsSync(join(appRoot, 'product.json')) || existsSync(join(appRoot, 'package.json'))) return appRoot
    }
  } catch {
    /* not on PATH */
  }
  return undefined
}

/** Locate the installed Cursor app root. */
export function findAppRoot() {
  const viaWhere = appRootViaWhere()
  if (viaWhere) return viaWhere
  for (const root of appRootCandidates()) {
    if (existsSync(join(root, 'product.json')) || existsSync(join(root, 'package.json'))) return root
  }
  return undefined
}

/** Read `product.json` (version, commit, date) from the app root. */
export function readProductInfo() {
  const root = findAppRoot()
  if (!root) return undefined
  const productPath = join(root, 'product.json')
  if (existsSync(productPath)) {
    try {
      const json = JSON.parse(readFileSync(productPath, 'utf8'))
      return { version: json.version, commit: json.commit, date: json.date }
    } catch {
      /* fall through */
    }
  }
  const pkgPath = join(root, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const json = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (json.version) return { version: json.version, commit: undefined, date: undefined }
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/** Latest `YYYY.MM.DD-<sha>` directory under the cursor-agent install. */
export function detectAgentVersion() {
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const versionsDir = join(base, 'cursor-agent', 'versions')
  if (!existsSync(versionsDir)) return undefined
  try {
    const names = readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(e.name))
      .map((e) => e.name)
    if (!names.length) return undefined
    names.sort((a, b) => numericDate(b) - numericDate(a))
    return names[0]
  } catch {
    return undefined
  }
}

function numericDate(name) {
  const [date] = name.split('-')
  const [y, m, d] = date.split('.').map((n) => Number(n))
  return y * 10000 + (m || 0) * 100 + (d || 0)
}

/** Read the version via the `cursor --version` CLI (best-effort). */
function detectViaCli() {
  try {
    const out = execFileSync('cursor', ['--version'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (first && /^\d[\d.]*$/.test(first)) return first
  } catch {
    /* not on PATH */
  }
  return undefined
}

/** Resolve the `x-cursor-client-version` string in `cli-<date>-<sha>` shape. */
export function resolveClientVersion(override) {
  if (override) return String(override)
  if (process.env.CURSOR_CLI_VERSION) return process.env.CURSOR_CLI_VERSION
  const agent = detectAgentVersion()
  if (agent) return `cli-${agent}`
  const info = readProductInfo()
  if (info?.date && info?.commit) {
    const date = info.date.slice(0, 10).replace(/-/g, '.')
    return `cli-${date}-${info.commit.slice(0, 7)}`
  }
  return detectViaCli() ? `cli-${detectViaCli()}` : FALLBACK_CLIENT_VERSION
}
