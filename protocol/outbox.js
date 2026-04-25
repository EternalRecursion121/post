import { encode, seal } from './envelope.js'

export class Outbox {
  constructor (core, identity) {
    this.core = core
    this.identity = identity
  }

  async ready () {
    await this.core.ready()
    return this
  }

  // Build, sign, append. Returns the envelope.
  async send ({ to, type, body, inReplyTo, attach, roomKey }) {
    const env = seal({
      from: this.identity.pubHex,
      to,
      type,
      body,
      inReplyTo,
      attach,
      roomKey
    }, this.identity)
    await this.core.append(encode(env))
    return env
  }

  get key () { return this.core.key }
  get length () { return this.core.length }
}
