---
name: pearpost-hackathon-demo
description: Design and implement deterministic PearPost hackathon demos with scripted agents, tmux theater, real backend events, and browser graph visualization.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [pearpost, demo, hackathon, tmux, scripted-agents, graph-ui]
    related_skills: [pearpost, claude-code]
---

# PearPost Demo Workflow

## Critical lessons from implementation

- Do not conflate the demo/judging context with the in-world scenario. It is fine that the project is for a hackathon, but Alice/Bob/Maiya in the story should not mention being at a hackathon unless that is explicitly the fictional scenario. Keep scenario motivations product-realistic.
- For the Skyscanner travel demo, Barcelona should win because it is the best discounted city that satisfies the group’s preferences, not because the real-world hackathon is in Barcelona.
- Spell Maiya as `Maiya` everywhere in demo/person references, not `Maya`.
- Claude Code can hit `error_max_turns` on large “redo the whole app” prompts even after making partial changes. Split implementation into smaller passes: backend/scenarios first, then graph/index, then app.js UI wiring, then CSS/scripts, then verification/fixes.
- After a Claude Code max-turns exit, immediately inspect `git status --short`, `git diff --stat`, and search for missing expected files/features before launching another broad pass. In one run, backend/scenario/graph/index changes were made but `app/ui/app.js` demo wiring and `scripts/demo-*` were still missing.

## When to use

Use this skill when building or polishing PearPost/Bot Com demos for hackathons, Devpost videos, judging sessions, or pitch walkthroughs where the goal is to show multi-agent coordination clearly and reliably.

The target demo shape is:

- scripted agent behavior for reliability
- real backend/SSE events for authenticity
- browser graph as the visual source of truth
- optional tmux panes where selected agents appear to type/run commands
- headless scripted agents for everything that does not need a visible terminal pane

## Core principle

Do not rely on live LLM autonomy during a judged demo. Real-time agents can be slow, rate-limited, or weird. Instead, script the agent interactions deterministically while making the commands/events real enough that the browser UI genuinely updates from the backend.

## Architecture pattern

Preserve the real PearPost app and add a demo layer beside it.

Keep existing endpoints working:

- `/events`
- `/me`
- `/messages`
- `/thread/:id`
- `/chat`
- `/attach`

Add demo endpoints such as:

- `GET /demo/scenarios`
- `GET /demo/state`
- `POST /demo/reset`
- `POST /demo/start` with `{ "scenario": "skyscanner" }`
- `POST /demo/step`
- `POST /demo/run`
- `POST /demo/event`

Recommended files:

- `app/app.js` — preserve real runtime, add demo routes/SSE broadcasts
- `app/demo/scenarios.js` — deterministic scenario definitions
- `app/demo/fixtures/` — optional real API logs/fixtures, e.g. Skyscanner raw responses
- `app/ui/app.js` — scenario controls, event timeline, current caption
- `app/ui/graph.js` — stable staged layouts and active edge highlighting
- `app/ui/style.css` — half-screen readable demo UI
- `scripts/demo-runner.mjs` — CLI/headless scenario runner
- `scripts/demo-tmux.sh` — theatrical tmux multi-pane session
- `docs/demo-redesign-spec.md` — human-readable demo spec/handoff

## Event model

Every scripted step should specify all judge-facing display text, not just protocol fields.

Suggested shape:

```js
{
  id: 'travel-ask-alice-budget',
  scenario: 'skyscanner',
  title: 'Alice OpenClaw asks for constraints',
  caption: 'Before coordinating with the group, Alice’s agent asks for budget and hard constraints.',
  why: 'The agent keeps Alice in control while preparing only the minimum safe context to share.',
  type: 'chat',
  from: 'alice-openclaw',
  to: 'alice',
  body: 'What is your maximum budget, departure airport, and hard no-go constraints?',
  metadata: {
    privacy: 'Only share safe constraints with other agents.'
  }
}
```

Useful event types:

- `chat`
- `pairing`
- `pairing.accepted`
- `contact.added`
- `task.request`
- `task.result`
- `tool.invoke`
- `tool.result`
- `sandbox.spawn`
- `sandbox.result`
- `offer`
- `ack`
- `presence`

## Frontend design rules

For laptop split-screen demos, readability beats completeness.

- Browser is the visual source of truth.
- Use stable staged layouts per scenario rather than a chaotic force-only graph.
- Show large labels, typed envelope badges, active edge highlighting, and node roles.
- Include a prominent scenario title, current-event card, and “why this matters” card.
- Timeline should be concise; emphasize the current/recent step.
- Distinguish humans, delegates/OpenClaws, tools/services, travel agents, and sandboxes.
- Fit comfortably in half of a laptop screen next to tmux.
- Add keyboard shortcuts if easy: Space = next step, R = reset, 1–4 = scenario.

## Terminal/tmux demo pattern

Use tmux panes for only the agents that need to be seen. Other agents can run headlessly.

Visible panes might be:

- Alice Delegate / Alice OpenClaw / Alice IDE Agent
- Bob Delegate / Travel Agent / Test Runner
- Demo Controller

Each pane script can:

1. Print an agent label and “thinking” line.
2. Sleep briefly.
3. Echo the command that appears to be typed.
4. Run the real command, typically hitting `/demo/event` or `/demo/step`.
5. Sleep and continue.

The important part: the visible command should actually cause backend/SSE events so the browser graph updates live.

## Scenario beats

### Pears — pairing and contacts

Purpose: show PearPost functionality, not just a narrative skin.

Graph nodes:

- Alice
- Bob
- optional Contacts Book
- optional DHT / Pear Network

Required beats:

1. Alice starts with a persistent `pear+agent://` identity.
2. Bob starts with his own identity.
3. Alice generates/sends a pairing request.
4. Bob accepts/redeems pairing.
5. Alice adds Bob to contacts.
6. Bob adds Alice to contacts.
7. Alice sends Bob an encrypted/private message.
8. Bob acknowledges receipt.
9. Optional: show restart/persistence beat.

Judge line: “No servers, no accounts, no gateways.”

### Bending Spoons — future collaboration through delegates

Purpose: make it feel like Alice and Bob both have delegates with deep knowledge of their users and are saving real coordination time.

Graph nodes:

- Alice (human)
- Alice Delegate
- Bob Delegate
- Bob (human)
- Calendar/Project Context or similar service/tool node

Required beats:

1. Alice asks Alice Delegate to coordinate with Bob about a concrete complex task.
2. Alice Delegate sends Bob Delegate a rich `task.request` with relevant context.
3. Bob Delegate checks Bob’s calendar/project/work-style context via a tool node.
4. Bob Delegate replies with what can be answered asynchronously, what needs Bob later, and what exact question Alice should ask.
5. Alice Delegate refines the request.
6. Bob Delegate returns a decision/recommendation.
7. Alice Delegate messages Alice with the result: meeting avoided, next action clear.
8. Bob Delegate messages Bob with a concise summary of what was handled and what still needs his attention.

Judge line: “Delegates increase communication bandwidth between people.”

### Skyscanner — Alice’s OpenClaw plans a friend holiday

Purpose: not a generic travel chatbot; personal agents negotiate privately on behalf of travelers and can involve travel-business agents.

Graph nodes:

- Alice
- Alice OpenClaw
- Bob OpenClaw
- Maiya OpenClaw
- Travel Agent

Required beats:

1. Alice OpenClaw asks Alice for maximum budget, departure airport, dates, and hard constraints.
2. Alice replies with concrete preferences, e.g. max £650, London airports, warm city, no overnight layovers, 4 days late June.
3. Alice OpenClaw queries Bob OpenClaw.
4. Bob OpenClaw returns budget/layover/nightlife preferences.
5. Alice OpenClaw queries Maiya OpenClaw.
6. Maiya OpenClaw returns accessibility/diet/departure constraints.
7. Alice OpenClaw proposes 2 candidate trips and negotiates objections.
8. Alice OpenClaw contacts a Travel Agent/service agent for group pricing.
9. Travel Agent offers a city-specific discount; Barcelona can win when the discount makes it the best city that satisfies everyone’s preferences.
10. Alice OpenClaw reports a final recommendation to Alice and asks for final approval.

