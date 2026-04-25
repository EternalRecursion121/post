#!/usr/bin/env node
import os from 'os'
import path from 'path'
import { Agent } from '../protocol/index.js'

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.pearpost')
const ALIAS = process.env.PEARPOST_ALIAS || os.userInfo().username

const [, , cmd, ...rest] = process.argv

const usage = `pearpost — P2P agent inbox

Usage:
  pearpost id                           print my pear+agent:// address
  pearpost discover                     join the directory and print peers
  pearpost contacts                     list known contacts
  pearpost contacts rm <pubhex>         remove a contact and block re-gossip
  pearpost contacts unblock <pubhex>    let gossip restore a previously removed contact
  pearpost contacts purge               remove + block every contact (clean slate)
  pearpost add <addr> [alias]           add a contact manually
  pearpost pair [code] [--alias name]   short-code pairing (omit code to generate one)
  pearpost chat <addr> <text...>        send a chat message
  pearpost send <addr> <type> <json>    send any envelope type with JSON body
  pearpost invoke <addr> <tool> <json>  call a remote tool (RPC)
  pearpost serve <tool>                 register a built-in echo tool and stay up
  pearpost tail                         stream live incoming messages
  pearpost list [n]                     print last n messages (default 20)
  pearpost room new [name]              create a room (prints serialized)
  pearpost room join <serialized>       join a room
  pearpost room send <id> <text...>     send chat to a joined room
  pearpost rooms                        list joined rooms
  pearpost mcp list <addr>              list MCP tools on a peer
  pearpost mcp call <addr> <tool> <json>  call an MCP tool on a peer
  pearpost mcp host <stdio-cmd...>      bridge a local stdio MCP server out to peers

Env:
  PEARPOST_HOME    storage dir (default ~/.pearpost)
  PEARPOST_ALIAS   directory profile alias (default $USER)
`

if (!cmd || cmd === '-h' || cmd === '--help') {
  process.stdout.write(usage)
  process.exit(0)
}

run().catch(err => {
  console.error('error:', err.message || err)
  process.exit(1)
})

