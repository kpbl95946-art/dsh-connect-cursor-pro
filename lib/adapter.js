/**
 * CursorAdapter: maps DSH's `LlmAdapter` contract onto Cursor's Run protocol.
 *
 * Implemented structurally (no base-class import) so it mounts across DSH
 * kernel lines; `registerAdapter` validates by calling the methods, not by
 * `instanceof`. The contract it honors:
 *   - every `block-start` pairs with a `block-end` (BlockAssembler requirement)
 *   - `finish.reason` is an object `{kind: ...}`, not a string
 *   - `resolveModel` returns a flat `LlmResolvedModelInfo`
 *
 * Pro additions over the original plugin:
 *   - multi-turn conversation state reuse (keyed by `options.sessionId`)
 *   - tool forwarding is opt-in (`settings.tools`), off by default
 *   - system prompt is included on the first turn of a conversation
 *
 * @module dsh-connect-cursor-pro/adapter
 */
import { randomUUID } from 'node:crypto'
import { catalog, resolveModel as resolveModelId } from './models.js'
import { probeCredential } from './auth.js'
import { RunSession } from './session.js'
import { settings } from './settings.js'

/** Provider route name. */
export const CURSOR_PROVIDER = 'cursor'

/** Render one message as text (string content or content blocks). */
function messageToText(message) {
  const content = message?.content
  if (typeof content === 'string') return content || ''
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && block.text) parts.push(block.text)
    else if (block?.type === 'image') parts.push('[image]')
    else if (block?.type === 'tool-result') {
      const inner = Array.isArray(block.content) ? block.content.map(messageToText).filter(Boolean).join('\n') : JSON.stringify(block.content)
      parts.push(`[tool result ${block.toolCallId ?? ''}] ${inner}`)
    }
  }
  if (message?.role === 'tool' && message?.callId) {
    parts.push(`[tool result ${message.callId}] ${JSON.stringify(content)}`)
  }
  return parts.filter(Boolean).join('\n')
}

/** Map DSH tools to Cursor MCP tool definitions (opt-in via settings.tools). */
function toolsToMcp(tools) {
  if (!tools?.length) return []
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: { type: 'object', ...(tool.parameters || {}) },
  }))
}

/** DSH reasoning effort -> Cursor `effort` param. */
function effortToParam(effort) {
  if (!effort) return undefined
  const map = { minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }
  return map[effort]
}

/** Build an LlmFailure (required fields of an error/aborted finish). */
function failure(message, code, status) {
  return status === undefined ? { message, code } : { message, code, status }
}

/**
 * Build the single user text sent to Cursor for this turn.
 *
 * Continuing a conversation (multiTurn on and we hold prior state) sends only
 * the newest user message; Cursor already remembers the rest. A fresh
 * conversation sends the system prompt plus the full visible history.
 */
function buildUserText(options, continuing) {
  const messages = options.messages || []
  const parts = []
  if (continuing) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        const text = messageToText(messages[i])
        if (text) parts.push(text)
        break
      }
    }
    if (!parts.length) parts.push(...messages.map(messageToText))
  } else {
    if (options.system) parts.push(options.system)
    parts.push(...messages.map(messageToText))
  }
  return parts.filter(Boolean).join('\n\n')
}

/** Session events -> DSH StreamChunk increments (one instance per turn). */
export class StreamTranslator {
  constructor() {
    this.entries = new Map()
    this.order = []
    this.nextIndex = 0
  }

  entry(key) {
    let state = this.entries.get(key)
    if (!state) {
      state = { index: this.nextIndex++, type: '', text: '', args: '', name: '', id: '', started: false, closed: false }
      this.entries.set(key, state)
      this.order.push(key)
    }
    return state
  }

  push(events) {
    const out = []
    for (const event of events) {
      if (event.type === 'text-delta') {
        const state = this.entry('text')
        if (!state.started) {
          state.started = true
          state.type = 'text'
          out.push({ type: 'block-start', index: state.index, blockType: 'text' })
        }
        state.text += event.text
        out.push({ type: 'text-delta', index: state.index, text: event.text })
      } else if (event.type === 'thinking-delta') {
        const state = this.entry('reasoning')
        if (!state.started) {
          state.started = true
          state.type = 'reasoning'
          out.push({ type: 'block-start', index: state.index, blockType: 'reasoning' })
        }
        state.text += event.text
        out.push({ type: 'reasoning-delta', index: state.index, text: event.text })
      } else if (event.type === 'tool-call') {
        const state = this.entry(`tool:${event.id}`)
        if (!state.started) {
          state.started = true
          state.type = 'tool-call'
          state.id = event.id
          state.name = event.name
          out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' })
        }
        state.args += event.arguments
        out.push({
          type: 'tool-call-delta',
          index: state.index,
          id: event.id,
          name: state.name,
          argumentsDelta: event.arguments,
        })
      } else if (event.type === 'turn-ended') {
        out.push({
          type: 'usage',
          usage: {
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheRead,
            cacheWriteTokens: event.usage.cacheWrite,
            reasoningTokens: event.usage.reasoningTokens,
          },
        })
      }
    }
    return out
  }

