/**
 * Single-turn streaming session over Cursor's bidi `agent.v1.AgentService/Run`.
 *
 * Verified field layout (2026-10, matching Cursor's own protobuf definitions):
 *   AgentClientMessage.f1 = AgentRunRequest   (first frame must wrap this)
 *   AgentRunRequest requires f1 conversation_state / f2 action / f3 model_details / f4 mcp_tools
 *   UserMessageAction requires f1 user_message / f2 request_context
 *   model_details.f1 model_id must be the default variant slug
 *
 * Downstream: AgentServerMessage.f1 = InteractionUpdate
 *   f1 text_delta / f4 thinking_delta / f13 heartbeat / f14 turn_ended
 *
 * The Pro version adds conversation continuity: an initial `conversationState`
 * blob is passed in and the updated blob returned, so consecutive turns reuse
 * one Cursor conversation instead of starting fresh each time.
 *
 * @module dsh-connect-cursor-pro/session
 */
import { randomUUID } from 'node:crypto'
import { deframe, encode, frame, get, getVar, msg } from './pb.js'
import { openStreamRaw, runHeadersWithAuth } from './h2.js'
import { executeToolCall } from './tools.js'
import { settings } from './settings.js'

/** RequestedModel: model id + params (thinking/effort/...). */
export function requestedModel(name, params = {}) {
  return msg({
    1: name,
    3: Object.entries(params).map(([key, value]) => msg({ 1: key, 2: String(value) })),
  })
}

/** ModelDetails (AgentRunRequest.f3, required). modelId must be the slug. */
export function modelDetails(modelId, display, baseId) {
  return msg({ 1: modelId, 3: baseId || modelId, 4: display || modelId, 5: display || modelId, 6: [] })
}

/**
 * RequestContext (UserMessageAction.f2). `env.workspace_paths` and
 * `env.process_working_directory` tell Cursor where the workspace lives so its
 * file tools target the right directory; empty file_contents is required.
 */
function requestContext(workspaceRoot) {
  const root = workspaceRoot || process.cwd()
  const env = msg({ 2: root, 3: 'bash', 21: root })
  return msg({ 4: env, 20: Buffer.alloc(0) })
}

/**
 * SelectedContext (UserMessage.f3): the turn's attached images as inline bytes.
 * SelectedImage{ f2:uuid, f4:Dimension{width,height}, f7:mime_type, f8:data }.
 */
function selectedContext(images) {
  const defs = images.map((img) =>
    msg({
      2: randomUUID(),
      4: msg({ 1: img.width || 0, 2: img.height || 0 }),
      7: img.mediaType || 'image/png',
      8: Buffer.from(img.data),
    }),
  )
  return msg({ 1: defs })
}

/**
 * UserMessageAction{ f1: UserMessage{f1:text,f2:message_id,f3:selected_context}, f2: request_context }.
 */
export function userMessageAction(text, messageId = randomUUID(), images = [], workspaceRoot) {
  const fields = { 1: text, 2: messageId }
  if (images?.length) fields[3] = selectedContext(images)
  const userMessage = msg(fields)
  return msg({ 1: userMessage, 2: requestContext(workspaceRoot) })
}

/** ConversationAction{ f1: UserMessageAction }. */
export function conversationAction(text, messageId = randomUUID(), images = [], workspaceRoot) {
  return msg({ 1: userMessageAction(text, messageId, images, workspaceRoot) })
}

/**
 * AgentRunRequest (the content of AgentClientMessage.f1, not the first frame).
 * @param {object} options
 */
export function runRequest(options) {
  const fields = { 2: options.action, 3: options.modelDetails }
  if (options.requestedModel && options.requestedModel.length) fields[9] = options.requestedModel
  if (options.conversationState && options.conversationState.length) fields[1] = options.conversationState
  if (options.mcpTools && options.mcpTools.length) fields[4] = options.mcpTools
  if (options.conversationId) fields[5] = options.conversationId
  if (options.inlineImages) fields[19] = true
  if (options.runId) fields[25] = options.runId
  return msg(fields)
}

/** Wrap into the first frame: AgentClientMessage.f1 = run_request. */
export function wrapRunRequest(runReq) {
  return encode([{ field: 1, wireType: 2, value: runReq }])
}

/** Answer `request_context_args` (ExecServerMessage.f10) with the workspace context. */
function requestContextResult(workspaceRoot) {
  const success = msg({ 1: requestContext(workspaceRoot) })
  const result = msg({ 1: success })
  return encode([{ field: 2, wireType: 2, value: msg({ 10: result }) }])
}

/** Wrap an ExecClientMessage into AgentClientMessage.f2. */
function wrapExecResult(execClientMsg) {
  return encode([{ field: 2, wireType: 2, value: execClientMsg }])
}

/** Wrap a KvClientMessage into AgentClientMessage.f3. */
function wrapKvResult(kvClientMsg) {
  return encode([{ field: 3, wireType: 2, value: kvClientMsg }])
}