async function run () {
  const agent = new Agent(HOME, { profile: { alias: ALIAS } })
  await agent.start()

  switch (cmd) {
    case 'id':
      console.log(agent.address)
      return shutdown(agent)

    case 'contacts': {
      const sub = rest[0]
      if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
        const pub = rest[1]
        if (!pub) throw new Error('contacts rm: need pubhex')
        const out = await agent.deleteContact(pub)
        console.log('removed', out.pubkey, out.blocked ? '(blocked)' : '')
        return shutdown(agent)
      }
      if (sub === 'unblock') {
        const pub = rest[1]
        if (!pub) throw new Error('contacts unblock: need pubhex')
        await agent.unblockContact(pub)
        console.log('unblocked', pub)
        return shutdown(agent)
      }
      if (sub === 'purge') {
        const all = await agent.contacts()
        for (const c of all) {
          await agent.deleteContact(c.pubkey).catch(err => console.error('!', c.pubkey.slice(0, 12), err.message))
        }
        console.log(`purged ${all.length} contact(s) — all blocked`)
        return shutdown(agent)
      }
      for (const c of await agent.contacts()) {
        console.log(`${c.pubkey}  ${c.alias || ''}  [${(c.capabilities || []).join(', ')}]`)
      }
      return shutdown(agent)
    }

    case 'add': {
      const [addr, alias] = rest
      if (!addr) throw new Error('add: need address')
      const card = await agent.addContact(addr, alias)
      console.log('added', card.pubkey, alias || '')
      return shutdown(agent)
    }

    case 'pair': {
      const aliasIdx = rest.indexOf('--alias')
      const alias = aliasIdx >= 0 ? rest[aliasIdx + 1] : undefined
      const positional = rest.filter((tok, i) => {
        if (tok === '--alias') return false
        if (aliasIdx >= 0 && i === aliasIdx + 1) return false
        return true
      })
      const code = positional[0]
      agent.on('pair-code', (c) => {
        console.log('code:', c)
        console.log('share this code with the other agent — they run: pearpost pair ' + c)
      })
      if (code) console.log('pairing with code:', code)
      const { peer } = await agent.pair({ code, alias })
      console.log('paired with', peer.pubkey, peer.alias || '')
      return shutdown(agent)
    }

    case 'chat': {
      const [to, ...words] = rest
      const env = await agent.chat(to, words.join(' '))
      console.log('sent', env.id)
      return shutdown(agent, 250)
    }

    case 'send': {
      const [to, type, json = '{}'] = rest
      const env = await agent.send(to, type, JSON.parse(json))
      console.log('sent', env.id)
      return shutdown(agent, 250)
    }

    case 'invoke': {
      const [to, tool, json = '{}'] = rest
      const value = await agent.invoke(to, tool, JSON.parse(json), { timeout: 20000 })
      console.log(JSON.stringify(value, null, 2))
      return shutdown(agent)
    }

    case 'serve': {
      const tool = rest[0] || 'echo'
      agent.registerTool(tool, async (args, ctx) => {
        console.log(`[tool ${tool}] from=${ctx.from.slice(0, 12)} args=${JSON.stringify(args)}`)
        return { tool, args, at: Date.now() }
      })
      console.log(`serving tool "${tool}" as ${agent.address}`)
      console.log('Ctrl+C to stop.')
      keepAlive()
      return
    }

    case 'tail': {
      console.log('listening as', agent.address)
      console.log('commands:  :chat <addr> <text>   :send <addr> <type> <json>')
      console.log('           :invoke <addr> <tool> <json>   :room send <id> <text>')
      console.log('           :contacts   :rooms   :quit')
      agent.on('message', (rec) => printRecord(rec))
      startRepl(agent)
      return
    }

    case 'discover': {
      console.log('directory: joining…')
      agent.on('peer', (card) => {
        console.log(`peer ${card.pubkey}  ${card.alias || ''}  [${(card.capabilities || []).join(', ')}]`)
      })
      keepAlive()
      return
    }

    case 'list': {
      const n = parseInt(rest[0] || '20', 10)
      const msgs = await agent.messages({ limit: n, reverse: true })
      for (const r of msgs.reverse()) printRecord(r)
      return shutdown(agent)
    }

    case 'rooms': {
      for (const r of agent.rooms()) {
        console.log(`${r.id}  ${r.name || ''}`)
      }
      return shutdown(agent)
    }

    case 'mcp': {
      const sub = rest[0]
      if (sub === 'list') {
        const peer = rest[1]
        if (!peer) throw new Error('mcp list: need peer address')
        const tools = await agent.mcpListTools(peer, { timeout: 30000 })
        for (const t of tools) {
          console.log(`${t.name}\t${t.description || ''}`)
        }
        return shutdown(agent)
      }
      if (sub === 'call') {
        const [, peer, tool, json = '{}'] = rest
        if (!peer || !tool) throw new Error('mcp call: need peer and tool')
        const res = await agent.mcpCallTool(peer, tool, JSON.parse(json), { timeout: 120000 })
        console.log(JSON.stringify(res, null, 2))
        return shutdown(agent)
      }
      if (sub === 'host') {
        // Hand off to the bridge. We import it dynamically by re-execing
        // so the bridge owns its own agent lifecycle (it needs swarm).
        await agent.stop()
        const { spawn } = await import('child_process')
        const path = await import('path')
        const url = await import('url')
        const here = path.dirname(url.fileURLToPath(import.meta.url))
        const bridge = path.join(here, 'pearpost-mcp-bridge.js')
        const child = spawn(process.execPath, [bridge, ...rest.slice(1)], { stdio: 'inherit' })
        child.on('exit', code => process.exit(code ?? 0))
        return
      }
      throw new Error('mcp: unknown subcommand ' + (sub || ''))
    }

    case 'room': {
      const sub = rest[0]
      if (sub === 'new' || sub === 'create') {
        const room = await agent.createRoom(rest[1] || '')
        console.log('id     :', room.id)
        console.log('name   :', room.name)
        console.log('share  :', room.serialize())
        return shutdown(agent)
      }
      if (sub === 'join') {
        const room = await agent.joinRoom(rest[1])
        console.log('joined', room.id, room.name || '')
        return shutdown(agent)
      }
      if (sub === 'send') {
        const [, id, ...words] = rest
        await agent.sendRoom(id, 'chat', { text: words.join(' ') })
        console.log('sent to room', id)
        return shutdown(agent, 250)
      }
      throw new Error('room: unknown subcommand ' + sub)
    }

    default:
      process.stderr.write(usage)
      process.exit(2)
  }
}

