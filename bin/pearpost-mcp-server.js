#!/usr/bin/env node
// pearpost-mcp-server — expose PearPost Agent operations as a stdio MCP server
// for Hermes native MCP. Implements enough JSON-RPC/MCP surface for tools/list
// and tools/call without external SDK dependencies.

import os from 'os'
import path from 'path'
import { Agent } from '../protocol/index.js'

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.hermes', 'pearpost')
const ALIAS = process.env.PEARPOST_ALIAS || process.env.HERMES_USER || os.userInfo().username
const DEFAULT_TIMEOUT = Number(process.env.PEARPOST_TOOL_TIMEOUT_MS || 120000)
const PAIR_TIMEOUT = Number(process.env.PEARPOST_PAIR_TIMEOUT_MS || 10 * 60 * 1000)

const tools = [
  {
    name: 'address',
    description: 'Print this agent\'s pear+agent:// address and pubkey.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'contacts',
    description: 'List known PearPost contacts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'add_contact',
    description: 'Add a peer by pear+agent:// address, optionally with an alias.',
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string' }, alias: { type: 'string' } },
      required: ['address'],
      additionalProperties: false
    }
  },
  {
    name: 'pair',
    description: 'Short-code pairing. With no code, generate a code and keep waiting in the background; with code, redeem and wait for the peer.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string' }, alias: { type: 'string' }, timeout_ms: { type: 'number' } },
      additionalProperties: false
    }
  },
  {
    name: 'pair_status',
    description: 'Check the background pairing session started by pair with no code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'chat',
    description: 'Send a chat message to a peer address/pubkey.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, text: { type: 'string' } },
      required: ['to', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'send',
    description: 'Send any PearPost envelope type with a JSON body.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, type: { type: 'string' }, body: { type: 'object' } },
      required: ['to', 'type', 'body'],
      additionalProperties: false
    }
  },
  {
    name: 'invoke',
    description: 'Call a remote PearPost tool by name and wait for the result.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' }, timeout_ms: { type: 'number' } },
      required: ['to', 'tool'],
      additionalProperties: false
    }
  },
  {
    name: 'mcp_list',
    description: 'List MCP tools exposed by a remote PearPost peer.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['to'],
      additionalProperties: false
    }
  },
  {
    name: 'mcp_call',
    description: 'Call an MCP tool exposed by a remote PearPost peer.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' }, timeout_ms: { type: 'number' } },
      required: ['to', 'tool'],
      additionalProperties: false
    }
  },
  {
    name: 'tail',
    description: 'Return recent inbox messages. bucket may be main, requests, or all.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number' }, bucket: { type: 'string', enum: ['main', 'requests', 'all'] } },
      additionalProperties: false
    }
  },
  {
    name: 'requests',
    description: 'Return recent first-contact quarantine messages from non-contacts.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false }
  },
  {
    name: 'thread',
    description: 'Walk the inReplyTo tree of a thread/message id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
  },
  {
    name: 'room_new',
    description: 'Create a PearPost shared room and return its share link/serialized room.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false }
  },
  {
    name: 'room_join',
    description: 'Join a PearPost room from a serialized room link.',
    inputSchema: { type: 'object', properties: { serialized: { type: 'string' } }, required: ['serialized'], additionalProperties: false }
  },
  {
    name: 'room_send',
    description: 'Post a chat message to a joined room id.',
    inputSchema: { type: 'object', properties: { room_id: { type: 'string' }, text: { type: 'string' } }, required: ['room_id', 'text'], additionalProperties: false }
  },
  {
    name: 'rooms',
    description: 'List joined PearPost rooms.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

let agent
let pendingPair = null
let initialized = false
let buf = ''

async function startAgent () {
  if (agent) return agent
  agent = new Agent(HOME, { profile: { alias: ALIAS } })
  agent.on('error', (err) => console.error('[pearpost-mcp] agent error:', err?.message || err))
  await agent.start()
  console.error(`[pearpost-mcp] ready as ${agent.address}`)
  return agent
}

function send (msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function ok (id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail (id, err, code = -32000) { send({ jsonrpc: '2.0', id, error: { code, message: err?.message || String(err) } }) }
function content (value) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] } }

