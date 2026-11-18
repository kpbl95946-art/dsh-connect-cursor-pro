/**
 * Cursor safe-storage decryption (Cursor 3.27+).
 *
 * Cursor now encrypts `cursorAuth/accessToken` and `refreshToken` at rest with
 * Electron's `safeStorage`, i.e. Chromium OSCrypt. The stored value looks like:
 *
 *   cursor-safe-storage:v1:<base64("v10" + nonce(12) + AES-256-GCM ciphertext + tag(16))>
 *
 * The AES-256 key lives in the Cursor user-data `Local State` file under
 * `os_crypt.encrypted_key`. On Windows that key is DPAPI-protected (null
 * entropy, CurrentUser scope); on macOS it is in the Keychain item
 * `Cursor Safe Storage` (account `Cursor Key`, legacy `Cursor`); on Linux it is
 * in the desktop keyring.
 *
 * This module only ever reads Cursor's files; it never writes them, and it
 * never logs or returns the key.
 *
 * @module dsh-connect-cursor-pro/safestorage
 */
import { createDecipheriv } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'cursor-safe-storage:v1:'

let cachedKey = null

/** Whether a stored value is safe-storage encrypted (vs. a plain JWT). */
export function isSafeStorage(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Cursor user-data directories that hold `Local State` and `User/globalStorage`. */
function cursorUserDataDirs() {
  const out = []
  if (process.platform === 'darwin') {
    out.push(join(homedir(), 'Library', 'Application Support', 'Cursor'))
  } else if (process.platform === 'win32') {
    out.push(join(process.env.APPDATA || '', 'Cursor'))
  } else {
    out.push(join(homedir(), '.config', 'Cursor'))
  }
  return out.filter((d) => d && !d.startsWith('Cursor'))
}

/** Locate Cursor's `Local State` file. */
function findLocalState() {
  for (const dir of cursorUserDataDirs()) {
    const p = join(dir, 'Local State')
    if (existsSync(p)) return p
  }
  return undefined
}

/** Read the `os_crypt.encrypted_key` blob (may still be DPAPI-encrypted). */
function readEncryptedKey() {
  const p = findLocalState()
  if (!p) return undefined
  try {
    const json = JSON.parse(readFileSync(p, 'utf8'))
    const b64 = json?.os_crypt?.encrypted_key
    if (!b64) return undefined
    return Buffer.from(b64, 'base64')
  } catch {
    return undefined
  }
}

/** DPAPI-unprotect a blob on Windows via Windows PowerShell (cached upstream). */
function dpapiUnprotect(blob) {
  const b64 = blob.toString('base64')
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$bytes = [Convert]::FromBase64String('${b64}')`,
    '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($plain)',
  ].join('; ')
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  })
  return Buffer.from(out.trim(), 'base64')
}

/** Read the AES key from the macOS Keychain (best-effort; untested here). */
function keychainKey() {
  const accounts = ['Cursor Key', 'Cursor']
  for (const acct of accounts) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'Cursor Safe Storage', '-a', acct, '-w'], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      const trimmed = out.trim()
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
      if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
      return Buffer.from(trimmed, 'utf8')
    } catch {
      /* try the next account */
    }
  }
  return undefined
}

/** Recover and cache the AES-256 key. */
async function getOscryptKey() {
  if (cachedKey) return cachedKey
  const enc = readEncryptedKey()
  if (!enc) {
    // macOS keeps the key in Keychain, not in Local State.
    if (process.platform === 'darwin') {
      const key = keychainKey()
      if (key && (key.length === 16 || key.length === 32)) {
        cachedKey = key
        return key
      }
    }
    throw new Error('Cursor safe-storage key not found (Local State has no os_crypt.encrypted_key)')
  }
  let key
  if (enc.subarray(0, 5).toString('ascii') === 'DPAPI') {
    if (process.platform !== 'win32') {
      throw new Error('DPAPI-encrypted Cursor key found on a non-Windows platform')
    }
    key = dpapiUnprotect(enc.subarray(5))
  } else {
    key = keychainKey()
  }
  if (!key || key.length !== 32) {
    throw new Error(`Failed to recover the Cursor safe-storage AES key (got ${key?.length ?? 0} bytes)`)
  }
  cachedKey = key
  return key
}

/**
 * Decrypt a `cursor-safe-storage:v1:` value back to its plaintext (a JWT).
 * Returns the input unchanged when it is not safe-storage encrypted.
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function decryptSafeStorage(value) {
  if (!isSafeStorage(value)) return value
  const key = await getOscryptKey()
  const payload = Buffer.from(value.slice(PREFIX.length), 'base64')
  const body = payload.subarray(3) // strip the "v10" magic
  if (body.length < 12 + 16 + 16) throw new Error('Cursor safe-storage payload is too short')
  const nonce = body.subarray(0, 12)
  const tag = body.subarray(body.length - 16)
  const ciphertext = body.subarray(12, body.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
