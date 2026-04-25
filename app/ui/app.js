// PearPost UI — vanilla JS, talks to the local backend over fetch + SSE.
// Three panes: contacts/rooms (left), agent graph (middle), thread/peer (right).

import { Graph } from '/graph.js'

const state = {
  me: null,
  records: [],
  presence: {},                  // pubHex -> { state, lastSeen }
  delivered: new Set(),          // env.id of envelopes confirmed delivered
  tasks: new Map(),              // task root id -> { status, title, to, children:Set, parent }
  selectedConversation: null,    // { kind: 'peer'|'room', other: id }
  replyingTo: null               // env.id we're replying to (or null = no inReplyTo)
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
  threadPresence: document.getElementById('thread-presence'),
  replyChip: document.getElementById('reply-chip'),
  replyChipText: document.getElementById('reply-chip-text'),
  replyChipClose: document.getElementById('reply-chip-close'),
  peerAlias: document.getElementById('peer-alias'),
  peerAddr: document.getElementById('peer-addr'),
  peerBlurb: document.getElementById('peer-blurb'),
  peerTools: document.getElementById('peer-tools'),
  peerThreads: document.getElementById('peer-threads'),
  peerOpenChat: document.getElementById('peer-open-chat'),
  peerInvokeForm: document.getElementById('peer-invoke-form'),
  peerInvokeTool: document.getElementById('peer-invoke-tool'),
  peerInvokeArgs: document.getElementById('peer-invoke-args'),
  peerTaskForm: document.getElementById('peer-task-form'),
  peerTaskTitle: document.getElementById('peer-task-title'),
  peerTaskArgs: document.getElementById('peer-task-args'),
  composerType: document.getElementById('composer-type'),
  composerText: document.getElementById('composer-text'),
  composerAttach: document.getElementById('composer-attach'),
  composer: document.getElementById('composer'),
  back: document.getElementById('back'),
  graph: document.getElementById('graph'),
  taskTray: document.getElementById('task-tray')
}

const graph = new Graph(els.graph, {
  onNodeClick: (node) => openPeer(node.id),
  onEdgeClick: (edge) => openConversation(edge),
  isMe: (id) => state.me && id === state.me.pubHex,
  presenceFor: (id) => state.presence[id]?.state,
  deliveredFor: (envId) => state.delivered.has(envId)
})

init().catch(err => console.error(err))

