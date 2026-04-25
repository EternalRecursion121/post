// Per-message Hyperdrive attachments.
//
// Sender:
//   const items = await attachments.pack(envId, [{ path, name? } | filePath])
//   // items: [{ key, name, size }] — embed in envelope.attach[]
//
// Receiver:
//   await attachments.follow(item)            // opens the drive in our store
//   const buf = await attachments.read(item)  // pulls bytes lazily
//
// Drives ride for free over the existing corestore.replicate streams that
// hyperswarm wires up — no extra topic joins needed once both peers are
// already connected (e.g. via outbox topics).

import path from 'path'
import { promises as fs } from 'fs'
import b4a from 'b4a'
import Hyperdrive from 'hyperdrive'

export class Attachments {
  constructor (store) {
    this.store = store
    this.drives = new Map() // keyHex -> Hyperdrive
  }

  // Sender: bundle one or more files into a fresh per-message drive.
  // Each call uses a distinct corestore namespace so the underlying 'db'
  // core is unique per envelope (otherwise repeated calls would collide
  // on the same default-named core).
  async pack (envId, items = []) {
    if (!items.length) return []
    const ns = this.store.namespace('pearpost-drive:' + envId + ':' + Math.random().toString(36).slice(2))
    const drive = new Hyperdrive(ns)
    await drive.ready()
    const out = []
    for (const it of items) {
      const filePath = typeof it === 'string' ? it : it.path
      const name = (typeof it === 'object' && it.name) || path.basename(filePath)
      const buf = await fs.readFile(filePath)
      await drive.put('/' + name, buf)
      out.push({ key: b4a.toString(drive.key, 'hex'), name, size: buf.length })
    }
    this.drives.set(b4a.toString(drive.key, 'hex'), drive)
    return out
  }

  // Receiver: open a drive by key. Idempotent.
  async follow (item) {
    const keyHex = item.key
    if (!keyHex) return null
    if (this.drives.has(keyHex)) return this.drives.get(keyHex)
    const drive = new Hyperdrive(this.store, b4a.from(keyHex, 'hex'))
    await drive.ready()
    this.drives.set(keyHex, drive)
    return drive
  }

  // Read a single file from a received attachment. Hyperdrive's metadata
  // and content cores are advertised over the existing corestore replication
  // stream, but the muxer needs a brief findingPeers window for the request
  // to register; otherwise core.length stays 0 and .get() blocks.
  async read (item) {
    const drive = await this.follow(item)
    if (this.store.findingPeers) {
      const release = this.store.findingPeers()
      await new Promise(r => setTimeout(r, 600))
      release()
    }
    if (drive.update) await drive.update().catch(() => {})
    return drive.get('/' + item.name)
  }

  // Materialize all drives referenced by a freshly received envelope.
  async materialize (env) {
    if (!env || !Array.isArray(env.attach)) return
    for (const item of env.attach) {
      if (item && item.key) await this.follow(item).catch(() => {})
    }
  }
}