async function callTool (name, args = {}) {
  const a = await startAgent()
  switch (name) {
    case 'address': return { address: a.address, pubHex: a.pubHex, home: HOME, alias: ALIAS }
    case 'contacts': return await a.contacts()
    case 'add_contact': return await a.addContact(args.address, args.alias)
    case 'pair': return await pair(args)
    case 'pair_status': return pairStatus()
    case 'chat': return summarizeEnv(await a.chat(args.to, args.text))
    case 'send': return summarizeEnv(await a.send(args.to, args.type, args.body || {}))
    case 'invoke': return await a.invoke(args.to, args.tool, args.args || {}, { timeout: args.timeout_ms || DEFAULT_TIMEOUT })
    case 'mcp_list': return await a.mcpListTools(args.to, { timeout: args.timeout_ms || DEFAULT_TIMEOUT })
    case 'mcp_call': return await a.mcpCallTool(args.to, args.tool, args.args || {}, { timeout: args.timeout_ms || DEFAULT_TIMEOUT })
    case 'tail': return await a.messages({ limit: args.limit || 20, reverse: true, bucket: args.bucket || 'main' })
    case 'requests': return await a.requests({ limit: args.limit || 20, reverse: true })
    case 'thread': return await a.thread(args.id)
    case 'room_new': {
      const room = await a.createRoom(args.name || '')
      return roomInfo(room)
    }
    case 'room_join': {
      const room = await a.joinRoom(args.serialized)
      return roomInfo(room)
    }
    case 'room_send': return summarizeEnv(await a.sendRoom(args.room_id, 'chat', { text: args.text }))
    case 'rooms': return a.rooms().map(roomInfo)
    default: throw new Error('unknown tool: ' + name)
  }
}

async function pair (args = {}) {
  const a = await startAgent()
  if (args.code) {
    const result = await a.pair({ code: args.code, alias: args.alias, timeout: args.timeout_ms || PAIR_TIMEOUT })
    return { paired: true, peer: result.peer, code: result.code }
  }
  if (pendingPair && pendingPair.state === 'pending') return pairStatus()
  const waitForCode = new Promise((resolve) => a.once('pair-code', resolve))
  const promise = a.pair({ alias: args.alias, timeout: args.timeout_ms || PAIR_TIMEOUT })
  pendingPair = { state: 'pending', code: null, peer: null, error: null, promise }
  promise.then((result) => {
    pendingPair.state = 'paired'
    pendingPair.peer = result.peer
  }).catch((err) => {
    pendingPair.state = 'failed'
    pendingPair.error = err?.message || String(err)
  })
  const code = await waitForCode
  pendingPair.code = code
  return { generated: code, state: 'pending', instruction: `Other agent should run: pearpost pair ${code}` }
}

function pairStatus () {
  if (!pendingPair) return { state: 'none' }
  return { state: pendingPair.state, code: pendingPair.code, peer: pendingPair.peer, error: pendingPair.error }
}

function summarizeEnv (env) {
  return { id: env.id, from: env.from, to: env.to, type: env.type, ts: env.ts, inReplyTo: env.inReplyTo }
}

function roomInfo (room) {
  return { id: room.id, name: room.name, to: room.to, members: [...room.members], serialized: room.serialize() }
}

async function handle (msg) {
  const { id, method, params } = msg
  try {
    if (method === 'initialize') {
      initialized = true
      return ok(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'pearpost', version: '0.0.1' }
      })
    }
    if (method === 'notifications/initialized') return
    if (!initialized && id != null) return fail(id, new Error('not initialized'), -32002)
    if (method === 'tools/list') return ok(id, { tools })
    if (method === 'tools/call') {
      const result = await callTool(params?.name, params?.arguments || {})
      return ok(id, content(result))
    }
    if (method === 'ping') return ok(id, {})
    if (id != null) return fail(id, new Error('method not found: ' + method), -32601)
  } catch (err) {
    if (id != null) fail(id, err)
    else console.error('[pearpost-mcp] notification error:', err?.message || err)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try { handle(JSON.parse(line)) } catch (err) { console.error('[pearpost-mcp] bad json:', err?.message || err) }
  }
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
async function shutdown () {
  try { await agent?.stop() } catch {}
  process.exit(0)
}
