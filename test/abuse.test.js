// Spam / abuse controls. Two in-process agents pipe their corestores
// together. We deliberately do NOT have alice add bob as a contact in
// most tests so bob is treated as an unknown peer.
//
// Run with: node test/abuse.test.js

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { Agent } from '../protocol/index.js'

const TMP = path.join(os.tmpdir(), 'pearpost-abuse-test-' + Date.now())
let failed = 0
let _n = 0

await main()

async function main () {
  console.log('test sandbox:', TMP)
  await fs.mkdir(TMP, { recursive: true })

  // ---- 1. contacts-only invoke gate ----
  await test('non-contact invoke on a non-public tool is rejected', async () => {
    const { alice, bob, cleanup } = await pair({ aliceAbuse: tightInvoke(), aliceAddsBob: false, bobAddsAlice: true })
    alice.registerTool('private', async () => 'should not run')
    let caught
    try { await bob.invoke(alice.pubHex, 'private', {}, { timeout: 4000 }) } catch (e) { caught = e }
    assertEq(!!caught, true)
    assertEq(/contacts-only/i.test(caught.message), true)
    await cleanup()
  })

  await test('non-contact invoke on a public tool succeeds', async () => {
    const { alice, bob, cleanup } = await pair({ aliceAbuse: tightInvoke(), aliceAddsBob: false, bobAddsAlice: true })
    alice.registerTool('open', async () => ({ ok: 1 }), { public: true })
    const value = await bob.invoke(alice.pubHex, 'open', {}, { timeout: 4000 })
    assertEq(value.ok, 1)
    await cleanup()
  })

  await test('contact invoke succeeds on a non-public tool', async () => {
    const { alice, bob, cleanup } = await pair({ aliceAbuse: tightInvoke(), aliceAddsBob: true, bobAddsAlice: true })
    alice.registerTool('private', async () => 42)
    const value = await bob.invoke(alice.pubHex, 'private', {}, { timeout: 4000 })
    assertEq(value, 42)
    await cleanup()
  })

  // ---- 2. rate limiting ----
  await test('non-contact chat over limit is dropped (and lands in requests bucket while under limit)', async () => {
    const cfg = { chatUnknown: 2, windowMs: 60_000, autoBlockTrips: 99, maxChatBytes: 65536, maxInvokeBytes: 65536 }
    const { alice, bob, cleanup } = await pair({ aliceAbuse: cfg, aliceAddsBob: false, bobAddsAlice: true })
    const drops = []
    alice.on('rejected', (info) => { if (info.reason === 'rate limit') drops.push(info) })
    // 2 allowed under cfg; the 3rd trips.
    await bob.chat(alice.pubHex, 'a')
    await bob.chat(alice.pubHex, 'b')
    await bob.chat(alice.pubHex, 'c')
    await wait(400)
    assertEq(drops.length, 1)
    const reqs = await alice.requests({ limit: 50, reverse: false })
    const fromBob = reqs.filter(r => r.env.from === bob.pubHex && r.env.type === 'chat')
    assertEq(fromBob.length, 2)
    await cleanup()
  })

  await test('non-contact invoke over limit is dropped', async () => {
    const cfg = { invokeUnknown: 1, windowMs: 60_000, autoBlockTrips: 99 }
    const { alice, bob, cleanup } = await pair({ aliceAbuse: cfg, aliceAddsBob: false, bobAddsAlice: true })
    alice.registerTool('open', async () => ({ ok: 1 }), { public: true })
    // First call passes; second trips rate limit and the call should
    // hang (we drop the envelope, no result envelope ever comes back).
    const v1 = await bob.invoke(alice.pubHex, 'open', {}, { timeout: 3000 })
    assertEq(v1.ok, 1)
    let caught
    try { await bob.invoke(alice.pubHex, 'open', {}, { timeout: 1500 }) } catch (e) { caught = e }
    assertEq(!!caught, true)
    assertEq(/timed out/.test(caught.message), true)
    await cleanup()
  })

  await test('contacts are unmetered', async () => {
    const cfg = { chatUnknown: 1, windowMs: 60_000, autoBlockTrips: 99 }
    const { alice, bob, cleanup } = await pair({ aliceAbuse: cfg, aliceAddsBob: true, bobAddsAlice: true })
    const drops = []
    alice.on('rejected', (info) => drops.push(info))
    for (let i = 0; i < 8; i++) await bob.chat(alice.pubHex, 'msg-' + i)
    await wait(400)
    assertEq(drops.length, 0)
    const main = await alice.messages({ limit: 50, reverse: false })
    const fromBob = main.filter(r => r.env.from === bob.pubHex && r.env.type === 'chat')
    assertEq(fromBob.length, 8)
    await cleanup()
  })

  // ---- 3. size cap ----
  await test('chat over size cap is rejected pre-decrypt', async () => {
    // Set a tiny cap so a normal message trips it.
    const cfg = { maxChatBytes: 16, chatUnknown: 100, autoBlockTrips: 99 }
    const { alice, bob, cleanup } = await pair({ aliceAbuse: cfg, aliceAddsBob: false, bobAddsAlice: true })
    const drops = []
    alice.on('rejected', (info) => drops.push(info))
    await bob.chat(alice.pubHex, 'a quite normal but over-cap message')
    await wait(400)
    assertEq(drops.length, 1)
    assertEq(drops[0].reason, 'size cap exceeded')
    await cleanup()
  })

  // ---- 4. auto-block heuristic ----
  await test('auto-block kicks in after N rate-limit trips', async () => {
    const cfg = {
      chatUnknown: 0,            // every chat from non-contact trips
      windowMs: 60_000,
      autoBlockTrips: 2,
      autoBlockWindowMs: 60_000
    }
    const { alice, bob, cleanup } = await pair({ aliceAbuse: cfg, aliceAddsBob: false, bobAddsAlice: true })
    let autoBlockedAt = null
    alice.on('rejected', (info) => { if (info.autoBlocked) autoBlockedAt = Date.now() })
    // First chat: rate limit trip #1 (no block yet).
    // Second chat: trip #2 → auto-block.
    await bob.chat(alice.pubHex, 'hi')
    await bob.chat(alice.pubHex, 'hi again')
    // Settle: auto-block work is async (block + unfollow happen in
    // _onRejected after the event fires).
    await wait(400)
    assertEq(!!autoBlockedAt, true)
    const blocked = await alice.blockedContacts()
    assertEq(blocked.includes(bob.pubHex), true)
    await cleanup()
  })

  console.log()
  console.log(failed ? `FAIL — ${failed} test(s) failed` : 'OK — all tests passed')
  process.exit(failed ? 1 : 0)
}

