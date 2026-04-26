#!/usr/bin/env node
// PearPost demo runner — theatrical CLI for the scripted scenarios.
//
// All commands hit the local app server (PEARPOST_PORT or 7777). The runner
// only orchestrates: every event the renderer sees comes from the backend's
// /demo/* endpoints, broadcast over SSE. So whatever you see here also shows
// up in the browser graph and timeline.
//
// Usage:
//   node scripts/demo-runner.mjs list
//   node scripts/demo-runner.mjs start skyscanner
//   node scripts/demo-runner.mjs step
//   node scripts/demo-runner.mjs run skyscanner --delay 1600
//   node scripts/demo-runner.mjs reset
//   node scripts/demo-runner.mjs say "<text>"           // inject custom event
//   node scripts/demo-runner.mjs follow <agent-id>      // narrate one agent
//
// Environment:
//   PEARPOST_PORT   server port (default 7777)
//   PEARPOST_HOST   server host (default 127.0.0.1)
//   NO_COLOR        disable ANSI colour output

import http from 'http'

const HOST = process.env.PEARPOST_HOST || '127.0.0.1'
const PORT = parseInt(process.env.PEARPOST_PORT || '7777', 10)
const BASE = `http://${HOST}:${PORT}`
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY

const C = {
  reset:  USE_COLOR ? '\x1b[0m'  : '',
  dim:    USE_COLOR ? '\x1b[2m'  : '',
  bold:   USE_COLOR ? '\x1b[1m'  : '',
  green:  USE_COLOR ? '\x1b[32m' : '',
  cyan:   USE_COLOR ? '\x1b[36m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  magenta:USE_COLOR ? '\x1b[35m' : '',
  blue:   USE_COLOR ? '\x1b[34m' : '',
  red:    USE_COLOR ? '\x1b[31m' : '',
  grey:   USE_COLOR ? '\x1b[90m' : ''
}

const TYPE_COLOUR = {
  chat:               C.green,
  pairing:            C.magenta,
  'pairing.accepted': C.magenta,
  'contact.added':    C.green,
  'task.request':     C.yellow,
  'task.result':      C.yellow,
  'tool.invoke':      C.cyan,
  'tool.result':      C.cyan,
  'sandbox.spawn':    C.magenta,
  offer:              C.yellow,
  presence:           C.grey,
  ack:                C.grey
}

function colourFor (type) { return TYPE_COLOUR[type] || C.cyan }
function fmt (label, msg, colour = C.cyan) {
  return `${colour}${label.padEnd(7)}${C.reset} ${msg}`
}

const [, , cmd = 'help', ...rest] = process.argv

main().catch(err => {
  console.error(C.red + 'error: ' + (err.message || err) + C.reset)
  process.exit(1)
})

async function main () {
  switch (cmd) {
    case 'list':    return cmdList()
    case 'start':   return cmdStart(rest[0])
    case 'step':    return cmdStep(rest)
    case 'run':     return cmdRun(rest)
    case 'reset':   return cmdReset()
    case 'state':   return cmdState()
    case 'say':     return cmdSay(rest)
    case 'follow':  return cmdFollow(rest[0])
    case 'help': case '-h': case '--help': return printHelp()
    default:
      console.error('unknown command:', cmd)
      printHelp()
      process.exit(1)
  }
}

function printHelp () {
  process.stdout.write(`pearpost demo-runner — drive scripted scenarios

  list                            list available scenarios
  start <id>                      start (and reset) a scenario
  step                            advance one step
  run <id> [--delay <ms>]         start and run all steps with delay
  reset                           clear demo state
  state                           print current state
  say <text>                      inject a custom event into the timeline
  follow <agent-id>               stream events filtered to one agent

server:  ${BASE}
`)
}

async function cmdList () {
  const list = await getJSON('/demo/scenarios')
  console.log(C.bold + 'scenarios' + C.reset)
  for (let i = 0; i < list.length; i++) {
    const s = list[i]
    console.log(`  ${C.cyan}${i + 1}${C.reset} ${C.bold}${s.id.padEnd(12)}${C.reset} ${C.dim}${s.track}${C.reset}  ${s.title}`)
    console.log(`    ${C.dim}${s.subtitle}${C.reset}`)
    console.log(`    ${C.dim}${s.steps} steps · ${s.nodes} nodes${C.reset}`)
  }
}

async function cmdStart (id) {
  if (!id) { console.error('usage: start <scenario-id>'); process.exit(1) }
  const r = await postJSON('/demo/start', { scenario: id })
  if (!r.ok) { console.error(C.red + (r.error || 'start failed') + C.reset); process.exit(1) }
  console.log(fmt('START', `scenario=${C.bold}${id}${C.reset} steps=${r.steps}`, C.green))
  await streamUntil((ev) => ev.type === 'scenario.start')
}

async function cmdStep () {
  const r = await postJSON('/demo/step')
  if (r.ok === false && r.done) { console.log(fmt('END', 'scenario complete', C.green)); return }
  if (!r.ok) { console.error(C.red + (r.error || 'step failed') + C.reset); process.exit(1) }
  // Wait for the corresponding step event so we can render it cleanly
  await streamUntil((ev) => ev.type === 'step' && ev.index === r.index)
}

async function cmdRun (args) {
  let id, delay = 1600
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delay') { delay = parseInt(args[++i], 10) }
    else if (!id) id = args[i]
  }
  if (id) await cmdStart(id)
  await postJSON('/demo/run', { delayMs: delay })
  console.log(fmt('RUN', `delay=${delay}ms`, C.green))
  // stream until backend stops emitting steps for >5s
  await streamWhileBusy()
}

