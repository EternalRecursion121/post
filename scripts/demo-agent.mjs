#!/usr/bin/env node
// PearPost demo-agent — long-lived per-role agent process.
//
// Each tmux pane runs one of these. It boots a real PearPost Agent with its
// own keypair and home dir, joins the DHT, registers as the named role, and
// listens on an HTTP control port for orchestrator commands. Every step
// driven by the orchestrator is a real envelope leaving this process and
// arriving at another agent process — not a scripted echo.
//
// Usage:
//   node scripts/demo-agent.mjs <role> [--scenario <id>] [--app-base <url>]
//
// Env (besides PEARPOST_HOME / PEARPOST_ALIAS, which we set per role):
//   DEMO_ROOT        roster root, default /tmp/pearpost-demo
//   APP_BASE         app server (default http://127.0.0.1:7777)
//
// Control surface (HTTP, on a localhost-only port published in the roster):
//   GET  /info                          { role, address, alias, peers }
//   POST /add-contacts  { roster }      add every other role as a contact
//   POST /act           { step }        send the real envelope for this step
//   POST /shutdown                       graceful shutdown

import http from 'http'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import path from 'path'
import os from 'os'

import { Agent } from '../protocol/index.js'
import { getScenario } from '../app/demo/scenarios.js'

const argv = process.argv.slice(2)
const role = argv[0]
if (!role) { console.error('usage: demo-agent.mjs <role> [--scenario <id>]'); process.exit(1) }

let scenarioId = null
let appBase = process.env.APP_BASE || 'http://127.0.0.1:7777'
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--scenario') scenarioId = argv[++i]
  else if (argv[i] === '--app-base') appBase = argv[++i]
}

const DEMO_ROOT = process.env.DEMO_ROOT || path.join(os.tmpdir(), 'pearpost-demo')
const ROSTER_DIR = scenarioId ? path.join(DEMO_ROOT, scenarioId) : DEMO_ROOT
const ROSTER_FILE = path.join(ROSTER_DIR, 'roster.json')
mkdirSync(ROSTER_DIR, { recursive: true })

const HOME = process.env.PEARPOST_HOME || path.join(DEMO_ROOT, 'home', role)
mkdirSync(HOME, { recursive: true })
const ALIAS = process.env.PEARPOST_ALIAS || role

// Boot the real agent.
const agent = new Agent(HOME, { profile: { alias: ALIAS } })
agent.on('error', (err) => log('agent error:', err.message || err))
await agent.start()
log(`up — ${agent.address}`)

// Role->{address,...} cache, populated when the orchestrator pushes a roster
let peers = {}

// Mirror every received envelope (a) to stdout for the pane and (b) to the
// app server's /demo/event channel so the browser graph can render it as a
// real demo step. We tag mirrored events with `source: 'real'` so the UI
// can label them.
agent.on('message', (rec) => {
  const env = rec.env
  const fromRole = roleByPub(env.from) || env.from?.slice(0, 8)
  log(`◀ recv ${env.type} from ${fromRole}: ${preview(rec.body)}`)
  mirror({
    role,
    direction: 'recv',
    type: env.type,
    fromRole,
    toRole: role,
    fromAddr: env.from,
    toAddr: env.to,
    body: rec.body,
    ts: env.ts || Date.now()
  })
})

