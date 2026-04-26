// BotCom — P2P Travel Agents (Skyscanner × Pears × JetBrains HackUPC)
//
// Single source of truth: `state.view = { kind, target }`. The right sheet
// renders exactly one of: empty, thread, peer. No `[hidden]` toggling.
//
// Talks to the local backend over fetch + SSE. Only chat is composed by
// humans; tool/task envelopes are observed in the graph and thread but
// never initiated from the UI.

import { Graph } from '/graph.js'

const state = {
  me: null,
  records: [],
  presence: {},                  // pubHex -> { state, lastSeen }
  delivered: new Set(),          // env.id of envelopes confirmed delivered
  acked: new Set(),              // env.id of envelopes acked by recipient
  tasks: new Map(),              // task root id -> { id, status, title, ... }
  view: { kind: 'empty', target: null },
  replyingTo: null,
  replyToPreview: '',
  filters: { chat: true, tool: true, task: true, presence: true },
  unread: new Map(),             // pubHex/room-id -> count
  swarmPeerCount: 0,
  cmd: { open: false, query: '', active: 0, items: [] }
}

function el (id) { return document.getElementById(id) }

const graph = new Graph(el('graph'), {
  onNodeClick: (n, ev) => {
    if (ev && ev.shiftKey) openPeer(n.id)
    else openThread(n.id)
  },
  onEdgeClick: (e) => openThread(e.a === state.me?.pubHex ? e.b : e.a),
  onEdgeHover: (e, pos) => showEdgeTooltip(e, pos),
  isMe: (id) => state.me && id === state.me.pubHex,
  isSelected: (id) => state.view.target === id,
  presenceFor: (id) => state.presence[id]?.state,
  filters: state.filters
})

init().catch(err => { console.error(err); toast('init error: ' + err.message) })

