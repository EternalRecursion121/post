// Tests for the stdio PearPost MCP server runtime helpers.
// Run with: node test/mcp-server.test.js

import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { createServerRuntime } from '../bin/pearpost-mcp-server.js'

const TMP = path.join(os.tmpdir(), 'pearpost-mcp-server-test-' + Date.now())
let failed = 0

await main()

async function main () {
  console.log('test sandbox:', TMP)
  await fs.mkdir(TMP, { recursive: true })

  await test('failed Agent startup does not poison future MCP calls', async () => {
    class FakeAgent extends EventEmitter {
      static starts = 0
      constructor () {
        super()
        this.address = 'pear+agent://fake'
        this.pubHex = 'fakepub'
      }

      async start () {
        FakeAgent.starts++
        if (FakeAgent.starts === 1) throw new Error('storage locked')
      }

      async contacts () { return [{ alias: 'alice' }] }
      async stop () {}
    }

    const runtime = createServerRuntime({ AgentClass: FakeAgent, home: path.join(TMP, 'poison'), alias: 'test' })
    let caught
    try { await runtime.callTool('contacts', {}) } catch (err) { caught = err }
    assertEq(/storage locked/.test(caught?.message || ''), true)

    const contacts = await runtime.callTool('contacts', {})
    assertEq(FakeAgent.starts, 2)
    assertEq(contacts[0].alias, 'alice')
  })

  await test('stdio server drains in-flight tool calls before stdin shutdown', async () => {
    const input = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'contacts', arguments: {} } })
    ].join('\n') + '\n'
    const out = await runServer(input, { PEARPOST_HOME: path.join(TMP, 'stdio'), PEARPOST_ALIAS: 'stdio-test', PEARPOST_SKIP_FLUSH: '1' })
    const lines = out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assertEq(lines.length, 2)
    assertEq(lines[0].id, 1)
    assertEq(lines[1].id, 2)
    assertEq(/\[\]/.test(lines[1].result.content[0].text), true)
  })

  await test('MCP owner writes only semantic inbound events to wake spool once', async () => {
    class FakeAgent extends EventEmitter {
      constructor () {
        super()
        this.address = 'pear+agent://fake'
        this.pubHex = 'fakepub'
      }

      async start () {}
      async contacts () { return [] }
      async stop () {}
    }

    const spool = path.join(TMP, 'events.jsonl')
    const seen = path.join(TMP, 'seen.json')
    const runtime = createServerRuntime({ AgentClass: FakeAgent, home: path.join(TMP, 'spool'), alias: 'test', wakeSpool: spool, wakeSeen: seen })
    const agent = await runtime.startAgent()

    agent.emit('message', { key: 'presence-1', env: { id: 'presence-1', type: 'presence', from: 'a', to: 'b', ts: 1 }, bucket: 'main' })
    agent.emit('message', { key: 'chat-1', env: { id: 'chat-1', type: 'chat', from: 'a', to: 'b', ts: 2 }, body: { text: 'hi from decrypted body' }, bucket: 'main' })
    agent.emit('message', { key: 'chat-1', env: { id: 'chat-1', type: 'chat', from: 'a', to: 'b', ts: 2 }, body: { text: 'hi from decrypted body' }, bucket: 'main' })
    await wait(100)

    const lines = (await fs.readFile(spool, 'utf8')).trim().split('\n')
    assertEq(lines.length, 1)
    const event = JSON.parse(lines[0])
    assertEq(event.type, 'chat')
    assertEq(event.id, 'chat-1')
    assertEq(event.text, 'hi from decrypted body')
    assertEq(event.body.text, 'hi from decrypted body')

    const state = JSON.parse(await fs.readFile(seen, 'utf8'))
    assertEq(state.seen.includes('chat-1'), true)
    assertEq(state.seen.includes('presence-1'), false)
  })

  console.log()
  console.log(failed ? `FAIL — ${failed} test(s) failed` : 'OK — all tests passed')
  process.exit(failed ? 1 : 0)
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

function runServer (input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/pearpost-mcp-server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, ...env }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`server exited ${code}: ${stderr}`))
      resolve(stdout)
    })
    child.stdin.end(input)
  })
}

function wait (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