// Control HTTP server.
const ctrl = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/info') {
      return json(res, { role, address: agent.address, alias: ALIAS, peers })
    }
    if (req.method === 'POST' && req.url === '/add-contacts') {
      const { roster } = await body(req)
      const added = []
      for (const [r, info] of Object.entries(roster || {})) {
        if (r === role) continue
        try { await agent.addContact(info.address, r); added.push(r) }
        catch (err) {
          // already-a-contact / blocked are non-fatal; surface anything else
          if (!/already|blocked/i.test(err.message || '')) log('addContact', r, 'error:', err.message)
        }
      }
      peers = roster
      log(`peers ← ${added.length} (${added.join(', ')})`)
      return json(res, { ok: true, added })
    }
    if (req.method === 'POST' && req.url === '/act') {
      const { step } = await body(req)
      const result = await act(step)
      return json(res, result)
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      json(res, { ok: true })
      setTimeout(() => shutdown(0), 50)
      return
    }
    res.writeHead(404); res.end('not found')
  } catch (err) {
    log('ctrl error:', err.message)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

await new Promise((resolve) => ctrl.listen(0, '127.0.0.1', resolve))
const ctrlPort = ctrl.address().port

publishToRoster()
log(`ctrl http://127.0.0.1:${ctrlPort}  · home ${HOME}`)
log(`waiting for orchestrator…`)

process.on('SIGINT',  () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ---------- helpers ----------

async function act (step) {
  if (!step) return { ok: false, error: 'no step' }
  const toRole = step.to
  const peer = peers[toRole]
  // Some scenario nodes (humans like 'alice', 'bob') may exist as agent
  // processes too — that's fine. If a target role isn't in the roster, we
  // still mirror the envelope to the graph so the visualization is honest
  // about the gap.
  if (!peer || !peer.address) {
    mirror({
      role,
      direction: 'send-skip',
      type: step.type,
      fromRole: role,
      toRole,
      body: step.body,
      reason: 'peer not in roster'
    })
    return { ok: false, error: 'peer not in roster: ' + toRole }
  }

  const dest = peer.address
  let out
  try {
    if (step.type === 'chat') {
      out = await agent.send(dest, 'chat', step.body || {})
    } else if (step.type === 'task.request') {
      out = await agent.send(dest, 'task.request', step.body || {})
    } else if (step.type === 'task.result') {
      out = await agent.send(dest, 'task.result', step.body || {})
    } else if (step.type === 'tool.invoke') {
      out = await agent.send(dest, 'tool.invoke', step.body || {})
    } else if (step.type === 'tool.result') {
      out = await agent.send(dest, 'tool.result', step.body || {})
    } else if (step.type === 'offer') {
      out = await agent.send(dest, 'offer', step.body || {})
    } else if (step.type === 'sandbox.spawn') {
      out = await agent.send(dest, 'sandbox.spawn', step.body || {})
    } else if (step.type === 'pairing' || step.type === 'pairing.accepted' || step.type === 'contact.added') {
      // these don't have first-class envelope methods; send raw
      out = await agent.send(dest, step.type, step.body || {})
    } else if (step.type === 'presence' || step.type === 'ack') {
      // graph-only beats; mirror but don't burn a real envelope
      mirror({ role, direction: 'beat', type: step.type, fromRole: role, toRole, body: step.body })
      return { ok: true, mirrored: true }
    } else {
      out = await agent.send(dest, step.type, step.body || {})
    }
    log(`▶ send ${step.type} → ${toRole}: ${preview(step.body)}`)
    mirror({
      role,
      direction: 'send',
      type: step.type,
      fromRole: role,
      toRole,
      fromAddr: agent.address,
      toAddr: dest,
      envId: out?.id,
      body: step.body,
      ts: Date.now()
    })
    return { ok: true, envId: out?.id }
  } catch (err) {
    log(`✗ send ${step.type} → ${toRole} failed: ${err.message}`)
    return { ok: false, error: err.message }
  }
}

function publishToRoster () {
  const cur = readRoster()
  cur[role] = {
    role,
    address: agent.address,
    alias: ALIAS,
    ctrlPort,
    pid: process.pid,
    home: HOME,
    scenarioId,
    ts: Date.now()
  }
  writeRoster(cur)
}

function readRoster () {
  if (!existsSync(ROSTER_FILE)) return {}
  try { return JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) } catch { return {} }
}
function writeRoster (obj) {
  // Last write wins; concurrent agent boots are racy but this is a single
  // controller starting them in serial under tmux.
  writeFileSync(ROSTER_FILE, JSON.stringify(obj, null, 2))
}

function roleByPub (pubHex) {
  if (!pubHex) return null
  for (const [r, info] of Object.entries(peers)) {
    if (info.address && info.address.toLowerCase().includes(pubHex.toLowerCase())) return r
  }
  return null
}

function mirror (entry) {
  const payload = { source: 'real-agent', scenarioId, ...entry }
  // Best-effort post; never crash the agent on app-server hiccups.
  fetch(appBase + '/demo/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => {})
}

function preview (body) {
  if (!body) return ''
  if (typeof body === 'string') return body.slice(0, 80)
  if (body.text) return String(body.text).slice(0, 80)
  if (body.title) return String(body.title)
  try { const s = JSON.stringify(body); return s.length > 90 ? s.slice(0, 87) + '…' : s } catch { return '' }
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

function log (...args) {
  const stamp = new Date().toISOString().slice(11, 19)
  process.stdout.write(`\x1b[2m[${stamp}]\x1b[0m \x1b[1;33m[${role}]\x1b[0m ${args.join(' ')}\n`)
}

let shuttingDown = false
async function shutdown (code) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down…')
  // Hard force-exit if anything (swarm flush, hyperbee close) hangs.
  // The hyperswarm DHT teardown can dangle in some environments; we don't
  // want a stuck signal handler.
  const force = setTimeout(() => {
    log('force-exit (clean shutdown timed out)')
    process.exit(code)
  }, 4000)
  force.unref?.()
  try { ctrl.close() } catch {}
  // Remove ourselves from roster so the next demo run starts clean.
  try {
    const cur = readRoster()
    delete cur[role]
    if (Object.keys(cur).length) writeRoster(cur)
    else if (existsSync(ROSTER_FILE)) unlinkSync(ROSTER_FILE)
  } catch {}
  try { await agent.stop?.() } catch {}
  clearTimeout(force)
  process.exit(code)
}

// reference unused import to avoid lint complaints in some runtimes
void getScenario