async function cmdReset () {
  await postJSON('/demo/reset')
  console.log(fmt('RESET', 'demo state cleared', C.green))
}

async function cmdState () {
  const s = await getJSON('/demo/state')
  console.log(JSON.stringify(s, null, 2))
}

async function cmdSay (args) {
  const text = args.join(' ').trim()
  if (!text) { console.error('usage: say "<text>"'); process.exit(1) }
  await postJSON('/demo/event', { kind: 'cli', text })
  console.log(fmt('SAY', text, C.cyan))
}

async function cmdFollow (agentId) {
  if (!agentId) { console.error('usage: follow <agent-id>'); process.exit(1) }
  console.log(fmt('FOLLOW', `streaming events for ${C.bold}${agentId}${C.reset}`, C.cyan))
  await streamForever((ev) => {
    if (ev.type === 'step') {
      const s = ev.step
      if (s.from === agentId || s.to === agentId) renderStep(ev.index, s)
    }
  })
}

// -------- SSE streaming helpers --------

function streamUntil (matcher, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/events`, { method: 'GET' })
    let buf = ''
    let timeout = null
    if (opts.timeoutMs) {
      timeout = setTimeout(() => { req.destroy(); resolve() }, opts.timeoutMs)
    }
    req.on('response', (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode))
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            const json = line.slice(5).trim(); if (!json) continue
            let d; try { d = JSON.parse(json) } catch { continue }
            if (d.kind !== 'demo') continue
            const ev = d.event
            renderEvent(ev)
            if (matcher(ev)) {
              if (timeout) clearTimeout(timeout)
              req.destroy(); return resolve(ev)
            }
          }
        }
      })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function streamForever (onDemoEvent) {
  return new Promise((_, reject) => {
    const req = http.request(`${BASE}/events`, { method: 'GET' })
    let buf = ''
    req.on('response', (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode))
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            const json = line.slice(5).trim(); if (!json) continue
            let d; try { d = JSON.parse(json) } catch { continue }
            if (d.kind === 'demo') onDemoEvent(d.event)
          }
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function streamWhileBusy () {
  // Heuristic: stop when we haven't seen a `step` for 6s.
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/events`, { method: 'GET' })
    let buf = ''
    let idleTimer = setTimeout(end, 6000)
    function end () { try { req.destroy() } catch {} resolve() }
    function bump () { clearTimeout(idleTimer); idleTimer = setTimeout(end, 6000) }
    req.on('response', (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE status ' + res.statusCode))
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue
            const json = line.slice(5).trim(); if (!json) continue
            let d; try { d = JSON.parse(json) } catch { continue }
            if (d.kind !== 'demo') continue
            const ev = d.event
            renderEvent(ev)
            if (ev.type === 'step') bump()
          }
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function renderEvent (ev) {
  if (ev.type === 'reset') return console.log(fmt('RESET', 'demo state cleared', C.grey))
  if (ev.type === 'scenario.start') {
    return console.log(fmt('SCENE', `${C.bold}${ev.scenario.title}${C.reset} ${C.dim}(${ev.scenario.stepCount} steps)${C.reset}`, C.green))
  }
  if (ev.type === 'step') return renderStep(ev.index, ev.step)
  if (ev.type === 'custom') return console.log(fmt('SAY', JSON.stringify(ev.payload), C.cyan))
}

function renderStep (idx, step) {
  const colour = colourFor(step.type)
  const route  = `${C.bold}${step.from}${C.reset}${C.dim} → ${C.reset}${C.bold}${step.to}${C.reset}`
  const label  = `STEP ${String(idx + 1).padStart(2)}`
  console.log(`${C.green}${label}${C.reset} ${colour}${(step.type || '').padEnd(14)}${C.reset} ${route}`)
  if (step.title)   console.log(`        ${C.bold}${step.title}${C.reset}`)
  if (step.caption) console.log(`        ${C.dim}${step.caption}${C.reset}`)
  if (step.cmd)     console.log(`        ${C.cyan}$ ${step.cmd}${C.reset}`)
  if (step.why)     console.log(`        ${C.yellow}why:${C.reset} ${C.dim}${step.why}${C.reset}`)
}

// -------- HTTP helpers --------

function getJSON (path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try { resolve(JSON.parse(buf || 'null')) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function postJSON (path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : ''
    const req = http.request(`${BASE}${path}`, {
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
