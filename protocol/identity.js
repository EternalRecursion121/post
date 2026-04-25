import sodium from 'sodium-native'
import b4a from 'b4a'

const SIGN_PUB = sodium.crypto_sign_PUBLICKEYBYTES
const SIGN_SEC = sodium.crypto_sign_SECRETKEYBYTES
const BOX_PUB = sodium.crypto_box_PUBLICKEYBYTES
const BOX_SEC = sodium.crypto_box_SECRETKEYBYTES
const SIGN_BYTES = sodium.crypto_sign_BYTES
const SEAL_OVERHEAD = sodium.crypto_box_SEALBYTES

export class Identity {
  constructor (signPub, signSec) {
    this.signPub = signPub
    this.signSec = signSec

    this.boxPub = b4a.alloc(BOX_PUB)
    this.boxSec = b4a.alloc(BOX_SEC)
    sodium.crypto_sign_ed25519_pk_to_curve25519(this.boxPub, signPub)
    sodium.crypto_sign_ed25519_sk_to_curve25519(this.boxSec, signSec)
  }

  get pub () { return this.signPub }
  get pubHex () { return b4a.toString(this.signPub, 'hex') }
  get address () { return 'pear+agent://' + this.pubHex }

  sign (msg) {
    const sig = b4a.alloc(SIGN_BYTES)
    sodium.crypto_sign_detached(sig, b4a.from(msg), this.signSec)
    return sig
  }

  static verify (msg, sig, signPub) {
    return sodium.crypto_sign_verify_detached(sig, b4a.from(msg), signPub)
  }

  // sealed-box encrypt to a recipient identified by their ed25519 pubkey
  sealTo (signPubRecipient, plaintext) {
    const xpub = b4a.alloc(BOX_PUB)
    sodium.crypto_sign_ed25519_pk_to_curve25519(xpub, signPubRecipient)
    const ct = b4a.alloc(plaintext.length + SEAL_OVERHEAD)
    sodium.crypto_box_seal(ct, plaintext, xpub)
    return ct
  }

  openSeal (ciphertext) {
    if (ciphertext.length < SEAL_OVERHEAD) return null
    const out = b4a.alloc(ciphertext.length - SEAL_OVERHEAD)
    const ok = sodium.crypto_box_seal_open(out, ciphertext, this.boxPub, this.boxSec)
    return ok ? out : null
  }
}

// Build identity from the keypair of the outbox Hypercore so that
// `agent.pub` IS the outbox key. The corestore-managed keypair has a
// 64-byte ed25519 secret (the standard sodium "secretkey").
export async function identityFromCore (core) {
  await core.ready()
  if (!core.keyPair || !core.keyPair.secretKey) {
    throw new Error('core has no writable keypair (not the owner)')
  }
  return new Identity(core.keyPair.publicKey, core.keyPair.secretKey)
}

export function pubFromAddress (addr) {
  const m = /^pear\+agent:\/\/([0-9a-fA-F]{64})/.exec(addr)
  if (!m) throw new Error('not a pear+agent:// address')
  return b4a.from(m[1], 'hex')
}
