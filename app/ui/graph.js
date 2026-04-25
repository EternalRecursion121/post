// Force-directed agent graph. Vanilla JS / canvas.
//
// Nodes settle into orbits via repulsion + spring forces. Edges visualise
// active threads (thickness = volume, animated pulses on each new envelope).
// Pulse colour reflects the envelope type (chat / tool / task / ack /
// presence). Presence halos show online/away/unknown peer state.

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

    window.addEventListener('resize', () => this.resize())
    canvas.addEventListener('mousemove', (e) => this.onMove(e))
    canvas.addEventListener('mousedown', (e) => this.onDown(e))
    canvas.addEventListener('mouseup', (e) => this.onUp(e))
    canvas.addEventListener('click', (e) => this.onClick(e))
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.hoverEdge = null; this.dragging = null })

    this.resize()
    requestAnimationFrame((t) => this.tick(t))
  }

  resize () {
    const r = this.canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = r.width * dpr
    this.canvas.height = r.height * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.w = r.width; this.h = r.height
  }

  update (nodes, edges) {
    const existing = new Map(this.nodes.map(n => [n.id, n]))
    this.nodes = nodes.map((n, i) => {
      const old = existing.get(n.id)
      if (old) return Object.assign(old, n)
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2
      const r = 140
      return Object.assign(n, {
        x: this.w / 2 + Math.cos(a) * r,
        y: this.h / 2 + Math.sin(a) * r,
        vx: 0, vy: 0,
        r: n.kind === 'room' ? 18 : (n.kind === 'you' ? 16 : 12)
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
    this.draw()
    requestAnimationFrame((tt) => this.tick(tt))
  }

  simulate (dt) {
    const cx = this.w / 2, cy = this.h / 2
    const repulse = 8000, spring = 0.06, friction = 0.85, gravity = 0.02
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
        const d2 = Math.max(40, dx * dx + dy * dy)
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
      const desired = 160
      const f = (d - desired) * spring
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

  draw () {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.w, this.h)
    const id2node = new Map(this.nodes.map(n => [n.id, n]))

    // edges
    for (const e of this.edges) {
      const a = id2node.get(e.a), b = id2node.get(e.b)
      if (!a || !b) continue
      const w = Math.min(5, 0.6 + Math.log2(1 + e.count))
      const recent = (Date.now() - e.lastTs) < 60_000
      const taskActive = e.recentTaskFan && (Date.now() - e.recentTaskFan) < 30_000
      let stroke = 'rgba(138,180,248,0.25)'
      if (recent) stroke = 'rgba(110,231,183,0.65)'
      if (taskActive) stroke = 'rgba(192,132,252,0.85)'
      if (e === this.hoverEdge) stroke = '#6ee7b7'
      ctx.strokeStyle = stroke
      ctx.lineWidth = w
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }

    // pulses on edges
    const now = performance.now()
    this.pulses = this.pulses.filter(p => now - p.t0 < 1500)
    for (const p of this.pulses) {
      const a = id2node.get(p.from), b = id2node.get(p.to)
      if (!a || !b) continue
      const t = (now - p.t0) / 1500
      const x = a.x + (b.x - a.x) * t
      const y = a.y + (b.y - a.y) * t
      const colour = pulseColour(p.type, 1 - t)
      ctx.fillStyle = colour
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill()
    }

    // nodes
    for (const n of this.nodes) {
      const colour = n.kind === 'you' ? '#8ab4ff' : n.kind === 'room' ? '#c084fc' : '#ffd166'
      // presence halo
      let presence = null
      if (this.opts.presenceFor) presence = this.opts.presenceFor(n.id)
      if (presence === 'online') {
        ctx.fillStyle = hexA('#6ee7b7', 0.20)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 10, 0, Math.PI * 2); ctx.fill()
      } else if (presence === 'away') {
        ctx.fillStyle = hexA('#ffd166', 0.12)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2); ctx.fill()
      }
      // hover halo
      if (n === this.hover || (this.opts.isMe && this.opts.isMe(n.id))) {
        ctx.fillStyle = hexA(colour, 0.15)
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2); ctx.fill()
      }
      // body
      ctx.fillStyle = colour
      if (n.kind === 'room') {
        ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2)
      } else {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill()
      }
      // label
      ctx.fillStyle = '#e6e9f2'
      ctx.font = '12px ui-monospace, Menlo, Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.fillText(n.label, n.x, n.y + n.r + 14)
    }
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
    if (n) return this.opts.onNodeClick && this.opts.onNodeClick(n)
    const ed = this.pickEdge(x, y)
    if (ed) return this.opts.onEdgeClick && this.opts.onEdgeClick(ed)
  }
}

function pulseColour (type, alpha) {
  const palette = {
    chat: '#6ee7b7',
    'tool.invoke': '#ffd166',
    'tool.result': '#ffd166',
    'task.request': '#c084fc',
    'task.result': '#c084fc',
    presence: '#8ab4ff',
    ack: '#8a90a6'
  }
  const hex = palette[type] || '#6ee7b7'
  return hexA(hex, alpha)
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
