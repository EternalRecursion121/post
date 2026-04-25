import { EventEmitter } from 'events'
import b4a from 'b4a'
import { decode, open } from './envelope.js'

// The Inbox watches a set of peer outbox cores, decrypts envelopes addressed
// to us, and stores them in a local Hyperbee keyed by `<ts>:<from>:<id>`.
// Threads are reconstructed by following inReplyTo through the bee.
//
// Emits:
//   'message' (record) — { key, env, body } for any new envelope (direct,
//                        room, or broadcast) we successfully opened
export class Inbox extends EventEmitter {
  constructor (store, swarm, identity, bee, cursors) {
    super()
    this.store = store
    this.swarm = swarm
    this.identity = identity
    this.bee = bee          // Hyperbee — sorted message log
    this.cursors = cursors  // Hyperbee — peerHex -> last processed length
    this.watching = new Map() // peerHex -> core
  }

  async ready () {
    await this.bee.ready()
    await this.cursors.ready()
    return this
  }

  // Begin replicating a peer's outbox and watching for envelopes addressed
  // to us. Idempotent.
  async follow (peerPubkey) {
    const hex = b4a.isBuffer(peerPubkey) ? b4a.toString(peerPubkey, 'hex') : peerPubkey
    if (this.watching.has(hex)) return
    const key = b4a.from(hex, 'hex')

    if (b4a.equals(key, this.identity.pub)) return // don't follow self

    const core = this.store.get({ key })
    await core.ready()
    this.watching.set(hex, core)

    // Join the discovery key as a client so we find peers serving this core.
    this.swarm.join(core.discoveryKey, { server: false, client: true })

    const drain = () => this._drain(hex, core).catch(err => this.emit('error', err))
    core.on('append', drain)

    // Catch up on existing entries.
    drain()
  }

  async _drain (hex, core) {
    const cursorVal = await this.cursors.get(hex)
    let from = cursorVal ? Number(b4a.toString(cursorVal.value)) : 0
    const to = core.length
    for (let i = from; i < to; i++) {
      let buf
      try { buf = await core.get(i, { wait: true, timeout: 15000 }) } catch { break }
      const env = safeDecode(buf)
      if (!env) continue
      const result = open(env, this.identity)
      if (!result.ok) continue
      const beeKey = recordKey(env)
      const record = { env, body: result.body }
      await this.bee.put(beeKey, b4a.from(JSON.stringify(record)))
      this.emit('message', { key: beeKey, ...record })
    }
    await this.cursors.put(hex, b4a.from(String(to)))
  }

  async list ({ limit = 100, reverse = true } = {}) {
    const out = []
    for await (const { key, value } of this.bee.createReadStream({ reverse, limit })) {
      out.push({ key: b4a.toString(key), ...JSON.parse(b4a.toString(value)) })
    }
    return out
  }

  async thread (rootId) {
    // Walk forward from a given message id, collecting any messages that
    // reference it (or its descendants) via inReplyTo.
    const all = await this.list({ limit: 1000, reverse: false })
    const byId = new Map(all.map(r => [r.env.id, r]))
    const root = byId.get(rootId)
    if (!root) return []
    const out = [root]
    const stack = [rootId]
    const claimed = new Set([rootId])
    while (stack.length) {
      const parent = stack.pop()
      for (const r of all) {
        if (r.env.inReplyTo === parent && !claimed.has(r.env.id)) {
          claimed.add(r.env.id)
          out.push(r)
          stack.push(r.env.id)
        }
      }
    }
    return out
  }
}

function recordKey (env) {
  // Lex-sortable key. ts is padded to 16 chars, ulid id keeps order within
  // the same millisecond.
  const ts = String(env.ts).padStart(16, '0')
  return `${ts}:${env.from}:${env.id}`
}

function safeDecode (buf) {
  try { return decode(buf) } catch { return null }
}