function printRecord (rec) {
  const { env, body } = rec
  const t = new Date(env.ts).toISOString().replace('T', ' ').slice(0, 19)
  const tag = env.to.startsWith('room:') ? `room:${env.to.slice(5, 13)}…` : 'direct'
  let summary
  if (env.type === 'chat') summary = body.text
  else if (env.type === 'tool.invoke') summary = `${body.name}(${JSON.stringify(body.args)})`
  else if (env.type === 'tool.result') summary = body.ok ? `→ ${JSON.stringify(body.value)}` : `! ${body.error}`
  else summary = JSON.stringify(body)
  console.log(`${t}  ${env.type.padEnd(12)}  ${tag}  ${env.from.slice(0, 12)}…  ${summary}`)
}

function keepAlive () {
  process.stdin.resume()
  process.on('SIGINT', () => process.exit(0))
}

function startRepl (agent) {
  process.on('SIGINT', () => process.exit(0))
  process.stdin.setEncoding('utf8')
  let buf = ''
  process.stdin.on('data', async (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try { await dispatch(agent, line) } catch (e) { console.error('!', e.message) }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

async function dispatch (agent, line) {
  if (!line.startsWith(':')) {
    console.error('commands start with ":"  e.g. :chat <addr> hello')
    return
  }
  const parts = line.slice(1).split(/\s+/)
  const verb = parts[0]
  if (verb === 'chat') {
    const [, to, ...words] = parts
    const env = await agent.chat(to, words.join(' '))
    console.log('  → sent', env.id)
  } else if (verb === 'send') {
    const [, to, type, ...rest] = parts
    const env = await agent.send(to, type, JSON.parse(rest.join(' ') || '{}'))
    console.log('  → sent', env.id)
  } else if (verb === 'invoke') {
    const [, to, tool, ...rest] = parts
    const value = await agent.invoke(to, tool, JSON.parse(rest.join(' ') || '{}'), { timeout: 20000 })
    console.log('  →', JSON.stringify(value))
  } else if (verb === 'contacts') {
    for (const c of await agent.contacts()) console.log('  ' + c.pubkey + '  ' + (c.alias || ''))
  } else if (verb === 'rooms') {
    for (const r of agent.rooms()) console.log('  ' + r.id + '  ' + (r.name || ''))
  } else if (verb === 'room') {
    const sub = parts[1]
    if (sub === 'send') {
      const [, , id, ...words] = parts
      await agent.sendRoom(id, 'chat', { text: words.join(' ') })
      console.log('  → sent to room', id)
    } else if (sub === 'new') {
      const room = await agent.createRoom(parts.slice(2).join(' '))
      console.log('  id:', room.id)
      console.log('  share:', room.serialize())
    } else if (sub === 'join') {
      const room = await agent.joinRoom(parts.slice(2).join(' '))
      console.log('  joined', room.id)
    }
  } else if (verb === 'quit' || verb === 'q') {
    await agent.stop()
    process.exit(0)
  } else {
    console.error('unknown:', verb)
  }
}

async function shutdown (agent, delay = 0) {
  if (delay) await new Promise(r => setTimeout(r, delay))
  await agent.stop()
  process.exit(0)
}
