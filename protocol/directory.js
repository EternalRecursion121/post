import { EventEmitter } from 'events'
import b4a from 'b4a'
import sodium from 'sodium-native'
import Hyperswarm from 'hyperswarm'
import { Identity } from './identity.js'

const TOPIC_LABEL = 'pearpost:directory:v0'

function topicFor (label) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(label))
  return out
}

// Directory: a separate Hyperswarm joined to a well-known topic. Connections
// are JSON-only (no replication) — peers exchange signed profile cards and
// nothing else. The card lets you derive everything you need to follow that
// peer's outbox: their pubkey IS the outbox key.
//
// Card schema:
//   { pubkey: hex, alias, blurb, capabilities: [], ts, sig }
//
// Sig is over canonical JSON of {pubkey, alias, blurb, capabilities, ts}.
export class Directory extends EventEmitter {
  constructor (identity, contactsBee, profile = {}, blockBee = null) {
    super()
    this.identity = identity
    this.bee = contactsBee
    this.blockBee = blockBee    // Hyperbee — pubHex -> '1' for blocked peers
    this.profile = profile      // { alias, blurb, capabilities }
    this.swarm = null
    this._topic = topicFor(TOPIC_LABEL)
  }

  async ready () {
    await this.bee.ready()
    if (this.blockBee) await this.blockBee.ready()
    return this
  }

  async isBlocked (pubHex) {
    if (!this.blockBee) return false
    const v = await this.blockBee.get(pubHex)
    return !!v
  }

  async block (pubHex) {
    if (!this.blockBee) return
    await this.blockBee.put(pubHex, b4a.from('1'))
  }

  async unblock (pubHex) {
    if (!this.blockBee) return
    await this.blockBee.del(pubHex)
  }

  async blockedList () {
    if (!this.blockBee) return []
    const out = []
    for await (const { key } of this.blockBee.createReadStream()) {
      out.push(b4a.toString(key))
    }
    return out
  }

  async remove (pubHex) {
    await this.bee.del(pubHex)
  }

  async start () {
    if (this.swarm) return
    this.swarm = new Hyperswarm()
    this.swarm.on('connection', (conn) => this._onConn(conn))
    this.swarm.join(this._topic, { server: true, client: true })
    await this.swarm.flush().catch(() => {})
  }

  async stop () {
    if (!this.swarm) return
    await this.swarm.destroy()
    this.swarm = null
  }

  setProfile (p) { this.profile = { ...this.profile, ...p } }

  card () {
    const body = {
      pubkey: this.identity.pubHex,
      alias: this.profile.alias || '',
      blurb: this.profile.blurb || '',
      capabilities: this.profile.capabilities || [],
      ts: Date.now()
    }
    const sig = this.identity.sign(canonical(body))
    return { ...body, sig: b4a.toString(sig, 'base64') }
  }

  _onConn (conn) {
    let buf = ''
    const card = JSON.stringify(this.card()) + '\n'
    conn.write(card)
    conn.on('data', (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line) this._ingest(line)
      }
    })
    conn.on('error', () => {})
    conn.on('close', () => {})
    // Close after a short window — directory connections are ephemeral.
    setTimeout(() => conn.end(), 2000).unref()
  }

  async _ingest (line) {
    let card
    try { card = JSON.parse(line) } catch { return }
    if (!card.pubkey || !card.sig) return
    const body = {
      pubkey: card.pubkey,
      alias: card.alias,
      blurb: card.blurb,
      capabilities: card.capabilities,
      ts: card.ts
    }
    const ok = Identity.verify(canonical(body), b4a.from(card.sig, 'base64'), b4a.from(card.pubkey, 'hex'))
    if (!ok) return
    // Skip peers we've explicitly blocked — otherwise gossip would
    // resurrect every contact we delete.
    if (await this.isBlocked(card.pubkey)) return
    try {
      await this.bee.put(card.pubkey, b4a.from(JSON.stringify(card)))
      this.emit('peer', card)
    } catch {}
  }

  async contacts () {
    const out = []
    for await (const { value } of this.bee.createReadStream()) {
      out.push(JSON.parse(b4a.toString(value)))
    }
    return out
  }

  async addManual (card) {
    // Add a contact discovered out-of-band (e.g. via paste of pear+agent://).
    // No signature required — caller vouches.
    await this.bee.put(card.pubkey, b4a.from(JSON.stringify(card)))
    this.emit('peer', card)
  }
}

function canonical (obj) {
  const keys = Object.keys(obj).sort()
  const out = {}
  for (const k of keys) out[k] = obj[k]
  return JSON.stringify(out)
}