/** New-conversation state; minimal but carries the client metadata Cursor expects. */
function newConversationState() {
  return msg({
    5: msg({}), // token_details (empty)
    17: 0, // self_summary_count
    22: 'cli', // agent_type
    26: Date.now(), // conversation_started_timestamp_ms
    27: 'UTC', // conversation_started_time_zone
  })
}

/** Encode client-declared tools as MCP tool definitions. */
export function encodeMcpTools(tools) {
  if (!tools?.length) return Buffer.alloc(0)
  const defs = tools.map((tool) =>
    msg({
      1: tool.name,
      2: tool.description || '',
      6: JSON.stringify(tool.inputSchema || { type: 'object', properties: {} }),
    }),
  )
  return msg({ 1: defs.map((d) => msg({ 1: d })) })
}

/** Cursor built-in tool names; a colliding client tool name gets a suffix. */
const BUILTIN_PREFIXES = ['read', 'write', 'edit', 'grep', 'glob', 'ls', 'shell', 'web_search', 'web_fetch']

export function clientToolName(name) {
  return BUILTIN_PREFIXES.some((p) => name === p || name.startsWith(`${p}_`)) ? `${name}_dsh` : name
}

/** Strip Cursor's inline control markers (STX/NUL etc.) from streamed text. */
function cleanText(value) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

/** Extract InteractionUpdate events from one payload. */
function decodeInteractionUpdate(payload) {
  const update = get(payload, 1)
  if (!update) return []
  const events = []
  const textDelta = get(update, 1)
  if (textDelta) events.push({ type: 'text-delta', text: cleanText(textDelta.toString('utf8')) })
  const thinkingDelta = get(update, 4)
  if (thinkingDelta) events.push({ type: 'thinking-delta', text: cleanText(thinkingDelta.toString('utf8')) })
  const turnEnded = get(update, 14)
  if (turnEnded) {
    events.push({
      type: 'turn-ended',
      usage: {
        inputTokens: getVar(turnEnded, 1) || 0,
        outputTokens: getVar(turnEnded, 2) || 0,
        cacheRead: getVar(turnEnded, 3) || 0,
        cacheWrite: getVar(turnEnded, 4) || 0,
        reasoningTokens: getVar(turnEnded, 5) || 0,
      },
    })
  }
  // Newer Cursor often skips `turn_ended` and only emits per-call completion
  // (f31). For a single-call text/vision turn that IS the end of the answer.
  // Note: `model_call_completed` (f31) fires after every model call, not just the
  // final one, so treating it as `turn-ended` would truncate multi-step turns
  // (announce -> tool call -> continue). Only `turn_ended` (f14) ends the turn.
  return events
}

/** Decode one AgentServerMessage into session events. */
function decodeServerMessage(payload) {
  const events = decodeInteractionUpdate(payload)
  const exec = get(payload, 2)
  if (exec) {
    if (get(exec, 10)) events.push({ type: 'request-context' })
    if (get(exec, 11)) events.push({ type: 'mcp-args' })
  }
  // Conversation-state checkpoint (f3); the KV blob protocol (f4) is answered
  // directly in the run loop via handleKvMessage.
  const checkpoint = get(payload, 3)
  if (checkpoint) events.push({ type: 'kv', blob: checkpoint })
  return events
}

/**
 * Run one turn.
 *
 * Emits session events (text-delta / thinking-delta / turn-ended / error) via
 * `onEvent` and returns the final conversation state, so the adapter can carry
 * it into the next turn.
 */
export class RunSession {
  /**
   * @param {object} deps
   * @param {string} deps.accessToken
   * @param {(event: object) => void} deps.onEvent
   * @param {string} [deps.host]
   * @param {Buffer|null} [deps.conversationState] initial state (null = new conversation)
   * @param {string} [deps.conversationId]
   */
  constructor({ accessToken, onEvent, host, conversationState = null, conversationId = randomUUID(), workspaceRoot = process.cwd() }) {
    this.accessToken = accessToken
    this.onEvent = onEvent
    this.host = host
    this.requestId = randomUUID()
    this.runId = randomUUID()
    this.conversationId = conversationId
    this.conversationState = conversationState
    this.workspaceRoot = workspaceRoot
    this._blobs = new Map()
  }

  respondContext(stream) {
    stream.write(frame(requestContextResult(this.workspaceRoot))).catch(() => {})
  }

