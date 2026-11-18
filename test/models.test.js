import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveModel, __setCatalog } from '../lib/models.js'

const FAKE = [
  {
    id: 'claude-sonnet-5',
    display: 'Claude Sonnet 5',
    options: {},
    order: [],
    variants: [
      { id: 'claude-sonnet-5-thinking-high', spec: 'claude-sonnet-5[thinking=true,effort=high]', params: { thinking: 'true', effort: 'high' }, default: true },
    ],
    params: { thinking: 'true', effort: 'high' },
    aliases: ['claude-3-7-sonnet'],
    slugs: ['claude-sonnet-5-thinking-high'],
    thinking: true,
    images: true,
    context: 200000,
    hidden: false,
  },
]

__setCatalog(async () => FAKE)

test('resolveModel returns the default variant slug for a base id', async () => {
  const r = await resolveModel('claude-sonnet-5')
  assert.equal(r.modelId, 'claude-sonnet-5-thinking-high')
  assert.equal(r.baseId, 'claude-sonnet-5')
})

test('resolveModel resolves an alias to the base model', async () => {
  const r = await resolveModel('claude-3-7-sonnet')
  assert.equal(r.baseId, 'claude-sonnet-5')
})

test('resolveModel throws for an unknown model', async () => {
  await assert.rejects(() => resolveModel('does-not-exist'), /not in the Cursor catalog/)
})

test('resolveModel uses fallback when name is empty', async () => {
  const r = await resolveModel('', 'claude-sonnet-5')
  assert.equal(r.baseId, 'claude-sonnet-5')
})
