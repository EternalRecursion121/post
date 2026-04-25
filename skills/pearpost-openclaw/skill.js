// OpenClaw skill: PearPost
//
// OpenClaw skills export a `register(claw)` function. The claw object
// gives us:
//   claw.tool(name, schema, handler)         — register a tool
//   claw.session(opts)                       — get/create a session-scoped
//                                              channel ("agent", "browser",
//                                              "canvas", …)
//   claw.on('message'|'session:event', fn)   — subscribe to events
//   claw.skills.bridge('sessions_send', …)   — invoke another tool
//
// We use it to add a new "agent" channel: incoming PearPost messages are
// posted into the user's main session as if they came from a regular
// messaging contact. So you'll see "[pearpost] alice: standup at 10?" in
// the same conversation as everything else.

import os from 'os'
import path from 'path'
import { Agent } from 'pearpost/protocol/index.js'

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.openclaw', 'pearpost')

export function register (claw) {
  let agentP = null
  function get () {
    if (!agentP) {
      const profile = { alias: claw.user?.name || os.userInfo().username }
      const a = new Agent(HOME, { profile })
      agentP = a.start().then(() => {
        // Mirror incoming messages into the user's main OpenClaw session
        // so they appear in the unified inbox.
        a.on('message', async (rec) => {
          if (rec.env.from === a.pubHex) return
          const tag = rec.env.to.startsWith('room:') ? `room ${rec.env.to.slice(5,11)}…` : 'direct'
          const summary = summarise(rec)
          await claw.skills.bridge('sessions_send', {
            session: 'main',
            from: 'pearpost',
            channel: 'agent',
            text: `[pearpost ${tag} • ${rec.env.from.slice(0,8)}] ${summary}`,
            metadata: { envelope: rec.env, body: rec.body }
          }).catch(() => {})
        })
        return a
      })
    }
    return agentP
  }

  // ---- tools ----
  claw.tool('pearpost_address', {
    description: 'Print my pear+agent:// address. Share it with other agents.',
    parameters: {}
  }, async () => {
    const a = await get()
    return { address: a.address }
  })

  claw.tool('pearpost_contacts', {
    description: 'List known PearPost peers.',
    parameters: {}
  }, async () => {
    const a = await get()
    return { contacts: await a.contacts() }
  })

  claw.tool('pearpost_add_contact', {
    description: 'Add a peer agent by pear+agent:// address.',
    parameters: { type: 'object', properties: { address: { type: 'string' }, alias: { type: 'string' } }, required: ['address'] }
  }, async ({ address, alias }) => {
    const a = await get()
    return { added: await a.addContact(address, alias) }
  })

  claw.tool('pearpost_pair', {
    description: 'Short-code pairing. Omit `code` to generate one to share with the other agent; pass `code` to redeem one shared with you. On success the peer is added as a contact and both sides start following each other — no hex addresses to copy.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'human-readable code; omit to generate one' },
        alias: { type: 'string', description: 'local alias for the paired peer' },
        timeout_ms: { type: 'number', default: 60000 }
      }
    }
  }, async ({ code, alias, timeout_ms }) => {
    const a = await get()
    let generated = null
    const onCode = (c) => {
      generated = c
      // Surface the generated code into the user's main session so they can
      // read it out / copy it before the other side redeems.
      claw.skills.bridge('sessions_send', {
        session: 'main',
        from: 'pearpost',
        channel: 'agent',
        text: `[pearpost] pairing code: ${c}  — share with the other agent within 60s`
      }).catch(() => {})
    }
    a.once('pair-code', onCode)
    try {
      const result = await a.pair({ code, alias, timeout: timeout_ms || 60000 })
      return { code: result.code, generated, peer: result.peer }
    } finally {
      a.removeListener('pair-code', onCode)
    }
  })

  claw.tool('pearpost_chat', {
    description: 'Send a chat to a peer agent.',
    parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'] }
  }, async ({ to, text }) => {
    const a = await get()
    const env = await a.chat(to, text)
    return { id: env.id }
  })

  claw.tool('pearpost_send', {
    description: 'Send any envelope type with a JSON body.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, type: { type: 'string' }, body: { type: 'object' }, in_reply_to: { type: 'string' } },
      required: ['to', 'type']
    }
  }, async ({ to, type, body, in_reply_to }) => {
    const a = await get()
    const env = await a.send(to, type, body || {}, { inReplyTo: in_reply_to })
    return { id: env.id }
  })

  claw.tool('pearpost_invoke', {
    description: 'Call a remote agent\'s tool by name. Blocks until result or timeout.',
    parameters: {
      type: 'object',
      properties: { to: { type: 'string' }, tool: { type: 'string' }, args: { type: 'object' }, timeout_ms: { type: 'number' } },
      required: ['to', 'tool']
    }
  }, async ({ to, tool, args, timeout_ms }) => {
    const a = await get()
    return { value: await a.invoke(to, tool, args || {}, { timeout: timeout_ms || 30000 }) }
  })

  claw.tool('pearpost_register_tool', {
    description: 'Expose one of this OpenClaw\'s skills to remote PearPost agents under a given name. Defaults to contacts-only; pass public=true to expose to strangers (still rate-limited).',
    parameters: { type: 'object', properties: { name: { type: 'string' }, openclaw_tool: { type: 'string' }, public: { type: 'boolean' } }, required: ['name', 'openclaw_tool'] }
  }, async ({ name, openclaw_tool, public: isPublic }) => {
    const a = await get()
    a.registerTool(name, async (args, ctx) => {
      // forward to an existing OpenClaw tool, with the caller's pubkey in metadata
      return claw.skills.bridge(openclaw_tool, args, { caller: ctx.from })
    }, { public: !!isPublic })
    return { registered: name, forwards_to: openclaw_tool, public: !!isPublic }
  })

  claw.tool('pearpost_tail', {
    description: 'Recent inbox messages. Defaults to the main bucket; pass bucket="requests" or "all" to see quarantined non-contact traffic.',
    parameters: { type: 'object', properties: { limit: { type: 'number' }, bucket: { type: 'string', enum: ['main', 'requests', 'all'] } } }
  }, async ({ limit, bucket }) => {
    const a = await get()
    return { messages: await a.messages({ limit: limit || 50, reverse: true, bucket: bucket || 'main' }) }
  })

  claw.tool('pearpost_requests', {
    description: 'Pending messages from non-contacts (the quarantine bucket). Review before promoting to contacts.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } }
  }, async ({ limit }) => {
    const a = await get()
    return { requests: await a.requests({ limit: limit || 50, reverse: true }) }
  })

  claw.tool('pearpost_thread', {
    description: 'Walk a thread by root id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  }, async ({ id }) => {
    const a = await get()
    return { thread: await a.thread(id) }
  })

  claw.tool('pearpost_room_new', {
    description: 'Create a shared room and return a share-link.',
    parameters: { type: 'object', properties: { name: { type: 'string' } } }
  }, async ({ name }) => {
    const a = await get()
    const r = await a.createRoom(name || '')
    return { id: r.id, name: r.name, share: r.serialize() }
  })

  claw.tool('pearpost_room_join', {
    description: 'Join a room from a share-link.',
    parameters: { type: 'object', properties: { share: { type: 'string' } }, required: ['share'] }
  }, async ({ share }) => {
    const a = await get()
    const r = await a.joinRoom(share)
    return { id: r.id, name: r.name }
  })

  claw.tool('pearpost_room_send', {
    description: 'Send a chat to a joined room.',
    parameters: { type: 'object', properties: { room_id: { type: 'string' }, text: { type: 'string' } }, required: ['room_id', 'text'] }
  }, async ({ room_id, text }) => {
    const a = await get()
    const env = await a.sendRoom(room_id, 'chat', { text })
    return { id: env.id }
  })

  return {
    async stop () {
      if (agentP) { try { (await agentP).stop() } catch {} }
    }
  }
}

function summarise (rec) {
  const e = rec.env
  if (e.type === 'chat') return rec.body?.text || ''
  if (e.type === 'tool.invoke') return `${rec.body.name}(${JSON.stringify(rec.body.args || {})})`
  if (e.type === 'tool.result') return rec.body.ok ? `→ ${JSON.stringify(rec.body.value)}` : `! ${rec.body.error}`
  return `${e.type} ${JSON.stringify(rec.body)}`
}

export default register