async function init () {
  state.me = await fetch('/me').then(r => r.json())
  els.meAlias.textContent = state.me.alias || '(you)'
  els.meAddr.textContent = state.me.address
  els.meAddr.onclick = () => navigator.clipboard.writeText(state.me.address)
  state.presence = state.me.presence || {}
  for (const t of state.me.tasks || []) recordTask(t)

  state.records = await fetch('/messages?limit=500').then(r => r.json())
  rebuildGraph()
  renderContacts(); renderRooms(); renderCapabilities(); renderTaskTray()

  const ev = new EventSource('/events')
  ev.onmessage = (e) => {
    const d = JSON.parse(e.data)
    if (d.kind === 'message') {
      state.records.push(d.record)
      pulse(d.record)
      rebuildGraph()
      maybeRenderThread()
      renderTaskTray()
    } else if (d.kind === 'peer') {
      refreshMe()
    } else if (d.kind === 'presence') {
      state.presence[d.presence.pubkey] = { state: d.presence.state, lastSeen: d.presence.ts }
      graph.requestRedraw()
    } else if (d.kind === 'delivered') {
      state.delivered.add(d.delivered.id)
      maybeRenderThread()
      renderTaskTray()
    } else if (d.kind === 'task') {
      recordTask(d.task)
      renderTaskTray()
      rebuildGraph()
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
    if (!state.selectedConversation) return
    const text = els.composerText.value
    if (!text && !els.composerAttach?.files?.length) return
    const type = els.composerType.value
    const inReplyTo = state.replyingTo
    await sendInConversation(type, text, inReplyTo)
    els.composerText.value = ''
    if (els.composerAttach) els.composerAttach.value = ''
    state.replyingTo = null
    renderReplyChip()
    els.composerText.focus()
  }
  els.replyChipClose.onclick = () => { state.replyingTo = null; renderReplyChip() }
  els.back.onclick = closeRight
  document.querySelectorAll('.back-peer').forEach(b => b.onclick = closeRight)
  els.peerOpenChat.onclick = () => {
    if (!state.selectedPeer) return
    openConversationWithPeer(state.selectedPeer)
  }
  els.peerInvokeForm.onsubmit = async (e) => {
    e.preventDefault()
    if (!state.selectedPeer) return
    const tool = els.peerInvokeTool.value.trim()
    if (!tool) return
    let args = {}
    try { args = els.peerInvokeArgs.value.trim() ? JSON.parse(els.peerInvokeArgs.value) : {} } catch (err) { return flash('args must be JSON') }
    flash(`invoking ${tool}…`)
    const r = await fetch('/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: state.selectedPeer, tool, args }) }).then(r => r.json()).catch(e => ({ error: e.message }))
    flash(r.error ? `error: ${r.error}` : `→ ${JSON.stringify(r.value).slice(0, 80)}`)
  }
  els.peerTaskForm.onsubmit = async (e) => {
    e.preventDefault()
    if (!state.selectedPeer) return
    const title = els.peerTaskTitle.value.trim()
    if (!title) return
    let args = {}
    try { args = els.peerTaskArgs.value.trim() ? JSON.parse(els.peerTaskArgs.value) : {} } catch (err) { return flash('args must be JSON') }
    flash(`task "${title}" launched`)
    fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: state.selectedPeer, title, args }) }).then(r => r.json()).then(r => {
      flash(r.ok ? `task done: ${JSON.stringify(r.value).slice(0, 60)}` : `task error: ${r.error}`)
    })
    els.peerTaskTitle.value = ''
    els.peerTaskArgs.value = ''
  }
}

async function refreshMe () {
  state.me = await fetch('/me').then(r => r.json())
  state.presence = { ...state.presence, ...(state.me.presence || {}) }
  for (const t of state.me.tasks || []) recordTask(t)
  renderContacts(); renderRooms(); renderCapabilities(); renderTaskTray()
  rebuildGraph()
}

function renderContacts () {
  els.contacts.innerHTML = ''
  for (const c of state.me.contacts) {
    const li = document.createElement('li')
    const stateClass = state.presence[c.pubkey]?.state || 'unknown'
    li.innerHTML = `<i class="presence ${stateClass}"></i><span class="name">${esc(c.alias || '(unnamed)')}</span><span class="addr">${c.pubkey.slice(0,10)}…</span>`
    li.onclick = () => openConversationWithPeer(c.pubkey)
    li.oncontextmenu = (e) => { e.preventDefault(); openPeer(c.pubkey) }
    li.title = 'click: chat • right-click: peer panel'
    els.contacts.appendChild(li)
  }
}