function tightInvoke () {
  // Tight enough to ensure a single non-contact invoke is allowed
  // without tripping anything; we just want the contacts-only gate.
  return { invokeUnknown: 5, chatUnknown: 5, autoBlockTrips: 99 }
}

async function pair ({ aliceAbuse = {}, aliceAddsBob = false, bobAddsAlice = false } = {}) {
  const alice = await spawn('alice-' + uniq(), { abuse: aliceAbuse })
  const bob = await spawn('bob-' + uniq(), {})

  const sa = alice.store.replicate(true)
  const sb = bob.store.replicate(false)
  sa.on('error', () => {})
  sb.on('error', () => {})
  sa.pipe(sb).pipe(sa)

  if (aliceAddsBob) {
    await alice.addContact(bob.address, 'bob')
  } else {
    // Without addContact, alice would never follow bob's outbox and his
    // envelopes would never reach her inbox — tests for the
    // non-contact path need her to subscribe without promoting him.
    await alice.inbox.follow(bob.pubHex)
  }
  if (bobAddsAlice) await bob.addContact(alice.address, 'alice')
  await wait(300)

  return {
    alice,
    bob,
    cleanup: async () => {
      await alice.stop()
      await bob.stop()
    }
  }
}

async function spawn (name, opts = {}) {
  const dir = path.join(TMP, name)
  await fs.mkdir(dir, { recursive: true })
  const agent = new Agent(dir, {
    profile: { alias: name },
    directory: false,
    presence: false,
    ack: false,
    ...opts
  })
  await agent.startNoSwarm()
  return agent
}

function uniq () { return String(++_n) + '-' + Date.now().toString(36) }

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
