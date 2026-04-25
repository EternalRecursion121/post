// Rooms.
//
// A room is a shared 32-byte secret. Anyone holding it can read and write
// to the room. Each member writes a room message into THEIR OWN outbox
// (envelope.to = `room:<roomId>`); other members, on replicating that
// outbox, decrypt and materialise the envelope into their inbox bee.
//
// "Linearization" is a deterministic local merge: sort by (env.ts, env.id)
// over all envelopes addressed to this room. Because every member's outbox
// is signed and append-only, the merge is byte-identical across members
// and gives every reader the same ordering — without requiring a quorum
// protocol. (See `roomTimeline` below.)
//
// This is the v0 design we ship. The path to true Autobase-backed
// causal-ordered rooms — per-room Autobase keyed by member outbox cores,
// indexer admission via signed control envelopes — is a swap of this file
// without changing the envelope schema. We've prototyped it and left the
// notes here for the upgrade.

import b4a from 'b4a'
import sodium from 'sodium-native'

export class Room {
  constructor (key, opts = {}) {
    this.key = b4a.isBuffer(key) ? key : b4a.from(key, 'hex')
    this.name = opts.name || ''
  }

  get id () { return b4a.toString(this.key, 'hex') }
  get to () { return 'room:' + this.id }

  static create (name = '') {
    const k = b4a.alloc(32)
    sodium.randombytes_buf(k)
    return new Room(k, { name })
  }

  serialize () {
    return JSON.stringify({ key: this.id, name: this.name })
  }

  static deserialize (s) {
    const o = JSON.parse(s)
    return new Room(o.key, { name: o.name })
  }
}

// Compute a deterministic linearized timeline of envelopes addressed to a
// given room, drawn from a pool of records (typically inbox.list()).
//
// Sort key: (env.ts, env.id). Because env.id is a ULID, the ordering is
// stable both within and across milliseconds, and is byte-identical for
// any two readers who have seen the same set of envelopes — no consensus
// protocol required.
export function roomTimeline (records, roomIdHex) {
  const tag = 'room:' + roomIdHex
  const out = records.filter(r => r.env?.to === tag)
  out.sort((a, b) => {
    if (a.env.ts !== b.env.ts) return a.env.ts - b.env.ts
    return a.env.id < b.env.id ? -1 : a.env.id > b.env.id ? 1 : 0
  })
  return out
}