  close(reason) {
    const out = []
    for (const key of this.order) {
      const state = this.entries.get(key)
      if (!state.started || state.closed) continue
      state.closed = true
      if (state.type === 'text') {
        out.push({ type: 'block-end', index: state.index, block: { type: 'text', text: state.text } })
      } else if (state.type === 'reasoning') {
        out.push({ type: 'block-end', index: state.index, block: { type: 'reasoning', text: state.text } })
      } else if (state.type === 'tool-call') {
        out.push({
          type: 'block-end',
          index: state.index,
          block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args },
        })
      }
    }
    out.push({ type: 'finish', reason })
    return out
  }
}

/** Async event queue turning callback-style events into an awaitable pull. */
export class EventQueue {
  constructor() {
    this.items = []
    this.done = false
    this.wakeup = null
  }

  push(item) {
    this.items.push(item)
    this.notify()
  }

  close() {
    this.done = true
    this.notify()
  }

  notify() {
    const resolve = this.wakeup
    this.wakeup = null
    resolve?.()
  }

  async next() {
    if (!this.items.length && !this.done) {
      await new Promise((resolve) => {
        this.wakeup = resolve
      })
    }
    return this.items.shift()
  }
}

const MAX_CONVERSATIONS = 500

/** Cursor's LlmAdapter (structural). */
export class CursorAdapter {
  constructor(options = {}) {
    this.injectedCredential = options.credential || null
    this._conversations = new Map()
  }

  providerInfo(provider) {
    return { id: provider || CURSOR_PROVIDER, name: 'Cursor' }
  }

  providerRetryPolicy() {
    return undefined
  }

  async listModels(provider) {
    const models = await catalog()
    return models
      .filter((m) => settings.includeHidden || !m.hidden)
      .map((m) => ({
        provider: provider || CURSOR_PROVIDER,
        id: m.id,
        name: m.display || m.id,
        // Text only: image bytes are not yet forwarded to Cursor's Run protocol.
        inputModalities: ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const models = await catalog()
    const hit = models.find((m) => m.id === model)
    if (!hit) {
      throw new Error(`model "${model}" is not in the Cursor catalog. Available: ${models.map((m) => m.id).join(', ') || '(empty)'}`)
    }
    return {
      provider: provider || CURSOR_PROVIDER,
      id: hit.id,
      name: hit.display || hit.id,
      inputModalities: ['text'],
      ...(hit.context ? { context: { contextWindow: hit.context } } : {}),
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /** Conversation state for a session key, reusing prior state when present. */
  _conversationFor(key) {
    if (!key) return { conversationState: null, conversationId: randomUUID() }
    if (this._conversations.has(key)) return this._conversations.get(key)
    const conv = { conversationState: null, conversationId: randomUUID() }
    if (this._conversations.size >= MAX_CONVERSATIONS) {
      const oldest = this._conversations.keys().next().value
      this._conversations.delete(oldest)
    }
    this._conversations.set(key, conv)
    return conv
  }

  /**
   * Stream one turn.
   * @param {import('@deepseek-ai/dsh-llm').GenerateOptions} options
   * @returns {AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>}
   */
  async *stream(options) {
    const translator = new StreamTranslator()
    const signal = options.signal
    const credential = this.injectedCredential || (await probeCredential()).credential

    if (!credential?.accessToken) {
      yield* translator.close({ kind: 'error', failure: failure('No usable Cursor login; open the Cursor desktop app or set CURSOR_API_KEY', 'NO_CREDENTIAL') })
      return
    }

    let resolved
    try {
      resolved = await resolveModelId(options.model)
    } catch (error) {
      yield* translator.close({ kind: 'error', failure: failure(error?.message || 'model resolution failed', 'UNKNOWN_MODEL') })
      return
    }
    const { modelId, baseId, display, params: modelParams } = resolved

    const params = { ...modelParams }
    const effort = effortToParam(options.reasoningEffort)
    if (effort) params.effort = effort

    const key = settings.multiTurn ? String(options.sessionId ?? `${options.provider}:${options.model}`) : null
    const conv = this._conversationFor(key)
    const continuing = settings.multiTurn && Boolean(conv.conversationState)

    const queue = new EventQueue()
    const session = new RunSession({
      accessToken: credential.accessToken,
      onEvent: (event) => queue.push(event),
      conversationState: conv.conversationState,
      conversationId: conv.conversationId,
    })

    const tools = settings.tools ? toolsToMcp(options.tools) : []
    const runPromise = session
      .run({
        text: buildUserText(options, continuing),
        modelId,
        baseModelId: baseId,
        displayName: display,
        modelParams: params,
        tools,
      })
      .then((result) => {
        if (key) {
          conv.conversationState = result.conversationState
          this._conversations.set(key, conv)
        }
      })
      .catch((error) => queue.push({ type: 'error', message: error?.message || String(error) }))
      .finally(() => queue.close())

    const onAbort = () => queue.push({ type: 'error', message: 'request cancelled' })
    signal?.addEventListener('abort', onAbort, { once: true })

    let runError = null
    try {
      for (;;) {
        const event = await queue.next()
        if (event === undefined) break
        if (event.type === 'error') runError = event.message
        yield* translator.push([event])
        if (runError) break
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
    await runPromise

    if (signal?.aborted) {
      yield* translator.close({ kind: 'aborted', failure: failure('request cancelled', 'ABORTED') })
    } else if (runError) {
      yield* translator.close({ kind: 'error', failure: failure(runError, 'UPSTREAM') })
    } else {
      yield* translator.close({ kind: 'stop' })
    }
  }
}
