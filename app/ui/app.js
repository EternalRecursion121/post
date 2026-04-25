// PearPost UI — vanilla JS, talks to the local backend over fetch + SSE.
// Three panes: contacts/rooms (left), agent graph (middle), thread/peer (right).

import { Graph } from '/graph.js'

const state = {
  me: null,                       // /me payload
  records: [],                    // all envelopes we know about
  pulses: [],                     // visual ripples on edges, time-bound
  selectedThread: null,           // root envelope id
  selectedPeer: null              // contact pubkey (hex)
}

const els = {
  meAlias: document.getElementById('me-alias'),
  meAddr: document.getElementById('me-addr'),
  contacts: document.getElementById('contacts'),
  rooms: document.getElementById('rooms'),
  capabilities: document.getElementById('capabilities'),
  rightEmpty: document.getElementById('right-empty'),
  rightThread: document.getElementById('right-thread'),
  rightPeer: document.getElementById('right-peer'),
  messages: document.getElementById('messages'),
  threadWithAlias: document.getElementById('thread-with-alias'),
  threadWithAddr: document.getElementById('thread-with-addr'),
  peerAlias: document.getElementById('peer-alias'),
  peerAddr: document.getElementById('peer-addr'),
  peerBlurb: document.getElementById('peer-blurb'),
  peerTools: document.getElementById('peer-tools'),
  peerThreads: document.getElementById('peer-threads'),
  composerType: document.getElementById('composer-type'),
  composerText: document.getElementById('composer-text'),
  composer: document.getElementById('composer'),
  back: document.getElementById('back'),
  graph: document.getElementById('graph')
}

const graph = new Graph(els.graph, {
  onNodeClick: (node) => openPeer(node.id),
  onEdgeClick: (edge) => openThread(edge),
  isMe: (id) => state.me && id === state.me.pubHex
})

init().catch(err => console.error(err))

