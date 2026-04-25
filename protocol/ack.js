// Auto-emit ack envelopes on direct (non-room) receipt and surface delivery
// state for envelopes WE sent.
//
// Sender side: we record { id -> pending } when we mirror a sent direct
// envelope; when an ack { for: id } arrives from the recipient, mark
// delivered and emit 'delivered'.
//
// Receiver side: when a direct envelope addressed to us is materialised
// (and isn't itself an ack), send back an ack {for: env.id}. Acks are
// fire-and-forget — we don't ack the ack.

import { EventEmitter } from 'events'

const ACK_LESS_TYPES = new Set(['ack'])

export class Ack extends EventEmitter {
  constructor (outbox, inbox) {
    super()
    this.outbox = outbox
    this.inbox = inbox
    this.delivered = new Set()  // ids we've confirmed delivery for
    this.pending = new Map()    // id -> { to, ts }
    this.inbox.on('message', (rec) => this._onMessage(rec))
  }

  trackOutgoing (env) {
    if (!isDirect(env.to)) return
    if (env.to === this.outbox.identity.pubHex) return
    if (ACK_LESS_TYPES.has(env.type)) return
    this.pending.set(env.id, { to: env.to, ts: env.ts })
  }

  isDelivered (id) { return this.delivered.has(id) }

  async _onMessage (rec) {
    const env = rec.env
    const me = this.outbox.identity.pubHex

    // Sender side: incoming ack closes a pending envelope.
    if (env.type === 'ack' && env.from !== me && rec.body && rec.body.for) {
      const id = rec.body.for
      this.delivered.add(id)
      this.pending.delete(id)
      this.emit('delivered', { id, by: env.from, ts: env.ts })
      return
    }

    // Receiver side: someone else's direct envelope addressed to us → ack it.
    if (env.from === me) return                  // our own mirror
    if (!isDirect(env.to)) return                // room/broadcast — no ack
    if (env.to !== me) return                    // shouldn't happen, but
    if (ACK_LESS_TYPES.has(env.type)) return     // don't ack acks

    try {
      await this.outbox.send({
        to: env.from,
        type: 'ack',
        body: { for: env.id, ts: Date.now() }
      })
    } catch (err) { this.emit('error', err) }
  }
}

function isDirect (to) { return /^[0-9a-fA-F]{64}$/.test(to || '') }
