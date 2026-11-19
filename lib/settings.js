/**
 * Resolved plugin settings singleton.
 *
 * Modules read through `settings` so every layer (h2 headers, model catalog,
 * credential probing) sees one consistent snapshot. `apply()` calls
 * `configure()` once with config-overlaid defaults; nothing else mutates it.
 *
 * Secrets (access token / API key) are intentionally NOT part of settings: they
 * stay in environment variables or the local Cursor login, per DSH's
 * configuration guidance.
 *
 * @module dsh-connect-cursor-pro/settings
 */
import { resolveClientVersion } from './version.js'

/** Build defaults from environment alone. */
export function defaultSettings() {
  return {
    /** Unary API base for token exchange + model catalog. */
    apiBase: (process.env.CURSOR_API_BASE_URL || 'https://api2.cursor.sh').replace(/\/+$/, ''),
    /** Host that serves the bidi `agent.v1.AgentService/Run` stream. */
    agentHost: process.env.CURSOR_AGENT_HOST || 'agentn.global.api5.cursor.sh',
    /** `x-cursor-client-version` header value (`cli-YYYY.MM.DD-<sha>`). */
    clientVersion: resolveClientVersion(process.env.CURSOR_CLI_VERSION),
    /** Cursor app root (non-default install). */
    appPath: process.env.CURSOR_APP_PATH || undefined,
    /** Direct path to `workbench.desktop.main.js`. */
    workbenchBundle: process.env.CURSOR_WORKBENCH_BUNDLE || undefined,
    /** Whole-turn timeout in milliseconds. */
    timeoutMs: toInt(process.env.CURSOR_TIMEOUT_MS, 300_000),
    /** Content-idle timeout in milliseconds (Cursor may not send `turn_ended`). */
    idleMs: toInt(process.env.CURSOR_IDLE_MS, 12_000),
    /** Workspace directory Cursor's file tools operate on. */
    workspaceRoot: process.env.CURSOR_WORKSPACE || process.cwd(),
    /** HTTP/2 prewarm pool size. */
    poolSize: toInt(process.env.CURSOR2API_POOL, 2),
    /** Forward DSH tools as Cursor MCP tools (off by default; see README). */
    tools: process.env.CURSOR_TOOLS === 'true',
    /** Reuse the Cursor conversation state across turns keyed by session. */
    multiTurn: process.env.CURSOR_MULTITURN !== 'false',
    /** Include hidden models in the catalog. */
    includeHidden: process.env.CURSOR_INCLUDE_HIDDEN === 'true',
  }
}

function toInt(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Live settings snapshot; starts as environment-only defaults. */
export let settings = defaultSettings()

/**
 * Overlay bundle config onto the environment defaults.
 * @param {Record<string, unknown>} [config] bundle row config
 */
export function configure(config = {}) {
  settings = {
    apiBase: (config.apiBase || process.env.CURSOR_API_BASE_URL || 'https://api2.cursor.sh').replace(/\/+$/, ''),
    agentHost: config.agentHost || process.env.CURSOR_AGENT_HOST || 'agentn.global.api5.cursor.sh',
    clientVersion: resolveClientVersion(config.clientVersion || process.env.CURSOR_CLI_VERSION),
    appPath: config.appPath || process.env.CURSOR_APP_PATH || undefined,
    workbenchBundle: config.workbenchBundle || process.env.CURSOR_WORKBENCH_BUNDLE || undefined,
    timeoutMs: toInt(config.timeoutMs ?? process.env.CURSOR_TIMEOUT_MS, 300_000),
    idleMs: toInt(config.idleMs ?? process.env.CURSOR_IDLE_MS, 12_000),
    workspaceRoot: config.workspaceRoot || process.env.CURSOR_WORKSPACE || process.cwd(),
    poolSize: toInt(config.poolSize ?? process.env.CURSOR2API_POOL, 2),
    tools: config.tools === true || process.env.CURSOR_TOOLS === 'true',
    multiTurn: (config.multiTurn ?? true) !== false && process.env.CURSOR_MULTITURN !== 'false',
    includeHidden: config.includeHidden === true || process.env.CURSOR_INCLUDE_HIDDEN === 'true',
  }
  return settings
}