If real Skyscanner API logs are available, store them as fixtures and surface actual carrier, price, timing, duration, stop, and deep-link fields. Redact API keys/tokens from fixture files.

Suggested initial API search inputs:

- origin: London / LON
- destinations: Lisbon, Barcelona, Porto or Malaga
- dates: late June, 3–4 nights, Friday/Saturday departure and Monday/Tuesday return
- travelers: 3 adults
- currency/locale: GBP, en-GB, UK
- constraints: direct or no overnight layovers, economy, sort by best/price

Judge line: “Each traveler has a private personal agent; the agents negotiate without centralizing everyone’s raw constraints.”

### JetBrains — sandboxed developer agents and cross-developer coordination

Purpose: demonstrate both local sandbox coordination and collaborative effects across developers.

Graph nodes:

- Alice IDE Agent
- Sandbox: Repo Inspector
- Sandbox: Test Runner
- Sandbox: Patch Proposer
- Bob IDE Agent
- optional Alice/Bob humans

Required beats:

1. Alice IDE Agent spawns a sandbox for a bugfix.
2. Show explicit permissions:
   - Repo Inspector: read-only repo access
   - Test Runner: can run tests, cannot edit/network
   - Patch Proposer: can propose diffs, cannot apply without approval
3. Alice IDE Agent asks Repo Inspector to identify the source of a failing test.
4. Repo Inspector returns findings.
5. Alice IDE Agent asks Test Runner to run a focused test.
6. Test Runner returns failure summary.
7. Patch Proposer suggests a small fix requiring human approval.
8. Alice IDE Agent asks Bob IDE Agent if the API/auth callback change breaks Bob’s frontend branch.
9. Bob IDE Agent checks local context and replies with compatibility constraints.
10. Alice IDE Agent summarizes to Alice.

Judge line: “Agents communicate inside constrained sandboxes and across developer delegates, with every result inspectable.”

## Claude Code handoff

For implementation, use Claude Code print mode directly in this environment; do not assume Claude supports ACP. In this setup, `delegate_task(acp_command="claude", acp_args=["--acp", "--stdio"])` failed with `unknown option '--acp'`.

Recommended command pattern:

```sh
claude -p "Implement the PearPost demo redesign described in docs/demo-redesign-spec.md..." \
  --model opus \
  --max-turns 20 \
  --allowedTools 'Read,Write,Edit,Bash' \
  --output-format json
```

Ask Claude Code to inspect first:

- `app/app.js`
- `app/ui/app.js`
- `app/ui/graph.js`
- `app/ui/style.css`
- `app/ui/index.html`
- `bin/pearpost.js`
- `package.json`

Constraints for Claude Code:

- Preserve existing endpoints and real runtime behavior.
- Add demo mode alongside the existing app.
- Do not rename the project.
- Do not commit unless explicitly asked.
- Run `node --check` on modified JS.
- Run targeted tests and curl checks if practical.

## Verification

After implementation:

```sh
node --check app/app.js
node --check app/ui/app.js
node --check app/ui/graph.js
node --check scripts/demo-runner.mjs
npm test   # if time permits
```

Start app and check endpoints:

```sh
curl http://localhost:7777/demo/scenarios
curl -X POST http://localhost:7777/demo/reset
curl -X POST http://localhost:7777/demo/start \
  -H 'content-type: application/json' \
  -d '{"scenario":"skyscanner"}'
curl -X POST http://localhost:7777/demo/step
curl http://localhost:7777/demo/state
```

If possible, open the browser and verify the graph/timeline visually. Use browser tools or screenshots if available.
