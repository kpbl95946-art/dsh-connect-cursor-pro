import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeVarint, decodeVarint, msg, frame, deframe, get, getVar, getAll } from '../lib/pb.js'

test('varint round-trips', () => {
  for (const value of [0, 1, 127, 128, 300, 16384, 2 ** 32 - 1, 2 ** 40]) {
    const [decoded, next] = decodeVarint(encodeVarint(value), 0)
    assert.equal(decoded, value)
    assert.equal(next, encodeVarint(value).length)
  }
})

test('msg encodes fields with expected wire types', () => {
  const buf = msg({ 1: 'hello', 2: 7, 3: true, 4: ['a', 'b'] })
  assert.equal(get(buf, 1).toString('utf8'), 'hello')
  assert.equal(getVar(buf, 2), 7)
  assert.equal(getVar(buf, 3), 1)
  assert.deepEqual(
    getAll(buf, 4).map((b) => b.toString('utf8')),
    ['a', 'b'],
  )
})

test('frame/deframe round-trips a single frame', () => {
  const payload = Buffer.from('hello world', 'utf8')
  const [frames, rest] = deframe(frame(payload))
  assert.equal(frames.length, 1)
  assert.equal(frames[0].flag, 0)
  assert.equal(frames[0].payload.toString('utf8'), 'hello world')
  assert.equal(rest.length, 0)
})

test('deframe splits concatenated frames and keeps partial tail', () => {
  const a = frame(Buffer.from('first'))
  const b = frame(Buffer.from('second'))
  const combined = Buffer.concat([a, b, Buffer.from([0x01])])
  const [frames, rest] = deframe(combined)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].payload.toString('utf8'), 'first')
  assert.equal(frames[1].payload.toString('utf8'), 'second')
  assert.equal(rest.toString('hex'), '01')
})