function renderRooms () {
  els.rooms.innerHTML = ''
  for (const r of state.me.rooms) {
    const li = document.createElement('li')
    li.innerHTML = `<span class="name">${esc(r.name || '(unnamed)')}</span><span class="addr">${r.id.slice(0,10)}…</span>`
    li.onclick = () => openConversation({ a: state.me.pubHex, b: 'room:' + r.id })
    li.oncontextmenu = (e) => { e.preventDefault(); navigator.clipboard.writeText(r.share); flash('share copied') }
    li.title = 'click: open room • right-click: copy share-link'
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

function recordTask (t) {
  if (!t || !t.id) return
  const prev = state.tasks.get(t.id) || { children: new Set() }
  const next = {
    id: t.id,
    status: t.status || prev.status,
    title: t.title || prev.title,
    to: t.to || prev.to,
    body: t.body || prev.body,
    parent: t.parent ?? prev.parent,
    children: new Set(t.children || prev.children || [])
  }
  state.tasks.set(t.id, next)
  if (next.parent && state.tasks.has(next.parent)) {
    state.tasks.get(next.parent).children.add(next.id)
  }
}

function renderTaskTray () {
  if (!els.taskTray) return
  // Reconstruct task tree from envelopes too — task.request / task.result
  // pairs we've materialised in the inbox.
  for (const r of state.records) {
    if (r.env.type === 'task.request' && !state.tasks.has(r.env.id)) {
      state.tasks.set(r.env.id, {
        id: r.env.id,
        status: 'pending',
        title: r.body?.title || '(untitled)',
        to: r.env.to,
        from: r.env.from,
        parent: r.env.inReplyTo || null,
        children: new Set()
      })
    }
    if (r.env.type === 'task.result' && r.env.inReplyTo) {
      const t = state.tasks.get(r.env.inReplyTo)
      if (t) { t.status = r.body?.status || 'progress'; t.last = r.body }
    }
  }

  // Top-level only.
  const roots = [...state.tasks.values()].filter(t => !t.parent || !state.tasks.has(t.parent))
  els.taskTray.innerHTML = ''
  if (!roots.length) {
    els.taskTray.innerHTML = '<li class="muted">(no tasks)</li>'
    return
  }
  for (const t of roots) els.taskTray.appendChild(renderTaskNode(t, 0))
}

function renderTaskNode (t, depth) {
  const li = document.createElement('li')
  li.className = 'task-node depth-' + Math.min(depth, 4) + ' status-' + (t.status || 'pending')
  const dest = (t.to || '').slice(0, 8)
  li.innerHTML = `<span class="status-pill"></span><span class="title">${esc(t.title || '(no-title)')}</span><span class="dest">→${dest}…</span><span class="status-text">${esc(t.status || '…')}</span>`
  for (const childId of t.children) {
    const child = state.tasks.get(childId)
    if (child) li.appendChild(renderTaskNode(child, depth + 1))
  }
  return li
}

// Build nodes + edges out of records and feed the graph.
function rebuildGraph () {
  const nodes = new Map()
  const edges = new Map()

  nodes.set(state.me.pubHex, { id: state.me.pubHex, label: state.me.alias || 'me', kind: 'you' })
  for (const c of state.me.contacts) {
    if (!nodes.has(c.pubkey)) nodes.set(c.pubkey, { id: c.pubkey, label: c.alias || c.pubkey.slice(0,8), kind: 'peer' })
  }
  for (const r of state.me.rooms) {
    nodes.set('room:' + r.id, { id: 'room:' + r.id, label: r.name || ('room ' + r.id.slice(0,6)), kind: 'room' })
  }

  for (const rec of state.records) {
    const e = rec.env
    if (!nodes.has(e.from)) nodes.set(e.from, { id: e.from, label: e.from.slice(0,8), kind: 'peer' })

    if (e.to && /^[0-9a-f]{64}$/i.test(e.to)) {
      const a = e.from, b = e.to
      const key = a < b ? a + '|' + b : b + '|' + a
      const edge = edges.get(key) || { a, b, count: 0, lastTs: 0, types: new Set(), recentTaskFan: 0 }
      edge.count++
      edge.lastTs = Math.max(edge.lastTs, e.ts)
      edge.types.add(e.type)
      if (e.type === 'task.request' || e.type === 'task.result') edge.recentTaskFan = Math.max(edge.recentTaskFan, e.ts)
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
    a: e.a, b: e.b, count: e.count, lastTs: e.lastTs, types: [...e.types], recentTaskFan: e.recentTaskFan
  })))
}

function pulse (rec) {
  const e = rec.env
  graph.pulse(e.from, e.to, { type: e.type })
}

function openConversationWithPeer (pubHex) {
  return openConversation({ a: state.me.pubHex, b: pubHex })
}

function openConversation (edge) {
  const otherId = edge.a === state.me.pubHex ? edge.b : edge.a
  state.selectedConversation = { kind: otherId.startsWith('room:') ? 'room' : 'peer', other: otherId }
  state.replyingTo = null
  els.rightEmpty.hidden = true
  els.rightPeer.hidden = true
  els.rightThread.hidden = false
  const otherIsRoom = otherId.startsWith('room:')
  els.threadWithAlias.textContent = otherIsRoom
    ? labelForRoom(otherId.slice(5))
    : (state.me.contacts.find(c => c.pubkey === otherId)?.alias || otherId.slice(0,12))
  els.threadWithAddr.textContent = otherId
  if (els.threadPresence) {
    els.threadPresence.className = 'presence ' + (otherIsRoom ? 'room' : (state.presence[otherId]?.state || 'unknown'))
  }
  renderReplyChip()
  renderThread()
  els.composerText.focus()
}

