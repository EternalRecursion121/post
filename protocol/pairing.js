// Short-code pairing. Two agents derive the same Hyperswarm topic from a
// human-typeable code, exchange signed directory cards over that topic, and
// disconnect. Either side can initiate; whoever calls without a code gets
// one generated. Codes are single-use and time-bound.
//
// Wire format on the pairing connection: one line of JSON per card, same
// shape as Directory cards (pubkey + signed body). We accept the FIRST
// valid card from a peer and resolve.

import { EventEmitter } from 'events'
import b4a from 'b4a'
import sodium from 'sodium-native'
import Hyperswarm from 'hyperswarm'
import { Identity } from './identity.js'

const TOPIC_PREFIX = 'pearpost:pair:v0:'
const DEFAULT_TIMEOUT = 60_000

// Small, unambiguous wordlist. Avoids look-alike pairs (no "bear/bare").
// Keeps codes typeable on a phone keyboard.
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'dusky', 'eager', 'fuzzy', 'glossy', 'happy',
  'icy', 'jolly', 'kind', 'lucky', 'misty', 'noble', 'olive', 'plush',
  'quick', 'rusty', 'silky', 'tidy', 'umber', 'vivid', 'warm', 'xenial',
  'young', 'zesty', 'bold', 'crisp', 'deep', 'fine', 'grand', 'hazy'
]
const ANIMALS = [
  'badger', 'cat', 'dolphin', 'eel', 'fox', 'goose', 'heron', 'ibis',
  'jaguar', 'koala', 'lemur', 'moth', 'newt', 'otter', 'puffin', 'quail',
  'rabbit', 'seal', 'tiger', 'urchin', 'vole', 'whale', 'yak', 'zebra',
  'crane', 'falcon', 'gecko', 'hawk', 'lynx', 'panda', 'raven', 'sloth'
]

export function generateCode () {
  const adj = ADJECTIVES[randomIndex(ADJECTIVES.length)]
  const animal = ANIMALS[randomIndex(ANIMALS.length)]
  const num = randomIndex(100).toString().padStart(2, '0')
  return `${adj}-${animal}-${num}`
}

export function topicForCode (code) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from(TOPIC_PREFIX + code.toLowerCase()))
  return out
}

// Run one pairing exchange. Returns the peer's signed card on success.
// `cardFn` returns the local signed card to advertise (same shape Directory
// uses). `identity` is needed to verify the peer's signature.
export class Pairing extends EventEmitter {
  constructor (identity, cardFn) {
    super()
    this.identity = identity
    this.cardFn = cardFn
    this.swarm = null
  }

  async run ({ code, timeout = DEFAULT_TIMEOUT } = {}) {
    const usingGenerated = !code
    const finalCode = code || generateCode()
    const topic = topicForCode(finalCode)
    if (usingGenerated) this.emit('code', finalCode)

    this.swarm = new Hyperswarm()
    this.swarm.join(topic, { server: true, client: true })

    const peerCard = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`pairing "${finalCode}" timed out after ${timeout}ms`))
      }, timeout)

      const finish = (card) => {
        clearTimeout(timer)
        resolve(card)
      }

      this.swarm.on('connection', (conn) => {
        let buf = ''
        try { conn.write(JSON.stringify(this.cardFn()) + '\n') } catch {}
        conn.on('data', (chunk) => {
          buf += chunk.toString()
          let nl
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            const card = parseAndVerify(line)
            if (!card) continue
            if (card.pubkey === this.identity.pubHex) continue
            finish(card)
            try { conn.end() } catch {}
            return
          }
        })
        conn.on('error', () => {})
      })

      this.swarm.flush().catch(() => {})
    })

    await this.stop()
    return { code: finalCode, peer: peerCard }
  }

  async stop () {
    if (!this.swarm) return
    try { await this.swarm.destroy() } catch {}
    this.swarm = null
  }
}

function parseAndVerify (line) {
  let card
  try { card = JSON.parse(line) } catch { return null }
  if (!card || !card.pubkey || !card.sig) return null
  const body = {
    pubkey: card.pubkey,
    alias: card.alias || '',
    blurb: card.blurb || '',
    capabilities: card.capabilities || [],
    ts: card.ts
  }
  const ok = Identity.verify(canonical(body), b4a.from(card.sig, 'base64'), b4a.from(card.pubkey, 'hex'))
  return ok ? card : null
}

function canonical (obj) {
  const keys = Object.keys(obj).sort()
  const out = {}
  for (const k of keys) out[k] = obj[k]
  return JSON.stringify(out)
}

function randomIndex (n) {
  const buf = b4a.alloc(4)
  sodium.randombytes_buf(buf)
  const v = buf.readUInt32BE(0)
  return v % n
}
