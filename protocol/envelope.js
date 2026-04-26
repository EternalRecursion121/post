import b4a from 'b4a'
import sodium from 'sodium-native'
import { ulid } from 'ulid'
import { Identity } from './identity.js'

const NONCE = sodium.crypto_secretbox_NONCEBYTES
const MAC = sodium.crypto_secretbox_MACBYTES

function sealRoom (plaintext, roomKey) {
  const nonce = b4a.alloc(NONCE)
  sodium.randombytes_buf(nonce)
  const ct = b4a.alloc(plaintext.length + MAC)
  sodium.crypto_secretbox_easy(ct, plaintext, nonce, roomKey)
  return b4a.concat([nonce, ct])
}

function openRoom (combined, roomKey) {
  if (combined.length < NONCE + MAC) return null
  const nonce = combined.slice(0, NONCE)
  const ct = combined.slice(NONCE)
  const out = b4a.alloc(ct.length - MAC)
  if (!sodium.crypto_secretbox_open_easy(out, ct, nonce, roomKey)) return null
  return out
}

export const TYPES = [
  'chat',
  'task.request',
  'task.result',
  'tool.invoke',
  'tool.result',
  'presence',
  'ack',
  // Application-level event types used by demos and higher-level flows.
  // The protocol does not interpret these; they are just signed/sealed
  // envelopes whose `body` is opaque to the wire layer.
  'pairing',
  'pairing.accepted',
  'contact.added',
  'sandbox.spawn',
  'sandbox.result',
  'offer'
]

// Address forms for `to`:
//   - 64-hex string                -> direct message to that agent pubkey
//   - "room:<hex>"                 -> message into an Autobase room
//   - "broadcast"                  -> public, body left in cleartext (rare)
function isDirectAddr (to) { return /^[0-9a-fA-F]{64}$/.test(to) }

// Build + sign + (optionally) seal an envelope. Returns the JSON-serializable
// object you write into your outbox Hypercore.
//
// For direct messages, `attach` is folded INTO the sealed payload so that
// drive keys are not visible to passive observers replicating the outbox —
// only the recipient sees them.
//
// For room messages, callers pass a `roomKey` (the 32-byte shared secret).
// We secretbox-encrypt {body, attach} with that key, prefixed by a fresh
// nonce. The outer `attach` field on the wire is always [] for sealed
// envelopes (direct or room).
export function seal ({ from, to, type, body, inReplyTo, attach, roomKey }, identity) {
  if (!TYPES.includes(type)) throw new Error('unknown envelope type: ' + type)
  const wireAttach = attach || []
  let outerAttach = wireAttach
  let ciphertext = ''
  if (isDirectAddr(to)) {
    const recipient = b4a.from(to, 'hex')
    const sealed = b4a.from(JSON.stringify({ body: body ?? {}, attach: wireAttach }))
    ciphertext = b4a.toString(identity.sealTo(recipient, sealed), 'base64')
    outerAttach = []
  } else if (typeof to === 'string' && to.startsWith('room:') && roomKey) {
    const sealed = b4a.from(JSON.stringify({ body: body ?? {}, attach: wireAttach }))
    ciphertext = b4a.toString(sealRoom(sealed, roomKey), 'base64')
    outerAttach = []
  } else {
    // broadcast (or room without a key — shouldn't happen via agent.sendRoom).
    ciphertext = b4a.toString(b4a.from(JSON.stringify(body ?? {})), 'base64')
  }

  const env = {
    v: 0,
    id: ulid(),
    ts: Date.now(),
    from: typeof from === 'string' ? from : b4a.toString(from, 'hex'),
    to,
    inReplyTo: inReplyTo || null,
    type,
    ciphertext,
    attach: outerAttach
  }

  const toSign = canonicalBytes(env)
  const sig = identity.sign(toSign)
  env.sig = b4a.toString(sig, 'base64')
  return env
}

// Verify signature; if envelope is direct + addressed to me, decrypt body.
// For room envelopes the caller passes opts.roomKey (the shared secret) so
// we can secretbox-decrypt the body.
export function open (env, identity, opts = {}) {
  if (!env || env.v !== 0) return { ok: false, reason: 'bad version' }
  const fromPub = b4a.from(env.from, 'hex')
  const sig = b4a.from(env.sig, 'base64')
  const toVerify = canonicalBytes(envWithoutSig(env))
  if (!Identity.verify(toVerify, sig, fromPub)) {
    return { ok: false, reason: 'bad signature' }
  }

  let body = null
  const direct = isDirectAddr(env.to)
  if (direct && env.to === identity.pubHex) {
    const ct = b4a.from(env.ciphertext, 'base64')
    const pt = identity.openSeal(ct)
    if (!pt) return { ok: false, reason: 'cannot decrypt' }
    body = unwrapSealed(pt, env)
  } else if (typeof env.to === 'string' && env.to.startsWith('room:')) {
    if (!opts.roomKey) return { ok: false, reason: 'no room key' }
    const ct = b4a.from(env.ciphertext, 'base64')
    const pt = openRoom(ct, opts.roomKey)
    if (!pt) return { ok: false, reason: 'cannot decrypt room' }
    body = unwrapSealed(pt, env)
  } else if (!direct) {
    // broadcast — cleartext at this layer.
    body = JSON.parse(b4a.toString(b4a.from(env.ciphertext, 'base64')))
  } else {
    // direct, but not for me
    return { ok: false, reason: 'not addressed to me' }
  }

  return { ok: true, env, body }
}

// Common shape for sealed payloads: { body, attach }. Recovers attach onto
// env so downstream code (UI, attachments.read) sees it the way it always
// has, even though the outer wire field was [].
function unwrapSealed (plaintext, env) {
  const obj = JSON.parse(b4a.toString(plaintext))
  if (obj && Object.prototype.hasOwnProperty.call(obj, 'body') &&
      Object.prototype.hasOwnProperty.call(obj, 'attach')) {
    env.attach = obj.attach || []
    return obj.body
  }
  return obj
}

function envWithoutSig (env) {
  // eslint-disable-next-line no-unused-vars
  const { sig, ...rest } = env
  return rest
}

// Stable serialization for signing: sort top-level keys.
function canonicalBytes (obj) {
  const keys = Object.keys(obj).sort()
  const out = {}
  for (const k of keys) out[k] = obj[k]
  return b4a.from(JSON.stringify(out))
}

// Hypercore append/decode helpers — store envelopes as JSON Buffers.
export function encode (env) { return b4a.from(JSON.stringify(env)) }
export function decode (buf) { return JSON.parse(b4a.toString(buf)) }
