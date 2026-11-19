import { test } from 'node:test'
import assert from 'node:assert/strict'
import { conversationAction, runRequest } from '../lib/session.js'
import { get, getVar } from '../lib/pb.js'

test('conversationAction encodes an inline image into selected_context', () => {
  const img = { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png', width: 10, height: 20 }
  const action = conversationAction('hi', 'm1', [img])
  const userMessage = get(get(action, 1), 1)
  assert.equal(get(userMessage, 1).toString(), 'hi')
  const ctx = get(userMessage, 3)
  assert.ok(ctx, 'selected_context present')
  const image = get(ctx, 1)
  assert.equal(get(image, 7).toString(), 'image/png')
  assert.equal(get(image, 8).toString('hex'), '89504e47')
  assert.equal(getVar(get(image, 4), 1), 10)
  assert.equal(getVar(get(image, 4), 2), 20)
})

test('conversationAction without images omits selected_context', () => {
  const userMessage = get(get(conversationAction('hi', 'm1'), 1), 1)
  assert.equal(get(userMessage, 3), undefined)
})

test('runRequest sets client_supports_inline_images only when images are present', () => {
  const withImages = runRequest({ action: Buffer.from([1, 2]), modelDetails: Buffer.from([1, 2]), inlineImages: true })
  assert.equal(getVar(withImages, 19), 1)
  const without = runRequest({ action: Buffer.from([1, 2]), modelDetails: Buffer.from([1, 2]) })
  assert.equal(getVar(without, 19), undefined)
})