async function init () {
  state.me = await fetch('/me').then(r => r.json())
  for (const t of state.me.tasks || []) recordTask(t)
  state.presence = state.me.presence || {}

  state.records = await fetch('/messages?limit=500').then(r => r.json())
  for (const rec of state.records) {
    if (rec.env.type === 'ack' && rec.body?.for) state.acked.add(rec.body.for)
  }
  rebuildGraph()
  renderTopStrip()
  renderRail()
  renderRightSheet()
  startClock()

  const ev = new EventSource('/events')
  ev.onmessage = (e) => {
    const d = JSON.parse(e.data)
    if (d.kind === 'message') {
      state.records.push(d.record)
      const env = d.record.env
      if (env.type === 'ack' && d.record.body?.for) state.acked.add(d.record.body.for)
      pulse(d.record)
      bumpUnread(d.record)
      rebuildGraph()
      maybeRenderThread()
      renderRail()
    } else if (d.kind === 'peer') {
      refreshMe()
    } else if (d.kind === 'presence') {
      state.presence[d.presence.pubkey] = { state: d.presence.state, lastSeen: d.presence.ts, capabilities: d.presence.capabilities || [] }
      renderRail()
      renderTopStrip()
      graph.requestRedraw()
    } else if (d.kind === 'delivered') {
      state.delivered.add(d.delivered.id)
      maybeRenderThread()
    } else if (d.kind === 'task') {
      recordTask(d.task)
      renderRail()
      rebuildGraph()
    }
  }

  // graph filter chips
  for (const chip of document.querySelectorAll('#graph-filters .chip')) {
    chip.onclick = () => {
      const k = chip.dataset.filter
      state.filters[k] = !state.filters[k]
      chip.classList.toggle('on', state.filters[k])
      graph.setFilters(state.filters)
    }
  }

  // journeys pill: focus the rail
  // explorations pill: focus the rail
  el('tasks-pill').onclick = () => {
    el('task-tray').scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  // me-addr copy
  el('me-addr').onclick = () => {
    if (!state.me) return
    navigator.clipboard.writeText(state.me.address)
    toast('agent ID copied')
  }

  document.addEventListener('keydown', onGlobalKey)
}

async function refreshMe () {
  state.me = await fetch('/me').then(r => r.json())
  for (const t of state.me.tasks || []) recordTask(t)
  state.presence = { ...state.presence, ...(state.me.presence || {}) }
  renderTopStrip()
  renderRail()
  rebuildGraph()
}

// ---------- top strip ----------

function renderTopStrip () {
  if (!state.me) return
  el('me-alias').textContent = state.me.alias || '(you)'
  el('me-addr').textContent = truncAddr(state.me.address)
  el('me-addr').title = state.me.address + '\nclick to copy'
  const caps = (state.me.capabilities || []).slice(0, 4)
  el('me-caps').innerHTML = caps.length ? `<b>caps:</b> ${caps.map(esc).join(' · ')}` : ''

  const onlinePeers = Object.values(state.presence).filter(p => p.state === 'online').length
  state.swarmPeerCount = onlinePeers
  const dht = el('dht-status')
  dht.classList.remove('ok', 'warn')
  if (onlinePeers >= 1) {
    dht.classList.add('ok')
    dht.querySelector('.lbl').textContent = `P2P · ${onlinePeers} agent${onlinePeers === 1 ? '' : 's'} online`
  } else if ((state.me.contacts || []).length) {
    dht.classList.add('warn')
    dht.querySelector('.lbl').textContent = 'P2P · no agents online'
  } else {
    dht.querySelector('.lbl').textContent = 'P2P · idle'
  }

  const active = [...state.tasks.values()].filter(t => ['progress','pending','accepted'].includes(t.status)).length
  el('tasks-n').textContent = active
}

function startClock () {
  const tick = () => {
    const d = new Date()
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mm = String(d.getUTCMinutes()).padStart(2, '0')
    const ss = String(d.getUTCSeconds()).padStart(2, '0')
    el('clock').textContent = `${hh}:${mm}:${ss} UTC`
  }
  tick(); setInterval(tick, 1000)
}

// ---------- left rail ----------

function renderRail () {
  if (!state.me) return

  // agents (contacts)
  const contactsEl = el('contacts'); contactsEl.innerHTML = ''
  el('contacts-count').textContent = state.me.contacts.length
  for (const c of state.me.contacts) {
    const presence = state.presence[c.pubkey]?.state || 'unknown'
    const li = document.createElement('li')
    li.className = 'row contact' + (state.view.target === c.pubkey ? ' selected' : '')
    li.innerHTML = `
      <i class="pres ${presence}" title="${presence}"></i>
      <span class="name">${esc(c.alias || '(unnamed)')}</span>
      <span class="addr">${esc(short(c.pubkey))}</span>
    `
    const u = state.unread.get(c.pubkey) || 0
    if (u > 0) {
      const b = document.createElement('span'); b.className = 'badge'; b.textContent = u
      li.querySelector('.addr').replaceWith(b)
    }
    li.title = `${c.alias || '(unnamed)'} — ${c.pubkey}\nclick: open channel • shift-click / right-click: agent profile`
    li.onclick = (e) => e.shiftKey ? openPeer(c.pubkey) : openThread(c.pubkey)
    li.oncontextmenu = (e) => { e.preventDefault(); openPeer(c.pubkey) }
    contactsEl.appendChild(li)
  }

  // trips (rooms)
  const roomsEl = el('rooms'); roomsEl.innerHTML = ''
  el('rooms-count').textContent = state.me.rooms.length
  for (const r of state.me.rooms) {
    const target = 'room:' + r.id
    const li = document.createElement('li')
    li.className = 'row room' + (state.view.target === target ? ' selected' : '')
    const u = state.unread.get(target) || 0
    li.innerHTML = `
      <i class="pres" title="destination"></i>
      <span class="name">${esc(r.name || '(unnamed)')}</span>
      <span class="addr">${esc(short(r.id))}</span>
    `
    if (u > 0) {
      const b = document.createElement('span'); b.className = 'badge'; b.textContent = u
      li.querySelector('.addr').replaceWith(b)
    }
    li.title = `${r.name || '(unnamed)'} — ${r.id}\nclick: open • right-click: copy invite link`
    li.onclick = () => openThread(target)
    li.oncontextmenu = (e) => { e.preventDefault(); navigator.clipboard.writeText(r.share); toast('destination invite link copied') }
    roomsEl.appendChild(li)
  }

  // journeys (tasks)
  const trayEl = el('task-tray'); trayEl.innerHTML = ''
  syncTasksFromRecords()
  const roots = [...state.tasks.values()].filter(t => !t.parent || !state.tasks.has(t.parent))
  el('tasks-count').textContent = state.tasks.size
  if (!roots.length) {
    const li = document.createElement('li')
    li.style.cssText = 'color:var(--text-muted);padding:4px 12px;font-size:11px;cursor:default;display:block'
    li.textContent = '— no active explorations —'
    trayEl.appendChild(li)
  } else {
    for (const t of roots) renderTaskBranch(trayEl, t, 0)
  }
  renderTopStrip()
}

function renderTaskBranch (parent, t, depth) {
  const li = document.createElement('li')
  li.className = `task-row depth-${Math.min(depth,3)} status-${t.status || 'pending'}`
  const dest = (t.to || '').slice(0, 8)
  const elapsed = t.createdAt ? formatElapsed(Date.now() - t.createdAt) : ''
  li.innerHTML = `
    <i class="pill"></i>
    <span class="title">${esc(t.title || '(no-title)')}</span>
    <span class="dest">→${esc(dest)}…</span>
    <span class="elapsed">${esc(elapsed)}</span>
  `
  if (t.to) li.onclick = () => openThread(t.to)
  parent.appendChild(li)
  for (const cid of t.children || []) {
    const child = state.tasks.get(cid)
    if (child) renderTaskBranch(parent, child, depth + 1)
  }
}

// ---------- right sheet ----------

function renderRightSheet () {
  const sheet = el('right-sheet')
  sheet.innerHTML = ''
  let view
  if (state.view.kind === 'thread') view = renderThreadView(state.view.target)
  else if (state.view.kind === 'peer') view = renderPeerView(state.view.target)
  else view = renderEmptyView()
  view.classList.add('sheet-view')
  sheet.appendChild(view)
}

function renderEmptyView () {
  const wrap = document.createElement('div')
  wrap.className = 'empty-view'
  wrap.innerHTML = `
    <div class="lede">
      <b>where to next?</b> select a destination or agent.
      <span class="sub">AI travel agents · peer-to-peer · no central server</span>
    </div>
    <div class="quick" data-q="add">
      <span class="label">add a travel agent</span>
      <span class="kbd">⌘K · /add</span>
    </div>
    <div class="quick" data-q="room">
      <span class="label">explore a destination</span>
      <span class="kbd">⌘K · /destination</span>
    </div>
    <div class="quick" data-q="copy">
      <span class="label">copy your agent ID</span>
      <span class="kbd">click logo above</span>
    </div>
  `
  wrap.querySelector('[data-q="add"]').onclick = () => openPalette('/add ')
  wrap.querySelector('[data-q="room"]').onclick = () => openPalette('/destination ')
  wrap.querySelector('[data-q="copy"]').onclick = () => {
    if (!state.me) return
    navigator.clipboard.writeText(state.me.address); toast('agent ID copied')
  }
  return wrap
}

function renderThreadView (target) {
  const wrap = document.createElement('div')
  const isRoom = target.startsWith('room:')
  const presence = isRoom ? 'room' : (state.presence[target]?.state || 'unknown')
  const aliasFor = isRoom
    ? labelForRoom(target.slice(5))
    : (state.me.contacts.find(c => c.pubkey === target)?.alias || short(target))

  const header = document.createElement('div')
  header.className = 'sheet-h'
  header.innerHTML = `
    <button class="back" title="close">◀</button>
    <i class="pres ${presence}"></i>
    <span class="alias">${esc(aliasFor)}</span>
    <button class="menu" title="more">⋯</button>
    <span class="addr" title="click to copy">${esc(target)}</span>
  `
  header.querySelector('.back').onclick = closeRight
  header.querySelector('.addr').onclick = () => { navigator.clipboard.writeText(target); toast('copied') }
  header.querySelector('.menu').onclick = () => isRoom ? toast('destination: ' + target) : openPeer(target)
  wrap.appendChild(header)

  const msgs = document.createElement('div')
  msgs.className = 'thread-msgs'
  msgs.id = 'thread-msgs'
  wrap.appendChild(msgs)

  fillThread(msgs, target)

  if (state.replyingTo) {
    const chip = document.createElement('div')
    chip.className = 'reply-chip'
    chip.innerHTML = `
      <span class="preview">↩ ${esc(state.replyToPreview || state.replyingTo.slice(0, 12))}</span>
      <button class="x" title="cancel">×</button>
    `
    chip.querySelector('.x').onclick = () => { state.replyingTo = null; renderRightSheet() }
    wrap.appendChild(chip)
  }

  const comp = document.createElement('form')
  comp.className = 'composer'
  comp.innerHTML = `
    <span class="stripe"></span>
    <textarea placeholder="message…  ⌘↵ to send" rows="1" autocomplete="off"></textarea>
    <button class="send" type="submit">SEND <span class="kbd">⌘↵</span></button>
  `
  const ta = comp.querySelector('textarea')
  ta.addEventListener('focus', () => comp.classList.add('focused'))
  ta.addEventListener('blur', () => comp.classList.remove('focused'))
  ta.addEventListener('input', () => {
    ta.style.height = 'auto'
    ta.style.height = Math.min(110, ta.scrollHeight) + 'px'
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      comp.requestSubmit()
    }
  })
  comp.onsubmit = async (e) => {
    e.preventDefault()
    const text = ta.value.trim()
    if (!text) return
    const inReplyTo = state.replyingTo
    await sendChat(target, text, inReplyTo)
    ta.value = ''
    ta.style.height = 'auto'
    state.replyingTo = null
    renderRightSheet()
    setTimeout(() => {
      const tm = el('thread-msgs')
      if (tm) tm.scrollTop = tm.scrollHeight
    }, 0)
  }
  const drop = document.createElement('div')
  drop.className = 'drop-overlay'
  drop.textContent = 'drop to attach (cli only for now)'
  drop.hidden = true
  wrap.appendChild(comp)
  wrap.appendChild(drop)
  wrap.addEventListener('dragenter', (e) => { e.preventDefault(); drop.hidden = false })
  wrap.addEventListener('dragleave', (e) => { if (e.target === wrap) drop.hidden = true })
  wrap.addEventListener('dragover', (e) => e.preventDefault())
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); drop.hidden = true
    if (e.dataTransfer?.files?.length) toast('attachments via browser not yet supported (use CLI)')
  })

  setTimeout(() => ta.focus(), 0)
  state.unread.delete(target)
  return wrap
}

