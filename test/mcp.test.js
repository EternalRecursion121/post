// MCP-over-pearpost integration test.
//
// Two in-process agents pipe their corestores together (no DHT). One hosts
// MCP tools; the other initializes, lists, calls, and exercises the
// allowlist. Run with: node test/mcp.test.js

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { Agent, MCP_PROTOCOL_VERSION } from '../protocol/index.js'

const TMP = path.join(os.tmpdir(), 'pearpost-mcp-test-' + Date.now())
let failed = 0

await main()

async function main () {
  console.log('test sandbox:', TMP)
  await fs.mkdir(TMP, { recursive: true })

  const alice = await spawn('alice')
  const bob = await spawn('bob')

  await alice.addContact(bob.address, 'bob')
  await bob.addContact(alice.address, 'alice')

  const sa = alice.store.replicate(true)
  const sb = bob.store.replicate(false)
  sa.on('error', e => console.error('sa err:', e.message))
  sb.on('error', e => console.error('sb err:', e.message))
  sa.pipe(sb).pipe(sa)
  await wait(300)

  // Bob hosts two MCP tools.
  bob.registerMCPTool('echo', {
    description: 'Echo a string back to the caller.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }, async (args) => ({ youSent: args.text }))

  bob.registerMCPTool('add', {
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
  }, async (args) => args.a + args.b)

  // Bob keeps a third tool unauthorized.
  bob.registerMCPTool('secret', {
    description: 'Should not be callable by alice.'
  }, async () => 'should not see this')

  // Allow alice only echo + add (default-deny is the point).
  bob.allowMCP(alice.pubHex, ['echo', 'add'])

  await test('initialize returns capabilities + serverInfo', async () => {
    const info = await alice.mcpInitialize(bob.pubHex)
    assertEq(info.protocolVersion, MCP_PROTOCOL_VERSION)
    assertEq(!!info.capabilities.tools, true)
    assertEq(info.serverInfo.name, 'bob')
  })

  await test('ping responds', async () => {
    const out = await alice.mcpPing(bob.pubHex)
    assertEq(JSON.stringify(out), '{}')
  })

  await test('tools/list returns only allowed tools, with schemas', async () => {
    const tools = await alice.mcpListTools(bob.pubHex)
    const names = tools.map(t => t.name).sort()
    assertEq(JSON.stringify(names), JSON.stringify(['add', 'echo']))
    const echo = tools.find(t => t.name === 'echo')
    assertEq(echo.description, 'Echo a string back to the caller.')
    assertEq(echo.inputSchema.type, 'object')
  })

  await test('tools/call returns wrapped content', async () => {
    const res = await alice.mcpCallTool(bob.pubHex, 'echo', { text: 'hi' })
    assertEq(res.isError, false)
    assertEq(res.content[0].type, 'text')
    assertEq(res.content[0].text, JSON.stringify({ youSent: 'hi' }))
  })

  await test('tools/call: numeric return gets stringified', async () => {
    const res = await alice.mcpCallTool(bob.pubHex, 'add', { a: 2, b: 3 })
    assertEq(res.isError, false)
    assertEq(res.content[0].text, '5')
  })

  await test('unauthorized tool rejected with isError', async () => {
    const res = await alice.mcpCallTool(bob.pubHex, 'secret', {})
    assertEq(res.isError, true)
    assertEq(/not authorized/.test(res.content[0].text), true)
  })

  await test('unknown tool rejected with isError', async () => {
    bob.allowMCP(alice.pubHex, ['ghost'])  // allowed but doesn't exist
    const res = await alice.mcpCallTool(bob.pubHex, 'ghost', {})
    assertEq(res.isError, true)
    assertEq(/unknown tool/.test(res.content[0].text), true)
  })

  await test('handler exception surfaces as isError', async () => {
    bob.registerMCPTool('boom', {}, async () => { throw new Error('kaboom') })
    bob.allowMCP(alice.pubHex, ['boom'])
    const res = await alice.mcpCallTool(bob.pubHex, 'boom', {})
    assertEq(res.isError, true)
    assertEq(/kaboom/.test(res.content[0].text), true)
  })

  await test('raw MCP-shaped handler results pass through unwrapped', async () => {
    bob.registerMCPTool('raw', {}, async () => ({
      content: [{ type: 'text', text: 'pre-shaped' }, { type: 'text', text: 'two' }],
      isError: false
    }))
    bob.allowMCP(alice.pubHex, ['raw'])
    const res = await alice.mcpCallTool(bob.pubHex, 'raw', {})
    assertEq(res.content.length, 2)
    assertEq(res.content[0].text, 'pre-shaped')
    assertEq(res.content[1].text, 'two')
  })

  await test('allowPublic opens everything to everyone', async () => {
    const carol = await spawn('carol')
    await alice.addContact(carol.address, 'carol')
    await carol.addContact(alice.address, 'alice')
    const sac = alice.store.replicate(true)
    const sca = carol.store.replicate(false)
    sac.on('error', e => console.error('sac err:', e.message))
    sca.on('error', e => console.error('sca err:', e.message))
    sac.pipe(sca).pipe(sac)
    await wait(300)

    carol.registerMCPTool('open', { description: 'public' }, async () => 'ok')
    carol.allowMCPPublic()
    const tools = await alice.mcpListTools(carol.pubHex)
    assertEq(tools.length, 1)
    const res = await alice.mcpCallTool(carol.pubHex, 'open', {})
    assertEq(res.content[0].text, 'ok')
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
  const agent = new Agent(dir, {
    profile: { alias: name },
    directory: false,
    presence: false,
    ack: true,
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
