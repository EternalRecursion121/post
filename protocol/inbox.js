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
    this.rooms = new Set()  // hex room ids we accept envelopes for
  }

  joinRoom (roomKeyHex) { this.rooms.add(roomKeyHex) }
  leaveRoom (roomKeyHex) { this.rooms.delete(roomKeyHex) }

  // Schedule a drain for a peer. Drains for the same peer are serialised
  // (re-running once if more appends happened during the current run) so
  // we never have two concurrent core.get waits racing for the same index.
  _scheduleDrain (hex, core) {
    if (this._draining?.has(hex)) {
      this._pending = this._pending || new Set()
      this._pending.add(hex)
      return
    }
    this._draining = this._draining || new Map()
    this._draining.set(hex, this._runDrain(hex, core))
  }

  async _runDrain (hex, core) {
    try {
      do {
        this._pending?.delete(hex)
        await this._drain(hex, core)
      } while (this._pending?.has(hex))
    } catch (err) { this.emit('error', err) }
    finally { this._draining.delete(hex) }
  }

  // Mirror an envelope we just SENT into our own inbox so threads include
  // both sides without us having to decrypt our own ciphertext (which we
  // can't — sealed-box is one-way to the recipient).
  async record (env, body) {
    const beeKey = recordKey(env)
    const record = { env, body }
    await this.bee.put(beeKey, b4a.from(JSON.stringify(record)))
    this.emit('message', { key: beeKey, ...record })
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

    // Open the peer's outbox by signer pubkey so corestore reproduces the
    // same manifest (and therefore the same core.key) the owner used. If we
    // passed { key } directly we'd be passing the signer pubkey as if it
    // were a manifest hash — corestore would create a different core and
    // replication would never match.
    const core = this.store.get({ keyPair: { publicKey: key } })
    await core.ready()
    this.watching.set(hex, core)

    // Join the discovery key as a client so we find peers serving this core.
    this.swarm.join(core.discoveryKey, { server: false, client: true })

    const schedule = () => this._scheduleDrain(hex, core)
    core.on('append', schedule)

    // Catch up on existing entries.
    schedule()
  }

  async _drain (hex, core) {
    const cursorVal = await this.cursors.get(hex)
    let from = cursorVal ? Number(b4a.toString(cursorVal.value)) : 0
    const to = core.length
    if (to <= from) return
    for (let i = from; i < to; i++) {
      let buf
      try { buf = await core.get(i, { wait: true, timeout: 15000 }) } catch { break }
      const env = safeDecode(buf)
      if (!env) continue
      // Filter rooms before opening so we don't materialize chatter from
      // rooms we haven't joined.
      if (env.to && env.to.startsWith('room:')) {
        const roomId = env.to.slice('room:'.length)
        if (!this.rooms.has(roomId)) continue
      }
      const result = open(env, this.identity)
      if (!result.ok) continue
      const beeKey = recordKey(env)
      const record = { env, body: result.body }
      try {
        await this.bee.put(beeKey, b4a.from(JSON.stringify(record)))
      } catch (err) {
        // Storage closed mid-drain (process is shutting down) — bail out.
        if (/closed|closing/i.test(err.message)) return
        throw err
      }
      // Drive replication is on-demand via attachments.read(); we don't
      // pre-open here because hypercore's findingPeers handshake collides
      // with the metadata-only state we'd be left in.
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
