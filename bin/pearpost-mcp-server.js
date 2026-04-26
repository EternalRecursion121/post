#!/usr/bin/env node
// pearpost-mcp-server — expose PearPost Agent operations as a stdio MCP server
// for Hermes native MCP. Implements enough JSON-RPC/MCP surface for tools/list
// and tools/call without external SDK dependencies.

import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { pathToFileURL } from 'url'
import { Agent } from '../protocol/index.js'

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.hermes', 'pearpost')
const ALIAS = process.env.PEARPOST_ALIAS || process.env.HERMES_USER || os.userInfo().username
const DEFAULT_TIMEOUT = Number(process.env.PEARPOST_TOOL_TIMEOUT_MS || 120000)
const PAIR_TIMEOUT = Number(process.env.PEARPOST_PAIR_TIMEOUT_MS || 10 * 60 * 1000)
const WAKE_SPOOL = process.env.PEARPOST_WAKE_SPOOL || path.join(HOME, 'inbox-events.jsonl')
const WAKE_SEEN = process.env.PEARPOST_WAKE_SEEN || path.join(HOME, 'inbox-watcher-seen.json')
const WAKE_TYPES = (process.env.PEARPOST_WAKE_TYPES || 'chat,tool.invoke,task.request')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

export const tools = [
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

export function createServerRuntime (opts = {}) {
  const AgentClass = opts.AgentClass || Agent
  const home = opts.home || HOME
  const alias = opts.alias || ALIAS
  const defaultTimeout = opts.defaultTimeout || DEFAULT_TIMEOUT
  const pairTimeout = opts.pairTimeout || PAIR_TIMEOUT
  const wakeSpool = opts.wakeSpool || WAKE_SPOOL
  const wakeSeen = opts.wakeSeen || WAKE_SEEN
  const wakeTypes = new Set(opts.wakeTypes || WAKE_TYPES)
  const enableWakeSpool = opts.enableWakeSpool !== false
  const log = opts.log || ((...args) => console.error(...args))

  let agent = null
  let agentStart = null
  let pendingPair = null
  let wake = null

  async function startAgent () {
    if (agent?.inbox) return agent
    if (agentStart) return agentStart

    agent = new AgentClass(home, {
      profile: { alias },
      // Directory gossip can hang on Hyperswarm.flush() in some containerized
      // environments; direct add/contact/follow and pairing still work without it.
      directory: false
    })
    agent.on?.('error', (err) => log('[pearpost-mcp] agent error:', err?.message || err))

    agentStart = agent.start().then(() => {
      if (enableWakeSpool) wake = attachWakeSpool(agent, { spoolPath: wakeSpool, seenPath: wakeSeen, types: wakeTypes, log })
      log(`[pearpost-mcp] ready as ${agent.address}`)
      return agent
    }).catch(async (err) => {
      try { await agent?.stop?.() } catch {}
      agent = null
      throw err
    }).finally(() => {
      agentStart = null
    })

    return agentStart
  }

  async function callTool (name, args = {}) {
    const a = await startAgent()
    switch (name) {
      case 'address': return { address: a.address, pubHex: a.pubHex, home, alias }
      case 'contacts': return await a.contacts()
      case 'add_contact': return await a.addContact(args.address, args.alias)
      case 'pair': return await pair(args)
      case 'pair_status': return pairStatus()
      case 'chat': return summarizeEnv(await a.chat(args.to, args.text))
      case 'send': return summarizeEnv(await a.send(args.to, args.type, args.body || {}))
      case 'invoke': return await a.invoke(args.to, args.tool, args.args || {}, { timeout: args.timeout_ms || defaultTimeout })
      case 'mcp_list': return await a.mcpListTools(args.to, { timeout: args.timeout_ms || defaultTimeout })
      case 'mcp_call': return await a.mcpCallTool(args.to, args.tool, args.args || {}, { timeout: args.timeout_ms || defaultTimeout })
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
      const result = await a.pair({ code: args.code, alias: args.alias, timeout: args.timeout_ms || pairTimeout })
      return { paired: true, peer: result.peer, code: result.code }
    }
    if (pendingPair && pendingPair.state === 'pending') return pairStatus()
    const waitForCode = new Promise((resolve) => a.once('pair-code', resolve))
    const promise = a.pair({ alias: args.alias, timeout: args.timeout_ms || pairTimeout })
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

  async function stop () {
    try { await wake?.flush?.() } catch {}
    try { await agent?.stop?.() } catch {}
    agent = null
    agentStart = null
  }

  return { startAgent, callTool, pairStatus, stop }
}

export function attachWakeSpool (agent, opts = {}) {
  const spoolPath = opts.spoolPath || WAKE_SPOOL
  const seenPath = opts.seenPath || WAKE_SEEN
  const types = opts.types || new Set(WAKE_TYPES)
  const log = opts.log || ((...args) => console.error(...args))
  const seen = new Set()
  let loaded = false
  let chain = Promise.resolve()

  async function loadSeen () {
    if (loaded) return
    loaded = true
    try {
      const state = JSON.parse(await fs.readFile(seenPath, 'utf8'))
      for (const id of state.seen || []) seen.add(id)
    } catch {}
  }

  async function persistSeen () {
    await fs.mkdir(path.dirname(seenPath), { recursive: true })
    const recent = [...seen].slice(-2000)
    await fs.writeFile(seenPath, JSON.stringify({ seen: recent }, null, 2))
  }

  async function append (rec) {
    await loadSeen()
    const event = normalizeWakeEvent(rec, types)
    if (!event || seen.has(event.key)) return
    seen.add(event.key)
    await fs.mkdir(path.dirname(spoolPath), { recursive: true })
    await fs.appendFile(spoolPath, JSON.stringify(event) + '\n')
    await persistSeen()
    log('[pearpost-mcp] wake event:', event.type, event.id || event.key)
  }

  function onMessage (rec) {
    chain = chain.then(() => append(rec)).catch((err) => log('[pearpost-mcp] wake spool error:', err?.message || err))
  }

  agent.on('message', onMessage)
  return {
    flush: () => chain,
    close: () => agent.off?.('message', onMessage)
  }
}

export function normalizeWakeEvent (rec, types = new Set(WAKE_TYPES)) {
  const env = rec?.env || rec
  const type = env?.type
  if (!type || !types.has(type)) return null
  const id = env.id || rec?.key || `${env.from || ''}:${env.ts || ''}:${type}`
  const body = rec?.body || env.body
  const text = typeof body?.text === 'string' ? body.text : undefined
  return {
    key: rec?.key || id,
    id,
    ts: env.ts,
    from: env.from,
    to: env.to,
    type,
    bucket: rec?.bucket || 'main',
    inReplyTo: env.inReplyTo,
    text,
    body
  }
}

function send (msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function ok (id, result) { send({ jsonrpc: '2.0', id, result }) }
function fail (id, err, code = -32000) { send({ jsonrpc: '2.0', id, error: { code, message: err?.message || String(err) } }) }
function content (value) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] } }
function summarizeEnv (env) { return { id: env.id, from: env.from, to: env.to, type: env.type, ts: env.ts, inReplyTo: env.inReplyTo } }
function roomInfo (room) { return { id: room.id, name: room.name, to: room.to, members: [...room.members], serialized: room.serialize() } }