function fillThread (host, target) {
  host.innerHTML = ''
  const recs = state.records
    .filter(r => onConversation(r.env, target))
    .sort((a, b) => a.env.ts - b.env.ts)

  const consumed = new Set()
  for (const rec of recs) {
    if (consumed.has(rec.env.id)) continue
    const e = rec.env
    if (e.type === 'tool.invoke') {
      const reply = recs.find(x => x.env.inReplyTo === e.id && x.env.type === 'tool.result')
      if (reply) consumed.add(reply.env.id)
      host.appendChild(renderToolPair(rec, reply))
    } else if (e.type === 'tool.result' && e.inReplyTo && recs.find(x => x.env.id === e.inReplyTo)) {
      continue
    } else if (e.type === 'task.request') {
      const updates = recs.filter(x => x.env.inReplyTo === e.id && x.env.type === 'task.result')
      for (const u of updates) consumed.add(u.env.id)
      host.appendChild(renderTaskPair(rec, updates))
    } else if (e.type === 'task.result' && e.inReplyTo && recs.find(x => x.env.id === e.inReplyTo)) {
      continue
    } else if (e.type === 'ack' || e.type === 'presence') {
      continue
    } else {
      host.appendChild(renderMessage(rec))
    }
  }
  setTimeout(() => { host.scrollTop = host.scrollHeight }, 0)
}

