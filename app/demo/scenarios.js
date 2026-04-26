// Scripted scenarios for the PearPost demo.
//
// Each scenario has a stable node layout (positions normalized 0..1) and an
// ordered list of script steps. A step is a typed event the UI consumes to
// update the graph and timeline. Steps are deterministic and resettable, so
// the demo behaves the same on stage as in rehearsal.
//
// Node kinds: human | agent | delegate | sandbox | tool | service | business

import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'skyscanner-search.json')

function loadSkyscannerFixture () {
  try {
    if (!existsSync(FIXTURE_PATH)) return null
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function fmtTime (dt) {
  if (!dt) return '—'
  const hh = String(dt.hour ?? 0).padStart(2, '0')
  const mm = String(dt.minute ?? 0).padStart(2, '0')
  return `${hh}:${mm}`
}

function summariseLeg (leg) {
  if (!leg) return null
  const seg = leg.segments?.[0]
  return {
    from: leg.from,
    to: leg.to,
    depart: fmtTime(leg.depart),
    arrive: fmtTime(leg.arrive),
    durationMin: leg.durationMin,
    stops: leg.stops,
    flight: seg?.flightNumber,
    carrier: seg?.carrier
  }
}

function discountedPP (perAdult, fixture) {
  if (!perAdult || !fixture?.groupDiscount) return perAdult
  const pct = fixture.groupDiscount.percentOff || 0
  return Math.round(perAdult * (1 - pct / 100))
}

const FIXTURE = loadSkyscannerFixture()

const SKYSCANNER_DETAIL = (() => {
  if (!FIXTURE) {
    return {
      bcn: { perAdult: 612, totalForThree: 1836, outbound: { from: 'LHR', to: 'BCN', depart: '19:25', arrive: '22:50', flight: 'VY6653', carrier: 'Vueling Airlines', stops: 0 }, ret: { from: 'BCN', to: 'LHR', depart: '07:30', arrive: '09:10', flight: 'VY6650', carrier: 'Vueling Airlines', stops: 0 } },
      lis: { perAdult: 690, totalForThree: 2070, outbound: { from: 'LHR', to: 'LIS', depart: '19:50', arrive: '22:40', flight: 'TP1369', carrier: 'TAP Air Portugal', stops: 0 }, ret: null },
      discount: { pct: 12, perAdultOff: 70, expires: 'tonight' }
    }
  }
  const bcnOpt = FIXTURE.options?.barcelona
  const lisOpt = FIXTURE.options?.lisbon
  const bcnPerAdult = bcnOpt?.pricePerAdultGBP || 0
  const lisPerAdult = lisOpt?.pricePerAdultGBP || 0
  return {
    bcn: {
      perAdult: bcnPerAdult,
      perAdultDiscounted: discountedPP(bcnPerAdult, FIXTURE),
      totalForThree: Math.round(bcnPerAdult * 3),
      outbound: summariseLeg(bcnOpt?.legs?.[0]),
      ret: summariseLeg(bcnOpt?.legs?.[1]),
      bookingAgent: bcnOpt?.bookingAgent
    },
    lis: {
      perAdult: lisPerAdult,
      totalForThree: Math.round(lisPerAdult * 3),
      outbound: summariseLeg(lisOpt?.legs?.[0]),
      ret: summariseLeg(lisOpt?.legs?.[1]),
      bookingAgent: lisOpt?.bookingAgent
    },
    discount: {
      pct: FIXTURE.groupDiscount?.percentOff || 12,
      perAdultOff: FIXTURE.groupDiscount?.perAdultOff || 70,
      expires: 'tonight'
    },
    capturedAt: FIXTURE.capturedAt,
    source: 'skyscanner partners.api · live capture'
  }
})()

export const SCENARIOS = [
  {
    id: 'pears',
    track: 'Pears',
    title: 'Pears — Pairing & Contacts',
    subtitle: 'Pairing, contacts, encrypted P2P chat — no server.',
    why: 'No server, no account, no gateway. Pairing creates explicit contacts before richer communication happens. Every event below is a typed P2P agent envelope.',
    nodes: [
      { id: 'alice',    label: 'Alice',         kind: 'agent',   x: 0.18, y: 0.55, sublabel: 'pear+agent://a1c…' },
      { id: 'bob',      label: 'Bob',           kind: 'agent',   x: 0.82, y: 0.55, sublabel: 'pear+agent://b0b…' },
      { id: 'dht',      label: 'Pear DHT',      kind: 'service', x: 0.50, y: 0.18, sublabel: 'no central server' },
      { id: 'contacts', label: 'Contacts Book', kind: 'tool',    x: 0.50, y: 0.85, sublabel: 'local, on-disk' }
    ],
    steps: [
      {
        id: 'pears-1',
        title: 'Alice comes online',
        caption: 'Alice starts with a persistent pear+agent:// identity.',
        why: 'Each agent has its own keypair and DHT-routable address. No central account.',
        type: 'presence', from: 'alice', to: 'dht',
        body: { state: 'online', address: 'pear+agent://a1c8…' },
        cmd: 'pearpost id'
      },
      {
        id: 'pears-2',
        title: 'Bob comes online',
        caption: 'Bob runs the same protocol on a different machine.',
        why: 'Two independent peers join the DHT. No bootstrapping account, no handshake server.',
        type: 'presence', from: 'bob', to: 'dht',
        body: { state: 'online', address: 'pear+agent://b0b4…' },
        cmd: 'pearpost id'
      },
      {
        id: 'pears-3',
        title: 'Alice generates a pairing code',
        caption: 'Alice sends Bob a one-time pairing code: "alpha-bravo-7".',
        why: 'Pairing is explicit and human-witnessable, not a silent friending.',
        type: 'pairing', from: 'alice', to: 'bob',
        body: { code: 'alpha-bravo-7', ttl: '5m' },
        cmd: 'pearpost pair'
      },
      {
        id: 'pears-4',
        title: 'Bob redeems the code',
        caption: 'Bob runs `pearpost pair alpha-bravo-7` and is paired.',
        why: 'The DHT lookup is keyed by the code; a successful redeem swaps long-term identities.',
        type: 'pairing.accepted', from: 'bob', to: 'alice',
        body: { code: 'alpha-bravo-7', confirmed: true },
        cmd: 'pearpost pair alpha-bravo-7'
      },
      {
        id: 'pears-5',
        title: 'Alice adds Bob to contacts',
        caption: 'Alice writes Bob into her local contacts book.',
        why: 'Contacts are local, not gossiped to a directory. Trust is earned per-pair.',
        type: 'contact.added', from: 'alice', to: 'contacts',
        body: { contact: 'bob', alias: 'Bob' }
      },
      {
        id: 'pears-6',
        title: 'Bob adds Alice to contacts',
        caption: 'Bob does the symmetric write on his side.',
        why: 'Each side independently chooses to trust the other. Either can revoke locally.',
        type: 'contact.added', from: 'bob', to: 'contacts',
        body: { contact: 'alice', alias: 'Alice' }
      },
      {
        id: 'pears-7',
        title: 'Alice sends an encrypted note',
        caption: 'Alice → Bob: "hey — here is the integration plan for tonight."',
        why: 'Direct encrypted messaging. The body is sealed to Bob; nobody else can read it.',
        type: 'chat', from: 'alice', to: 'bob',
        body: { text: 'hey — here is the integration plan for tonight.' },
        cmd: 'pearpost chat <bob> "hey — here is the integration plan for tonight."'
      },
      {
        id: 'pears-8',
        title: 'Bob acks receipt',
        caption: 'Bob → Alice: ack ✓✓ delivered & read.',
        why: 'Acks are typed envelopes too — the whole protocol is observable.',
        type: 'ack', from: 'bob', to: 'alice',
        body: { for: 'pears-7', state: 'read' }
      },
      {
        id: 'pears-9',
        title: 'Bob restarts; state survives',
        caption: 'Bob restarts. Contact list and inbox are still on disk.',
        why: 'PearPost stores everything locally on Hypercore. Identity, contacts, threads are durable.',
        type: 'presence', from: 'bob', to: 'dht',
        body: { state: 'restored', persisted: true }
      }
    ]
  },

  {
    id: 'spoons',
    track: 'Bending Spoons',
    title: 'Bending Spoons — Delegate Coordination',
    subtitle: 'Alice and Bob both have delegates that coordinate on their behalf.',
    why: 'Delegates increase communication bandwidth between people. Less raw context shared, more effective coordination — humans stay in control.',
    nodes: [
      { id: 'alice',          label: 'Alice',           kind: 'human',    x: 0.12, y: 0.18, sublabel: 'human · release lead' },
      { id: 'alice-delegate', label: 'Alice Delegate',  kind: 'delegate', x: 0.30, y: 0.55, sublabel: 'knows: Alice context' },
      { id: 'bob',            label: 'Bob',             kind: 'human',    x: 0.88, y: 0.18, sublabel: 'human · focus mode' },
      { id: 'bob-delegate',   label: 'Bob Delegate',    kind: 'delegate', x: 0.70, y: 0.55, sublabel: 'knows: Bob calendar+code' },
      { id: 'calendar',       label: 'Calendar / Project Ctx', kind: 'tool', x: 0.50, y: 0.88, sublabel: 'read-only' }
    ],
    steps: [
      {
        id: 'spoons-1',
        title: 'Alice asks her delegate',
        caption: 'Alice → Alice Delegate: "Can you coordinate with Bob about whether we can safely ship the integration demo tonight?"',
        why: 'Humans speak naturally to their own delegate. The delegate carries the rich context the other side will not see.',
        type: 'chat', from: 'alice', to: 'alice-delegate',
        body: { text: 'Coordinate with Bob about whether we can safely ship the integration demo tonight.' }
      },
      {
        id: 'spoons-2',
        title: 'Alice Delegate sends a structured task',
        caption: 'Alice Delegate → Bob Delegate: task.request "ship-review" — context: release tonight, low risk tolerance, minimal interruption.',
        why: 'Not a vague chat. Delegates exchange structured asks with the minimum context needed to decide.',
        type: 'task.request', from: 'alice-delegate', to: 'bob-delegate',
        body: {
          title: 'ship-review: integration demo',
          context: { event: 'release-window', deadline: 'tonight', risk: 'low-tolerance', interrupt: 'minimal' },
          asks: ['can-we-ship-tonight', 'what-blocks']
        }
      },
      {
        id: 'spoons-3',
        title: 'Bob Delegate looks up Bob',
        caption: 'Bob Delegate → Calendar/Project Ctx: tool.invoke read("bob.availability + bob.repo.state").',
        why: 'Private context (Bob\'s schedule, current branch, review preferences) stays on Bob\'s side, mediated by his delegate.',
        type: 'tool.invoke', from: 'bob-delegate', to: 'calendar',
        body: { name: 'lookup', args: { who: 'bob', fields: ['availability', 'project', 'review-style'] } }
      },
      {
        id: 'spoons-4',
        title: 'Calendar returns Bob context',
        caption: 'Calendar → Bob Delegate: focus mode now, free in 45m, frontend depends on API shape, prefers concrete diffs.',
        why: 'The tool exposes only what the delegate needs — not Bob\'s whole calendar.',
        type: 'tool.result', from: 'calendar', to: 'bob-delegate',
        body: {
          ok: true,
          value: {
            availability: { state: 'focus', freeIn: '45m' },
            project: { branch: 'feature/profile-settings', depends_on: 'api.profile.shape' },
            reviewStyle: 'wants-concrete-diff-and-question'
          }
        }
      },
      {
        id: 'spoons-5',
        title: 'Bob Delegate negotiates',
        caption: 'Bob Delegate → Alice Delegate: I can answer async; Bob needs the exact diff + the specific question. Risk if `user.name` removed.',
        why: 'Delegate-to-delegate negotiation extracts a smaller, sharper ask before disturbing the human.',
        type: 'task.result', from: 'bob-delegate', to: 'alice-delegate',
        body: {
          status: 'progress',
          note: 'need-refinement',
          asks: ['send focused diff', 'name the exact field changing'],
          flags: ['risk if user.name removed from auth callback']
        }
      },
      {
        id: 'spoons-6',
        title: 'Alice Delegate refines the ask',
        caption: 'Alice Delegate → Bob Delegate: refined diff summary — auth.js removes `user.name`, adds `profile.displayName`.',
        why: 'The delegate translates Alice\'s rough intent into the form Bob actually wants.',
        type: 'task.request', from: 'alice-delegate', to: 'bob-delegate',
        body: {
          title: 'ship-review: refined',
          diff_summary: { removed: ['user.name'], added: ['profile.displayName'], file: 'auth.js' },
          inReplyTo: 'spoons-2'
        }
      },
      {
        id: 'spoons-7',
        title: 'Bob Delegate decides',
        caption: 'Bob Delegate → Alice Delegate: safe if response keeps `profile.displayName`; risk only if the auth callback changes shape. Bob can review after 15:00.',
        why: 'The decision is concrete, sourced, and reversible — exactly what a time-sensitive review needs.',
        type: 'task.result', from: 'bob-delegate', to: 'alice-delegate',
        body: {
          status: 'done',
          decision: 'safe-to-ship',
          conditions: ['keep profile.displayName', 'no auth-callback shape change'],
          followUp: { who: 'bob', when: '15:00', item: 'visual settings page review' }
        }
      },
      {
        id: 'spoons-8',
        title: 'Alice gets her summary',
        caption: 'Alice Delegate → Alice: "Saved you a meeting. Bob says safe to ship if you keep profile.displayName. Focused review queued for 15:00."',
        why: 'Alice gets exactly what she needed: a decision, the condition, and a queued follow-up. No back-and-forth chat.',
        type: 'chat', from: 'alice-delegate', to: 'alice',
        body: { text: 'Saved you a meeting. Bob says: safe to ship if you keep profile.displayName. Focused review queued for 15:00.' }
      },
      {
        id: 'spoons-9',
        title: 'Bob gets his summary',
        caption: 'Bob Delegate → Bob: "Handled Alice\'s coordination request. One concrete review item for you at 15:00."',
        why: 'Bob is not interrupted; one concrete task is queued in his preferred form.',
        type: 'chat', from: 'bob-delegate', to: 'bob',
        body: { text: 'Handled Alice\'s coordination. One concrete review item queued for 15:00 — settings page visual.' }
      }
    ]
  },

  {
    id: 'skyscanner',
    track: 'Skyscanner',
    title: 'Skyscanner — OpenClaw Plans a Friend Holiday',
    subtitle: 'Alice\'s OpenClaw negotiates with Bob\'s and Maiya\'s, then haggles a discount.',
    why: 'Each traveler has a personal agent with private constraints. Agents negotiate without centralizing budget/calendar/preferences. Travel businesses can join as agents too.',
    nodes: [
      { id: 'alice',        label: 'Alice',          kind: 'human',    x: 0.10, y: 0.20, sublabel: 'human · trip lead' },
      { id: 'alice-claw',   label: 'Alice OpenClaw', kind: 'delegate', x: 0.28, y: 0.50, sublabel: 'budget £650 · LON' },
      { id: 'bob-claw',     label: 'Bob OpenClaw',   kind: 'delegate', x: 0.72, y: 0.25, sublabel: 'budget £900' },
      { id: 'maya-claw',    label: 'Maiya OpenClaw',  kind: 'delegate', x: 0.74, y: 0.60, sublabel: 'low-walking · veg' },
      { id: 'travel-agent', label: 'Travel Agent',   kind: 'business', x: 0.50, y: 0.88, sublabel: 'business agent' }
    ],
    steps: [
      {
        id: 'sky-1',
        title: 'Alice OpenClaw asks Alice for prefs',
        caption: 'Alice OpenClaw → Alice: "Before I coordinate the group trip, what is your max budget, departure airport, and hard no-gos?"',
        why: 'The delegate asks once, up-front, before spending any cycles negotiating.',
        type: 'chat', from: 'alice-claw', to: 'alice',
        body: { text: 'Before I coordinate the group trip — max budget? departure airport? hard no-gos?' }
      },
      {
        id: 'sky-2',
        title: 'Alice answers',
        caption: 'Alice → Alice OpenClaw: "max £650, London airports, warm city, no overnight layovers, ideally 4 days late June."',
        why: 'Alice\'s constraints stay on her side. Her delegate is the only thing that ever sees them in full.',
        type: 'chat', from: 'alice', to: 'alice-claw',
        body: { text: 'max £650, London, warm city, no overnight layovers, ideally 4 days late June.' }
      },
      {
        id: 'sky-3',
        title: 'Query Bob\'s OpenClaw',
        caption: 'Alice OpenClaw → Bob OpenClaw: task.request "trip-prefs" — only the question shape, not Alice\'s budget.',
        why: 'Agents exchange the minimum needed for compatibility checks. No budgets are leaked.',
        type: 'task.request', from: 'alice-claw', to: 'bob-claw',
        body: { title: 'trip-prefs', window: 'late-June', duration: '4d', from: 'LON-area' }
      },
      {
        id: 'sky-4',
        title: 'Bob\'s OpenClaw replies',
        caption: 'Bob OpenClaw → Alice OpenClaw: "Up to £900, hates layovers > 2h, wants food/nightlife."',
        why: 'Each side returns the slice of preferences relevant to the negotiation.',
        type: 'task.result', from: 'bob-claw', to: 'alice-claw',
        body: { status: 'done', value: { budget_max: 900, max_layover_h: 2, vibe: ['food', 'nightlife'] } }
      },
      {
        id: 'sky-5',
        title: 'Query Maiya\'s OpenClaw',
        caption: 'Alice OpenClaw → Maiya OpenClaw: task.request "trip-prefs".',
        why: 'Same structured ask, fan-out — three travelers, parallel negotiation.',
        type: 'task.request', from: 'alice-claw', to: 'maya-claw',
        body: { title: 'trip-prefs', window: 'late-June', duration: '4d', from: 'LON-area' }
      },
      {
        id: 'sky-6',
        title: 'Maiya\'s OpenClaw replies',
        caption: 'Maiya OpenClaw → Alice OpenClaw: "Low-walking itinerary, vegetarian options, cannot leave before Friday evening."',
        why: 'Accessibility and dietary constraints surfaced as data, not as a chat thread to wade through.',
        type: 'task.result', from: 'maya-claw', to: 'alice-claw',
        body: { status: 'done', value: { walking: 'low', diet: 'vegetarian', earliest_depart: 'Fri evening' } }
      },
      {
        id: 'sky-7',
        title: 'Alice OpenClaw proposes two trips',
        caption: `Alice OpenClaw → Bob & Maiya: "Lisbon (£${SKYSCANNER_DETAIL.lis.perAdult}pp on ${SKYSCANNER_DETAIL.lis.outbound?.carrier || 'TAP'}) vs Barcelona (£${SKYSCANNER_DETAIL.bcn.perAdult}pp on ${SKYSCANNER_DETAIL.bcn.outbound?.carrier || 'Vueling'}) — both direct."`,
        why: 'Real Skyscanner-priced options. The lead delegate synthesizes, then asks the others to react to concrete itineraries — the winning city should be the best fit for the group, not pre-chosen.',
        type: 'task.request', from: 'alice-claw', to: 'bob-claw',
        body: {
          title: 'trip-options',
          source: SKYSCANNER_DETAIL.source || 'skyscanner',
          options: [
            {
              city: 'Lisbon',
              outbound: SKYSCANNER_DETAIL.lis.outbound,
              return: SKYSCANNER_DETAIL.lis.ret,
              estimated_pp: SKYSCANNER_DETAIL.lis.perAdult,
              estimated_total: SKYSCANNER_DETAIL.lis.totalForThree,
              walking: 'medium', food: 'great'
            },
            {
              city: 'Barcelona',
              outbound: SKYSCANNER_DETAIL.bcn.outbound,
              return: SKYSCANNER_DETAIL.bcn.ret,
              estimated_pp: SKYSCANNER_DETAIL.bcn.perAdult,
              estimated_total: SKYSCANNER_DETAIL.bcn.totalForThree,
              walking: 'medium-low with central hotel', food: 'great',
              note: 'eligible for group discount'
            }
          ]
        }
      },
      {
        id: 'sky-8',
        title: 'Bob prefers Barcelona with direct flights',
        caption: 'Bob OpenClaw → Alice OpenClaw: "Barcelona works if flights are direct and transfer stays under 45m."',
        why: 'Constraints are checked automatically. The agent does not just vote; it returns conditions that make the trip acceptable.',
        type: 'task.result', from: 'bob-claw', to: 'alice-claw',
        body: { status: 'done', value: { accept: 'Barcelona', conditions: ['direct flights', 'airport transfer <45m'], reject_if: 'layover>2h' } }
      },
      {
        id: 'sky-9',
        title: 'Maiya conditional on Barcelona',
        caption: 'Maiya OpenClaw → Alice OpenClaw: "Barcelona ok if hotel is central and itinerary is low-walking."',
        why: 'Negotiation captures constraints as conditions, not blockers.',
        type: 'task.result', from: 'maya-claw', to: 'alice-claw',
        body: { status: 'done', value: { accept: 'Barcelona', conditions: ['central hotel', 'low-walking itinerary', 'vegetarian options'] } }
      },
      {
        id: 'sky-10',
        title: 'Alice OpenClaw refines Barcelona plan',
        caption: 'Alice OpenClaw → Bob & Maiya: "Revised Barcelona: direct flights, central hotel, low-walking, Friday evening departure."',
        why: 'The proposal is shaped by the union of constraints: Alice’s budget, Bob’s layover constraint, and Maiya’s accessibility needs.',
        type: 'task.request', from: 'alice-claw', to: 'maya-claw',
        body: { title: 'barcelona-revised', hotel: 'central', itinerary: 'low-walking', depart: 'Fri-evening', flights: 'direct' }
      },
      {
        id: 'sky-11',
        title: 'Alice OpenClaw asks Travel Agent',
        caption: `Alice OpenClaw → Travel Agent: "3 travelers, late June, Barcelona currently best matches preferences (£${SKYSCANNER_DETAIL.bcn.perAdult}pp on ${SKYSCANNER_DETAIL.bcn.outbound?.carrier || 'Vueling'}) — can you improve the package?"`,
        why: 'A travel business can be an agent peer too — same envelope shape, same protocol. The quote is sourced from a live Skyscanner search.',
        type: 'task.request', from: 'alice-claw', to: 'travel-agent',
        body: {
          title: 'group-package-quote',
          city: 'Barcelona',
          travelers: 3,
          window: 'late-June',
          flexible: true,
          baseline: {
            outbound: SKYSCANNER_DETAIL.bcn.outbound,
            return: SKYSCANNER_DETAIL.bcn.ret,
            pp: SKYSCANNER_DETAIL.bcn.perAdult,
            total: SKYSCANNER_DETAIL.bcn.totalForThree,
            source: SKYSCANNER_DETAIL.source || 'skyscanner'
          },
          reason: 'best preference match before discount'
        }
      },
      {
        id: 'sky-12',
        title: 'Travel Agent offers a Barcelona discount',
        caption: `Travel Agent → Alice OpenClaw: offer "Barcelona gets ${SKYSCANNER_DETAIL.discount.pct}% group discount / £${SKYSCANNER_DETAIL.discount.perAdultOff} off pp if booked ${SKYSCANNER_DETAIL.discount.expires}."`,
        why: 'The travel agent changes the decision frontier: Barcelona now satisfies the group and beats the budget.',
        type: 'offer', from: 'travel-agent', to: 'alice-claw',
        body: {
          city: 'Barcelona',
          baseline_pp: SKYSCANNER_DETAIL.bcn.perAdult,
          discounted_pp: SKYSCANNER_DETAIL.bcn.perAdultDiscounted ?? Math.round(SKYSCANNER_DETAIL.bcn.perAdult * (1 - SKYSCANNER_DETAIL.discount.pct / 100)),
          options: [
            { kind: 'group-discount', pct: SKYSCANNER_DETAIL.discount.pct, expires: SKYSCANNER_DETAIL.discount.expires },
            { kind: 'flat-discount-pp', amount: SKYSCANNER_DETAIL.discount.perAdultOff, currency: 'GBP', expires: SKYSCANNER_DETAIL.discount.expires }
          ],
          notes: 'package includes central hotel + direct outbound'
        }
      },
      {
        id: 'sky-13',
        title: 'Alice OpenClaw recommends Barcelona',
        caption: (() => {
          const dpp = SKYSCANNER_DETAIL.bcn.perAdultDiscounted ?? Math.round(SKYSCANNER_DETAIL.bcn.perAdult * (1 - SKYSCANNER_DETAIL.discount.pct / 100))
          return `Alice OpenClaw → Alice: "Barcelona — £${dpp}pp after group discount, direct outbound on ${SKYSCANNER_DETAIL.bcn.outbound?.carrier || 'Vueling'} ${SKYSCANNER_DETAIL.bcn.outbound?.flight || ''}, central hotel, low-walking. It wins because the travel agent discount makes the best preference match fit everyone's budget."`
        })(),
        why: 'One human-readable summary, with constraints satisfied and the offer applied — sourced from a real Skyscanner search. Alice sees why Barcelona won instead of having to compare every raw itinerary herself.',
        type: 'chat', from: 'alice-claw', to: 'alice',
        body: {
          text: (() => {
            const dpp = SKYSCANNER_DETAIL.bcn.perAdultDiscounted ?? Math.round(SKYSCANNER_DETAIL.bcn.perAdult * (1 - SKYSCANNER_DETAIL.discount.pct / 100))
            return `Recommend Barcelona — £${dpp}pp after group discount (${SKYSCANNER_DETAIL.bcn.outbound?.carrier || 'Vueling'} ${SKYSCANNER_DETAIL.bcn.outbound?.flight || ''}, ${SKYSCANNER_DETAIL.bcn.outbound?.depart}→${SKYSCANNER_DETAIL.bcn.outbound?.arrive}, direct), central hotel, low-walking. It wins because the travel agent discount makes the best preference match fit everyone's budget. Ask everyone for final approval?`
          })()
        }
      }
    ]
  },

  {
    id: 'jetbrains',
    track: 'JetBrains',
    title: 'JetBrains — Sandboxed Dev Agents',
    subtitle: 'Constrained sandbox agents fix a bug, with cross-developer impact check.',
    why: 'Agents communicate inside a sandbox with constrained permissions. Every tool result and proposed patch is visible. Cross-developer coordination happens through delegates instead of Slack archaeology.',
    nodes: [
      { id: 'alice-ide',     label: 'Alice IDE',       kind: 'agent',   x: 0.12, y: 0.50, sublabel: 'dev agent' },
      { id: 'repo-inspector',label: 'Repo Inspector',  kind: 'sandbox', x: 0.42, y: 0.18, sublabel: 'read-only' },
      { id: 'test-runner',   label: 'Test Runner',     kind: 'sandbox', x: 0.50, y: 0.50, sublabel: 'tests · no edits' },
      { id: 'patch-proposer',label: 'Patch Proposer',  kind: 'sandbox', x: 0.42, y: 0.82, sublabel: 'propose · no apply' },
      { id: 'bob-ide',       label: 'Bob IDE',         kind: 'agent',   x: 0.88, y: 0.50, sublabel: 'dev agent · frontend' }
    ],
    steps: [
      {
        id: 'jb-1',
        title: 'Spawn Repo Inspector',
        caption: 'Alice IDE → spawn Repo Inspector (read-only).',
        why: 'Sandboxes are typed by capability. Repo Inspector cannot edit or hit the network.',
        type: 'sandbox.spawn', from: 'alice-ide', to: 'repo-inspector',
        body: { permissions: ['repo:read'], denied: ['repo:write', 'net'] }
      },
      {
        id: 'jb-2',
        title: 'Spawn Test Runner',
        caption: 'Alice IDE → spawn Test Runner (run tests, no edits, no network).',
        why: 'Capabilities are visible in the graph — judges see exactly what each sandbox can do.',
        type: 'sandbox.spawn', from: 'alice-ide', to: 'test-runner',
        body: { permissions: ['tests:run'], denied: ['repo:write', 'net'] }
      },
      {
        id: 'jb-3',
        title: 'Spawn Patch Proposer',
        caption: 'Alice IDE → spawn Patch Proposer (propose diffs only; cannot apply without human approval).',
        why: 'Write actions are gated by an explicit human-approval capability, not by trust.',
        type: 'sandbox.spawn', from: 'alice-ide', to: 'patch-proposer',
        body: { permissions: ['diff:propose'], denied: ['diff:apply', 'repo:write', 'net'] }
      },
      {
        id: 'jb-4',
        title: 'Find the bug',
        caption: 'Alice IDE → Repo Inspector: task.request "locate failing auth callback test".',
        why: 'A focused task, not a freeform chat. Sandboxes act on structured asks.',
        type: 'task.request', from: 'alice-ide', to: 'repo-inspector',
        body: { title: 'locate-failure', signal: 'auth-callback test fails after login refactor' }
      },
      {
        id: 'jb-5',
        title: 'Repo Inspector returns findings',
        caption: 'Repo Inspector → Alice IDE: "auth.js:142 removed `user.name`; callback expects `user.name`."',
        why: 'Result is a structured finding with a file/line cite — easy to verify.',
        type: 'task.result', from: 'repo-inspector', to: 'alice-ide',
        body: {
          status: 'done',
          value: { file: 'auth.js', line: 142, removed: 'user.name', expected_by: 'login.callback' }
        }
      },
      {
        id: 'jb-6',
        title: 'Run focused test',
        caption: 'Alice IDE → Test Runner: tool.invoke run("auth/callback.test.js").',
        why: 'The IDE agent picks the smallest test scope that proves the bug.',
        type: 'tool.invoke', from: 'alice-ide', to: 'test-runner',
        body: { name: 'run', args: { suite: 'auth/callback.test.js' } }
      },
      {
        id: 'jb-7',
        title: 'Test fails as predicted',
        caption: 'Test Runner → Alice IDE: "fail · TypeError: cannot read `name` of undefined."',
        why: 'Failure is captured as data — not a console screenshot to scroll.',
        type: 'tool.result', from: 'test-runner', to: 'alice-ide',
        body: { ok: true, value: { passed: 0, failed: 1, error: 'TypeError: cannot read name of undefined', at: 'auth/callback.test.js:38' } }
      },
      {
        id: 'jb-8',
        title: 'Propose a patch',
        caption: 'Alice IDE → Patch Proposer: task.request "use profile.displayName, fall back to user.name".',
        why: 'The patch is proposed inside a sandbox that cannot apply without approval.',
        type: 'task.request', from: 'alice-ide', to: 'patch-proposer',
        body: { title: 'fix-auth-callback', strategy: 'prefer profile.displayName, fall back to user.name' }
      },
      {
        id: 'jb-9',
        title: 'Diff proposed (needs approval)',
        caption: 'Patch Proposer → Alice IDE: diff ready, marked "requires human approval".',
        why: 'Apply is gated. Even a perfect diff does not land without a human nod.',
        type: 'task.result', from: 'patch-proposer', to: 'alice-ide',
        body: {
          status: 'done',
          value: {
            diff: '- const name = user.name\n+ const name = profile.displayName ?? user.name',
            approval: 'required'
          }
        }
      },
      {
        id: 'jb-10',
        title: 'Ask Bob\'s IDE',
        caption: 'Alice IDE → Bob IDE: "Does removing user.name break the frontend branch?"',
        why: 'Cross-developer impact check, agent-to-agent. No Slack archaeology, no cold paste of the diff.',
        type: 'task.request', from: 'alice-ide', to: 'bob-ide',
        body: { title: 'cross-impact', removed: 'user.name', added: 'profile.displayName' }
      },
      {
        id: 'jb-11',
        title: 'Bob\'s IDE replies',
        caption: 'Bob IDE → Alice IDE: "Settings page reads user.name; safe if profile.displayName is present."',
        why: 'Bob\'s delegate inspects his branch and answers with a concrete, sourced compatibility note.',
        type: 'task.result', from: 'bob-ide', to: 'alice-ide',
        body: {
          status: 'done',
          value: { breaks: ['settings.page reads user.name'], safe_if: 'profile.displayName present', refs: ['frontend/settings.tsx:74'] }
        }
      },
      {
        id: 'jb-12',
        title: 'Summary to Alice',
        caption: 'Alice IDE → Alice: "Sandbox found the bug, proposed a patch, Bob flagged one compat constraint."',
        why: 'A single, complete picture — root cause, proposed fix, gating approval, cross-dev compat.',
        type: 'chat', from: 'alice-ide', to: 'alice',
        body: { text: 'Sandbox found auth.js:142. Patch proposed (needs approval). Bob: safe iff profile.displayName remains.' }
      }
    ]
  }
]

export function getScenario (id) {
  return SCENARIOS.find(s => s.id === id) || null
}

export function listScenarios () {
  return SCENARIOS.map(s => ({
    id: s.id,
    track: s.track,
    title: s.title,
    subtitle: s.subtitle,
    why: s.why,
    nodes: s.nodes.length,
    steps: s.steps.length
  }))
}