export function createJsonRpcHandler (runtime) {
  let initialized = false
  return async function handle (msg) {
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
        const result = await runtime.callTool(params?.name, params?.arguments || {})
        return ok(id, content(result))
      }
      if (method === 'ping') return ok(id, {})
      if (id != null) return fail(id, new Error('method not found: ' + method), -32601)
    } catch (err) {
      if (id != null) fail(id, err)
      else console.error('[pearpost-mcp] notification error:', err?.message || err)
    }
  }
}

export function runStdioServer (runtime = createServerRuntime()) {
  const handle = createJsonRpcHandler(runtime)
  const inflight = new Set()
  let buf = ''
  let stopping = false

  function dispatch (msg) {
    const p = Promise.resolve(handle(msg)).finally(() => inflight.delete(p))
    inflight.add(p)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try { dispatch(JSON.parse(line)) } catch (err) { console.error('[pearpost-mcp] bad json:', err?.message || err) }
    }
  })
  process.stdin.on('end', shutdown)

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  async function shutdown () {
    if (stopping) return
    stopping = true
    // Corestore/Hyperswarm teardown can occasionally hang on shutdown; MCP
    // clients need process exit to be prompt when stdin closes or Hermes stops.
    const force = setTimeout(() => process.exit(0), 1500)
    force.unref?.()
    try { await Promise.allSettled([...inflight]) } catch {}
    try { await runtime.stop() } catch {}
    process.exit(0)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer()
}
