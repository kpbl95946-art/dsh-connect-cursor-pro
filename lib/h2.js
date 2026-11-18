/**
 * True bidirectional HTTP/2 client (h2 over TLS) driving Cursor's
 * `agent.v1.AgentService/Run`.
 *
 * `Run` is bidi-streaming: after the client sends the run request, the server
 * first sends `ExecServerMessage.request_context_args` and waits for the client
 * to answer with `request_context_result` before the model starts; mid-turn it
 * can push conversation-state blobs and built-in tool calls and block on a
 * reply. Any "send the whole body then read" half-client only ever sees
 * heartbeat frames.
 *
 * Behavior mirrors the MIT `cursor2api` h2stream.py, reimplemented on Node's
 * built-in `node:http2`. A small connection pool warms TLS + ALPN + HTTP/2
 * preface so the first token does not pay for the handshake.
 *
 * @module dsh-connect-cursor-pro/h2
 */
import http2 from 'node:http2'
import tls from 'node:tls'
import { settings } from './settings.js'

const { connect: http2Connect } = http2

/** Run path on the agent host. */
export const RUN_PATH = '/agent.v1.AgentService/Run'

/** Pool parameters (idle connections are recycled, not hoarded). */
const MAX_IDLE_MS = 40_000

/** A ready h2 connection plus one opened, immediately writable stream. */
export class BidiStream {
  /**
   * @param {import('node:http2').ClientHttp2Session} session
   * @param {import('node:http2').ClientHttp2Stream} stream
   * @param {string} host
   */
  constructor(session, stream, host) {
    this.session = session
    this.stream = stream
    this.host = host
    this.created = Date.now()
    this.closed = false
    this.onData = undefined
    this.onEnd = undefined
    this.onHeaders = undefined
    this.onError = undefined
    this._windowWaiters = []
    this._bind()
  }

  _bind() {
    this.stream.on('response', (headers) => this.onHeaders?.(headers))
    this.stream.on('data', (chunk) => {
      this._drainWindow()
      this.onData?.(chunk)
    })
    this.stream.on('end', () => {
      this.closed = true
      this.onEnd?.()
      this._wakeAll()
    })
    this.stream.on('close', () => {
      this.closed = true
      this._wakeAll()
    })
    this.stream.on('error', (error) => {
      this.closed = true
      this.onError?.(error)
      this._wakeAll()
    })
    this.stream.on('window_update', () => this._drainWindow())
    this.session.on('window', () => this._drainWindow())
  }

  _drainWindow() {
    if (this._windowWaiters.length) this._wakeAll()
  }

  _wakeAll() {
    const waiters = this._windowWaiters
    this._windowWaiters = []
    for (const wake of waiters) wake()
  }

  /**
   * Write a payload, chunked against the live flow-control window (a long
   * prompt can exceed the initial 64KB stream window).
   * @param {Buffer} payload
   * @param {boolean} [end=false] end the stream after writing
   */
  write(payload, end = false) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('connection closed'))
      let i = 0
      const sendChunk = () => {
        if (this.closed) return reject(new Error('connection closed'))
        if (i >= payload.length) {
          if (end) this.stream.end()
          return resolve()
        }
        const room = Math.min(
          this.stream.session?.localWindowSize?.(this.stream.id) ?? 65535,
          65535,
          payload.length - i,
        )
        const writable = room > 0 ? room : 0
        if (writable <= 0) {
          const waiter = sendChunk
          this._windowWaiters.push(waiter)
          this.stream.once('window_update', () => {
            const idx = this._windowWaiters.indexOf(waiter)
            if (idx >= 0) this._windowWaiters.splice(idx, 1)
            sendChunk()
          })
          return
        }
        try {
          this.stream.write(payload.subarray(i, i + writable))
          i += writable
          setImmediate(sendChunk)
        } catch (error) {
          reject(error)
        }
      }
      sendChunk()
    })
  }
}

/** Establish a TLS h2 session to `host` and start a POST stream. */
function openStream(host, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(443, host, { servername: host, ALPNProtocols: ['h2'] })
    socket.once('error', reject)
    socket.once('secureConnect', () => {
      if (socket.alpnProtocol !== 'h2') {
        socket.destroy()
        return reject(new Error('ALPN did not negotiate h2'))
      }
      const session = http2Connect(`https://${host}`, { createConnection: () => socket })
      session.once('error', reject)
      const stream = session.request({
        ':method': 'POST',
        ':authority': host,
        ':scheme': 'https',
        ':path': path,
        ...headers,
      })
      stream.setTimeout(0)
      resolve(new BidiStream(session, stream, host))
    })
  })
}

/** Run request shared headers. */
function runHeaders() {
  return {
    'content-type': 'application/connect+proto',
    'connect-protocol-version': '1',
    'connect-accept-encoding': 'gzip',
    'user-agent': 'connect-es/1.6.1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': settings.clientVersion,
    'x-ghost-mode': 'false',
  }
}

/** Run headers carrying the access token and request id. */
export function runHeadersWithAuth(accessToken, requestId) {
  return {
    ...runHeaders(),
    authorization: `Bearer ${accessToken}`,
    'x-request-id': requestId,
    'x-original-request-id': requestId,
  }
}

/** Open an authenticated Run stream. */
export function openStreamAuthed(host, accessToken, requestId) {
  return openStream(host, RUN_PATH, runHeadersWithAuth(accessToken, requestId))
}

/** Open a Run stream with fully custom headers. */
export function openStreamRaw(host, headers) {
  return openStream(host, RUN_PATH, headers)
}

const pool = []
const filling = new Set()

/** Grab a ready pooled stream for `host`, or open one on demand. */
export async function acquire(host) {
  for (let i = 0; i < pool.length; i += 1) {
    if (pool[i].host === host && !pool[i].closed) {
      const conn = pool.splice(i, 1)[0]
      if (Date.now() - conn.created < MAX_IDLE_MS) return conn
      conn.session.close()
    }
  }
  return openStream(host, RUN_PATH, runHeaders())
}

/** Warm the connection pool in the background. */
export function prewarm(host, count = settings.poolSize) {
  if (count <= 0) return
  if (filling.has(host) || pool.filter((c) => c.host === host).length >= count) return
  filling.add(host)
  const fill = async () => {
    try {
      while (pool.filter((c) => c.host === host).length < count) {
        const conn = await openStream(host, RUN_PATH, runHeaders())
        pool.push(conn)
      }
    } catch {
      /* prewarm failure: next acquire connects on demand */
    } finally {
      filling.delete(host)
    }
  }
  fill()
}

/** Close every pooled session (process teardown). */
export function closeAll() {
  for (const conn of pool) {
    try {
      conn.session.close()
    } catch {
      /* ignore */
    }
  }
  pool.length = 0
}