  /**
   * Answer Cursor's KV blob protocol (AgentServerMessage.f4). The server stores
   * the conversation-state blob via `set_blob` and reads it back via `get_blob`;
   * un-answered KV requests make the server cancel the turn ("KV stream closed").
   */
  handleKvMessage(kvServer, stream) {
    const kvId = getVar(kvServer, 1)
    const idFields = kvId !== undefined ? { 1: kvId } : {}
    const getBlob = get(kvServer, 2)
    const setBlob = get(kvServer, 3)
    if (setBlob) {
      const blobId = get(setBlob, 1)
      const blobData = get(setBlob, 2)
      if (blobId?.length && blobData?.length) {
        this._blobs.set(blobId.toString('hex'), blobData)
        this.conversationState = blobData
      }
      const result = msg({ ...idFields, 3: msg({}) })
      stream.write(frame(wrapKvResult(result))).catch(() => {})
    } else if (getBlob) {
      const blobId = get(getBlob, 1)
      const data = blobId ? this._blobs.get(blobId.toString('hex')) : undefined
      // A missing blob must omit `blob_data` (client sends `blobData: void 0`),
      // not an empty buffer, or the server's JSON hydration fails with
      // "Unexpected end of JSON input".
      const getBlobResult = data?.length ? msg({ 1: data }) : msg({})
      const result = msg({ ...idFields, 2: getBlobResult })
      stream.write(frame(wrapKvResult(result))).catch(() => {})
    }
  }

  /**
   * @param {object} options
   * @param {string} options.text
   * @param {string} options.modelId
   * @param {string} [options.baseModelId]
   * @param {string} [options.displayName]
   * @param {Record<string,string>} [options.modelParams]
   * @param {Array<{name: string, description?: string, inputSchema?: object}>} [options.tools]
   * @param {Array<{data: Uint8Array, mediaType?: string, width?: number, height?: number}>} [options.images]
   * @returns {Promise<{conversationState: Buffer|null, conversationId: string}>}
   */
  async run({ text, modelId, baseModelId, displayName, modelParams = {}, tools = [], images = [], timeoutMs = settings.timeoutMs, idleMs = settings.idleMs }) {
    const stream = await openStreamRaw(this.host || settings.agentHost, runHeadersWithAuth(this.accessToken, this.requestId))
    let buffer = Buffer.alloc(0)
    let settled = false
    // Cursor's client sends an empty client_heartbeat every 5s to keep the stream alive.
    const heartbeat = setInterval(() => {
      stream.write(frame(encode([{ field: 7, wireType: 2, value: msg({}) }]))).catch(() => {})
    }, 5000)

    const finished = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.onEvent({ type: 'error', message: 'Cursor Run timed out' })
        }
        resolve()
      }, timeoutMs)

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(heartbeat)
        if (idle) clearTimeout(idle)
        resolve()
      }

      // Cursor does not reliably send `turn_ended`; heartbeats keep arriving, so a
      // "no frames" check would never fire. Track a content-idle timer that only
      // text/thinking deltas reset.
      let sawContent = false
      let idle = null
      const armIdle = (ms = idleMs) => {
        if (!sawContent) return
        if (idle) clearTimeout(idle)
        idle = setTimeout(finish, ms)
      }

      stream.onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        const [frames, rest] = deframe(buffer)
        buffer = rest
        for (const { flag, payload } of frames) {
          if (flag & 0x02) {
            const trailer = payload.toString('utf8')
            // Cursor closes its conversation-state ("KV") sub-stream mid-turn with
            // a `canceled` trailer and keeps sending tool calls on the main stream;
            // only a non-canceled trailer is a real error.
            if (/canceled|KV stream closed/i.test(trailer)) continue
            this.onEvent({ type: 'error', message: trailer })
            finish()
            continue
          }
          // Answer the KV blob protocol (conversation-state get/set).
          const kvServer = get(payload, 4)
          if (kvServer) this.handleKvMessage(kvServer, stream)
          // Execute and answer the agent's built-in tool calls (read/write/ls/shell/grep).
          const exec = get(payload, 2)
          if (exec) {
            const execClient = executeToolCall(exec, this.workspaceRoot)
            if (execClient) {
              stream.write(frame(wrapExecResult(execClient))).catch(() => {})
            }
          }
          for (const event of decodeServerMessage(payload)) {
            if (event.type === 'text-delta' || event.type === 'thinking-delta') {
              sawContent = true
              armIdle()
            }
            if (event.type === 'request-context') this.respondContext(stream)
            if (event.type === 'kv' && event.blob?.length) {
              this.conversationState = event.blob
              // Conversation-state commit is Cursor's real end-of-turn marker
              // (`turn_ended` is unreliable). Shorten the idle window to finish fast.
              armIdle(5000)
            }
            if (event.type === 'turn-ended') {
              this.onEvent(event)
              finish()
              continue
            }
            this.onEvent(event)
          }
        }
      }
      stream.onEnd = finish
      stream.onError = (error) => {
        this.onEvent({ type: 'error', message: error.message })
        finish()
      }
    })

    const request = runRequest({
      conversationState: this.conversationState || newConversationState(),
      action: conversationAction(text, undefined, images, this.workspaceRoot),
      modelDetails: modelDetails(modelId, displayName, baseModelId),
      requestedModel: requestedModel(modelId, modelParams),
      mcpTools: encodeMcpTools(tools),
      inlineImages: images.length > 0,
      conversationId: this.conversationId,
      runId: this.runId,
    })
    await stream.write(frame(wrapRunRequest(request)))
    await finished
    try {
      stream.session.destroy()
    } catch {
      /* connection already closed */
    }
    return { conversationState: this.conversationState, conversationId: this.conversationId }
  }
}
