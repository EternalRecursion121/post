// PearPost desktop app entry.
//
// Runs an HTTP + SSE server on localhost that exposes the Agent to the
// renderer (a single-page app in app/ui). Works two ways:
//   1. Plain node (`node app/app.js`)        — opens nothing, prints the URL.
//   2. Pears runtime (`pear run --dev .`)    — opens an Electron window at it.
//
// Keeping the UI as a normal web page (no preload, no IPC) means the same
// code drives a browser tab during dev and a Pears desktop window in the
// demo. Trivially debuggable.

import http from 'http'
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

import { Agent } from '../protocol/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(__dirname, 'ui')

const HOME = process.env.PEARPOST_HOME || path.join(os.homedir(), '.pearpost')
const ALIAS = process.env.PEARPOST_ALIAS || os.userInfo().username
const PORT = parseInt(process.env.PEARPOST_PORT || '7777', 10)

const agent = new Agent(HOME, { profile: { alias: ALIAS } })
await agent.start()
console.log('agent ready as', agent.address)

const sseClients = new Set()
agent.on('message', (rec) => broadcast({ kind: 'message', record: serializeRecord(rec) }))
agent.on('peer', (card) => broadcast({ kind: 'peer', card }))

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/events') return sse(req, res)
    if (req.method === 'GET' && req.url === '/me') return json(res, await me())
    if (req.method === 'GET' && req.url.startsWith('/messages')) {
      const u = new URL(req.url, 'http://x')
      const limit = parseInt(u.searchParams.get('limit') || '500', 10)
      const list = await agent.messages({ limit, reverse: false })
      return json(res, list.map(serializeRecord))
    }
    if (req.method === 'GET' && req.url.startsWith('/thread/')) {
      const id = decodeURIComponent(req.url.slice('/thread/'.length))
      const list = await agent.thread(id)
      return json(res, list.map(serializeRecord))
    }
    if (req.method === 'POST' && req.url === '/chat') {
      const { to, text } = await body(req)
      const env = await agent.chat(to, text)
      return json(res, { id: env.id })
    }
    if (req.method === 'POST' && req.url === '/send') {
      const { to, type, body: b, inReplyTo } = await body(req)
      const env = await agent.send(to, type, b, { inReplyTo })
      return json(res, { id: env.id })
    }
    if (req.method === 'POST' && req.url === '/invoke') {
      const { to, tool, args } = await body(req)
      const value = await agent.invoke(to, tool, args, { timeout: 30000 })
      return json(res, { value })
    }
    if (req.method === 'POST' && req.url === '/contacts/add') {
      const { address, alias } = await body(req)
      const card = await agent.addContact(address, alias)
      return json(res, card)
    }
    if (req.method === 'POST' && req.url === '/room/new') {
      const { name } = await body(req)
      const room = await agent.createRoom(name || '')
      return json(res, { id: room.id, name: room.name, share: room.serialize() })
    }
    if (req.method === 'POST' && req.url === '/room/join') {
      const { share } = await body(req)
      const room = await agent.joinRoom(share)
      return json(res, { id: room.id, name: room.name })
    }
    if (req.method === 'POST' && req.url === '/room/send') {
      const { id, text, type, body: b } = await body(req)
      const env = await agent.sendRoom(id, type || 'chat', b || { text })
      return json(res, { id: env.id })
    }

    return staticFile(req, res)
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`
  console.log('UI ready:', url)
  maybeOpenPearWindow(url)
})

async function me () {
  return {
    address: agent.address,
    pubHex: agent.pubHex,
    alias: ALIAS,
    contacts: await agent.contacts(),
    rooms: agent.rooms().map(r => ({ id: r.id, name: r.name, share: r.serialize() })),
    capabilities: agent.directory.profile.capabilities || []
  }
}

function serializeRecord (rec) {
  return { key: rec.key, env: rec.env, body: rec.body }
}

function broadcast (event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const c of sseClients) {
    try { c.write(line) } catch {}
  }
}

function sse (req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  res.write('retry: 1000\n\n')
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
}

function json (res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function body (req) {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function staticFile (req, res) {
  const u = req.url === '/' ? '/index.html' : req.url
  const file = path.join(UI_DIR, u.replace(/\?.*$/, ''))
  if (!file.startsWith(UI_DIR) || !existsSync(file)) {
    res.writeHead(404); res.end('not found')
    return
  }
  const ext = path.extname(file).slice(1)
  const ct = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', json: 'application/json' }[ext] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': ct })
  res.end(readFileSync(file))
}

function maybeOpenPearWindow (url) {
  // If launched under Pears, the global `Pear` is defined and we can ask
  // the runtime for an Electron window. Otherwise we leave it to the user.
  if (typeof globalThis.Pear === 'undefined') return
  // pear-electron is loaded lazily so this file still runs under plain node
  import('pear-electron').then(({ default: electron }) => {
    if (!electron) return
    const win = new electron.BrowserWindow({ width: 1200, height: 800, backgroundColor: '#0f1117' })
    win.loadURL(url)
  }).catch(err => console.warn('pear-electron not available:', err.message))
}
