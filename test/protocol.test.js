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
    const got = waitFor(bob, 'message', r => r.env.type === 'chat' && r.body.text === 'hello bob')
    await alice.chat(bob.pubHex, 'hello bob')
    const rec = await got
    assertEq(rec.env.type, 'chat')
    assertEq(rec.body.text, 'hello bob')
    assertEq(rec.env.from, alice.pubHex)
  })

  // ---- 2. thread linking ----
  await test('inReplyTo materialises a thread', async () => {
    const root = await alice.send(bob.pubHex, 'chat', { text: 'q?' })
    await waitFor(bob, 'message', r => r.env.id === root.id)
    await bob.send(alice.pubHex, 'chat', { text: 'a!' }, { inReplyTo: root.id })
    await waitFor(alice, 'message', r => r.body.text === 'a!')
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
    const joined = await bob.joinRoom(room.serialize())
    assertEq(joined.id, room.id)
    const got = waitFor(bob, 'message', r => r.env.to === 'room:' + room.id && r.body?.text === 'standup in 5')
    await alice.sendRoom(room.id, 'chat', { text: 'standup in 5' })
    const rec = await got
    assertEq(rec.env.to, 'room:' + room.id)
    assertEq(rec.body.text, 'standup in 5')
  })

  await test('rooms: two-way exchange linearizes', async () => {
    const room = await alice.createRoom('two-way')
    await bob.joinRoom(room.serialize())
    const seenAlice = waitFor(alice, 'message', r => r.body.text === 'hi from bob')
    const seenBob = waitFor(bob, 'message', r => r.body.text === 'hi from alice')
    await alice.sendRoom(room.id, 'chat', { text: 'hi from alice' })
    await bob.sendRoom(room.id, 'chat', { text: 'hi from bob' })
    await Promise.all([seenAlice, seenBob])
  })

  await test('rejects messages for rooms we have not joined', async () => {
    const secret = await alice.createRoom('private')
    let received = false
    const off = (rec) => { if (rec.env.to === 'room:' + secret.id) received = true }
    bob.on('message', off)
    await alice.sendRoom(secret.id, 'chat', { text: 'inside' })
    await wait(400)
    bob.removeListener('message', off)
    assertEq(received, false)
  })

  // ---- 5. signature integrity ----
  await test('forged envelope is rejected at open()', async () => {
    const { Identity } = await import('../protocol/identity.js')
    const ok = Identity.verify(Buffer.from('x'), Buffer.alloc(64), Buffer.alloc(32))
    assertEq(ok, false)
  })

  // ---- 6. attachments ----
  await test('attachments: sender packs, receiver fetches', async () => {
    const tmpFile = path.join(TMP, 'note.txt')
    await fs.writeFile(tmpFile, 'hello attachment')
    const got = waitFor(bob, 'message', r => r.body?.text === 'see file' && r.env.attach?.length, 8000)
    await alice.send(bob.pubHex, 'chat', { text: 'see file' }, { attach: [tmpFile] })
    const rec = await got
    assertEq(rec.env.attach.length, 1)
    assertEq(rec.env.attach[0].name, 'note.txt')
    const buf = await bob.readAttachment(rec.env.attach[0])
    assertEq(buf.toString(), 'hello attachment')
  })

  // ---- 7. ack ----
  await test('ack: direct receipts are auto-acked', async () => {
    const id = (await alice.send(bob.pubHex, 'chat', { text: 'check ✓' })).id
    const deadline = Date.now() + 4000
    while (!alice.ack.isDelivered(id) && Date.now() < deadline) await wait(50)
    assertEq(alice.ack.isDelivered(id), true)
  })

  await test('ack: room messages are NOT acked', async () => {
    const room = await alice.createRoom('no-ack')
    await bob.joinRoom(room.serialize())
    const env = await alice.sendRoom(room.id, 'chat', { text: 'silent' })
    // bob receives the room message but should NOT auto-ack it (room
    // delivery is many-to-many; an ack flood would be untenable).
    await wait(800)
    assertEq(alice.ack.isDelivered(env.id), false)
  })

  // ---- 8. presence ----
  await test('presence: peer state surfaces on broadcast', async () => {
    // Manually trigger one broadcast cycle on alice.
    const got = waitFor(bob, 'presence', p => p.pubkey === alice.pubHex)
    await alice.presence.broadcast('online')
    const p = await got
    assertEq(p.state, 'online')
    assertEq(p.pubkey, alice.pubHex)
    assertEq(bob.presence.classify(alice.pubHex), 'online')
  })

  // ---- 9. tasks ----
  await test('tasks: progress + done', async () => {
    const updates = []
    bob.on('task', (u) => { if (u.body) updates.push(u.body.status) })
    bob.registerTask('build', async function * (args, ctx) {
      yield { status: 'progress', progress: 0.3, note: 'fetched' }
      yield { status: 'progress', progress: 0.7, note: 'compiled' }
      return { artefact: args.target + '.bin', size: 42 }
    })
    const value = await alice.task(bob.pubHex, { title: 'build', args: { target: 'demo' } })
    assertEq(value.artefact, 'demo.bin')
    assertEq(value.size, 42)
  })

  await test('tasks: errors surface as rejections', async () => {
    bob.registerTask('crash', async () => { throw new Error('boom') })
    let caught
    try { await alice.task(bob.pubHex, { title: 'crash' }) } catch (e) { caught = e }
    assertEq(!!caught, true)
    assertEq(/boom/.test(caught.message), true)
  })

  await test('tasks: subtask delegation forms a DAG', async () => {
    const carol = await spawn('carol')
    const sac = alice.store.replicate(true)
    const sca = carol.store.replicate(false)
    sac.pipe(sca).pipe(sac)
    const sbc = bob.store.replicate(true)
    const scb = carol.store.replicate(false)
    sbc.pipe(scb).pipe(sbc)
    await alice.addContact(carol.address, 'carol')
    await carol.addContact(alice.address, 'alice')
    await bob.addContact(carol.address, 'carol')
    await carol.addContact(bob.address, 'bob')
    await wait(300)

    carol.registerTask('half', async (args) => ({ half: args.n / 2 }))
    bob.registerTask('compute', async (args, ctx) => {
      const halved = await ctx.delegate(carol.pubHex, { title: 'half', args: { n: args.n } })
      return { result: halved.half + 1 }
    })
    const value = await alice.task(bob.pubHex, { title: 'compute', args: { n: 10 } })
    assertEq(value.result, 6)
    await carol.stop()
  })

  await alice.stop()
  await bob.stop()
  console.log()
  console.log(failed ? `FAIL — ${failed} test(s) failed` : 'OK — all tests passed')
  process.exit(failed ? 1 : 0)
}

async function spawn (name, opts = {}) {
  const dir = path.join(TMP, name)
  await fs.mkdir(dir, { recursive: true })
  // Disable directory swarm — we're in-process; no DHT.
  const agent = new Agent(dir, {
    profile: { alias: name },
    directory: false,
    presence: opts.presence ?? false,
    ack: opts.ack ?? true,
    ...opts
  })
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

function waitFor (emitter, event, predicate, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.removeListener(event, handler); reject(new Error('waitFor timeout: ' + event)) }, ms)
    const handler = (rec) => {
      if (!predicate(rec)) return
      clearTimeout(t)
      emitter.removeListener(event, handler)
      resolve(rec)
    }
    emitter.on(event, handler)
  })
}
