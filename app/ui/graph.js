// Force-directed agent graph — radar-console flavour.
//
// Nodes settle into orbits via repulsion + spring forces. Concentric radial
// rings and a slow rotational sweep give it a radar feel. Edges visualise
// active threads (thickness = log volume, alpha falls off when stale).
// Pulses on each new envelope, coloured by envelope type. Presence halos
// breathe when a peer is online; selection ring marks the active node.

const COLOURS = {
  you:   '#B8E86A',
  peer:  '#FFD166',
  room:  '#C084FC',

  // demo node kinds
  human:    '#FFD166',
  agent:    '#B8E86A',
  delegate: '#6FE3A6',
  sandbox:  '#C084FC',
  tool:     '#8AB4FF',
  service:  '#8C93A8',
  business: '#F0A65A',

  chat:          '#6FE3A6',
  'tool.invoke': '#FFD166',
  'tool.result': '#FFD166',
  'task.request':'#F0A65A',
  'task.result': '#F0A65A',
  pairing:       '#C084FC',
  'pairing.accepted': '#C084FC',
  'contact.added':    '#B8E86A',
  'sandbox.spawn':    '#C084FC',
  offer:         '#F0A65A',
  presence:      '#8C93A8',
  ack:           '#555B6E',

  online: '#6FE3A6',
  away:   '#FFD166',
  divider:'#1E2330',
  subtle: '#353A48',
  text:   '#DDE3EE'
}

const FILTER_TO_TYPES = {
  chat: ['chat'],
  tool: ['tool.invoke', 'tool.result'],
  task: ['task.request', 'task.result'],
  presence: ['presence', 'ack']
}

export class Graph {
  constructor (canvas, opts = {}) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.opts = opts
    this.nodes = []
    this.edges = []
    this.pulses = []
    this.dragging = null
    this.hover = null
    this.hoverEdge = null
    this.lastFrame = 0
    this._dirty = true
    this._sweepStart = performance.now()
    this.filters = opts.filters || { chat: true, tool: true, task: true, presence: true }
    this.staticMode = false        // demo mode: pinned positions, no physics
    this.activeEdgeKey = null      // a|b key of the edge to highlight (current step)

    window.addEventListener('resize', () => this.resize())
    canvas.addEventListener('mousemove', (e) => this.onMove(e))
    canvas.addEventListener('mousedown', (e) => this.onDown(e))
    canvas.addEventListener('mouseup',   (e) => this.onUp(e))
    canvas.addEventListener('click',     (e) => this.onClick(e))
    canvas.addEventListener('mouseleave', () => {
      this.hover = null; this.hoverEdge = null; this.dragging = null
      if (this.opts.onEdgeHover) this.opts.onEdgeHover(null)
    })

