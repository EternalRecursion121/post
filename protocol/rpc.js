// Agent-to-agent RPC over the inbox. A `tool.invoke` envelope is sent via
// the outbox; the matching `tool.result` (correlated by inReplyTo) lands
// in the inbox. We listen for that one envelope, resolve, done.
//
// Server side: register handlers keyed by tool name. When a tool.invoke
// arrives addressed to us, run the handler and send back tool.result.
import { EventEmitter } from 'events'

export class RPC extends EventEmitter {
  constructor (outbox, inbox) {
    super()
    this.outbox = outbox
    this.inbox = inbox
    this.handlers = new Map()  // name -> async (args, ctx) => value
    this.pending = new Map()   // requestId -> { resolve, reject, timer }

    this.inbox.on('message', (rec) => this._onMessage(rec))
  }

  // Server: register a callable tool.
  register (name, handler) {
    this.handlers.set(name, handler)
    return this
  }

  tools () { return [...this.handlers.keys()] }

  // Client: invoke a tool on a remote agent.
  async invoke (toPubHex, name, args, { timeout = 30000 } = {}) {
    const body = { name, args }
    const env = await this.outbox.send({
      to: toPubHex,
      type: 'tool.invoke',
      body
    })
    // Mirror into our own inbox so the UI / thread sees what we sent.
    await this.inbox.record(env, body).catch(err => this.emit('error', err))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(env.id)
        reject(new Error(`tool.invoke ${name} timed out after ${timeout}ms`))
      }, timeout)
      this.pending.set(env.id, { resolve, reject, timer })
    })
  }

  async _onMessage (rec) {
    const { env, body } = rec
    // Ignore mirror copies of envelopes we sent ourselves.
    if (env.from === this.outbox.identity.pubHex) return
    if (env.type === 'tool.result' && env.inReplyTo) {
      const p = this.pending.get(env.inReplyTo)
      if (!p) return
      this.pending.delete(env.inReplyTo)
      clearTimeout(p.timer)
      if (body.ok) p.resolve(body.value)
      else p.reject(new Error(body.error || 'tool failed'))
      return
    }
    if (env.type === 'tool.invoke') {
      const handler = this.handlers.get(body.name)
      let result
      if (!handler) {
        result = { ok: false, error: 'no such tool: ' + body.name }
      } else {
        try {
          const value = await handler(body.args, { from: env.from, env })
          result = { ok: true, value }
        } catch (e) {
          result = { ok: false, error: e.message || String(e) }
        }
      }
      await this.outbox.send({
        to: env.from,
        type: 'tool.result',
        body: result,
        inReplyTo: env.id
      }).catch(err => this.emit('error', err))
    }
  }
}
