import b4a from 'b4a'
import { ulid } from 'ulid'
import { Identity } from './identity.js'

export const TYPES = [
  'chat',
  'task.request',
  'task.result',
  'tool.invoke',
  'tool.result',
  'presence',
  'ack'
]

// Address forms for `to`:
//   - 64-hex string                -> direct message to that agent pubkey
//   - "room:<hex>"                 -> message into an Autobase room
//   - "broadcast"                  -> public, body left in cleartext (rare)
function isDirectAddr (to) { return /^[0-9a-fA-F]{64}$/.test(to) }

// Build + sign + (optionally) seal an envelope. Returns the JSON-serializable
// object you write into your outbox Hypercore.
export function seal ({ from, to, type, body, inReplyTo, attach }, identity) {
  if (!TYPES.includes(type)) throw new Error('unknown envelope type: ' + type)
  const payload = b4a.from(JSON.stringify(body ?? {}))

  let ciphertext = ''
  if (isDirectAddr(to)) {
    const recipient = b4a.from(to, 'hex')
    ciphertext = b4a.toString(identity.sealTo(recipient, payload), 'base64')
  } else {
    // room or broadcast: cleartext, since multiple readers (or anyone) may decrypt.
    // Room privacy is enforced by knowing the autobase key; we treat it as a
    // shared secret. Hackathon-grade.
    ciphertext = b4a.toString(payload, 'base64')
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
    attach: attach || []
  }

  const toSign = canonicalBytes(env)
  const sig = identity.sign(toSign)
  env.sig = b4a.toString(sig, 'base64')
  return env
}

// Verify signature; if envelope is direct + addressed to me, decrypt body.
export function open (env, identity) {
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
    body = JSON.parse(b4a.toString(pt))
  } else if (!direct) {
    // room or broadcast
    body = JSON.parse(b4a.toString(b4a.from(env.ciphertext, 'base64')))
  } else {
    // direct, but not for me
    return { ok: false, reason: 'not addressed to me' }
  }

  return { ok: true, env, body }
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
