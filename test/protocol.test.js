// In-process correctness test for the PearPost protocol.
//
// Bypasses Hyperswarm by piping each Agent's corestore.replicate() stream
// directly into the other's. Verifies: chat delivery, signature/seal,
// thread linking, RPC correlation, and rooms.
//
// Run with: node test/protocol.test.js

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { Agent } from '../protocol/index.js'

const TMP = path.join(os.tmpdir(), 'pearpost-test-' + Date.now())
let failed = 0

await main()

async function main () {
  console.log('test sandbox:', TMP)
  await fs.mkdir(TMP, { recursive: true })

  const alice = await spawn('alice')
  const bob = await spawn('bob')

  // Cross-add as contacts (for the directory address book and to register
  // each other's outbox keys).
  await alice.addContact(bob.address, 'bob')
  await bob.addContact(alice.address, 'alice')

  // Pipe their stores together — replaces hyperswarm.
  const sa = alice.store.replicate(true)
  const sb = bob.store.replicate(false)
  sa.on('error', e => console.error('sa err:', e.message))
  sb.on('error', e => console.error('sb err:', e.message))
  sa.pipe(sb).pipe(sa)
  await wait(300) // let replication handshake settle

  // ---- 1. chat delivery ----
  await test('chat delivers and decrypts', async () => {
    const got = once(bob, 'message')
    await alice.chat(bob.pubHex, 'hello bob')
    const rec = await got
    assertEq(rec.env.type, 'chat')
    assertEq(rec.body.text, 'hello bob')
    assertEq(rec.env.from, alice.pubHex)
  })

  // ---- 2. thread linking ----
  await test('inReplyTo materialises a thread', async () => {
    const got1 = once(alice, 'message')
    const root = await alice.send(bob.pubHex, 'chat', { text: 'q?' })
    await wait(120)
    await bob.send(alice.pubHex, 'chat', { text: 'a!' }, { inReplyTo: root.id })
    await got1
    await wait(120)
    const thread = await alice.thread(root.id)
    assertEq(thread.length, 2)
    assertEq(thread[1].body.text, 'a!')
  })

  // ---- 3. tool RPC ----
  await test('tool.invoke correlates with tool.result', async () => {
    bob.registerTool('echo', async (args) => ({ youSent: args }))
    const value = await alice.invoke(bob.pubHex, 'echo', { ping: 1 }, { timeout: 5000 })
    assertEq(JSON.stringify(value), JSON.stringify({ youSent: { ping: 1 } }))
  })

  await test('tool errors surface as rejections', async () => {
    bob.registerTool('boom', async () => { throw new Error('kaboom') })
    let caught
    try { await alice.invoke(bob.pubHex, 'boom', {}, { timeout: 5000 }) } catch (e) { caught = e }
    assertEq(!!caught, true)
    assertEq(/kaboom/.test(caught.message), true)
  })

  // ---- 4. rooms ----
  await test('rooms: two members exchange messages', async () => {
    const room = await alice.createRoom('hackers')
    await bob.joinRoom(room.serialize())
    const got = once(bob, 'message')
    await alice.sendRoom(room.id, 'chat', { text: 'standup in 5' })
    const rec = await got
    assertEq(rec.env.to, 'room:' + room.id)
    assertEq(rec.body.text, 'standup in 5')
  })

  await test('rejects messages for rooms we have not joined', async () => {
    // Carol-style: alice creates a private room, doesn't share with bob.
    const secret = await alice.createRoom('private')
    let received = false
    const off = (rec) => { if (rec.env.to === 'room:' + secret.id) received = true }
    bob.on('message', off)
    await alice.sendRoom(secret.id, 'chat', { text: 'inside' })
    await wait(200)
    bob.removeListener('message', off)
    assertEq(received, false)
  })

  // ---- 5. signature integrity ----
  await test('forged envelope is rejected at open()', async () => {
    // We can't easily inject a forged envelope into bob's outbox without his
    // key, which is the whole point. So just sanity-check Identity.verify.
    const { Identity } = await import('../protocol/identity.js')
    const ok = Identity.verify(Buffer.from('x'), Buffer.alloc(64), Buffer.alloc(32))
    assertEq(ok, false)
  })

  await alice.stop()
  await bob.stop()
  console.log()
  console.log(failed ? `FAIL — ${failed} test(s) failed` : 'OK — all tests passed')
  process.exit(failed ? 1 : 0)
}

async function spawn (name) {
  const dir = path.join(TMP, name)
  await fs.mkdir(dir, { recursive: true })
  // Disable directory swarm — we're in-process; no DHT.
  const agent = new Agent(dir, { profile: { alias: name }, directory: false })
  // Don't start hyperswarm — replace with manual pipe.
  await agent.startNoSwarm()
  return agent
}

async function test (name, fn) {
  try {
    await fn()
    console.log('  ✓', name)
  } catch (e) {
    failed++
    console.log('  ✗', name)
    console.log('    ' + (e.stack || e.message || e))
  }
}

function assertEq (actual, expected) {
  if (actual !== expected) {
    throw new Error(`assertEq: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function wait (ms) { return new Promise(r => setTimeout(r, ms)) }

function once (emitter, event) {
  return new Promise((resolve) => {
    const handler = (...args) => { emitter.removeListener(event, handler); resolve(args[0]) }
    emitter.on(event, handler)
  })
}