function renderMessage (rec) {
  const div = document.createElement('div')
  const mine = isMine(rec.env)
  div.className = 'msg ' + (mine ? 'me' : 'them')
  div.dataset.id = rec.env.id
  const t = formatTime(rec.env.ts)

  let body
  if (rec.env.type === 'chat') body = `<pre>${esc(rec.body.text || '')}</pre>`
  else body = `<pre>${esc(JSON.stringify(rec.body, null, 2))}</pre>`

  let attach = ''
  if (rec.env.attach?.length) {
    attach = '<div class="attach">'
    for (const it of rec.env.attach) {
      attach += `<a class="attach-link" href="/attach?key=${encodeURIComponent(it.key)}&name=${encodeURIComponent(it.name)}" download="${esc(it.name)}"><span class="clip">📎</span> <span>${esc(it.name)}</span> <span class="size">${formatSize(it.size)}</span></a>`
    }
    attach += '</div>'
  }

  const tickHtml = mine ? renderTick(rec.env.id) : ''
  const replyBtn = mine ? '' : `<button class="reply-btn" title="reply">↩</button>`

  div.innerHTML = `
    <div class="meta">
      <span class="type">${esc(rec.env.type)}</span>
      <span class="ts">${t}</span>
      ${tickHtml}
    </div>
    ${body}
    ${attach}
    <div class="actions">${replyBtn}</div>`
  div.querySelector('.reply-btn')?.addEventListener('click', () => {
    state.replyingTo = rec.env.id
    state.replyToPreview = rec.body?.text?.slice(0, 60) || rec.env.type
    renderRightSheet()
  })
  return div
}

function renderTick (envId) {
  if (state.acked.has(envId)) return `<span class="tick ok" title="acked by recipient">✓✓</span>`
  if (state.delivered.has(envId)) return `<span class="tick ok" title="delivered">✓</span>`
  return `<span class="tick" title="pending"><span class="spinner"></span></span>`
}

function renderToolPair (req, res) {
  const div = document.createElement('div')
  div.className = 'msg tool ' + (isMine(req.env) ? 'me' : 'them')
  const t = formatTime(req.env.ts)
  const reqBody = `${esc(req.body.name)}(${esc(JSON.stringify(req.body.args || {}))})`
  let resBody
  if (!res) resBody = `<div class="res pending">awaiting…</div>`
  else if (res.body.ok) resBody = `<div class="res ok">→ ${esc(JSON.stringify(res.body.value))}</div>`
  else resBody = `<div class="res err">! ${esc(res.body.error || 'error')}</div>`
  div.innerHTML = `
    <div class="meta"><span class="type">tool</span><span class="ts">${t}</span></div>
    <div class="pair">
      <div class="req">${reqBody}</div>
      ${resBody}
    </div>`
  return div
}

