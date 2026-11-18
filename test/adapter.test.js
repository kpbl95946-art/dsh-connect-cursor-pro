import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamTranslator, EventQueue } from '../lib/adapter.js'

test('StreamTranslator emits paired text block and stop finish', () => {
  const t = new StreamTranslator()
  const chunks = t.push([{ type: 'text-delta', text: 'Hel' }])
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(chunks[1].type, 'text-delta')
  assert.equal(chunks[1].text, 'Hel')

  const more = t.push([{ type: 'text-delta', text: 'lo' }])
  assert.equal(more.length, 1)

  const closed = t.close({ kind: 'stop' })
  assert.equal(closed[0].type, 'block-end')
  assert.equal(closed[0].block.type, 'text')
  assert.equal(closed[0].block.text, 'Hello')
  assert.equal(closed[1].type, 'finish')
  assert.equal(closed[1].reason.kind, 'stop')
})

test('StreamTranslator maps reasoning deltas to reasoning block', () => {
  const t = new StreamTranslator()
  t.push([{ type: 'thinking-delta', text: 'think' }])
  const closed = t.close({ kind: 'stop' })
  assert.equal(closed[0].type, 'block-end')
  assert.equal(closed[0].block.type, 'reasoning')
  assert.equal(closed[0].block.text, 'think')
})

test('StreamTranslator maps turn-ended usage', () => {
  const t = new StreamTranslator()
  const chunks = t.push([
    { type: 'turn-ended', usage: { inputTokens: 11, outputTokens: 22, cacheRead: 3, cacheWrite: 4, reasoningTokens: 5 } },
  ])
  assert.equal(chunks[0].type, 'usage')
  assert.equal(chunks[0].usage.inputTokens, 11)
  assert.equal(chunks[0].usage.outputTokens, 22)
})

test('StreamTranslator closes with error finish reason', () => {
  const t = new StreamTranslator()
  const closed = t.close({ kind: 'error', failure: { message: 'boom', code: 'UPSTREAM' } })
  assert.equal(closed[0].type, 'finish')
  assert.equal(closed[0].reason.kind, 'error')
  assert.equal(closed[0].reason.failure.code, 'UPSTREAM')
})

test('EventQueue delivers pushed items then ends', async () => {
  const q = new EventQueue()
  q.push('a')
  q.push('b')
  assert.equal(await q.next(), 'a')
  assert.equal(await q.next(), 'b')
  q.close()
  assert.equal(await q.next(), undefined)
})
