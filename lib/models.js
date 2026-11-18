/**
 * Cursor model catalog: the account's available models plus any-name -> (base
 * model, params) resolution.
 *
 * The catalog comes from the same unary Connect call the CLI model picker uses:
 *   POST {apiBase}/aiserver.v1.AiService/AvailableModels   (application/proto)
 * Field numbers follow the MIT `cursor2api` models.py.
 *
 * @module dsh-connect-cursor-pro/models
 */
import { resolveCredential } from './auth.js'
import { getAll, get, getVar, msg } from './pb.js'
import { settings } from './settings.js'

const RPC = () => `${settings.apiBase}/aiserver.v1.AiService/AvailableModels`
const TTL_MS = 15 * 60_000

/**
 * Offline fallback catalog: only long-lived base models that do not vary with
 * account tier. `claude` / `gpt` / `gemini` entries come and go with the
 * account, so they are deliberately absent here — listing them offline would
 * offer models the account cannot actually call.
 */
const FALLBACK = [
  ['composer-2.5', { fast: 'true' }],
  ['grok-4.7', { reasoning_effort: 'high', fast: 'false', context: '256k' }],
  ['grok-4.6', { reasoning_effort: 'high', fast: 'true', context: '256k' }],
  ['kimi-k3', { context: '1048576' }],
  ['glm-5.2', { context: '1000000' }],
]

/** Vendor API names -> Cursor model, so existing client spelling still works. */
const ALIASES = {
  'claude-opus-4-1': 'claude-opus-5',
  'claude-opus-4': 'claude-opus-5',
  'claude-3-opus': 'claude-opus-5',
  'claude-3-7-sonnet': 'claude-sonnet-5',
  'claude-3-5-sonnet': 'claude-sonnet-5',
  'claude-3-5-haiku': 'claude-haiku-4-5',
  'claude-3-haiku': 'claude-haiku-4-5',
  'gpt-5.6': 'gpt-5.6-sol',
  'gpt-5': 'gpt-5.5',
  'gpt-4.1': 'gpt-5.5',
  'gpt-4o-mini': 'gpt-5-mini',
  'gpt-4o': 'gpt-5.5',
  o3: 'gpt-5.3-codex',
  grok: 'grok-4.7',
  'gemini-pro': 'gemini-3.1-pro',
  kimi: 'kimi-k3',
}

/** Option values of one parameter definition, in display order. */
function paramValues(blob) {
  const out = []
  for (const field of [1, 2]) {
    for (const group of getAll(blob, field)) {
      for (const opt of getAll(group, 1)) {
        const val = get(opt, 1)
        if (val !== undefined) out.push(val.toString('utf8'))
      }
    }
  }
  return out
}

/** Parse one model variant (f1 params, f4 default flag, f9 spec, f11 slug). */
function variant(blob) {
  const params = {}
  for (const p of getAll(blob, 1)) {
    const key = get(p, 1)
    const val = get(p, 2)
    if (key !== undefined) params[key.toString('utf8')] = (val || Buffer.alloc(0)).toString('utf8')
  }
  return {
    params,
    id: (get(blob, 11) || Buffer.alloc(0)).toString('utf8'),
    spec: (get(blob, 9) || Buffer.alloc(0)).toString('utf8'),
    default: Boolean(getVar(blob, 4)),
  }
}

/** Default params when no variant is selected. */
function defaults(name, options, variants) {
  for (const v of variants) if (v.default) return { ...v.params }
  for (const [base, params] of FALLBACK) if (base === name) return { ...params }
  const out = {}
  for (const [pid, values] of Object.entries(options)) {
    if (!values.length) continue
    if (pid === 'thinking') out[pid] = values.includes('true') ? 'true' : values[0]
    else if (pid === 'effort' || pid === 'reasoning') out[pid] = values.includes('high') ? 'high' : values[values.length - 1]
    else out[pid] = values[0]
  }
  return out
}

/** Parse one AvailableModel entry. */
function model(blob) {
  const name = (get(blob, 1) || Buffer.alloc(0)).toString('utf8')
  const options = {}
  const order = []
  for (const pdef of getAll(blob, 29)) {
    const pid = (get(pdef, 1) || Buffer.alloc(0)).toString('utf8')
    if (!pid) continue
    order.push(pid)
    options[pid] = paramValues(get(pdef, 4) || Buffer.alloc(0))
  }
  const variants = getAll(blob, 30).map(variant).filter((v) => Object.keys(v.params).length)
  return {
    id: name,
    display: (get(blob, 17) || Buffer.alloc(0)).toString('utf8') || name,
    options,
    order,
    variants,
    params: defaults(name, options, variants),
    aliases: getAll(blob, 37).map((x) => x.toString('utf8')),
    slugs: getAll(blob, 36).map((x) => x.toString('utf8')),
    thinking: Boolean(getVar(blob, 9)),
    images: Boolean(getVar(blob, 10)),
    context: getVar(blob, 15) || 0,
    hidden: Boolean(getVar(blob, 35)),
  }
}

/** Offline fallback catalog. */
function fallbackCatalog() {
  return FALLBACK.map(([name, params]) => ({
    id: name,
    display: name,
    options: {},
    order: [],
    variants: [],
    params: { ...params },
    aliases: [],
    slugs: [],
    thinking: 'thinking' in params,
    images: true,
    context: 0,
    hidden: false,
  }))
}