function renderTaskPair (req, updates) {
  const div = document.createElement('div')
  div.className = 'msg task ' + (isMine(req.env) ? 'me' : 'them')
  const t = formatTime(req.env.ts)
  const last = updates[updates.length - 1]
  const status = last?.body?.status || 'pending'
  const progress = updates.filter(u => u.body?.status === 'progress')
  const updHtml = progress.map(u => `<div class="task-progress">→ ${esc(u.body.note || '')}<span class="pct">${Math.round((u.body.progress || 0) * 100)}%</span></div>`).join('')
  let resHtml
  if (status === 'done')       resHtml = `<div class="res ok">✔ ${esc(JSON.stringify(last.body.value || {}))}</div>`
  else if (status === 'error') resHtml = `<div class="res err">! ${esc(last.body.error || 'error')}</div>`
  else                         resHtml = `<div class="res pending">${esc(status)}…</div>`
  div.innerHTML = `
    <div class="meta"><span class="type">explore</span><span class="ts">${t}</span></div>
    <div class="pair">
      <div class="req">${esc(req.body.title || '(no-title)')} ${esc(JSON.stringify(req.body.args || {}))}</div>
      ${updHtml}
      ${resHtml}
    </div>`
  return div
}

// agent panel — read-only
function renderPeerView (target) {
  const wrap = document.createElement('div')
  const c = state.me.contacts.find(x => x.pubkey === target) || { pubkey: target, alias: '', blurb: '', capabilities: [] }
  const presence = state.presence[target] || {}
  const presClass = presence.state || 'unknown'
  const lastSeen = presence.lastSeen ? new Date(presence.lastSeen).toLocaleTimeString() : '—'
  const caps = (c.capabilities || presence.capabilities || [])

  const header = document.createElement('div')
  header.className = 'sheet-h'
  header.innerHTML = `
    <button class="back" title="close">◀</button>
    <i class="pres ${presClass}"></i>
    <span class="alias">${esc(c.alias || short(target))}</span>
    <button class="menu" title="more">⋯</button>
    <span class="addr" title="click to copy">${esc(target)}</span>
  `
  header.querySelector('.back').onclick = closeRight
  header.querySelector('.addr').onclick = () => { navigator.clipboard.writeText(target); toast('copied') }
  header.querySelector('.menu').onclick = () => toast('agent: ' + short(target))
  wrap.appendChild(header)

  const body = document.createElement('div')
  body.className = 'peer-view'

  const cta = document.createElement('button')
  cta.className = 'open-chat'
  cta.innerHTML = `▶ open agent channel`
  cta.onclick = () => openThread(target)
  body.appendChild(cta)

  if (state.me.contacts.find(x => x.pubkey === target)) {
    const rm = document.createElement('button')
    rm.className = 'open-chat'
    rm.style.cssText = 'background:transparent;color:var(--text-muted);border:1px solid var(--divider);margin-top:6px'
    rm.innerHTML = `✕ remove agent`
    rm.onclick = async () => {
      if (!confirm(`Remove ${c.alias || short(target)}? They won't reappear via gossip until you unblock.`)) return
      try {
        await fetch('/contacts/delete', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pubkey: target, block: true })
        })
        toast('agent removed')
        closeRight()
        await refreshMe()
      } catch (e) { toast('remove failed: ' + e.message) }
    }
    body.appendChild(rm)
  }

  body.appendChild(block('SIGNAL', `
    <div class="pres-line">
      <i class="pres ${presClass}"></i>
      <span class="v">${esc(presClass)}</span>
      <span class="seen">· last seen ${esc(lastSeen)}</span>
    </div>
  `))

  body.appendChild(block('CAPABILITIES', caps.length
    ? `<div class="caps">${caps.map(cap => `<span class="cap">${esc(cap)}</span>`).join('')}</div>`
    : `<div class="v" style="color:var(--text-muted)">— none advertised —</div>`
  ))

  if (c.blurb) body.appendChild(block('ABOUT', `<div class="blurb">"${esc(c.blurb)}"</div>`))

  const threadCount = state.records.filter(r => onConversation(r.env, target) && r.env.type !== 'ack' && r.env.type !== 'presence').length
  const last = [...state.records].reverse().find(r => onConversation(r.env, target) && r.env.type !== 'ack' && r.env.type !== 'presence')
  const lastTxt = last ? formatTime(last.env.ts) : '—'
  const summary = document.createElement('div')
  summary.className = 'thread-summary'
  summary.innerHTML = `${threadCount} message${threadCount === 1 ? '' : 's'} · last ${lastTxt}<br><span style="color:var(--text-muted);font-size:10px">click to open agent channel</span>`
  summary.onclick = () => openThread(target)
  body.appendChild(block('CHANNEL', summary))

  wrap.appendChild(body)
  return wrap
}

function block (heading, contentHtmlOrNode) {
  const div = document.createElement('div')
  div.className = 'block'
  div.innerHTML = `<div class="h">${esc(heading)}</div>`
  const v = document.createElement('div')
  if (typeof contentHtmlOrNode === 'string') v.innerHTML = contentHtmlOrNode
  else v.appendChild(contentHtmlOrNode)
  div.appendChild(v)
  return div
}

// ---------- view transitions ----------

