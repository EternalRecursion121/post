import b4a from 'b4a'
import sodium from 'sodium-native'

// A "room" in PearPost v0 is a shared 32-byte key. Anyone who knows it can
// read or write to the room by:
//   - send: outbox.send({ to: `room:<hex>`, type, body })
//   - read: inbox filters envelopes whose `to` matches a joined room
//
// Members discover each other through the standard contact graph: each
// member follows the others' outboxes (because they're contacts), and
// `inbox` will materialize any room envelope whose key it has joined.
//
// This skips Autobase entirely. Ordering is by sender timestamp; conflicts
// are tolerated. Trade: no causal consistency, but every message survives
// in its sender's outbox forever — the property we actually care about.
//
// Future: swap to Autobase for true linearization without changing the
// envelope schema (room messages already have a stable id).
export class Room {
  constructor (key, opts = {}) {
    this.key = b4a.isBuffer(key) ? key : b4a.from(key, 'hex')
    this.name = opts.name || ''
    this.members = opts.members || [] // hex pubkeys (for the UI)
  }

  get id () { return b4a.toString(this.key, 'hex') }
  get to () { return 'room:' + this.id }

  static create (name = '') {
    const k = b4a.alloc(32)
    sodium.randombytes_buf(k)
    return new Room(k, { name })
  }

  async send (outbox, { type, body, inReplyTo, attach }) {
    return outbox.send({ to: this.to, type, body, inReplyTo, attach })
  }

  // Convenience: pack a room into a shareable string.
  serialize () {
    return JSON.stringify({ key: this.id, name: this.name, members: this.members })
  }

  static deserialize (s) {
    const o = JSON.parse(s)
    return new Room(o.key, { name: o.name, members: o.members })
  }
}
