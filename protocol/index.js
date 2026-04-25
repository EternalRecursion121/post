// PearPost Agent — wires identity + outbox + inbox + directory + rpc + rooms
// into one object. The CLI, the Pears desktop app, and any embedding host
// (Hermes, OpenClaw) all use this same surface.

import { EventEmitter } from 'events'
import path from 'path'
import b4a from 'b4a'

import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import Hyperswarm from 'hyperswarm'

import { identityFromCore, pubFromAddress } from './identity.js'
import { Outbox } from './outbox.js'
import { Inbox } from './inbox.js'
import { Directory } from './directory.js'
import { RPC } from './rpc.js'
import { Room } from './rooms.js'

export { Room } from './rooms.js'
export { TYPES } from './envelope.js'
export { pubFromAddress } from './identity.js'

export class Agent extends EventEmitter {
  constructor (storageDir, opts = {}) {
    super()
    this.storageDir = storageDir
    this.opts = opts
    this.store = new Corestore(path.join(storageDir, 'store'))
    this.swarm = null
    this.identity = null
    this.outbox = null
    this.inbox = null
    this.directory = null
    this.rpc = null
    this._joinedRooms = new Map()  // hex -> Room
  }

  async start () {
    await this._startCore()
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn) => this.store.replicate(conn))

    // Serve our own outbox.
    this.swarm.join(this._outboxCore.discoveryKey, { server: true, client: false })

    await this._startTail()
    return this
  }

  // Test-only: boot everything except hyperswarm. The caller pipes
  // store.replicate() streams together to simulate a network.
  async startNoSwarm () {
    await this._startCore()
    this.swarm = new NoopSwarm()
    await this._startTail()
    return this
  }

  async _startCore () {
    await this.store.ready()
    const outboxCore = this.store.get({ name: 'outbox' })
    await outboxCore.ready()
    this._outboxCore = outboxCore
    this.identity = await identityFromCore(outboxCore)
    this.outbox = await new Outbox(outboxCore, this.identity).ready()
  }

  async _startTail () {

    // Local Hyperbees for inbox state.
    const inboxBee = new Hyperbee(this.store.get({ name: 'inbox' }))
    const cursorBee = new Hyperbee(this.store.get({ name: 'cursors' }))
    const contactBee = new Hyperbee(this.store.get({ name: 'contacts' }))
    const roomBee = new Hyperbee(this.store.get({ name: 'rooms' }))

    this.inbox = await new Inbox(this.store, this.swarm, this.identity, inboxBee, cursorBee).ready()
    this.inbox.on('message', (rec) => this.emit('message', rec))
    this.inbox.on('error', (err) => this.emit('error', err))

    this.directory = await new Directory(this.identity, contactBee, this.opts.profile || {}).ready()
    this.directory.on('peer', (card) => {
      this.inbox.follow(card.pubkey).catch(err => this.emit('error', err))
      this.emit('peer', card)
    })

    this.rpc = new RPC(this.outbox, this.inbox)
    this.rpc.on('error', (err) => this.emit('error', err))

    // Rejoin known rooms.
    this._roomBee = roomBee
    for await (const { value } of roomBee.createReadStream()) {
      const room = Room.deserialize(b4a.toString(value))
      this._joinedRooms.set(room.id, room)
      this.inbox.joinRoom(room.id)
    }

    // Catch up on existing contacts (follow their outboxes).
    for (const card of await this.directory.contacts()) {
      await this.inbox.follow(card.pubkey).catch(() => {})
    }

    // Start directory gossip.
    if (this.opts.directory !== false) await this.directory.start()
    if (this.swarm.flush) await this.swarm.flush().catch(() => {})

    return this
  }

  async stop () {
    try { if (this.directory) await this.directory.stop() } catch {}
    try { if (this.swarm && this.swarm.destroy) await this.swarm.destroy() } catch {}
    try { await this.store.close() } catch {}
  }

  // ---- contacts ----
  async addContact (addressOrCard, alias) {
    const card = typeof addressOrCard === 'string'
      ? { pubkey: b4a.toString(pubFromAddress(addressOrCard), 'hex'), alias: alias || '', blurb: '', capabilities: [], ts: Date.now() }
      : addressOrCard
    await this.directory.addManual(card)
    await this.inbox.follow(card.pubkey)
    return card
  }

  async contacts () { return this.directory.contacts() }

  // ---- messaging ----
  async send (to, type, body, opts = {}) {
    const dest = normalizeTo(to)
    const env = await this.outbox.send({ to: dest, type, body, inReplyTo: opts.inReplyTo, attach: opts.attach })
    // Mirror into our own inbox so the UI/thread sees what we just sent.
    await this.inbox.record(env, body)
    return env
  }

  async chat (to, text) { return this.send(to, 'chat', { text }) }

  async invoke (to, name, args, opts) {
    const dest = normalizeTo(to)
    return this.rpc.invoke(dest, name, args, opts)
  }

  registerTool (name, handler) {
    this.rpc.register(name, handler)
    const advertised = new Set(this.directory.profile.capabilities || [])
    advertised.add(name)
    this.directory.setProfile({ capabilities: [...advertised] })
    return this
  }

  // ---- rooms ----
  async createRoom (name = '') {
    const room = Room.create(name)
    return this._registerRoom(room)
  }

  async joinRoom (serialized) {
    const room = Room.deserialize(serialized)
    return this._registerRoom(room)
  }

  async _registerRoom (room) {
    await this._roomBee.put(room.id, b4a.from(room.serialize()))
    this._joinedRooms.set(room.id, room)
    this.inbox.joinRoom(room.id)
    return room
  }

  rooms () { return [...this._joinedRooms.values()] }

  async sendRoom (roomIdHex, type, body, opts = {}) {
    const room = this._joinedRooms.get(roomIdHex)
    if (!room) throw new Error('not in room: ' + roomIdHex)
    return room.send(this.outbox, { type, body, inReplyTo: opts.inReplyTo, attach: opts.attach }, this.inbox)
  }

  // ---- introspection ----
  get address () { return this.identity.address }
  get pubHex () { return this.identity.pubHex }

  async messages (opts) { return this.inbox.list(opts) }
  async thread (id) { return this.inbox.thread(id) }
}

// Minimal stand-in for tests where we pipe stores directly. The Inbox only
// needs swarm.join() to discover peers; in test the connection already
// exists, so join() is a no-op.
class NoopSwarm {
  join () { return { discovery: { flushed: () => Promise.resolve() } } }
  flush () { return Promise.resolve() }
  on () {}
  destroy () { return Promise.resolve() }
}

function normalizeTo (to) {
  if (!to) throw new Error('missing recipient')
  if (typeof to !== 'string') return b4a.toString(to, 'hex')
  if (to.startsWith('pear+agent://')) return b4a.toString(pubFromAddress(to), 'hex')
  if (to.startsWith('room:')) return to
  if (/^[0-9a-fA-F]{64}$/.test(to)) return to
  throw new Error('bad recipient: ' + to)
}
