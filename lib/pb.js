/**
 * Minimal Protobuf + Connect streaming codec, reverse-engineered from Cursor's
 * `agent.v1` / `aiserver.v1` wire protocol.
 *
 * Field numbers are taken from Cursor's own JS bundle (the same numbers the
 * reference `cursor2api` (MIT) project documents). This module implements the
 * four protobuf wire types (varint, length-delimited, fixed32, fixed64) plus
 * the Connect streaming frame `[1B flags][4B big-endian length][payload]`,
 * where flag `0x01` means gzip and `0x02` is the stream-end trailer.
 *
 * @module dsh-connect-cursor-pro/pb
 */
import { gunzipSync } from 'node:zlib'

/**
 * Encode an unsigned varint.
 * Uses division/modulo (not bitwise ops) so values above 32 bits survive;
 * Cursor context fields can exceed `2**32`.
 */
export function encodeVarint(value) {
  const out = []
  let v = Math.floor(value)
  if (!Number.isFinite(v) || v < 0) throw new RangeError(`varint: invalid value ${value}`)
  do {
    let byte = v % 128
    v = Math.floor(v / 128)
    if (v > 0) byte |= 0x80
    out.push(byte)
  } while (v > 0)
  return Buffer.from(out)
}

/**
 * Decode an unsigned varint; returns `[value, nextIndex]`.
 * Deliberately avoids `>>> 0` truncation: Cursor context fields exceed 32 bits.
 */
export function decodeVarint(buf, i) {
  let value = 0
  let multiplier = 1
  for (;;) {
    const byte = buf[i]
    i += 1
    value += (byte & 0x7f) * multiplier
    if (!(byte & 0x80)) return [value, i]
    multiplier *= 128
  }
}

/**
 * Parse protobuf bytes into `[{field, wireType, value}]`.
 * `value` is a Buffer for wireType 2, a number for wireType 0, and a raw
 * Buffer for fixed32/fixed64. Groups (wireType 3/4) are treated as one submessage.
 */
export function parse(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    let tag
    ;[tag, i] = decodeVarint(buf, i)
    const field = tag >> 3
    const wireType = tag & 7
    if (wireType === 0) {
      let v
      ;[v, i] = decodeVarint(buf, i)
      out.push({ field, wireType, value: v })
    } else if (wireType === 2) {
      let len
      ;[len, i] = decodeVarint(buf, i)
      out.push({ field, wireType, value: buf.subarray(i, i + len) })
      i += len
    } else if (wireType === 5) {
      out.push({ field, wireType, value: buf.subarray(i, i + 4) })
      i += 4
    } else if (wireType === 1) {
      out.push({ field, wireType, value: buf.subarray(i, i + 8) })
      i += 8
    } else if (wireType === 3 || wireType === 4) {
      // group (wt3 start / wt4 end): consume the paired block as one submessage.
      const start = i
      let depth = 1
      while (i < buf.length && depth > 0) {
        let inner
        ;[inner, i] = decodeVarint(buf, i)
        const innerWire = inner & 7
        if (innerWire === 3) depth += 1
        else if (innerWire === 4) depth -= 1
        else if (innerWire === 0) {
          ;[, i] = decodeVarint(buf, i)
        } else if (innerWire === 2) {
          let len
          ;[len, i] = decodeVarint(buf, i)
          i += len
        } else if (innerWire === 1) i += 8
        else if (innerWire === 5) i += 4
        else break
      }
      out.push({ field, wireType, value: buf.subarray(start, i) })
    } else {
      throw new Error(`protobuf: unsupported wire type ${wireType}`)
    }
  }
  return out
}

/** Serialize `[{field, wireType, value}]` tokens back to a Buffer. */
export function encode(tokens) {
  const parts = []
  for (const { field, wireType, value } of tokens) {
    parts.push(encodeVarint((field << 3) | wireType))
    if (wireType === 0) parts.push(encodeVarint(value))
    else if (wireType === 2) {
      parts.push(encodeVarint(value.length))
      parts.push(value)
    } else parts.push(value)
  }
  return Buffer.concat(parts)
}

/**
 * Build a message from `{ fieldNo: value }`. Field numbers may be numeric or
 * `f`-prefixed strings. bytes/string -> wireType 2, number/bool -> varint,
 * array -> repeated field.
 */
export function msg(fields) {
  const tokens = []
  for (const [key, value] of Object.entries(fields)) {
    const field = typeof key === 'number' ? key : Number(String(key).replace(/^f/, ''))
    if (!Number.isInteger(field) || field <= 0) {
      throw new TypeError(`msg: illegal field number ${key}`)
    }
    if (typeof value === 'boolean') tokens.push({ field, wireType: 0, value: value ? 1 : 0 })
    else if (typeof value === 'number') tokens.push({ field, wireType: 0, value })
    else if (typeof value === 'string') tokens.push({ field, wireType: 2, value: Buffer.from(value, 'utf8') })
    else if (Buffer.isBuffer(value)) tokens.push({ field, wireType: 2, value })
    else if (Array.isArray(value)) {
      for (const entry of value) {
        tokens.push({ field, wireType: 2, value: Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), 'utf8') })
      }
    } else {
      throw new TypeError(`msg: unsupported field type ${key}=${typeof value}`)
    }
  }
  return encode(tokens)
}

/** First wireType-2 value for a field; undefined when absent. */
export function get(buf, field) {
  for (const t of parse(buf)) if (t.field === field && t.wireType === 2) return t.value
  return undefined
}

/** Every wireType-2 value for a field. */
export function getAll(buf, field) {
  const out = []
  for (const t of parse(buf)) if (t.field === field && t.wireType === 2) out.push(t.value)
  return out
}

/** First varint value for a field. */
export function getVar(buf, field) {
  for (const t of parse(buf)) if (t.field === field && t.wireType === 0) return t.value
  return undefined
}

/** Rewrite the submessage value at `path` in place (used for session-state edits). */
export function editPath(buf, path, newValue) {
  const out = []
  let done = false
  for (const t of parse(buf)) {
    if (!done && t.field === path[0] && t.wireType === 2) {
      out.push({
        field: t.field,
        wireType: 2,
        value: path.length === 1 ? newValue : editPath(t.value, path.slice(1), newValue),
      })
      done = true
    } else {
      out.push(t)
    }
  }
  if (!done) throw new Error(`editPath: path missing ${path.join('.')}`)
  return encode(out)
}

/** Connect streaming frame: `[1B flags][4B big-endian length][payload]`. */
export function frame(payload, flag = 0) {
  const head = Buffer.alloc(5)
  head.writeUInt8(flag, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload])
}

/**
 * Decode a run of Connect frames. Returns `[{flag, payload}, leftoverBytes]`.
 * Flag `0x01` payloads are gunzipped (kept verbatim when that fails).
 */
export function deframe(buf) {
  const out = []
  let i = 0
  while (buf.length - i >= 5) {
    const flag = buf[i]
    const len = buf.readUInt32BE(i + 1)
    if (buf.length - i - 5 < len) break
    let payload = buf.subarray(i + 5, i + 5 + len)
    if (flag & 0x01) {
      try {
        payload = gunzipSync(payload)
      } catch {
        /* keep the non-gzip payload as-is */
      }
    }
    out.push({ flag, payload: Buffer.from(payload) })
    i += 5 + len
  }
  return [out, buf.subarray(i)]
}