function openThread (target) {
  if (!target) return
  state.view = { kind: 'thread', target }
  state.unread.delete(target)
  renderRightSheet()
  renderRail()
  graph.requestRedraw()
}
function openPeer (target) {
  if (!target) return
  if (target.startsWith('room:')) return openThread(target)
  state.view = { kind: 'peer', target }
  renderRightSheet()
  renderRail()
  graph.requestRedraw()
}
function closeRight () {
  state.view = { kind: 'empty', target: null }
  state.replyingTo = null
  renderRightSheet()
  renderRail()
  graph.requestRedraw()
}
function maybeRenderThread () {
  if (state.view.kind !== 'thread') return
  const host = el('thread-msgs')
  if (!host) return
  fillThread(host, state.view.target)
}

// ---------- send ----------

async function sendChat (target, text, inReplyTo) {
  if (target.startsWith('room:')) {
    const id = target.slice(5)
    return fetch('/room/send', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, type: 'chat', body: { text } })
    })
  }
  return fetch('/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: target, type: 'chat', body: { text }, inReplyTo: inReplyTo || null })
  })
}

// ---------- graph ----------

function rebuildGraph () {
  const nodes = new Map()
  const edges = new Map()
  if (!state.me) return

  nodes.set(state.me.pubHex, { id: state.me.pubHex, label: state.me.alias || 'me', kind: 'you' })
  for (const c of state.me.contacts) {
    if (!nodes.has(c.pubkey)) nodes.set(c.pubkey, { id: c.pubkey, label: c.alias || short(c.pubkey), kind: 'peer' })
  }
  for (const r of state.me.rooms) {
    nodes.set('room:' + r.id, { id: 'room:' + r.id, label: r.name || ('dest ' + r.id.slice(0, 6)), kind: 'room' })
    const a = state.me.pubHex, b = 'room:' + r.id
    const k = a + '|' + b
    if (!edges.has(k)) edges.set(k, { a, b, count: 0, lastTs: 0, types: new Set(), recentTaskFan: 0, membership: true })
  }

  for (const rec of state.records) {
    const e = rec.env
    if (!nodes.has(e.from)) nodes.set(e.from, { id: e.from, label: short(e.from), kind: 'peer' })

    if (e.to && /^[0-9a-f]{64}$/i.test(e.to)) {
      const a = e.from, b = e.to
      const key = a < b ? a + '|' + b : b + '|' + a
      const edge = edges.get(key) || { a, b, count: 0, lastTs: 0, types: new Set(), recentTaskFan: 0 }
      edge.count++
      edge.lastTs = Math.max(edge.lastTs, e.ts)
      edge.types.add(e.type)
      if (e.type === 'task.request' || e.type === 'task.result') edge.recentTaskFan = Math.max(edge.recentTaskFan, e.ts)
      edges.set(key, edge)
      if (!nodes.has(b)) nodes.set(b, { id: b, label: short(b), kind: 'peer' })
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
    a: e.a, b: e.b, count: e.count, lastTs: e.lastTs,
    types: [...(e.types || [])],
    recentTaskFan: e.recentTaskFan,
    membership: !!e.membership
  })))
}

function pulse (rec) {
  const e = rec.env
  graph.pulse(e.from, e.to, { type: e.type })
}

function showEdgeTooltip (edge, pos) {
  const tip = el('edge-tooltip')
  if (!edge) { tip.classList.remove('show'); return }
  const last = edge.lastTs ? formatTime(edge.lastTs) : '—'
  const types = (edge.types || []).filter(t => t !== 'ack' && t !== 'presence').join(' · ') || '—'
  tip.textContent = `${edge.count || 0} msgs · last ${last} · ${types}`
  tip.style.left = (pos.x + 12) + 'px'
  tip.style.top  = (pos.y + 12) + 'px'
  tip.classList.add('show')
}

function bumpUnread (rec) {
  const e = rec.env
  if (e.from === state.me?.pubHex) return
  if (e.type === 'ack' || e.type === 'presence') return
  const target = e.to?.startsWith('room:') ? e.to : e.from
  if (state.view.kind === 'thread' && state.view.target === target) return
  state.unread.set(target, (state.unread.get(target) || 0) + 1)
}

// ---------- tasks ----------

function recordTask (t) {
  if (!t || !t.id) return
  const prev = state.tasks.get(t.id) || { children: new Set(), createdAt: Date.now() }
  const next = {
    id: t.id,
    status: t.status || prev.status || 'pending',
    title: t.title || prev.title,
    to: t.to || prev.to,
    body: t.body || prev.body,
    parent: t.parent ?? prev.parent,
    createdAt: prev.createdAt || Date.now(),
    children: new Set([...(prev.children || []), ...(t.children || [])])
  }
  state.tasks.set(t.id, next)
  if (next.parent && state.tasks.has(next.parent)) {
    state.tasks.get(next.parent).children.add(next.id)
  }
}
function syncTasksFromRecords () {
  for (const r of state.records) {
    if (r.env.type === 'task.request' && !state.tasks.has(r.env.id)) {
      state.tasks.set(r.env.id, {
        id: r.env.id, status: 'pending',
        title: r.body?.title || '(untitled)',
        to: r.env.to, from: r.env.from,
        parent: r.env.inReplyTo || null,
        createdAt: r.env.ts,
        children: new Set()
      })
    }
    if (r.env.type === 'task.result' && r.env.inReplyTo) {
      const t = state.tasks.get(r.env.inReplyTo)
      if (t) { t.status = r.body?.status || 'progress'; t.last = r.body }
    }
  }
}

