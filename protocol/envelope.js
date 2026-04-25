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
//
// For direct messages, `attach` is folded INTO the sealed payload so that
// drive keys are not visible to passive observers replicating the outbox —
// only the recipient sees them. The outer `attach` field on the wire is
// always [] for direct envelopes.
export function seal ({ from, to, type, body, inReplyTo, attach }, identity) {
  if (!TYPES.includes(type)) throw new Error('unknown envelope type: ' + type)
  const wireAttach = attach || []
  let outerAttach = wireAttach
  let ciphertext = ''
  if (isDirectAddr(to)) {
    const recipient = b4a.from(to, 'hex')
    const sealed = b4a.from(JSON.stringify({ body: body ?? {}, attach: wireAttach }))
    ciphertext = b4a.toString(identity.sealTo(recipient, sealed), 'base64')
    outerAttach = []
  } else {
    // room or broadcast: cleartext at this layer. Rooms apply their own
    // symmetric encryption in agent.sendRoom (see envelope/index wiring).
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
    const sealed = JSON.parse(b4a.toString(pt))
    if (sealed && Object.prototype.hasOwnProperty.call(sealed, 'body') &&
        Object.prototype.hasOwnProperty.call(sealed, 'attach')) {
      body = sealed.body
      // Recover attach from inside the ciphertext — drive keys are private
      // to the recipient. Mutate the env so downstream code sees attach as
      // it always has.
      env.attach = sealed.attach || []
    } else {
      body = sealed
    }
  } else if (!direct) {
    // room or broadcast — cleartext at this layer.
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