async function init () {
  state.me = await fetch('/me').then(r => r.json())
  els.meAlias.textContent = state.me.alias || '(you)'
  els.meAddr.textContent = state.me.address
  els.meAddr.onclick = () => navigator.clipboard.writeText(state.me.address)

  state.records = await fetch('/messages?limit=500').then(r => r.json())
  rebuildGraph()
  renderContacts()
  renderRooms()
  renderCapabilities()

  const ev = new EventSource('/events')
  ev.onmessage = (e) => {
    const d = JSON.parse(e.data)
    if (d.kind === 'message') {
      state.records.push(d.record)
      pulse(d.record)
      rebuildGraph()
      if (state.selectedThread) renderThread()
    } else if (d.kind === 'peer') {
      refreshMe()
    }
  }

  document.getElementById('add-form').onsubmit = async (e) => {
    e.preventDefault()
    const address = document.getElementById('add-addr').value.trim()
    const alias = document.getElementById('add-alias').value.trim()
    if (!address) return
    await fetch('/contacts/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, alias }) })
    document.getElementById('add-addr').value = ''
    document.getElementById('add-alias').value = ''
    refreshMe()
  }
  document.getElementById('room-new-form').onsubmit = async (e) => {
    e.preventDefault()
    const name = document.getElementById('room-new-name').value.trim()
    const room = await fetch('/room/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then(r => r.json())
    document.getElementById('room-new-name').value = ''
    await navigator.clipboard.writeText(room.share)
    flash('room created — share copied to clipboard')
    refreshMe()
  }
  document.getElementById('room-join-form').onsubmit = async (e) => {
    e.preventDefault()
    const share = document.getElementById('room-join-share').value.trim()
    if (!share) return
    await fetch('/room/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ share }) })
    document.getElementById('room-join-share').value = ''
    refreshMe()
  }
  els.composer.onsubmit = async (e) => {
    e.preventDefault()
    if (!state.selectedThread) return
    const root = state.records.find(r => r.env.id === state.selectedThread.rootId)
    if (!root) return
    const text = els.composerText.value
    if (!text) return
    const type = els.composerType.value
    let body
    if (type === 'chat') body = { text }
    else if (type === 'tool.invoke') {
      const [name, ...rest] = text.split(/\s+/)
      let args = {}; try { args = JSON.parse(rest.join(' ') || '{}') } catch {}
      body = { name, args }
    } else body = { text }
    await sendInThread(root, type, body)
    els.composerText.value = ''
  }
  els.back.onclick = closeRight
  document.querySelectorAll('.back-peer').forEach(b => b.onclick = closeRight)
}

async function refreshMe () {
  state.me = await fetch('/me').then(r => r.json())
  renderContacts(); renderRooms(); renderCapabilities()
  rebuildGraph()
}

function renderContacts () {
  els.contacts.innerHTML = ''
  for (const c of state.me.contacts) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="name">${esc(c.alias || '(unnamed)')}</span><span class="addr">${c.pubkey.slice(0,10)}…</span>`
    li.onclick = () => openPeer(c.pubkey)
    els.contacts.appendChild(li)
  }
}

function renderRooms () {
  els.rooms.innerHTML = ''
  for (const r of state.me.rooms) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="name">${esc(r.name || '(unnamed)')}</span><span class="addr">${r.id.slice(0,10)}…</span>`
    li.title = 'click to copy share-link'
    li.onclick = () => { navigator.clipboard.writeText(r.share); flash('share copied') }
    els.rooms.appendChild(li)
  }
}

function renderCapabilities () {
  els.capabilities.innerHTML = ''
  for (const c of state.me.capabilities || []) {
    const li = document.createElement('li')
    li.textContent = c
    els.capabilities.appendChild(li)
  }
  if (!els.capabilities.childElementCount) {
    const li = document.createElement('li')
    li.textContent = '(none registered)'
    els.capabilities.appendChild(li)
  }
}

// Build nodes + edges out of records and feed the graph.
function rebuildGraph () {
  const nodes = new Map()
  const edges = new Map() // edgeKey -> { count, lastTs, types: Set, room? }

  // me node
  nodes.set(state.me.pubHex, { id: state.me.pubHex, label: state.me.alias || 'me', kind: 'you' })
  // contact nodes
  for (const c of state.me.contacts) {
    if (!nodes.has(c.pubkey)) nodes.set(c.pubkey, { id: c.pubkey, label: c.alias || c.pubkey.slice(0,8), kind: 'peer' })
  }
  // room hyper-nodes
  for (const r of state.me.rooms) {
    nodes.set('room:' + r.id, { id: 'room:' + r.id, label: r.name || ('room ' + r.id.slice(0,6)), kind: 'room' })
  }

  for (const rec of state.records) {
    const e = rec.env
    if (!nodes.has(e.from)) nodes.set(e.from, { id: e.from, label: e.from.slice(0,8), kind: 'peer' })

    // direct edge
    if (e.to && /^[0-9a-f]{64}$/i.test(e.to)) {
      const a = e.from, b = e.to
      const key = a < b ? a + '|' + b : b + '|' + a
      const edge = edges.get(key) || { a, b, count: 0, lastTs: 0, types: new Set() }
      edge.count++
      edge.lastTs = Math.max(edge.lastTs, e.ts)
      edge.types.add(e.type)
      edges.set(key, edge)
      if (!nodes.has(b)) nodes.set(b, { id: b, label: b.slice(0,8), kind: 'peer' })
    } else if (e.to && e.to.startsWith('room:')) {
      const a = e.from, b = e.to
      const key = a + '|' + b
      const edge = edges.get(key) || { a, b, count: 0, lastTs: 0, types: new Set() }
      edge.count++
      edge.lastTs = Math.max(edge.lastTs, e.ts)
      edge.types.add(e.type)
      edges.set(key, edge)
    }
  }

  graph.update([...nodes.values()], [...edges.values()].map(e => ({
    a: e.a, b: e.b, count: e.count, lastTs: e.lastTs, types: [...e.types]
  })))
}

function pulse (rec) {
  const e = rec.env
  const a = e.from
  const b = e.to
  graph.pulse(a, b)
}

function openThread (edge) {
  // Find the most recent root envelope on this edge.
  const recs = state.records.filter(r => onEdge(r.env, edge))
  if (!recs.length) return
  // Treat the oldest record without inReplyTo as the root.
  const root = recs.find(r => !r.env.inReplyTo) || recs[0]
  state.selectedThread = { rootId: root.env.id, edge }
  els.rightEmpty.hidden = true
  els.rightPeer.hidden = true
  els.rightThread.hidden = false
  const otherId = otherEnd(edge)
  const other = state.me.contacts.find(c => c.pubkey === otherId)
  els.threadWithAlias.textContent = otherId.startsWith('room:')
    ? labelForRoom(otherId.slice(5))
    : (other?.alias || otherId.slice(0,12))
  els.threadWithAddr.textContent = otherId
  renderThread()
}

function renderThread () {
  if (!state.selectedThread) return
  const { edge } = state.selectedThread
  const recs = state.records
    .filter(r => onEdge(r.env, edge))
    .sort((a, b) => a.env.ts - b.env.ts)
  els.messages.innerHTML = ''
  // Pair tool.invoke with their tool.result
  const consumed = new Set()
  for (const rec of recs) {
    if (consumed.has(rec.env.id)) continue
    const e = rec.env
    if (e.type === 'tool.invoke') {
      const reply = recs.find(x => x.env.inReplyTo === e.id && x.env.type === 'tool.result')
      if (reply) consumed.add(reply.env.id)
      els.messages.appendChild(renderToolPair(rec, reply))
    } else if (e.type === 'tool.result' && e.inReplyTo && recs.find(x => x.env.id === e.inReplyTo)) {
      // Will be picked up by its invoke pair
      continue
    } else {
      els.messages.appendChild(renderMessage(rec))
    }
  }
  els.messages.scrollTop = els.messages.scrollHeight
}

function renderMessage (rec) {
  const div = document.createElement('div')
  div.className = 'msg ' + (isMine(rec.env) ? 'me' : 'them')
  const t = new Date(rec.env.ts).toLocaleTimeString()
  let body
  if (rec.env.type === 'chat') body = `<pre>${esc(rec.body.text || '')}</pre>`
  else body = `<pre>${esc(JSON.stringify(rec.body, null, 2))}</pre>`
  div.innerHTML = `<div class="meta"><span class="type">${rec.env.type}</span><span>${t}</span></div>${body}`
  return div
}

function renderToolPair (req, res) {
  const div = document.createElement('div')
  div.className = 'msg tool ' + (isMine(req.env) ? 'me' : 'them')
  const t = new Date(req.env.ts).toLocaleTimeString()
  const reqBody = `${esc(req.body.name)}(${esc(JSON.stringify(req.body.args || {}))})`
  let resBody
  if (!res) resBody = `<div class="res pulse">awaiting…</div>`
  else if (res.body.ok) resBody = `<div class="res ok">→ ${esc(JSON.stringify(res.body.value))}</div>`
  else resBody = `<div class="res err">! ${esc(res.body.error)}</div>`
  div.innerHTML = `
    <div class="meta"><span class="type">tool</span><span>${t}</span></div>
    <div class="pair">
      <div class="req">${reqBody}</div>
      ${resBody}
    </div>`
  return div
}

function openPeer (pub) {
  if (pub.startsWith('room:')) {
    // Treat clicking a room node as opening the room thread.
    const fakeEdge = { a: state.me.pubHex, b: pub }
    return openThread(fakeEdge)
  }
  state.selectedPeer = pub
  els.rightEmpty.hidden = true
  els.rightThread.hidden = true
  els.rightPeer.hidden = false
  const c = state.me.contacts.find(x => x.pubkey === pub) || { pubkey: pub, alias: '', blurb: '', capabilities: [] }
  els.peerAlias.textContent = c.alias || pub.slice(0,12)
  els.peerAddr.textContent = pub
  els.peerBlurb.textContent = c.blurb || ''
  els.peerTools.innerHTML = ''
  for (const tool of c.capabilities || []) {
    const li = document.createElement('li')
    li.textContent = tool
    els.peerTools.appendChild(li)
  }
  if (!els.peerTools.childElementCount) {
    const li = document.createElement('li'); li.textContent = '(none advertised)'
    els.peerTools.appendChild(li)
  }
  // List threads on this edge
  els.peerThreads.innerHTML = ''
  const li = document.createElement('li')
  li.textContent = 'open thread →'
  li.onclick = () => openThread({ a: state.me.pubHex, b: pub })
  els.peerThreads.appendChild(li)
}

function closeRight () {
  state.selectedThread = null
  state.selectedPeer = null
  els.rightThread.hidden = true
  els.rightPeer.hidden = true
  els.rightEmpty.hidden = false
}

async function sendInThread (root, type, body) {
  const otherId = otherEnd(state.selectedThread.edge)
  if (otherId.startsWith('room:')) {
    const id = otherId.slice('room:'.length)
    return fetch('/room/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, type, body }) })
  }
  if (type === 'tool.invoke') {
    return fetch('/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: otherId, tool: body.name, args: body.args }) })
  }
  return fetch('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: otherId, type, body, inReplyTo: root.env.id }) })
}

function onEdge (env, edge) {
  const dest = env.to
  const a = env.from
  return (a === edge.a && dest === edge.b) || (a === edge.b && dest === edge.a)
}

function otherEnd (edge) {
  return edge.a === state.me.pubHex ? edge.b : edge.a
}

function isMine (env) { return env.from === state.me.pubHex }

function labelForRoom (id) {
  const r = state.me.rooms.find(x => x.id === id)
  return r?.name || ('room ' + id.slice(0, 6))
}

function esc (s) { return String(s ?? '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c])) }

function flash (msg) {
  const div = document.createElement('div')
  div.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1d2130;border:1px solid #262a38;color:#6ee7b7;padding:8px 14px;border-radius:6px;font-size:12px;z-index:1000;'
  div.textContent = msg
  document.body.appendChild(div)
  setTimeout(() => div.remove(), 1800)
}
