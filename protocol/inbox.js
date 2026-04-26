import { EventEmitter } from 'events'
import b4a from 'b4a'
import { decode, open } from './envelope.js'

// The Inbox watches a set of peer outbox cores, decrypts envelopes addressed
// to us, and stores them in a local Hyperbee keyed by `<ts>:<from>:<id>`.
// Threads are reconstructed by following inReplyTo through the bee.
//
// Emits:
//   'message' (record) — { key, env, body, bucket } for any new envelope
//                        (direct, room, or broadcast) we successfully opened
//   'rejected' (info)  — { env, reason, notify, autoBlocked } when an
//                        inbound envelope is dropped by the abuse guard
export class Inbox extends EventEmitter {
  constructor (store, swarm, identity, bee, cursors) {
    super()
    this.store = store
    this.swarm = swarm
    this.identity = identity
    this.bee = bee          // Hyperbee — sorted message log
    this.cursors = cursors  // Hyperbee — peerHex -> last processed length
    this.watching = new Map() // peerHex -> { core, onAppend }
    this.rooms = new Map()  // idHex -> 32-byte secret key (Buffer)
    this.guard = null       // optional AbuseGuard
  }

  setGuard (guard) { this.guard = guard }

  joinRoom (roomIdHex, roomKey) {
    if (!roomKey) throw new Error('joinRoom requires the 32-byte room key')
    this.rooms.set(roomIdHex, b4a.isBuffer(roomKey) ? roomKey : b4a.from(roomKey, 'hex'))
  }
  leaveRoom (roomIdHex) { this.rooms.delete(roomIdHex) }

  stop () {
    this._stopped = true
    for (const [, w] of this.watching) {
      try { w.core.removeAllListeners('append') } catch {}
    }
  }

  // Stop watching a peer's outbox. Detaches the append listener and leaves
  // the swarm topic so we no longer dial them. Idempotent.
  async unfollow (peerPubkey) {
    const hex = b4a.isBuffer(peerPubkey) ? b4a.toString(peerPubkey, 'hex') : peerPubkey
    const w = this.watching.get(hex)
    if (!w) return
    this.watching.delete(hex)
    try { w.core.removeListener('append', w.onAppend) } catch {}
    try { if (this.swarm.leave) await this.swarm.leave(w.core.discoveryKey) } catch {}
  }

  // Schedule a drain for a peer. Drains for the same peer are serialised
  // (re-running once if more appends happened during the current run) so
  // we never have two concurrent core.get waits racing for the same index.
  _scheduleDrain (hex, core) {
    if (this._stopped) return
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
  // can't — sealed-box is one-way to the recipient). Always lands in the
  // main bucket — we initiated this exchange.
  async record (env, body) {
    const beeKey = recordKey(env)
    const record = { env, body, bucket: 'main' }
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

    // Join the discovery key as a client so we find peers serving this core.
    this.swarm.join(core.discoveryKey, { server: false, client: true })

    const onAppend = () => this._scheduleDrain(hex, core)
    core.on('append', onAppend)
    this.watching.set(hex, { core, onAppend })

    // Catch up on existing entries.
    onAppend()
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
      let roomKey = null
      const isRoom = env.to && env.to.startsWith('room:')
      if (isRoom) {
        const roomId = env.to.slice('room:'.length)
        if (!this.rooms.has(roomId)) continue
        roomKey = this.rooms.get(roomId)
      }
      // Abuse guard runs on direct chat / tool.invoke. Room messages and
      // other types skip rate limiting / sizing (members already implicitly
      // trusted; ack and presence are tiny by construction).
      let bucket = 'main'
      if (this.guard && !isRoom) {
        const ctSize = typeof env.ciphertext === 'string' ? env.ciphertext.length : 0
        const verdict = await this.guard.checkInbound(env, ctSize)
        if (!verdict.ok) {
          this.emit('rejected', { env, ...verdict })
          continue
        }
        bucket = verdict.bucket || 'main'
      }
      const result = open(env, this.identity, { roomKey })
      if (!result.ok) continue
      const beeKey = recordKey(env)
      const record = { env, body: result.body, bucket }
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

  // bucket: 'main' (default), 'requests', or 'all'. Records written before
  // bucketing existed have no `bucket` field; treat those as 'main'.
  async list ({ limit = 100, reverse = true, bucket = 'main' } = {}) {
    const out = []
    // We may need to over-read when filtering by bucket; cap at 10x to
    // avoid unbounded scans on lopsided data.
    const wantAll = bucket === 'all'
    const target = limit
    const scanLimit = wantAll ? limit : Math.min(limit * 10, 10_000)
    for await (const { key, value } of this.bee.createReadStream({ reverse, limit: scanLimit })) {
      const rec = JSON.parse(b4a.toString(value))
      const recBucket = rec.bucket || 'main'
      if (!wantAll && recBucket !== bucket) continue
      out.push({ key: b4a.toString(key), ...rec, bucket: recBucket })
      if (out.length >= target) break
    }
    return out
  }

  async thread (rootId) {
    // Walk forward from a given message id, collecting any messages that
    // reference it (or its descendants) via inReplyTo. Pull from every
    // bucket so a thread that started in 'requests' and got promoted
    // still renders coherently.
    const all = await this.list({ limit: 1000, reverse: false, bucket: 'all' })
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
