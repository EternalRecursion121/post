// Presence: a periodic envelope advertising "I'm online" plus current
// capabilities, broadcast to known contacts. Receivers update a per-peer
// lastSeen table so the UI can show online/away halos on the graph.
//
// We send a separate sealed envelope to each contact (rather than a true
// broadcast) because direct sealed-box envelopes are how the rest of the
// protocol works — keeping presence on the same path means it's signed,
// authenticated, and visible in the inbox stream like any other message.

import { EventEmitter } from 'events'

const DEFAULT_INTERVAL = 30_000   // 30s ticker
const STALE_AFTER     = 90_000   // 90s without ping = "away"

export class Presence extends EventEmitter {
  constructor (outbox, inbox, directory, opts = {}) {
    super()
    this.outbox = outbox
    this.inbox = inbox
    this.directory = directory
    this.interval = opts.interval || DEFAULT_INTERVAL
    this.enabled = opts.enabled !== false
    this.timer = null
    this.peers = new Map()  // pubHex -> { state, lastSeen, capabilities }

    this.inbox.on('message', (rec) => this._onMessage(rec))
  }

  start () {
    if (!this.enabled || this.timer) return
    // First broadcast on a short delay so contacts learn we're online quickly.
    this.timer = setTimeout(() => this._tick(), 250)
  }

  stop () {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async _tick () {
    try { await this.broadcast('online') } catch (err) { this.emit('error', err) }
    if (!this.enabled) return
    this.timer = setTimeout(() => this._tick(), this.interval)
  }

  async broadcast (state) {
    const contacts = await this.directory.contacts().catch(() => [])
    const body = {
      state,
      capabilities: this.directory.profile?.capabilities || [],
      ts: Date.now()
    }
    for (const c of contacts) {
      if (c.pubkey === this.outbox.identity.pubHex) continue
      try {
        await this.outbox.send({ to: c.pubkey, type: 'presence', body })
      } catch {}
    }
  }

  // Mark a peer as away if we haven't heard from them lately.
  classify (pubHex) {
    const p = this.peers.get(pubHex)
    if (!p) return 'unknown'
    if (Date.now() - p.lastSeen > STALE_AFTER) return 'away'
    return p.state || 'online'
  }

  snapshot () {
    const out = {}
    for (const [k, v] of this.peers) {
      out[k] = { ...v, classified: this.classify(k) }
    }
    return out
  }

  _onMessage (rec) {
    const env = rec.env
    if (env.type !== 'presence') return
    if (env.from === this.outbox.identity.pubHex) return  // own mirror
    const prev = this.peers.get(env.from) || {}
    this.peers.set(env.from, {
      state: rec.body?.state || 'online',
      lastSeen: env.ts,
      capabilities: rec.body?.capabilities || prev.capabilities || []
    })
    this.emit('peer', { pubkey: env.from, state: rec.body?.state || 'online', ts: env.ts, capabilities: rec.body?.capabilities || [] })
  }
}