/** Fetch AvailableModels without caching; throws on failure. */
export async function fetchCatalog() {
  const credential = await resolveCredential()
  const response = await fetch(RPC(), {
    method: 'POST',
    headers: {
      'content-type': 'application/proto',
      'connect-protocol-version': '1',
      authorization: `Bearer ${credential.accessToken}`,
      'user-agent': 'connect-es/1.6.1',
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': settings.clientVersion,
    },
    body: msg({ 2: true, 5: true, 7: true }),
  })
  if (!response.ok) {
    throw new Error(`AvailableModels HTTP ${response.status} ${response.statusText}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  const models = getAll(raw, 2).map(model).filter((m) => m.id && m.id !== 'default')
  if (!models.length) throw new Error('AvailableModels returned an empty catalog')
  return models
}

let cache = { at: 0, models: [] }

/** Injectable catalog implementation (tests). */
let catalogFn = defaultCatalog
export function __setCatalog(fn) {
  catalogFn = fn
  cache = { at: 0, models: [] }
}

async function defaultCatalog() {
  const now = Date.now()
  if (cache.models.length && now - cache.at < TTL_MS) return cache.models
  try {
    const models = await fetchCatalog()
    cache = { at: now, models }
  } catch {
    if (cache.models.length) return cache.models
    cache = { at: now, models: fallbackCatalog() }
  }
  return cache.models
}

/** Cached catalog; `refresh` forces a network fetch. */
export async function catalog(refresh = false) {
  if (refresh) {
    const models = await fetchCatalog().catch(() => null)
    if (models) {
      cache = { at: Date.now(), models }
      return models
    }
  }
  return catalogFn()
}

/** name -> (base model, params) index; base id is written last so it wins. */
function index(models) {
  const table = new Map()
  const put = (name, value) => {
    if (name) table.set(name.toLowerCase(), value)
  }
  for (const m of models) {
    for (const alias of m.aliases) put(alias, [m.id, m.params])
    for (const slug of m.slugs) put(slug, [m.id, m.params])
    for (const v of m.variants) {
      for (const name of [v.id, v.spec]) put(name, [m.id, v.params])
    }
    put(m.id, [m.id, m.params])
  }
  return table
}

/** Split "base-flag1-flag2" into base model + params. */
function fromTokens(name, table, models) {
  const parts = name.split('-')
  for (let cut = parts.length - 1; cut > 0; cut -= 1) {
    const base = parts.slice(0, cut).join('-')
    const hit = table.get(base)
    if (!hit) continue
    const model = models.find((m) => m.id === hit[0])
    if (!model) continue
    const params = { ...hit[1] }
    for (const tok of parts.slice(cut)) {
      if (tok === 'thinking' || tok === 'think') params.thinking = 'true'
      else if (tok === 'nothinking' || tok === 'nonthinking') params.thinking = 'false'
      else if (tok === 'fast' || tok === 'max-mode') params.fast = 'true'
      else {
        const found = Object.entries(model.options).find(([, values]) => values.includes(tok))
        if (!found) return null
        params[found[0]] = tok
      }
    }
    return [model.id, params]
  }
  return null
}

/** Resolve one spelling. */
function resolveOne(name, table, models) {
  if (!name) return null
  const low = name.toLowerCase()
  if (table.has(low)) {
    const [base, params] = table.get(low)
    return [base, { ...params }]
  }
  if (low.includes('[') && low.endsWith(']')) {
    const head = low.slice(0, low.indexOf('['))
    const tail = low.slice(low.indexOf('[') + 1, -1)
    const got = resolveOne(head, table, models)
    if (got) {
      const [base, params] = got
      for (const pair of tail.split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) params[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
      }
      return [base, params]
    }
  }
  for (const suffix of ['-latest', '-preview']) {
    if (low.endsWith(suffix)) return resolveOne(low.slice(0, -suffix.length), table, models)
  }
  if (low.length > 9 && /\d$/.test(low.slice(-1)) && low.slice(-9, -8) === '-') {
    return resolveOne(low.slice(0, -9), table, models)
  }
  const tokens = fromTokens(low, table, models)
  if (tokens) return tokens
  for (const [prefix, target] of Object.entries(ALIASES)) {
    if (low.startsWith(prefix)) {
      const hit = table.get(target)
      if (hit) return [hit[0], { ...hit[1] }]
    }
  }
  return null
}

/**
 * Resolve any model spelling to the runtime identity.
 *
 * `Run` only accepts the default variant's slug (e.g. `claude-sonnet-5-thinking-high`);
 * a base id is rejected with `ERROR_BAD_MODEL_NAME`. An explicitly requested
 * spelling that does not resolve throws rather than silently substituting a
 * different model.
 *
 * @param {string} name
 * @param {string} [fallback]
 * @returns {Promise<{modelId: string, baseId: string, display: string, params: Record<string,string>}>}
 */
export async function resolveModel(name, fallback) {
  const models = await catalog()
  const table = index(models)
  const wanted = (name || '').trim()
  if (wanted) {
    const hit = resolveOne(wanted, table, models)
    if (hit) {
      const [baseId, params] = hit
      const model = models.find((m) => m.id === baseId)
      const slug = defaultVariantSlug(model) || baseId
      return {
        modelId: slug,
        baseId,
        display: model?.display || slug,
        params: { ...(model?.params || {}), ...params },
      }
    }
    throw new Error(`model "${wanted}" is not in the Cursor catalog. Available: ${models.map((m) => m.id).join(', ') || '(empty)'}`)
  }
  const target = fallback ? models.find((m) => m.id === fallback) : models[0]
  if (!target) {
    throw new Error('Cursor model catalog is empty; confirm the Cursor desktop app is signed in.')
  }
  const slug = defaultVariantSlug(target) || target.id
  return { modelId: slug, baseId: target.id, display: target.display || slug, params: { ...target.params } }
}

function defaultVariantSlug(model) {
  if (!model) return null
  const preferred = model.variants.find((v) => v.default)
  return preferred?.id || model.variants[0]?.id || null
}
