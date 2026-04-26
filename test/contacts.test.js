// Verify delete-contact and the blocklist that prevents gossip from
// resurrecting it. Run with: node test/contacts.test.js

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { Agent } from '../protocol/index.js'

const TMP = path.join(os.tmpdir(), 'pearpost-contacts-test-' + Date.now())
let failed = 0

await main()

async function main () {
  await fs.mkdir(TMP, { recursive: true })
  const alice = await spawn('alice')
  const bob = await spawn('bob')

  await alice.addContact(bob.address, 'bob')

  await test('contact appears after addContact', async () => {
    const cs = await alice.contacts()
    assertEq(cs.some(c => c.pubkey === bob.pubHex), true)
  })

  await test('inbox is following the new contact', async () => {
    assertEq(alice.inbox.watching.has(bob.pubHex), true)
  })

  await test('deleteContact removes from contacts and stops watching', async () => {
    await alice.deleteContact(bob.pubHex)
    const cs = await alice.contacts()
    assertEq(cs.some(c => c.pubkey === bob.pubHex), false)
    assertEq(alice.inbox.watching.has(bob.pubHex), false)
  })

  await test('blocked peer surfaces in blockedContacts()', async () => {
    const blocked = await alice.blockedContacts()
    assertEq(blocked.includes(bob.pubHex), true)
  })

  await test('directory gossip cannot resurrect a blocked peer', async () => {
    // Simulate gossip: feed alice's directory a signed line for bob.
    const fakeCard = JSON.stringify({
      pubkey: bob.pubHex,
      alias: 'bob-via-gossip',
      blurb: '',
      capabilities: [],
      ts: Date.now()
    })
    // Use bob's identity to sign a real card body shape so it would
    // normally pass verification.
    const body = {
      pubkey: bob.pubHex,
      alias: 'bob-via-gossip',
      blurb: '',
      capabilities: [],
      ts: JSON.parse(fakeCard).ts
    }
    const canonical = JSON.stringify(Object.keys(body).sort().reduce((o, k) => (o[k] = body[k], o), {}))
    const sig = bob.identity.sign(Buffer.from(canonical))
    const signedLine = JSON.stringify({ ...body, sig: Buffer.from(sig).toString('base64') })
    await alice.directory._ingest(signedLine)
    const cs = await alice.contacts()
    assertEq(cs.some(c => c.pubkey === bob.pubHex), false)
  })

  await test('unblockContact lets gossip restore the peer', async () => {
    await alice.unblockContact(bob.pubHex)
    const blocked = await alice.blockedContacts()
    assertEq(blocked.includes(bob.pubHex), false)
    // Now an ingest call should succeed
    const body = { pubkey: bob.pubHex, alias: 'bob-restored', blurb: '', capabilities: [], ts: Date.now() }
    const canonical = JSON.stringify(Object.keys(body).sort().reduce((o, k) => (o[k] = body[k], o), {}))
    const sig = bob.identity.sign(Buffer.from(canonical))
    const signedLine = JSON.stringify({ ...body, sig: Buffer.from(sig).toString('base64') })
    await alice.directory._ingest(signedLine)
    const cs = await alice.contacts()
    assertEq(cs.some(c => c.pubkey === bob.pubHex && c.alias === 'bob-restored'), true)
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
