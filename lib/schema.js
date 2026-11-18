/**
 * Protobuf schema inspection helper.
 *
 * Cursor inlines its protobuf definitions in `workbench.desktop.main.js` as
 * protobuf-es `makeMessageType("TypeName", () => [{no, name, ...}])` calls,
 * where `no` is the field number. This module reads that bundle to re-verify
 * field numbers after a Cursor upgrade. It is diagnostics-only: the Run encoder
 * in `session.js` uses the verified numbers directly and does not load this
 * module on the hot path.
 *
 * @module dsh-connect-cursor-pro/schema
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { settings } from './settings.js'

/** Cursor workbench bundle candidates by platform. */
function bundleCandidates() {
  const rel = join('out', 'vs', 'workbench', 'workbench.desktop.main.js')
  const out = []
  if (settings.workbenchBundle) out.push(settings.workbenchBundle)
  if (settings.appPath) out.push(join(settings.appPath, rel))
  if (process.platform === 'darwin') {
    out.push(join('/Applications/Cursor.app/Contents/Resources/app', rel))
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    out.push(join(localAppData, 'Programs', 'cursor', 'resources', 'app', rel))
    out.push(join(localAppData, 'Programs', 'Cursor', 'resources', 'app', rel))
  } else {
    for (const root of ['/usr/share/cursor', '/usr/lib/cursor', '/opt/Cursor', join(homedir(), '.local', 'share', 'cursor')]) {
      out.push(join(root, 'resources', 'app', rel))
    }
  }
  return out
}

let cachedBundle
/** First existing bundle path; undefined when Cursor is not installed. */
export function findBundle() {
  if (cachedBundle !== undefined) return cachedBundle
  for (const candidate of bundleCandidates()) {
    if (!candidate) continue
    if (existsSync(candidate)) {
      cachedBundle = candidate
      return candidate
    }
  }
  cachedBundle = null
  return null
}

/**
 * List a message type's field numbers and names as declared in the bundle.
 * @param {string} typeName e.g. `agent.v1.AgentRunRequest`
 * @returns {Array<{no: number, name: string, kind: string}> | null}
 */
export function inspectType(typeName) {
  const bundle = findBundle()
  if (!bundle) return null
  let source
  try {
    source = readFileSync(bundle, 'utf8')
  } catch {
    return null
  }
  const start = source.indexOf(`makeMessageType("${typeName}"`)
  if (start < 0) return null
  const bodyStart = source.indexOf('=>[', start) + 3
  const fields = []
  for (const m of source.slice(bodyStart).matchAll(/\{no:(\d+),name:"([^"]+)",kind:"(\w+)"/g)) {
    fields.push({ no: Number(m[1]), name: m[2], kind: m[3] })
  }
  return fields.length ? fields : null
}

/** Field numbers `AgentRunRequest` requires (protobuf-es fields without `opt:!0`). */
export function requiredRunRequestFields() {
  const fields = inspectType('agent.v1.AgentRunRequest')
  return fields || []
}
