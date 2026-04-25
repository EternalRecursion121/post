// Spam / abuse controls. Sits between the inbox drain and the local bee:
// every inbound envelope (chat or tool.invoke) gets filtered here for size
// caps, per-peer rate limits, and an auto-block heuristic.
//
// Config is read from env vars at construction so deployments can dial it
// without code changes. Anything left unset uses the DEFAULTS below.

const DEFAULTS = {
  chatUnknown: 10,                 // chat msgs / window from non-contacts
  invokeUnknown: 3,                // tool.invoke / window from non-contacts
  windowMs: 60_000,                // rate limit window (1 minute)
  maxChatBytes: 64 * 1024,         // ciphertext cap for chat
  maxInvokeBytes: 256 * 1024,      // ciphertext cap for tool.invoke args
  autoBlockTrips: 3,               // trips that trigger auto-block
  autoBlockWindowMs: 10 * 60_000,  // window over which trips count
  noticeCooldownMs: 5 * 60_000     // min interval between rate-limit notices
}

export function loadAbuseConfig (env = process.env, overrides = {}) {
  const num = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    chatUnknown: num(env.PEARPOST_RATE_CHAT_UNKNOWN, DEFAULTS.chatUnknown),
    invokeUnknown: num(env.PEARPOST_RATE_INVOKE_UNKNOWN, DEFAULTS.invokeUnknown),
    windowMs: num(env.PEARPOST_RATE_WINDOW_MS, DEFAULTS.windowMs),
    maxChatBytes: num(env.PEARPOST_MAX_CHAT_BYTES, DEFAULTS.maxChatBytes),
    maxInvokeBytes: num(env.PEARPOST_MAX_INVOKE_BYTES, DEFAULTS.maxInvokeBytes),
    autoBlockTrips: num(env.PEARPOST_AUTOBLOCK_TRIPS, DEFAULTS.autoBlockTrips),
    autoBlockWindowMs: num(env.PEARPOST_AUTOBLOCK_WINDOW_MS, DEFAULTS.autoBlockWindowMs),
    noticeCooldownMs: num(env.PEARPOST_NOTICE_COOLDOWN_MS, DEFAULTS.noticeCooldownMs),
    ...overrides
  }
}

export class AbuseGuard {
  constructor ({ config, isContact, isBlocked, log } = {}) {
    this.cfg = config || loadAbuseConfig()
    this.isContact = isContact || (() => false)
    this.isBlocked = isBlocked || (async () => false)
    this.log = log || ((...a) => console.warn('[pearpost abuse]', ...a))
    this.hits = new Map()      // hex -> { chat: [ts], invoke: [ts] }
    this.trips = new Map()     // hex -> [trip ts]
    this.notices = new Map()   // hex -> last notice ts
  }

  // Cheap pre-decrypt size check. Returns true if envelope is within cap
  // for its type. Non-chat / non-invoke types are always allowed.
  sizeOk (env, ciphertextSize) {
    if (env.type === 'tool.invoke') return ciphertextSize <= this.cfg.maxInvokeBytes
    if (env.type === 'chat') return ciphertextSize <= this.cfg.maxChatBytes
    return true
  }

  maxBytesFor (type) {
    if (type === 'tool.invoke') return this.cfg.maxInvokeBytes
    if (type === 'chat') return this.cfg.maxChatBytes
    return Infinity
  }

  // Run all inbound checks. Returns:
  //   { ok: true,  bucket: 'main' | 'requests' }   — pass through
  //   { ok: false, reason, notify, autoBlocked }  — drop
  async checkInbound (env, ciphertextSize) {
    const hex = env.from
    if (await this.isBlocked(hex)) {
      return { ok: false, reason: 'blocked', notify: false, autoBlocked: false }
    }

    const isInvoke = env.type === 'tool.invoke'
    const isChat = env.type === 'chat'
    const rateable = isInvoke || isChat

    if (rateable && !this.sizeOk(env, ciphertextSize)) {
      this.log('size cap exceeded', short(hex), env.type, ciphertextSize, '>', this.maxBytesFor(env.type))
      return { ok: false, reason: 'size cap exceeded', notify: false, autoBlocked: false }
    }

    const contact = await this.isContact(hex)

    if (!contact && rateable) {
      const limit = isInvoke ? this.cfg.invokeUnknown : this.cfg.chatUnknown
      if (limit >= 0 && this._tripped(hex, isInvoke ? 'invoke' : 'chat', limit)) {
        const tripCount = this._recordTrip(hex)
        let autoBlocked = false
        if (this.cfg.autoBlockTrips > 0 && tripCount >= this.cfg.autoBlockTrips) {
          autoBlocked = true
          this.log('auto-block', short(hex), 'after', tripCount, 'rate-limit trips')
        }
        const notify = !autoBlocked && this._noticeOk(hex)
        if (notify) this.notices.set(hex, Date.now())
        this.log('rate-limit drop', short(hex), env.type)
        return { ok: false, reason: 'rate limit', notify, autoBlocked }
      }
    }

    // Any direct message from a non-contact lands in the requests
    // quarantine — not just chat/invoke. task.request, presence, etc.
    // from strangers are equally untrusted.
    return { ok: true, bucket: contact ? 'main' : 'requests' }
  }

  // For tests: drop accumulated state for a peer.
  forget (hex) {
    this.hits.delete(hex)
    this.trips.delete(hex)
    this.notices.delete(hex)
  }

  _tripped (hex, kind, limit) {
    const now = Date.now()
    const cutoff = now - this.cfg.windowMs
    const buckets = this.hits.get(hex) || { chat: [], invoke: [] }
    const arr = (buckets[kind] || []).filter(t => t >= cutoff)
    arr.push(now)
    buckets[kind] = arr
    this.hits.set(hex, buckets)
    return arr.length > limit
  }

  _recordTrip (hex) {
    const now = Date.now()
    const cutoff = now - this.cfg.autoBlockWindowMs
    const trips = (this.trips.get(hex) || []).filter(t => t >= cutoff)
    trips.push(now)
    this.trips.set(hex, trips)
    return trips.length
  }

  _noticeOk (hex) {
    const last = this.notices.get(hex)
    if (!last) return true
    return Date.now() - last >= this.cfg.noticeCooldownMs
  }
}

function short (hex) { return typeof hex === 'string' ? hex.slice(0, 12) : hex }