    this.resize()
    requestAnimationFrame((t) => this.tick(t))
  }

  resize () {
    const r = this.canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width  = r.width  * dpr
    this.canvas.height = r.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.w = r.width; this.h = r.height
    if (this.staticMode) {
      for (const n of this.nodes) {
        n.x = this.w * n.nx
        n.y = this.h * n.ny
      }
    }
  }

  setFilters (f) { this.filters = f; this._dirty = true }

  // Switch into static, deterministic demo layout. Nodes carry normalized
  // positions (nx/ny in 0..1) plus a `kind` used for the role colour/shape.
  // Calling setStaticLayout(null) returns to the default radar/force mode.
  setStaticLayout (layoutNodes) {
    if (!layoutNodes) {
      this.staticMode = false
      this.activeEdgeKey = null
      this.nodes = []
      this.edges = []
      this._dirty = true
      return
    }
    this.staticMode = true
    this.nodes = layoutNodes.map(n => ({
      id: n.id, label: n.label, kind: n.kind, sublabel: n.sublabel,
      nx: n.x, ny: n.y, vx: 0, vy: 0,
      x: this.w * n.x, y: this.h * n.y,
      r: nodeRadius(n.kind)
    }))
    this.edges = []
    this._dirty = true
  }

  setStaticEdges (edges, activeKey) {
    if (!this.staticMode) return
    this.edges = edges || []
    this.activeEdgeKey = activeKey || null
    this._dirty = true
  }

  update (nodes, edges) {
    if (this.staticMode) return // demo mode owns nodes/edges
    const existing = new Map(this.nodes.map(n => [n.id, n]))
    this.nodes = nodes.map((n, i) => {
      const old = existing.get(n.id)
      if (old) return Object.assign(old, n)
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2
      const r = Math.min(this.w, this.h) * 0.28
      return Object.assign(n, {
        x: this.w / 2 + Math.cos(a) * r,
        y: this.h / 2 + Math.sin(a) * r,
        vx: 0, vy: 0,
        r: n.kind === 'room' ? 16 : (n.kind === 'you' ? 14 : 11)
      })
    })
    this.edges = edges
  }

  pulse (fromId, toId, opts = {}) {
    this.pulses.push({ from: fromId, to: toId, t0: performance.now(), type: opts.type || 'chat' })
  }

  requestRedraw () { this._dirty = true }

  tick (t) {
    const dt = Math.min(0.05, (t - this.lastFrame) / 1000 || 0.016)
    this.lastFrame = t
    this.simulate(dt)
    this.draw(t)
    requestAnimationFrame((tt) => this.tick(tt))
  }

  simulate (dt) {
    if (this.staticMode) {
      // pinned positions, but allow interactive drag while held
      for (const n of this.nodes) {
        if (this.dragging === n) continue
        const tx = this.w * n.nx, ty = this.h * n.ny
        n.x += (tx - n.x) * 0.18
        n.y += (ty - n.y) * 0.18
      }
      return
    }
    const cx = this.w / 2, cy = this.h / 2
    const repulse = 9000, spring = 0.05, friction = 0.86, gravity = 0.018
    const id2node = new Map(this.nodes.map(n => [n.id, n]))

    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i]
      a.fx = 0; a.fy = 0
      a.fx += (cx - a.x) * gravity
      a.fy += (cy - a.y) * gravity
      for (let j = 0; j < this.nodes.length; j++) {
        if (i === j) continue
        const b = this.nodes[j]
        const dx = a.x - b.x, dy = a.y - b.y
        const d2 = Math.max(50, dx * dx + dy * dy)
        const f = repulse / d2
        a.fx += (dx / Math.sqrt(d2)) * f
        a.fy += (dy / Math.sqrt(d2)) * f
      }
    }
    for (const e of this.edges) {
      const a = id2node.get(e.a), b = id2node.get(e.b)
      if (!a || !b) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const desired = e.membership ? 130 : 170
      const k = e.membership ? spring * 0.6 : spring
      const f = (d - desired) * k
      a.fx += (dx / d) * f; a.fy += (dy / d) * f
      b.fx -= (dx / d) * f; b.fy -= (dy / d) * f
    }
    for (const n of this.nodes) {
      if (this.dragging === n) continue
      n.vx = (n.vx + n.fx * dt) * friction
      n.vy = (n.vy + n.fy * dt) * friction
      n.x += n.vx; n.y += n.vy
      n.x = Math.max(40, Math.min(this.w - 40, n.x))
      n.y = Math.max(40, Math.min(this.h - 40, n.y))
    }
  }

  draw (t) {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)
    const cx = this.w / 2, cy = this.h / 2

    if (this.staticMode) return this._drawStatic(t)

    // ---- radar rings ----
    const maxR = Math.min(this.w, this.h) * 0.45
    for (let i = 1; i <= 4; i++) {
      const r = (maxR / 4) * i
      ctx.strokeStyle = i === 4 ? hexA(COLOURS.subtle, 0.35) : hexA(COLOURS.divider, 0.7)
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
    }
    // crosshair
    ctx.strokeStyle = hexA(COLOURS.divider, 0.9)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy)
    ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR)
    ctx.stroke()

    // ---- sweep ----
    const sweepT = ((t - this._sweepStart) / 6000) % 1
    const sweepAngle = sweepT * Math.PI * 2
    const grad = ctx.createConicGradient
      ? ctx.createConicGradient(sweepAngle, cx, cy)
      : null
    if (grad) {
      grad.addColorStop(0,    'rgba(184,232,106,0)')
      grad.addColorStop(0.10, 'rgba(184,232,106,0.07)')
      grad.addColorStop(0.16, 'rgba(184,232,106,0)')
      grad.addColorStop(1,    'rgba(184,232,106,0)')
      ctx.fillStyle = grad
      ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2); ctx.fill()
    }

    // ---- edges ----
    const id2node = new Map(this.nodes.map(n => [n.id, n]))
    const filterAllows = (types) => {
      // edge passes if any of its non-presence/non-ack types are in an enabled filter
      const visibleTypes = (types || []).filter(ty => !this._typeFiltered(ty))
      return visibleTypes.length > 0 || (!types || !types.length)
    }

    for (const e of this.edges) {
      const a = id2node.get(e.a), b = id2node.get(e.b)
      if (!a || !b) continue
      if (!e.membership && !filterAllows(e.types)) continue

      const w = e.membership ? 1 : Math.min(5, 0.6 + Math.log2(1 + (e.count || 0)))
      const recent = e.lastTs && (Date.now() - e.lastTs) < 60_000
      const stale  = e.lastTs && (Date.now() - e.lastTs) > 24 * 3600_000
      const taskActive = e.recentTaskFan && (Date.now() - e.recentTaskFan) < 30_000

      let stroke
      if (e.membership) stroke = hexA(COLOURS.room, 0.18)
      else if (taskActive) stroke = hexA('#F0A65A', 0.85)
      else if (recent)     stroke = hexA(COLOURS.online, 0.65)
      else                 stroke = hexA('#8AB4FF', stale ? 0.18 : 0.32)

      if (e === this.hoverEdge) stroke = COLOURS.you
      ctx.strokeStyle = stroke
      ctx.lineWidth = w
      if (e.membership) ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      if (e.membership) ctx.setLineDash([])
    }

    // ---- pulses ----
    const now = performance.now()
    this.pulses = this.pulses.filter(p => now - p.t0 < 1500)
    for (const p of this.pulses) {
      if (this._typeFiltered(p.type)) continue
      const a = id2node.get(p.from), b = id2node.get(p.to)
      if (!a || !b) continue
      const tt = (now - p.t0) / 1500
      const x = a.x + (b.x - a.x) * tt
      const y = a.y + (b.y - a.y) * tt
      const colour = COLOURS[p.type] || '#6FE3A6'
      ctx.fillStyle = hexA(colour, 1 - tt)
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill()
      // soft glow
      ctx.fillStyle = hexA(colour, (1 - tt) * 0.25)
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill()
    }

    // ---- ghost-node empty state ----
    if (this.nodes.length === 1 && this.opts.isMe && this.opts.isMe(this.nodes[0].id)) {
      const ghostX = cx + maxR * 0.65, ghostY = cy - maxR * 0.25
      ctx.strokeStyle = hexA(COLOURS.subtle, 0.9)
      ctx.lineWidth = 1
      ctx.setLineDash([2, 4])
      ctx.beginPath(); ctx.arc(ghostX, ghostY, 11, 0, Math.PI * 2); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = hexA('#8C93A8', 0.7)
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'left'
      ctx.fillText('no contacts — ⌘K → /add', ghostX + 16, ghostY + 4)
    }

    // ---- nodes ----
    for (const n of this.nodes) {
      const colour = n.kind === 'you' ? COLOURS.you : n.kind === 'room' ? COLOURS.room : COLOURS.peer
      const isMe = this.opts.isMe && this.opts.isMe(n.id)
      const isSelected = this.opts.isSelected && this.opts.isSelected(n.id)

      // presence halo
      let presence = null
      if (this.opts.presenceFor) presence = this.opts.presenceFor(n.id)
      if (presence === 'online') {
        const pulse = (Math.sin(now / 1100) + 1) / 2
        ctx.fillStyle = hexA(COLOURS.online, 0.10 + pulse * 0.10)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 9 + pulse * 2, 0, Math.PI * 2); ctx.fill()
      } else if (presence === 'away') {
        ctx.fillStyle = hexA(COLOURS.away, 0.10)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 7, 0, Math.PI * 2); ctx.fill()
      }

      // selected ring
      if (isSelected) {
        ctx.strokeStyle = COLOURS.you
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2); ctx.stroke()
      } else if (n === this.hover) {
        ctx.fillStyle = hexA(colour, 0.15)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2); ctx.fill()
      }

      // body
      ctx.fillStyle = colour
      if (n.kind === 'room') {
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2)
        if (isMe) {
          ctx.strokeStyle = '#0a0c10'; ctx.lineWidth = 2
          ctx.strokeRect(n.x - n.r + 2, n.y - n.r + 2, n.r * 2 - 4, n.r * 2 - 4)
        }
      } else {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
        if (isMe) {
          ctx.fillStyle = '#0a0c10'
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 0.4, 0, Math.PI * 2); ctx.fill()
        }
      }

      // label
      ctx.fillStyle = COLOURS.text
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(n.label || '', n.x, n.y + n.r + 14)
    }
  }

  // Demo-mode renderer: deterministic per-scenario layout, kind-aware glyphs,
  // and a strongly highlighted "active" edge for the current step.
  _drawStatic (t) {
    const ctx = this.ctx
    const now = performance.now()

    // soft baseline grid
    const gridStep = 56
    ctx.strokeStyle = hexA(COLOURS.divider, 0.5)
    ctx.lineWidth = 1
    for (let x = gridStep; x < this.w; x += gridStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke()
    }
    for (let y = gridStep; y < this.h; y += gridStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke()
    }

    const id2node = new Map(this.nodes.map(n => [n.id, n]))

    // edges
    for (const e of this.edges) {
      const a = id2node.get(e.a), b = id2node.get(e.b)
      if (!a || !b) continue
      const isActive = e.key && e.key === this.activeEdgeKey
      const w = isActive ? 3.2 : Math.min(3.5, 0.8 + Math.log2(1 + (e.count || 1)))
      const stroke = isActive
        ? hexA(COLOURS[e.type] || COLOURS.you, 0.95)
        : hexA('#8AB4FF', 0.32)
      ctx.strokeStyle = stroke
      ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
      ctx.stroke()

      // arrow head on active edge
      if (isActive) {
        const dx = b.x - a.x, dy = b.y - a.y
        const len = Math.hypot(dx, dy) || 1
        const ux = dx / len, uy = dy / len
        const tipX = b.x - ux * (b.r + 6)
        const tipY = b.y - uy * (b.r + 6)
        ctx.fillStyle = stroke
        ctx.beginPath()
        ctx.moveTo(tipX, tipY)
        ctx.lineTo(tipX - ux * 10 - uy * 5, tipY - uy * 10 + ux * 5)
        ctx.lineTo(tipX - ux * 10 + uy * 5, tipY - uy * 10 - ux * 5)
        ctx.closePath()
        ctx.fill()
      }
    }

    // pulses (along active edge)
    this.pulses = this.pulses.filter(p => now - p.t0 < 1500)
    for (const p of this.pulses) {
      const a = id2node.get(p.from), b = id2node.get(p.to)
      if (!a || !b) continue
      const tt = (now - p.t0) / 1500
      const x = a.x + (b.x - a.x) * tt
      const y = a.y + (b.y - a.y) * tt
      const colour = COLOURS[p.type] || '#6FE3A6'
      ctx.fillStyle = hexA(colour, 1 - tt)
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = hexA(colour, (1 - tt) * 0.25)
      ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill()
    }

    // nodes
    for (const n of this.nodes) {
      const colour = COLOURS[n.kind] || COLOURS.peer
      const isHover = n === this.hover

      // breathing halo when this node is endpoint of the active edge
      const isActive = this.edges.some(e => e.key === this.activeEdgeKey && (e.a === n.id || e.b === n.id))
      if (isActive) {
        const pulse = (Math.sin(now / 380) + 1) / 2
        ctx.fillStyle = hexA(colour, 0.10 + pulse * 0.18)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 12 + pulse * 4, 0, Math.PI * 2); ctx.fill()
      }
      if (isHover) {
        ctx.fillStyle = hexA(colour, 0.18)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2); ctx.fill()
      }

      // glyph by kind
      ctx.fillStyle = colour
      if (n.kind === 'human') {
        // diamond
        ctx.beginPath()
        ctx.moveTo(n.x, n.y - n.r)
        ctx.lineTo(n.x + n.r, n.y)
        ctx.lineTo(n.x, n.y + n.r)
        ctx.lineTo(n.x - n.r, n.y)
        ctx.closePath(); ctx.fill()
      } else if (n.kind === 'sandbox') {
        // hex (rounded square)
        const r = n.r
        ctx.beginPath()
        ctx.moveTo(n.x - r, n.y - r * 0.6)
        ctx.lineTo(n.x, n.y - r)
        ctx.lineTo(n.x + r, n.y - r * 0.6)
        ctx.lineTo(n.x + r, n.y + r * 0.6)
        ctx.lineTo(n.x, n.y + r)
        ctx.lineTo(n.x - r, n.y + r * 0.6)
        ctx.closePath(); ctx.fill()
      } else if (n.kind === 'tool' || n.kind === 'service') {
        // square
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2)
      } else if (n.kind === 'business') {
        // pentagon
        const r = n.r, sides = 5
        ctx.beginPath()
        for (let i = 0; i < sides; i++) {
          const a = -Math.PI / 2 + i * (2 * Math.PI / sides)
          const px = n.x + Math.cos(a) * r, py = n.y + Math.sin(a) * r
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        }
        ctx.closePath(); ctx.fill()
      } else {
        // agent / delegate: circle, with inner dot for delegate
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
        if (n.kind === 'delegate') {
          ctx.fillStyle = '#0a0c10'
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 0.42, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = colour
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 0.22, 0, Math.PI * 2); ctx.fill()
        }
      }

      // label
      ctx.fillStyle = COLOURS.text
      ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(n.label || '', n.x, n.y + n.r + 16)
      if (n.sublabel) {
        ctx.fillStyle = hexA(COLOURS.text, 0.55)
        ctx.font = '10px "JetBrains Mono", ui-monospace, monospace'
        ctx.fillText(n.sublabel, n.x, n.y + n.r + 30)
      }
    }
  }

  _typeFiltered (type) {
    for (const [k, types] of Object.entries(FILTER_TO_TYPES)) {
      if (types.includes(type)) return !this.filters[k]
    }
    return false
  }

  pick (x, y) {
    let best = null
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y)
      if (d < n.r + 4) best = n
    }
    return best
  }

  pickEdge (x, y) {
    const id2node = new Map(this.nodes.map(n => [n.id, n]))
    let best = null, bestD = 6
    for (const e of this.edges) {
      if (e.membership) continue
      const a = id2node.get(e.a), b = id2node.get(e.b)
      if (!a || !b) continue
      const d = pointSegmentDistance(x, y, a.x, a.y, b.x, b.y)
      if (d < bestD) { bestD = d; best = e }
    }
    return best
  }

  onMove (e) {
    const { x, y } = pos(e, this.canvas)
    if (this.dragging) {
      this.dragging.x = x; this.dragging.y = y; this.dragging.vx = 0; this.dragging.vy = 0
      return
    }
    this.hover = this.pick(x, y)
    this.hoverEdge = this.hover ? null : this.pickEdge(x, y)
    this.canvas.style.cursor = (this.hover || this.hoverEdge) ? 'pointer' : 'default'
    if (this.opts.onEdgeHover) this.opts.onEdgeHover(this.hoverEdge, { x: e.clientX, y: e.clientY })
  }
  onDown (e) {
    const { x, y } = pos(e, this.canvas)
    this.dragging = this.pick(x, y)
    if (this.dragging) this.canvas.style.cursor = 'grabbing'
  }
  onUp () { this.dragging = null }
  onClick (e) {
    const { x, y } = pos(e, this.canvas)
    const n = this.pick(x, y)
    if (n) return this.opts.onNodeClick && this.opts.onNodeClick(n, e)
    const ed = this.pickEdge(x, y)
    if (ed) return this.opts.onEdgeClick && this.opts.onEdgeClick(ed)
  }
}

function pos (e, canvas) {
  const r = canvas.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}
function pointSegmentDistance (px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (!len2) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}
function hexA (hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

function nodeRadius (kind) {
  switch (kind) {
    case 'human':    return 18
    case 'business': return 17
    case 'sandbox':  return 16
    case 'tool':
    case 'service':  return 15
    case 'delegate': return 16
    case 'agent':    return 16
    default:         return 14
  }
}