// ---------- command palette ----------

function openPalette (preset = '') {
  state.cmd.open = true
  state.cmd.query = preset
  state.cmd.active = 0
  renderPalette()
}
function closePalette () {
  state.cmd.open = false
  const node = document.getElementById('cmd-palette')
  if (node) node.remove()
}
function renderPalette () {
  let node = document.getElementById('cmd-palette')
  if (!node) {
    node = document.createElement('div')
    node.id = 'cmd-palette'
    node.innerHTML = `
      <div class="box">
        <input type="text" placeholder="search routes · /add · /destination · /join · discover…" />
        <ul class="results"></ul>
      </div>
    `
    document.body.appendChild(node)
    node.addEventListener('click', (e) => { if (e.target === node) closePalette() })
    const input = node.querySelector('input')
    input.addEventListener('input', () => { state.cmd.query = input.value; state.cmd.active = 0; refreshPaletteList() })
    input.addEventListener('keydown', onPaletteKey)
  }
  const input = node.querySelector('input')
  input.value = state.cmd.query
  setTimeout(() => input.focus(), 0)
  refreshPaletteList()
}
function refreshPaletteList () {
  const node = document.getElementById('cmd-palette')
  if (!node) return
  const list = node.querySelector('.results')
  const q = state.cmd.query
  const items = computePaletteItems(q)
  state.cmd.items = items
  list.innerHTML = ''
  if (!items.length) {
    const e = document.createElement('li'); e.className = 'empty'; e.textContent = 'no matches'
    list.appendChild(e); return
  }
  let lastGroup = null
  items.forEach((it, i) => {
    if (it.group !== lastGroup) {
      const h = document.createElement('li'); h.className = 'group-h'; h.textContent = it.group
      list.appendChild(h); lastGroup = it.group
    }
    const li = document.createElement('li')
    li.className = 'item' + (i === state.cmd.active ? ' active' : '')
    li.innerHTML = `<span class="icon">${esc(it.icon || '·')}</span><span class="label">${esc(it.label)}</span><span class="hint">${esc(it.hint || '')}</span>`
    li.onclick = () => { state.cmd.active = i; runPaletteItem(it) }
    list.appendChild(li)
  })
}
function computePaletteItems (q) {
  const items = []
  const lower = q.toLowerCase().trim()

  if (lower.startsWith('/add')) {
    const arg = q.slice(4).trim()
    items.push({ group: 'ACTION', icon: '+', label: `add agent ${arg ? '— ' + arg : ''}`, hint: 'pear+agent://…  alias?', kind: 'add', arg })
    return items
  }
  if (lower.startsWith('/destination') || lower.startsWith('/dest') || lower.startsWith('/room')) {
    const arg = q.replace(/^\/(destination|dest|room)\s*/i, '').trim()
    items.push({ group: 'ACTION', icon: '◈', label: `explore destination${arg ? ' — ' + arg : ''}`, hint: 'destination name', kind: 'newroom', arg })
    return items
  }
  if (lower.startsWith('/join')) {
    const arg = q.slice(5).trim()
    items.push({ group: 'ACTION', icon: '+', label: `join destination`, hint: 'paste serialized destination JSON', kind: 'joinroom', arg })
    return items
  }

  // agents/destinations (go-to)
  for (const c of state.me?.contacts || []) {
    const hay = (c.alias + ' ' + c.pubkey).toLowerCase()
    if (lower && !hay.includes(lower)) continue
    items.push({ group: 'FLY TO', icon: '●', label: c.alias || short(c.pubkey), hint: short(c.pubkey), kind: 'thread', target: c.pubkey })
  }
  for (const r of state.me?.rooms || []) {
    const hay = (r.name + ' ' + r.id).toLowerCase()
    if (lower && !hay.includes(lower)) continue
    items.push({ group: 'DISCOVER', icon: '◈', label: r.name || ('dest ' + r.id.slice(0, 6)), hint: short(r.id), kind: 'thread', target: 'room:' + r.id })
  }

  const baseActions = [
    { kind: 'add-pre', label: 'add travel agent…', icon: '+' },
    { kind: 'newroom-pre', label: 'explore a destination…', icon: '◈' },
    { kind: 'joinroom-pre', label: 'join a destination…', icon: '+' },
    { kind: 'copy-addr', label: 'copy my agent ID', icon: '⎘' }
  ]
  for (const a of baseActions) {
    if (!lower || a.label.toLowerCase().includes(lower)) items.push({ group: 'ACTION', ...a })
  }
  return items
}
async function runPaletteItem (it) {
  if (it.kind === 'thread') { closePalette(); openThread(it.target); return }
  if (it.kind === 'add-pre')      { state.cmd.query = '/add '; renderPalette(); return }
  if (it.kind === 'newroom-pre')  { state.cmd.query = '/destination '; renderPalette(); return }
  if (it.kind === 'joinroom-pre') { state.cmd.query = '/join '; renderPalette(); return }
  if (it.kind === 'copy-addr') {
    if (!state.me) return
    navigator.clipboard.writeText(state.me.address); toast('agent ID copied'); closePalette(); return
  }
  if (it.kind === 'add') {
    const parts = (it.arg || '').split(/\s+/).filter(Boolean)
    const address = parts[0]
    const alias = parts.slice(1).join(' ')
    if (!address) return toast('need pear+agent:// address')
    try {
      await fetch('/contacts/add', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, alias })
      })
      toast('agent added')
      closePalette()
      await refreshMe()
    } catch (e) { toast('add failed: ' + e.message) }
    return
  }
  if (it.kind === 'newroom') {
    const name = it.arg || ''
    try {
      const room = await fetch('/room/new', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name })
      }).then(r => r.json())
      await navigator.clipboard.writeText(room.share)
      toast('destination created — invite link copied')
      closePalette()
      await refreshMe()
    } catch (e) { toast('destination creation failed: ' + e.message) }
    return
  }
  if (it.kind === 'joinroom') {
    const share = it.arg
    if (!share) return toast('paste serialized destination JSON')
    try {
      await fetch('/room/join', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ share })
      })
      toast('joined destination')
      closePalette()
      await refreshMe()
    } catch (e) { toast('join failed: ' + e.message) }
  }
}
function onPaletteKey (e) {
  const list = state.cmd.items
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return }
  if (e.key === 'ArrowDown') { e.preventDefault(); state.cmd.active = Math.min(list.length - 1, state.cmd.active + 1); refreshPaletteList(); return }
  if (e.key === 'ArrowUp') { e.preventDefault(); state.cmd.active = Math.max(0, state.cmd.active - 1); refreshPaletteList(); return }
  if (e.key === 'Enter') { e.preventDefault(); const it = list[state.cmd.active]; if (it) runPaletteItem(it); return }
}