function maybeRenderThread () {
  if (state.selectedConversation) renderThread()
}

function renderThread () {
  if (!state.selectedConversation) return
  const { other } = state.selectedConversation
  const recs = state.records
    .filter(r => onConversation(r.env, other))
    .sort((a, b) => a.env.ts - b.env.ts)
  els.messages.innerHTML = ''
  const consumed = new Set()
  for (const rec of recs) {
    if (consumed.has(rec.env.id)) continue
    const e = rec.env
    if (e.type === 'tool.invoke') {
      const reply = recs.find(x => x.env.inReplyTo === e.id && x.env.type === 'tool.result')
      if (reply) consumed.add(reply.env.id)
      els.messages.appendChild(renderToolPair(rec, reply))
    } else if (e.type === 'tool.result' && e.inReplyTo && recs.find(x => x.env.id === e.inReplyTo)) {
      continue
    } else if (e.type === 'task.request') {
      // Group with its updates.
      const updates = recs.filter(x => x.env.inReplyTo === e.id && x.env.type === 'task.result')
      for (const u of updates) consumed.add(u.env.id)
      els.messages.appendChild(renderTaskPair(rec, updates))
    } else if (e.type === 'task.result' && e.inReplyTo && recs.find(x => x.env.id === e.inReplyTo)) {
      continue
    } else if (e.type === 'ack') {
      // Acks are visible as ✓ ticks on their target — don't render as messages.
      continue
    } else if (e.type === 'presence') {
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
  div.dataset.id = rec.env.id
  const t = new Date(rec.env.ts).toLocaleTimeString()
  let body
  if (rec.env.type === 'chat') body = `<pre>${esc(rec.body.text || '')}</pre>`
  else body = `<pre>${esc(JSON.stringify(rec.body, null, 2))}</pre>`
  let attach = ''
  if (rec.env.attach?.length) {
    attach = '<div class="attach">'
    for (const it of rec.env.attach) {
      attach += `<a class="attach-link" href="/attach?key=${encodeURIComponent(it.key)}&name=${encodeURIComponent(it.name)}" download="${esc(it.name)}">📎 ${esc(it.name)} <span class="size">${formatSize(it.size)}</span></a>`
    }
    attach += '</div>'
  }
  const tick = isMine(rec.env) && state.delivered.has(rec.env.id) ? '<span class="tick" title="delivered">✓</span>' : ''
  const reply = isMine(rec.env) ? '' : `<button class="reply-btn" title="reply">↩</button>`
  div.innerHTML = `<div class="meta"><span class="type">${rec.env.type}</span><span>${t}</span>${tick}</div>${body}${attach}<div class="actions">${reply}</div>`
  div.querySelector('.reply-btn')?.addEventListener('click', () => {
    state.replyingTo = rec.env.id
    state.replyToPreview = rec.body?.text?.slice(0, 60) || rec.env.type
    renderReplyChip()
    els.composerText.focus()
  })
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

function renderTaskPair (req, updates) {
  const div = document.createElement('div')
  div.className = 'msg task ' + (isMine(req.env) ? 'me' : 'them')
  const t = new Date(req.env.ts).toLocaleTimeString()
  const last = updates[updates.length - 1]
  const status = last?.body?.status || 'pending'
  const progress = updates.filter(u => u.body?.status === 'progress')
  let updHtml = progress.map(u => `<div class="task-progress">→ ${esc(u.body.note || '')} <span>${Math.round((u.body.progress || 0) * 100)}%</span></div>`).join('')
  let resHtml
  if (status === 'done') resHtml = `<div class="res ok">✔ ${esc(JSON.stringify(last.body.value || {}))}</div>`
  else if (status === 'error') resHtml = `<div class="res err">! ${esc(last.body.error)}</div>`
  else resHtml = `<div class="res pulse">${esc(status)}…</div>`
  div.innerHTML = `
    <div class="meta"><span class="type">task</span><span>${t}</span></div>
    <div class="task-row">
      <div class="title">${esc(req.body.title || '(no-title)')}</div>
      <div class="args">${esc(JSON.stringify(req.body.args || {}))}</div>
    </div>
    ${updHtml}
    ${resHtml}`
  return div
}

function renderReplyChip () {
  if (!els.replyChip) return
  if (!state.replyingTo) { els.replyChip.hidden = true; return }
  els.replyChip.hidden = false
  const target = state.records.find(r => r.env.id === state.replyingTo)
  els.replyChipText.textContent = '↩ ' + (target?.body?.text?.slice(0, 50) || target?.env?.type || state.replyingTo.slice(0, 12))
}

function openPeer (pub) {
  if (pub.startsWith('room:')) {
    return openConversation({ a: state.me.pubHex, b: pub })
  }
  state.selectedPeer = pub
  state.selectedConversation = null
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
    li.style.cursor = 'pointer'
    li.onclick = () => { els.peerInvokeTool.value = tool; els.peerInvokeArgs.focus() }
    els.peerTools.appendChild(li)
  }
  if (!els.peerTools.childElementCount) {
    const li = document.createElement('li'); li.textContent = '(none advertised)'
    els.peerTools.appendChild(li)
  }
  els.peerThreads.innerHTML = ''
  const li = document.createElement('li')
  const presenceClass = state.presence[pub]?.state || 'unknown'
  li.innerHTML = `<i class="presence ${presenceClass}"></i> ${presenceClass}`
  els.peerThreads.appendChild(li)
}

function closeRight () {
  state.selectedConversation = null
  state.selectedPeer = null
  els.rightThread.hidden = true
  els.rightPeer.hidden = true
  els.rightEmpty.hidden = false
}

async function sendInConversation (type, text, inReplyTo) {
  if (!state.selectedConversation) return
  const { kind, other } = state.selectedConversation
  const attachFiles = []
  if (els.composerAttach?.files?.length) {
    // Browsers can't hand the server a local path; we'd need a separate
    // /upload endpoint. For now, skip — the CLI/headless path uses paths.
    flash('attachments via browser not yet supported (use CLI)')
  }
  const body = type === 'chat'
    ? { text }
    : type === 'tool.invoke'
      ? toolInvokeBody(text)
      : type === 'task.request'
        ? taskRequestBody(text)
        : { text }
  if (kind === 'room') {
    const id = other.slice('room:'.length)
    return fetch('/room/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, type, body }) })
  }
  if (type === 'tool.invoke') {
    return fetch('/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: other, tool: body.name, args: body.args }) })
  }
  if (type === 'task.request') {
    return fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: other, ...body }) })
  }
  return fetch('/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: other, type, body, inReplyTo: inReplyTo || null, attach: attachFiles.length ? attachFiles : undefined }) })
}

function toolInvokeBody (text) {
  const [name, ...rest] = text.split(/\s+/)
  let args = {}
  try { args = JSON.parse(rest.join(' ') || '{}') } catch {}
  return { name, args }
}
function taskRequestBody (text) {
  const [title, ...rest] = text.split(/\s+/)
  let args = {}
  try { args = JSON.parse(rest.join(' ') || '{}') } catch {}
  return { title, args }
}

function onConversation (env, other) {
  if (other.startsWith('room:')) return env.to === other
  // Direct conversation between me and `other`.
  return (env.from === state.me.pubHex && env.to === other) ||
         (env.from === other && env.to === state.me.pubHex)
}

function isMine (env) { return env.from === state.me.pubHex }

function labelForRoom (id) {
  const r = state.me.rooms.find(x => x.id === id)
  return r?.name || ('room ' + id.slice(0, 6))
}

function esc (s) { return String(s ?? '').replace(/[<>&"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c])) }

function formatSize (n) {
  if (n == null) return ''
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K'
  return (n / 1024 / 1024).toFixed(1) + 'M'
}

function flash (msg) {
  const div = document.createElement('div')
  div.className = 'flash'
  div.textContent = msg
  document.body.appendChild(div)
  setTimeout(() => div.remove(), 2000)
}
