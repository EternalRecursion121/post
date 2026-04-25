// Long-running tasks. Like RPC but the result may be deferred and the
// task can post status updates and spawn subtasks — all linked via
// inReplyTo to the original task.request id.
//
// Wire model:
//   A → B   task.request   { title, description, args }            id = T
//   B → A   task.result    { status: 'accepted' | 'progress' | 'done' | 'error',
//                            value? , error? , progress? }          inReplyTo = T
//   B → C   task.request   { ... }                                  inReplyTo = T   (subtask)
//   C → B   task.result    { status: 'done', value }                inReplyTo = T'
//
// Anyone watching the inbox can reconstruct the DAG by following inReplyTo.

import { EventEmitter } from 'events'

const TERMINAL = new Set(['done', 'error', 'cancelled'])

export class Tasks extends EventEmitter {
  constructor (outbox, inbox) {
    super()
    this.outbox = outbox
    this.inbox = inbox
    this.handlers = new Map()    // name -> async (args, ctx) => value | iterator
    this.tasks = new Map()       // task id -> { req, status, last, children: Set, result?, error? }
    this.inbox.on('message', (rec) => this._onMessage(rec))
  }

  // Server: register a task handler. Handler may be:
  //   - a plain async fn returning a final value
  //   - an async generator yielding { status: 'progress', progress, note? }
  //     and finally returning a value
  register (name, handler) {
    this.handlers.set(name, handler)
    return this
  }

  list () {
    return [...this.tasks.values()]
  }

  // Client: request a task. Returns a Promise that settles when a terminal
  // task.result arrives (status: done|error|cancelled), and a stream of
  // status updates via emitter on this Tasks instance under 'update'.
  async request (toPubHex, { title, description, args, inReplyTo } = {}) {
    const env = await this.outbox.send({
      to: toPubHex,
      type: 'task.request',
      body: { title: title || 'task', description: description || '', args: args || {} },
      inReplyTo
    })
    return new Promise((resolve, reject) => {
      this.tasks.set(env.id, {
        id: env.id,
        req: { to: toPubHex, title, description, args },
        status: 'pending',
        last: null,
        children: new Set(),
        _resolve: resolve,
        _reject: reject,
        parent: inReplyTo || null
      })
      this.emit('task', { id: env.id, status: 'pending', title, to: toPubHex })
    })
  }

  // Convenience for server-side delegation: spawn a subtask and link it.
  async delegate (toPubHex, parentId, payload) {
    return this.request(toPubHex, { ...payload, inReplyTo: parentId })
  }

  async _onMessage (rec) {
    const env = rec.env
    const me = this.outbox.identity.pubHex
    if (env.from === me) {
      // Mirror of something WE sent. Track our own outgoing requests so we
      // know about subtasks we spawn.
      if (env.type === 'task.request' && env.inReplyTo && this.tasks.has(env.inReplyTo)) {
        this.tasks.get(env.inReplyTo).children.add(env.id)
      }
      return
    }

    // Server side: handle inbound task.request.
    if (env.type === 'task.request') {
      this._serve(env, rec.body).catch(err => this.emit('error', err))
      return
    }

    // Client side: status updates / final result.
    if (env.type === 'task.result' && env.inReplyTo) {
      const t = this.tasks.get(env.inReplyTo)
      if (!t) return
      const status = rec.body?.status || 'progress'
      t.status = status
      t.last = rec.body
      this.emit('update', { id: env.inReplyTo, status, body: rec.body, from: env.from })
      if (TERMINAL.has(status)) {
        if (status === 'done') t._resolve?.(rec.body.value)
        else t._reject?.(new Error(rec.body?.error || status))
      }
    }
  }

  async _serve (reqEnv, body) {
    const handler = this.handlers.get(body?.title)
    const send = (b) => this.outbox.send({
      to: reqEnv.from,
      type: 'task.result',
      body: b,
      inReplyTo: reqEnv.id
    }).catch(err => this.emit('error', err))

    if (!handler) {
      await send({ status: 'error', error: 'no such task: ' + body?.title })
      return
    }

    await send({ status: 'accepted' })
    try {
      const ctx = {
        from: reqEnv.from,
        env: reqEnv,
        progress: (progress, note) => send({ status: 'progress', progress, note: note || '' }),
        delegate: (to, sub) => this.delegate(to, reqEnv.id, sub)
      }
      const result = handler(body.args || {}, ctx)
      // Async iterator support: progress yields are sent as-is; the
      // generator's *return* value (the { value } when done is true) is
      // the final result. for-await-of would discard the return value, so
      // walk the iterator manually.
      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        let final
        const it = result[Symbol.asyncIterator]()
        while (true) {
          const { value: chunk, done } = await it.next()
          if (done) { final = chunk; break }
          if (chunk && chunk.status === 'progress') await send(chunk)
          else final = chunk
        }
        await send({ status: 'done', value: final ?? null })
      } else {
        const value = await result
        await send({ status: 'done', value })
      }
    } catch (e) {
      await send({ status: 'error', error: e.message || String(e) })
    }
  }
}
