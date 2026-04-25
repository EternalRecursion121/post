// Hermes-side adapter for PearPost. Exposes a flat set of `pearpost.*`
// tools that a Hermes agent can call. The shape matches the agentskills.io
// "tools" convention: each export is { name, description, parameters,
// handler } where handler returns JSON-serialisable output.
//
// The skill keeps a single Agent instance hot for the lifetime of the
// host process. Identity and inbox persist under PEARPOST_HOME.

import os from 'os'
import path from 'path'
import { Agent } from 'pearpost/protocol/index.js'

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.hermes', 'pearpost')
const ALIAS = process.env.PEARPOST_ALIAS || process.env.HERMES_USER || os.userInfo().username

let agentP = null
function agent () {
  if (!agentP) {
    const a = new Agent(HOME, { profile: { alias: ALIAS } })
    agentP = a.start().then(() => a)
  }
  return agentP
}

// Tool registry the host walks at load-time.
export const tools = [
  {
    name: 'pearpost.address',
    description: 'Print my own pear+agent:// address. Share this with anyone you want to talk to.',
    parameters: {},
    async handler () {
      const a = await agent()
      return { address: a.address }
    }
  },

  {
    name: 'pearpost.contacts',
    description: 'List known peers (alias, pubkey, advertised tools).',
    parameters: {},
    async handler () {
      const a = await agent()
      return { contacts: await a.contacts() }
    }
  },

  {
    name: 'pearpost.add_contact',
    description: 'Add a peer by their pear+agent:// address. Optional alias.',
    parameters: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'pear+agent://… address' },
        alias: { type: 'string' }
      },
      required: ['address']
    },
    async handler ({ address, alias }) {
      const a = await agent()
      const card = await a.addContact(address, alias)
      return { added: card }
    }
  },

  {
    name: 'pearpost.pair',
    description: 'Short-code pairing. Omit `code` to generate one to share; pass `code` to redeem one shared with you. On success the peer is added as a contact and both sides start following each other.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'human-readable code from the other side; omit to generate one' },
        alias: { type: 'string', description: 'local alias to assign to the paired peer' },
        timeout_ms: { type: 'number', default: 60000 }
      }
    },
    async handler ({ code, alias, timeout_ms }) {
      const a = await agent()
      let generated = null
      const onCode = (c) => { generated = c }
      a.once('pair-code', onCode)
      try {
        const result = await a.pair({ code, alias, timeout: timeout_ms || 60000 })
        return { code: result.code, generated, peer: result.peer }
      } finally {
        a.removeListener('pair-code', onCode)
      }
    }
  },

  {
    name: 'pearpost.chat',
    description: 'Send a chat (text) message to a peer.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'pear+agent:// or hex pubkey' },
        text: { type: 'string' }
      },
      required: ['to', 'text']
    },
    async handler ({ to, text }) {
      const a = await agent()
      const env = await a.chat(to, text)
      return { id: env.id, ts: env.ts }
    }
  },

  {
    name: 'pearpost.send',
    description: 'Send any envelope type with a JSON body.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        type: { type: 'string', enum: ['chat', 'task.request', 'task.result', 'tool.invoke', 'tool.result', 'presence', 'ack'] },
        body: { type: 'object' },
        in_reply_to: { type: 'string' }
      },
      required: ['to', 'type']
    },
    async handler ({ to, type, body, in_reply_to }) {
      const a = await agent()
      const env = await a.send(to, type, body || {}, { inReplyTo: in_reply_to })
      return { id: env.id, ts: env.ts }
    }
  },

  {
    name: 'pearpost.invoke',
    description: 'Call a remote agent\'s tool by name. Blocks until the agent responds (or timeout).',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        tool: { type: 'string' },
        args: { type: 'object' },
        timeout_ms: { type: 'number', default: 30000 }
      },
      required: ['to', 'tool']
    },
    async handler ({ to, tool, args, timeout_ms }) {
      const a = await agent()
      const value = await a.invoke(to, tool, args || {}, { timeout: timeout_ms || 30000 })
      return { value }
    }
  },

  {
    name: 'pearpost.register_tool',
    description: 'Expose one of this Hermes agent\'s skills/tools to remote PearPost agents under a given name. By default contacts-only; pass public=true to allow strangers (still rate-limited).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'name remote agents will call' },
        hermes_tool: { type: 'string', description: 'name of the local Hermes tool to forward to' },
        public: { type: 'boolean', description: 'expose to non-contacts (default: false)' }
      },
      required: ['name', 'hermes_tool']
    },
    async handler ({ name, hermes_tool, public: isPublic }, ctx) {
      const a = await agent()
      a.registerTool(name, async (args) => {
        // ctx.host is provided by the Hermes runtime when invoking a skill.
        if (!ctx?.host?.invokeTool) {
          throw new Error('host runtime did not provide invokeTool — cannot forward')
        }
        return ctx.host.invokeTool(hermes_tool, args)
      }, { public: !!isPublic })
      return { registered: name, forwards_to: hermes_tool, public: !!isPublic }
    }
  },

  {
    name: 'pearpost.tail',
    description: 'Return the most recent N inbox messages from the main bucket. Pass bucket="requests" to view quarantined messages from non-contacts, or "all" for both.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 50 },
        bucket: { type: 'string', enum: ['main', 'requests', 'all'], default: 'main' }
      }
    },
    async handler ({ limit, bucket }) {
      const a = await agent()
      return { messages: await a.messages({ limit: limit || 50, reverse: true, bucket: bucket || 'main' }) }
    }
  },

  {
    name: 'pearpost.requests',
    description: 'Pending messages from non-contacts (the quarantine bucket). Review here before adding the peer to contacts.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', default: 50 } }
    },
    async handler ({ limit }) {
      const a = await agent()
      return { requests: await a.requests({ limit: limit || 50, reverse: true }) }
    }
  },

  {
    name: 'pearpost.thread',
    description: 'Walk a thread starting from a root envelope id.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    },
    async handler ({ id }) {
      const a = await agent()
      return { thread: await a.thread(id) }
    }
  },

  {
    name: 'pearpost.room_new',
    description: 'Create a new shared room. Returns a share-link to give to invitees.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } }
    },
    async handler ({ name }) {
      const a = await agent()
      const room = await a.createRoom(name || '')
      return { id: room.id, name: room.name, share: room.serialize() }
    }
  },

  {
    name: 'pearpost.room_join',
    description: 'Join a room from its share-link.',
    parameters: {
      type: 'object',
      properties: { share: { type: 'string' } },
      required: ['share']
    },
    async handler ({ share }) {
      const a = await agent()
      const room = await a.joinRoom(share)
      return { id: room.id, name: room.name }
    }
  },

  {
    name: 'pearpost.room_send',
    description: 'Send a chat to a joined room.',
    parameters: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['room_id', 'text']
    },
    async handler ({ room_id, text }) {
      const a = await agent()
      const env = await a.sendRoom(room_id, 'chat', { text })
      return { id: env.id }
    }
  }
]

// Hermes can also subscribe to live messages. Optional — not all hosts use this.
export async function subscribe (onEvent) {
  const a = await agent()
  a.on('message', (rec) => onEvent({ kind: 'message', record: rec }))
  a.on('peer', (card) => onEvent({ kind: 'peer', card }))
  return () => {
    a.removeAllListeners('message')
    a.removeAllListeners('peer')
  }
}

export default { tools, subscribe }
