#!/usr/bin/env node
// pearpost-mcp-bridge — spawn a stdio MCP server as a child process and
// expose its tools over pearpost. Any off-the-shelf MCP server (filesystem,
// git, sqlite, …) becomes peer-hostable by pubkey on the DHT
// without modification.
//
// Usage:
//   pearpost-mcp-bridge [--public] [--allow <pubhex>]... -- <cmd> [arg]...
//
// Examples:
//   pearpost-mcp-bridge --public -- npx -y @modelcontextprotocol/server-filesystem /tmp
//   pearpost-mcp-bridge --allow <pubhex> -- node my-mcp-server.js
//
// Wire format on the child side: newline-delimited JSON-RPC 2.0 over
// stdin/stdout. Anything the child prints to stderr is forwarded to ours.

import os from 'os'
import path from 'path'
import url from 'url'
import { spawn } from 'child_process'
import { Agent } from '../protocol/index.js'

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.pearpost')
const ALIAS = process.env.PEARPOST_ALIAS || os.userInfo().username

// Only auto-run main() when this file is the program entrypoint. Importing
// it (e.g. from tests) just exposes StdioJsonRpc.
const isEntry = (() => {
  try { return process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url }
  catch { return false }
})()
if (isEntry) {
  main().catch(err => { console.error('bridge error:', err.message || err); process.exit(1) })
}

async function main () {
  const { isPublic, allowList, cmd, cmdArgs } = parseArgv(process.argv.slice(2))
  if (!cmd) {
    process.stderr.write(`pearpost-mcp-bridge — host a stdio MCP server peer-to-peer

Usage:
  pearpost-mcp-bridge [--public] [--allow <pubhex>]... -- <cmd> [arg]...

Options:
  --public            allow every peer to list/call tools (DHT is open)
  --allow <pubhex>    allow a specific peer (repeatable)

Env:
  PEARPOST_HOME       storage dir (default ~/.pearpost)
  PEARPOST_ALIAS      directory profile alias (default $USER)

Examples:
  pearpost-mcp-bridge --public -- npx -y @modelcontextprotocol/server-filesystem /tmp
  pearpost-mcp-bridge --allow abc... -- node my-mcp-server.js
`)
    process.exit(2)
  }

  const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'inherit'] })
  child.on('error', err => { console.error('spawn error:', err.message); process.exit(1) })
  child.on('exit', (code, sig) => {
    console.error(`[bridge] child exited code=${code} signal=${sig}`)
    process.exit(code ?? 1)
  })

  const rpc = new StdioJsonRpc(child)

  // 1. handshake — initialize then notifications/initialized
  const init = await rpc.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'pearpost-mcp-bridge', version: '0.1.0' }
  }, 30000)
  rpc.notify('notifications/initialized')

  // 2. enumerate tools (paginate until cursor exhausted)
  const tools = []
  let cursor
  for (;;) {
    const page = await rpc.request('tools/list', cursor ? { cursor } : {}, 30000)
    if (Array.isArray(page.tools)) tools.push(...page.tools)
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  console.error(`[bridge] child "${init.serverInfo?.name || cmd}" reports ${tools.length} tool(s)`)

  // 3. start pearpost agent
  const agent = new Agent(HOME, {
    profile: { alias: ALIAS, blurb: `MCP bridge: ${init.serverInfo?.name || cmd}` }
  })
  await agent.start()

  if (isPublic) agent.allowMCPPublic()
  for (const pub of allowList) agent.allowMCP(pub, '*')

  // 4. mirror each upstream tool as a pearpost MCP tool. Forward calls
  // verbatim and pass through the upstream { content, isError } result so
  // remote callers see the real MCP response.
  for (const t of tools) {
    agent.registerMCPTool(t.name, {
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object' }
    }, async (args) => {
      const out = await rpc.request('tools/call', { name: t.name, arguments: args || {} }, 120000)
      return out  // { content, isError } — passes through as raw MCP shape
    })
  }

  console.error(`[bridge] hosting as ${agent.address}`)
  console.error(`[bridge] pubhex: ${agent.pubHex}`)
  if (isPublic) console.error('[bridge] policy: allowPublic (any peer)')
  else if (allowList.length) console.error(`[bridge] policy: allow ${allowList.length} peer(s)`)
  else console.error('[bridge] policy: default-deny — no peers can call yet (use --public or --allow)')

  process.on('SIGINT', () => shutdown(agent, child))
  process.on('SIGTERM', () => shutdown(agent, child))
  process.stdin.resume()
}

async function shutdown (agent, child) {
  try { child.kill('SIGTERM') } catch {}
  try { await agent.stop() } catch {}
  process.exit(0)
}

function parseArgv (argv) {
  const allowList = []
  let isPublic = false
  let i = 0
  while (i < argv.length && argv[i] !== '--') {
    const a = argv[i]
    if (a === '--public') { isPublic = true; i++ }
    else if (a === '--allow') { allowList.push(argv[++i]); i++ }
    else if (a === '-h' || a === '--help') { return {} }
    else break
  }
  if (argv[i] === '--') i++
  const cmd = argv[i]
  const cmdArgs = argv.slice(i + 1)
  return { isPublic, allowList, cmd, cmdArgs }
}

// Newline-delimited JSON-RPC 2.0 over a child process's stdio. Tracks
// pending requests by id; surfaces server-pushed notifications via the
// 'notification' event (unused here — we don't subscribe to anything yet).
export class StdioJsonRpc {
  constructor (child) {
    this.child = child
    this.pending = new Map()
    this.nextId = 1
    this.buf = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this._onData(chunk))
  }

  _onData (chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) {
        console.error('[bridge] bad json from child:', line.slice(0, 200))
        continue
      }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
        else p.resolve(msg.result)
      }
      // server -> client requests/notifications: ignored for v1 (we don't
      // declare any client capabilities, so the child shouldn't send any)
    }
  }

  request (method, params, timeoutMs = 30000) {
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    this.child.stdin.write(payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
  }

  notify (method, params) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n'
    this.child.stdin.write(payload)
  }
}