// ---------- keyboard ----------

function onGlobalKey (e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (state.cmd.open) closePalette()
    else openPalette('')
    return
  }
  if (e.key === 'Escape') {
    if (state.cmd.open) { closePalette(); return }
    if (state.view.kind !== 'empty') { closeRight(); return }
  }
  const tag = (document.activeElement?.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); cycleContact(1); return }
  if (e.key === 'k' || e.key === 'ArrowUp')   { e.preventDefault(); cycleContact(-1); return }
  if (e.key === 'r' && state.view.kind === 'thread') {
    e.preventDefault()
    const recs = state.records.filter(r => onConversation(r.env, state.view.target) && r.env.type === 'chat' && r.env.from !== state.me?.pubHex)
    const last = recs[recs.length - 1]
    if (last) {
      state.replyingTo = last.env.id
      state.replyToPreview = last.body?.text?.slice(0, 60) || last.env.type
      renderRightSheet()
    }
  }
}
function cycleContact (dir) {
  const list = [...(state.me?.contacts || []).map(c => c.pubkey), ...(state.me?.rooms || []).map(r => 'room:' + r.id)]
  if (!list.length) return
  const cur = state.view.target
  let idx = list.indexOf(cur)
  if (idx === -1) idx = -1
  idx = (idx + dir + list.length) % list.length
  openThread(list[idx])
}

// ---------- helpers ----------

function onConversation (env, other) {
  if (other.startsWith('room:')) return env.to === other
  return (env.from === state.me.pubHex && env.to === other) ||
         (env.from === other && env.to === state.me.pubHex)
}
function isMine (env) { return env.from === state.me?.pubHex }
function labelForRoom (id) {
  const r = state.me.rooms.find(x => x.id === id)
  return r?.name || ('dest ' + id.slice(0, 6))
}
function esc (s) { return String(s ?? '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c])) }
function short (s) { return s ? (s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s) : '' }
function truncAddr (a) {
  if (!a) return ''
  const m = /^pear\+agent:\/\/([0-9a-f]+)/i.exec(a)
  const hex = m ? m[1] : a
  return hex.slice(0, 6) + '…' + hex.slice(-4)
}
function formatTime (ts) {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}
function formatElapsed (ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h'
}
function formatSize (n) {
  if (n == null) return ''
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K'
  return (n / 1024 / 1024).toFixed(1) + 'M'
}
function toast (msg) {
  const host = el('toast-host')
  const div = document.createElement('div')
  div.className = 'toast'
  div.textContent = msg
  host.appendChild(div)
  setTimeout(() => div.remove(), 2200)
}
