// MCP-over-pearpost: a thin layer on top of rpc.js that speaks the
// minimum-viable Model Context Protocol surface — initialize, tools/list,
// tools/call, ping. Everything rides existing tool.invoke/tool.result
// envelopes; no new wire types.
//
// Tools are registered with a JSON-Schema input shape so listings carry
// real type information (vs. rpc.js, which only knows names). Callers are
// authenticated by pubkey — every handler dispatches through an allowlist
// keyed on the sender's pubHex.

import { EventEmitter } from 'events'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const HANDLER_INIT = 'mcp.initialize'
const HANDLER_LIST = 'mcp.tools/list'
const HANDLER_CALL = 'mcp.tools/call'
const HANDLER_PING = 'mcp.ping'

// Server: register tools, expose them over rpc as MCP methods.
export class MCPServer extends EventEmitter {
  constructor (rpc, { name = 'pearpost-mcp', version = '0.1.0' } = {}) {
    super()
    this.rpc = rpc
    this.serverInfo = { name, version }
    this.tools = new Map()      // name -> { description, inputSchema, handler }
    this.allowlist = new Map()  // pubHex -> Set<toolName> | '*'
    this._public = false

    // MCP has its own per-peer allowlist (see _isAllowed); register the
    // protocol handlers as public so the rpc-level contacts-only gate
    // doesn't double-block legitimate MCP traffic. tools/call still goes
    // through _isAllowed before any user handler runs.
    rpc.register(HANDLER_INIT, (args, ctx) => this._initialize(args, ctx), { public: true })
    rpc.register(HANDLER_LIST, (args, ctx) => this._listTools(args, ctx), { public: true })
    rpc.register(HANDLER_CALL, (args, ctx) => this._callTool(args, ctx), { public: true })
    rpc.register(HANDLER_PING, () => ({}), { public: true })
  }

  // Register a tool. `def` is { description, inputSchema }. Handler returns
  // either a plain value (auto-wrapped as a text content block) or a raw
  // MCP-shaped { content, isError } object (passed through — used by the
  // bridge to forward upstream results untouched).
  tool (name, def, handler) {
    if (typeof name !== 'string' || !name) throw new Error('tool: name required')
    if (typeof handler !== 'function') throw new Error('tool: handler required')
    const description = (def && def.description) || ''
    const inputSchema = (def && def.inputSchema) || { type: 'object' }
    this.tools.set(name, { description, inputSchema, handler })
    return this
  }

  unregister (name) { this.tools.delete(name); return this }

  // Authorize a peer (by pubHex) to call a specific tool, list of tools,
  // or all tools ('*'). Default policy is deny.
  allow (pubHex, names) {
    if (names === '*' || names === true) {
      this.allowlist.set(pubHex, '*')
      return this
    }
    const list = Array.isArray(names) ? names : [names]
    const cur = this.allowlist.get(pubHex)
    if (cur === '*') return this
    const set = cur instanceof Set ? cur : new Set()
    for (const n of list) set.add(n)
    this.allowlist.set(pubHex, set)
    return this
  }

  allowAll (pubHex) { return this.allow(pubHex, '*') }

  // Open every tool to every caller. Useful for fully public hosted MCP
  // servers; equivalent to running on the open internet, so opt-in only.
  allowPublic () { this._public = true; return this }

  revoke (pubHex) { this.allowlist.delete(pubHex); return this }

  _isAllowed (pubHex, name) {
    if (this._public) return true
    const entry = this.allowlist.get(pubHex)
    if (!entry) return false
    if (entry === '*') return true
    return entry.has(name)
  }

  _initialize (_args, _ctx) {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.serverInfo
    }
  }

  _listTools (_args, ctx) {
    const visible = []
    for (const [name, { description, inputSchema }] of this.tools) {
      if (!this._isAllowed(ctx.from, name)) continue
      visible.push({ name, description, inputSchema })
    }
    return { tools: visible }
  }

  async _callTool (args, ctx) {
    const name = args && args.name
    const params = (args && args.arguments) || {}
    if (!name) return { content: [{ type: 'text', text: 'tools/call: missing name' }], isError: true }
    if (!this._isAllowed(ctx.from, name)) {
      return {
        content: [{ type: 'text', text: `tools/call: not authorized for ${name}` }],
        isError: true
      }
    }
    const entry = this.tools.get(name)
    if (!entry) {
      return {
        content: [{ type: 'text', text: `tools/call: unknown tool ${name}` }],
        isError: true
      }
    }
    try {
      const value = await entry.handler(params, { from: ctx.from, env: ctx.env })
      if (value && Array.isArray(value.content)) return value
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return { content: [{ type: 'text', text }], isError: false }
    } catch (e) {
      return {
        content: [{ type: 'text', text: e.message || String(e) }],
        isError: true
      }
    }
  }
}

// Client: per-peer initialize cache + thin wrappers for list/call/ping.
export class MCPClient {
  constructor (rpc, { defaultTimeout = 60000 } = {}) {
    this.rpc = rpc
    this.defaultTimeout = defaultTimeout
    this.sessions = new Map()  // peerHex -> initialize result
  }

  async initialize (peerHex, { force = false, timeout } = {}) {
    if (!force && this.sessions.has(peerHex)) return this.sessions.get(peerHex)
    const info = await this.rpc.invoke(peerHex, HANDLER_INIT, {}, {
      timeout: timeout ?? this.defaultTimeout
    })
    this.sessions.set(peerHex, info)
    return info
  }

  async ping (peerHex, opts = {}) {
    return this.rpc.invoke(peerHex, HANDLER_PING, {}, {
      timeout: opts.timeout ?? this.defaultTimeout
    })
  }

  async listTools (peerHex, opts = {}) {
    if (!this.sessions.has(peerHex)) await this.initialize(peerHex, opts)
    const out = await this.rpc.invoke(peerHex, HANDLER_LIST, {}, {
      timeout: opts.timeout ?? this.defaultTimeout
    })
    return out.tools || []
  }

  async callTool (peerHex, name, args, opts = {}) {
    if (!this.sessions.has(peerHex)) await this.initialize(peerHex, opts)
    return this.rpc.invoke(peerHex, HANDLER_CALL, { name, arguments: args || {} }, {
      timeout: opts.timeout ?? this.defaultTimeout
    })
  }

  forget (peerHex) { this.sessions.delete(peerHex) }
}
