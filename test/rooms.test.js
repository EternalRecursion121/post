// Verify that joining a room via just-the-share is enough to receive room
// messages — no separate addContact step required. Run with:
//   node test/rooms.test.js

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { Agent } from '../protocol/index.js'

const TMP = path.join(os.tmpdir(), 'pearpost-rooms-test-' + Date.now())
let failed = 0

await main()

async function main () {
  await fs.mkdir(TMP, { recursive: true })
  const alice = await spawn('alice')
  const bob = await spawn('bob')
  const carol = await spawn('carol')

  // Pipe stores so all three replicate. We deliberately do NOT call
  // addContact — the whole point is that joining a room must bootstrap
  // the outbox subscription on its own.
  const ab = alice.store.replicate(true)
  const ba = bob.store.replicate(false)
  ab.on('error', () => {}); ba.on('error', () => {})
  ab.pipe(ba).pipe(ab)

  const ac = alice.store.replicate(true)
  const ca = carol.store.replicate(false)
  ac.on('error', () => {}); ca.on('error', () => {})
  ac.pipe(ca).pipe(ac)

  const bc = bob.store.replicate(true)
  const cb = carol.store.replicate(false)
  bc.on('error', () => {}); cb.on('error', () => {})
  bc.pipe(cb).pipe(bc)
  await wait(300)

  await test('share carries the creator as a member', async () => {
    const room = await alice.createRoom('hackers')
    const parsed = JSON.parse(room.serialize())
    assertEq(parsed.members?.includes(alice.pubHex), true)
  })

  await test('joinRoom auto-follows the creator (no addContact needed)', async () => {
    const room = await alice.createRoom('one-sided')
    const got = waitFor(bob, 'message', r => r.body?.text === 'hi from alice')
    await bob.joinRoom(room.serialize())
    await alice.sendRoom(room.id, 'chat', { text: 'hi from alice' })
    const rec = await got
    assertEq(rec.body.text, 'hi from alice')
  })

  await test('after bob speaks, alice records bob as a room member', async () => {
    // For alice to see bob's outbox at all, she has to be following him
    // — directory gossip handles that in production; in this swarm-less
    // test we addContact explicitly. The behaviour under test is not the
    // discovery, but that _learnRoomMember folds bob into alice's local
    // room.members the first time she sees a room envelope from him.
    await alice.addContact(bob.address, 'bob')
    const room = await alice.createRoom('learn-members')
    await bob.joinRoom(room.serialize())
    const seen = waitFor(alice, 'message', r => r.body?.text === 'bob speaks')
    await bob.sendRoom(room.id, 'chat', { text: 'bob speaks' })
    await seen
    await wait(50)  // bee write
    const aliceRoom = alice.rooms().find(r => r.id === room.id)
    assertEq(aliceRoom.members.includes(bob.pubHex), true)
  })

  await test('a third joiner using a fresh share from alice also sees bob', async () => {
    await alice.addContact(bob.address, 'bob')
    const room = await alice.createRoom('three-way')
    await bob.joinRoom(room.serialize())
    await bob.sendRoom(room.id, 'chat', { text: 'hello room' })
    await waitFor(alice, 'message', r => r.body?.text === 'hello room')
    await wait(50)  // bee write
    // Re-serialize from alice's now-updated copy and hand it to carol —
    // carol now has both alice and bob in members, so joinRoom follows
    // bob's outbox and replays his historical room envelope.
    const aliceRoom = alice.rooms().find(r => r.id === room.id)
    const seen = waitFor(carol, 'message', r => r.body?.text === 'hello room')
    await carol.joinRoom(aliceRoom.serialize())
    const rec = await seen
    assertEq(rec.body.text, 'hello room')
    assertEq(rec.env.from, bob.pubHex)
  })

  await test('blocked peers are not auto-followed even via room share', async () => {
    const room = await alice.createRoom('with-blocked')
    await bob.deleteContact(alice.pubHex)  // bob blocks alice
    await bob.joinRoom(room.serialize())
    // bob should NOT now be following alice's outbox
    assertEq(bob.inbox.watching.has(alice.pubHex), false)
    // And bob's contacts should not list alice
    const cs = await bob.contacts()
    assertEq(cs.some(c => c.pubkey === alice.pubHex), false)
  })

  await alice.stop()
  await bob.stop()
  await carol.stop()
  console.log()
  console.log(failed ? `FAIL — ${failed} test(s) failed` : 'OK — all tests passed')
  process.exit(failed ? 1 : 0)
}

async function spawn (name) {
  const dir = path.join(TMP, name)
  await fs.mkdir(dir, { recursive: true })
  const agent = new Agent(dir, {
    profile: { alias: name },
    directory: false,
    presence: false,
    ack: true
  })
  await agent.startNoSwarm()
  return agent
}

async function test (name, fn) {
  try { await fn(); console.log('  ✓', name) }
  catch (e) { failed++; console.log('  ✗', name); console.log('    ' + (e.stack || e.message || e)) }
}

function assertEq (actual, expected) {
  if (actual !== expected) {
    throw new Error(`assertEq: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function wait (ms) { return new Promise(r => setTimeout(r, ms)) }

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
