#!/usr/bin/env node
// PearPost demo orchestrator — drives a scenario across real agent processes.
//
// Each scenario step's `from` and `to` are role ids; this orchestrator
// resolves them via the roster file each demo-agent writes when it boots,
// then POSTs to the from-role's control port to make that real process
// emit a real envelope to the to-role's address. The browser graph is kept
// in lock-step via the app server's /demo/start + /demo/step.
//
// Usage:
//   node scripts/demo-orchestrator.mjs <scenario> [--delay <ms>] [--manual] [--app-base <url>]
//
// --manual  pauses between steps so the operator can press <enter>
// --delay   defaults to 1600ms

import http from 'http'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import readline from 'readline'

import { getScenario } from '../app/demo/scenarios.js'

const argv = process.argv.slice(2)
const scenarioId = argv[0]
if (!scenarioId) { console.error('usage: demo-orchestrator.mjs <scenario> [--delay <ms>] [--manual]'); process.exit(1) }

let delayMs = 1600
let manual = false
let appBase = process.env.APP_BASE || 'http://127.0.0.1:7777'
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--delay') delayMs = parseInt(argv[++i], 10)
  else if (argv[i] === '--manual') manual = true
  else if (argv[i] === '--app-base') appBase = argv[++i]
}

const scenario = getScenario(scenarioId)
if (!scenario) { console.error('unknown scenario:', scenarioId); process.exit(1) }

const DEMO_ROOT = process.env.DEMO_ROOT || path.join(os.tmpdir(), 'pearpost-demo')
const ROSTER_FILE = path.join(DEMO_ROOT, scenarioId, 'roster.json')

const C = process.stdout.isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', grey: '\x1b[90m', red: '\x1b[31m'
} : {}

const c = (k, s) => `${C[k] || ''}${s}${C.reset || ''}`

let interrupted = false
process.on('SIGINT',  () => { interrupted = true; console.log('\n' + c('yellow', '! interrupted — asking agents to shutdown')); teardown().catch(() => {}).finally(() => process.exit(130)) })
process.on('SIGTERM', () => { interrupted = true; teardown().catch(() => {}).finally(() => process.exit(143)) })

async function teardown () {
  let roster = {}
  try { if (existsSync(ROSTER_FILE)) roster = JSON.parse(readFileSync(ROSTER_FILE, 'utf8')) } catch {}
  const ports = Object.values(roster).map(x => x.ctrlPort).filter(Boolean)
  await Promise.all(ports.map(p =>
    postJSON(`http://127.0.0.1:${p}/shutdown`).catch(() => {})
  ))
}

main().catch(err => { console.error('orchestrator error:', err.message || err); process.exit(1) })

async function main () {
  console.log(c('bold', `▶ orchestrating ${scenario.title} (${scenario.steps.length} steps)`))
  console.log(c('dim', `  app-base ${appBase}  roster ${ROSTER_FILE}`))

  const expectedRoles = collectRolesFromScenario(scenario)
  console.log(c('dim', `  expecting roles: ${[...expectedRoles].join(', ')}`))

  const roster = await waitForRoster(expectedRoles, 45_000)
  console.log(c('green', `✓ roster ready (${Object.keys(roster).length} agents)`))

  // Push contacts so every agent can resolve every other agent's pubkey.
  await broadcastRoster(roster)
  console.log(c('green', '✓ contacts seeded'))

  // Drive the app-server scripted demo in lock-step (browser visualization).
  await postJSON(appBase + '/demo/reset')
  await postJSON(appBase + '/demo/start', { scenario: scenarioId })

  // Walk steps.
  let rl = null
  if (manual) rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  for (let i = 0; i < scenario.steps.length; i++) {
    if (interrupted) break
    const step = scenario.steps[i]
    console.log()
    console.log(`${c('green', 'STEP ' + String(i + 1).padStart(2))} ${c('cyan', step.type)} ${c('bold', step.from)} → ${c('bold', step.to)}`)
    if (step.title)   console.log('       ' + c('bold', step.title))
    if (step.caption) console.log('       ' + c('dim', step.caption))

    // Visualization advance (scripted scenario in browser).
    await postJSON(appBase + '/demo/step').catch(() => {})

    // Real action: tell the from-role agent to emit the envelope.
    const fromInfo = roster[step.from]
    if (!fromInfo?.ctrlPort) {
      console.log(c('red', `       ! no agent for role "${step.from}" — skipping real send`))
    } else {
      const r = await postJSON(`http://127.0.0.1:${fromInfo.ctrlPort}/act`, { step }).catch(err => ({ ok: false, error: err.message }))
      if (r.ok) {
        console.log(c('grey', `       envelope sent (id ${r.envId ? r.envId.slice(0, 12) : '—'})`))
      } else if (r.mirrored) {
        console.log(c('grey', `       beat mirrored to graph (no envelope)`))
      } else {
        console.log(c('red', `       ! send failed: ${r.error}`))
      }
    }

    if (manual) {
      await new Promise(resolve => rl.question(c('dim', '       [enter] for next step…'), () => resolve()))
    } else if (i < scenario.steps.length - 1) {
      await sleep(delayMs)
    }
  }

  if (rl) rl.close()
  console.log()
  console.log(c('green', '✓ scenario complete'))
}

function collectRolesFromScenario (sc) {
  const set = new Set()
  for (const n of sc.nodes || []) set.add(n.id)
  for (const s of sc.steps || []) { if (s.from) set.add(s.from); if (s.to) set.add(s.to) }
  return set
}

async function waitForRoster (expected, timeoutMs) {
  // Soft-wait: try to get every expected role, but proceed after timeout
  // with whatever's there. Steps targeting missing roles are mirrored to
  // the graph by the agent's act() handler instead of failing the run.
  const deadline = Date.now() + timeoutMs
  let last = {}
  while (Date.now() < deadline) {
    if (existsSync(ROSTER_FILE)) {
      try {
        last = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'))
        const have = new Set(Object.keys(last))
        const missing = [...expected].filter(x => !have.has(x))
        if (missing.length === 0) {
          process.stdout.write('\r' + ' '.repeat(70) + '\r')
          return last
        }
        process.stdout.write(`\r${c('dim', `  waiting on: ${missing.join(', ')}…`)}      `)
      } catch {}
    }
    await sleep(800)
  }
  process.stdout.write('\r' + ' '.repeat(70) + '\r')
  const have = new Set(Object.keys(last))
  const missing = [...expected].filter(x => !have.has(x))
  if (missing.length) {
    console.log(c('yellow', `! proceeding without: ${missing.join(', ')} (steps targeting them will mirror-only)`))
  }
  return last
}

async function broadcastRoster (roster) {
  const ports = Object.values(roster).map(x => x.ctrlPort).filter(Boolean)
  await Promise.all(ports.map(p =>
    postJSON(`http://127.0.0.1:${p}/add-contacts`, { roster }).catch(err => {
      console.warn('add-contacts on port', p, 'failed:', err.message)
    })
  ))
}

function postJSON (url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : ''
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
    }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode} ${buf}`))
        try { resolve(buf ? JSON.parse(buf) : {}) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(data); req.end()
  })
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }
