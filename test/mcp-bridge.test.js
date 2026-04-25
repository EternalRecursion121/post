// Smoke test for the bridge's upstream JSON-RPC plumbing. Spawns a fake
// stdio MCP server (a script we write ourselves) and verifies the bridge
// performs initialize, tools/list, and tools/call correctly. This exercises
// the StdioJsonRpc client without needing a real DHT or pearpost agent.

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { spawn } from 'child_process'

const TMP = path.join(os.tmpdir(), 'pearpost-bridge-test-' + Date.now())
let failed = 0

const FAKE_MCP_SERVER = `
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    handle(JSON.parse(line))
  }
})
function send (obj) { process.stdout.write(JSON.stringify(obj) + '\\n') }
function handle (msg) {
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '0.0.1' }
    }})
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{ name: 'shout', description: 'uppercase a string',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
    }})
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params
    if (name === 'shout') {
      return send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: String(args.text).toUpperCase() }],
        isError: false
      }})
    }
    return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool: ' + name } })
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found: ' + msg.method } })
}
`

await main()

async function main () {
  await fs.mkdir(TMP, { recursive: true })
  const fake = path.join(TMP, 'fake-mcp.js')
  await fs.writeFile(fake, FAKE_MCP_SERVER)

  // Import the bridge's StdioJsonRpc class. It isn't exported, so we read
  // the file and pull it out via a helper module that re-exports it.
  // Cleaner: refactor the bridge to export it. We'll do the refactor.
  const { StdioJsonRpc } = await import('../bin/pearpost-mcp-bridge.js')

  const child = spawn(process.execPath, [fake], { stdio: ['pipe', 'pipe', 'inherit'] })
  const rpc = new StdioJsonRpc(child)

  await test('initialize round-trips', async () => {
    const out = await rpc.request('initialize', { protocolVersion: '2025-06-18' }, 5000)
    assertEq(out.serverInfo.name, 'fake-mcp')
    assertEq(out.protocolVersion, '2025-06-18')
  })

  await test('tools/list returns declared tools', async () => {
    const out = await rpc.request('tools/list', {}, 5000)
    assertEq(out.tools.length, 1)
    assertEq(out.tools[0].name, 'shout')
  })

  await test('tools/call returns content array', async () => {
    const out = await rpc.request('tools/call', { name: 'shout', arguments: { text: 'hi' } }, 5000)
    assertEq(out.isError, false)
    assertEq(out.content[0].text, 'HI')
  })

  await test('tools/call error surfaces', async () => {
    let caught
    try { await rpc.request('tools/call', { name: 'missing' }, 5000) } catch (e) { caught = e }
    assertEq(!!caught, true)
    assertEq(/unknown tool/.test(caught.message), true)
  })

  child.kill()
  console.log()
  console.log(failed ? `FAIL — ${failed} test(s) failed` : 'OK — all tests passed')
  process.exit(failed ? 1 : 0)
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
