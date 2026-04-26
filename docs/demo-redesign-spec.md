# PearPost Demo Redesign Spec

Goal: redesign the PearPost desktop demo so it is a polished, deterministic, judge-friendly set of scripted multi-agent scenarios. The browser should visualize everything in a live graph. Terminal panes may be visible for selected agents, but many agents/processes can run headlessly; all meaningful entities and messages must still appear in the graph/timeline.

Non-goals:
- Do not rename the project.
- Do not remove the real PearPost protocol/runtime.
- Do not break existing app endpoints used by the current UI: `/events`, `/me`, `/messages`, `/thread/:id`, `/chat`, `/attach`, etc.
- Do not require real LLM calls during the judged demo. Agent behavior should be scripted/deterministic for reliability.

Design principles:
1. Browser is the source of visual truth.
2. Terminal is theatrical, but commands should actually trigger backend events.
3. Demo scripts must be deterministic and resettable.
4. Every event should have readable judge-facing copy: what happened, why it matters, and which track it supports.
5. The graph should use stable layouts per scenario, not a chaotic force-only view.
6. Agent/person distinction matters. For Bending Spoons, Alice and Bob themselves should appear as graph nodes as humans whose delegates report back to them.
7. Headless agents are allowed. They do not all need visible terminal panes, but they should appear in the graph and timeline.

Requested implementation shape:
- Add a demo mode to the existing local app server in `app/app.js`.
- Add scenario definitions in a separate module if useful, e.g. `app/demo/scenarios.js`.
- Add endpoints:
  - `GET /demo/scenarios` returns scenario metadata.
  - `POST /demo/reset` clears demo events/state.
  - `POST /demo/start` with `{ scenario }` starts/resets a scenario.
  - `POST /demo/step` advances one scripted step.
  - `POST /demo/run` runs all remaining steps with delays if practical.
  - `POST /demo/event` injects a custom event used by terminal scripts.
  - `GET /demo/state` returns current demo state.
- Add or update CLI/demo scripts:
  - `scripts/demo-runner.mjs` to run scenarios/steps from terminal/headless processes.
  - `scripts/demo-tmux.sh` to create a tmux layout with browser-friendly agent panes for selected scenarios.
- Redesign `app/ui/app.js`, `app/ui/graph.js`, `app/ui/style.css`, and if needed `app/ui/index.html` to support:
  - prominent current scenario title
  - current step caption
  - why-it-matters caption
  - stable staged graph layout per scenario
  - visual distinction: human, delegate/openclaw, tool/sandbox, travel/business service
  - timeline/event feed with typed envelopes and readable message bodies
  - controls: scenario selector, reset, next step, run demo
  - fit well in half a laptop screen next to a terminal

Core demo event model:
Each scripted step should include fields like:
- scenario
- step id
- title
- caption
- why
- type: chat | task.request | tool.invoke | tool.result | task.result | presence | ack | pairing | contact.added | sandbox.spawn | sandbox.result | offer
- from
- to
- body/text
- optional metadata: confidence, privacy note, permissions, discount, budget, etc.
- optional visible command string for terminal scripts

Scenario 1: Pears — Pairing and Contacts
Purpose: show real-ish PearPost app functionality, including pairing, contacts, encrypted chat/message flow, and local/P2P identity.
Visible graph nodes:
- Alice (agent)
- Bob (agent)
- Contacts Book (system/service node, optional)
- DHT / Pear Network (system/service node, optional)
Required script beats:
1. Alice starts with a persistent `pear+agent://` identity. Show caption: “Each agent has a local identity and address.”
2. Bob starts with his own persistent identity.
3. Alice generates or sends a pairing/contact request. Event type: `pairing`.
4. Bob accepts/redeems pairing. Event type: `pairing.accepted`.
5. Alice adds Bob to contacts. Event type: `contact.added`.
6. Bob adds Alice to contacts. Event type: `contact.added`.
7. Alice sends Bob an encrypted direct message / private note.
8. Bob acknowledges receipt.
9. Show local persistence/restart beat if easy: “Bob restarts; contact and inbox are still present.” This can be simulated visually if actual restart is too invasive.
Judge-facing copy:
- “No server, no account, no gateway.”
- “Pairing creates explicit contacts before richer communication.”
- “The UI is visualizing typed P2P agent events.”

Scenario 2: Bending Spoons — Future Collaboration Through Delegates
Purpose: make it feel like Alice and Bob both have delegates with deep knowledge of their users, saving time and coordinating better than Slack/meetings.
Visible graph nodes:
- Alice (human)
- Alice Delegate (agent)
- Bob Delegate (agent)
- Bob (human)
- Calendar/Project Context (tool/service node)
- maybe Contract/Finance System (tool/service node) if not too crowded; headless is okay.
Terminal panes only need Alice Delegate and Bob Delegate, maybe a controller. Alice/Bob humans can be graph-only nodes receiving status messages.
Script story:
Alice is trying to coordinate a complex integration/review with Bob. Alice’s delegate knows Alice needs a quick unblock, cares about release risk, and wants minimal interruption. Bob’s delegate knows Bob’s schedule, working style, current project context, and review preferences.
Required script beats:
1. Alice tells Alice Delegate: “Can you coordinate with Bob about whether we can safely ship this integration demo tonight?” Show human-to-delegate message.
2. Alice Delegate summarizes Alice’s context and sends a rich `task.request` to Bob Delegate, not just a vague chat message.
3. Bob Delegate checks Bob’s calendar/project context via `tool.invoke` to Calendar/Project Context.
4. Tool returns: Bob is in focus mode, free in 45 minutes, frontend branch depends on API shape, hates vague review requests, prefers specific diff/questions.
5. Bob Delegate replies with a structured negotiation: what Bob can answer now asynchronously, what needs Bob later, and what exact question Alice should ask.
6. Alice Delegate sends a refined question/diff summary to Bob Delegate.
7. Bob Delegate returns a decision: safe if response field remains stable; risk if auth callback changes; Bob can review after 3pm.
8. Alice Delegate messages Alice with the result: “I saved you a meeting; Bob’s agent says X; I’ve queued a focused review request.”
9. Bob Delegate messages Bob: “I handled Alice’s coordination request; only one concrete review item needs your attention later.”
Judge-facing copy:
- “The future is not just agents doing tasks; it is delegates increasing communication bandwidth between people.”
- “Alice and Bob share less raw private context, but coordinate more effectively.”
- “Agents negotiate actionable next steps while humans stay in control.”

Scenario 3: Skyscanner — Alice’s OpenClaw Plans a Friend Holiday
Purpose: from Alice’s perspective, her OpenClaw asks specific travel preferences, contacts other travelers’ OpenClaws, negotiates, talks to a travel agent, and secures a discount.
Important implementation note: the Skyscanner scenario should be able to incorporate real raw Skyscanner API responses/logs supplied by the user. Store fixture data in a file such as `app/demo/fixtures/skyscanner-search.json` or `docs/demo/skyscanner-raw-response.json` and have the scripted scenario surface realistic flight/package details from that fixture where possible. If the fixture is absent, use readable fallback demo data.
Visible graph nodes:
- Alice (human)
- Alice OpenClaw (agent)
- Bob OpenClaw (agent)
- Maiya OpenClaw (agent)
- Travel Agent (service/business agent)
- Optional Trip Proposal node if useful.
Terminal panes can show only Alice OpenClaw and maybe Travel Agent; Bob/Maiya OpenClaws can run headless but appear in graph.
Script beats:
1. Alice OpenClaw messages Alice: “Before I coordinate the group trip, what is your maximum budget, preferred departure airport, and hard no-go constraints?”
2. Alice replies with specific preferences, e.g. max £650, London airports, warm city, no overnight layovers, ideally 4 days in late June.
3. Alice OpenClaw sends structured preference query to Bob OpenClaw.
4. Bob OpenClaw replies: Bob can spend up to £900, hates layovers over 2h, wants good food/nightlife.
5. Alice OpenClaw sends structured preference query to Maiya OpenClaw.
6. Maiya OpenClaw replies: Maiya needs low walking intensity, vegetarian options, and cannot depart before Friday evening.
7. Alice OpenClaw proposes 2 candidate trips to Bob/Maiya OpenClaws: Lisbon vs Barcelona, with tradeoffs.
8. Bob OpenClaw pushes back on Barcelona due to flight times/layovers.
9. Maiya OpenClaw pushes back on Lisbon itinerary walking intensity but accepts if hotel is central.
10. Alice OpenClaw negotiates revised Barcelona plan. Barcelona should win because it is the best discounted city that satisfies everyone’s preferences.
11. Alice OpenClaw contacts Travel Agent: “We have three travelers, flexible within late June, and Barcelona currently looks like the best fit. Can you improve the package if we book together?”
12. Travel Agent offers a city-specific discount for Barcelona, e.g. £70 off per person or 12% group package discount if booked by tonight.
13. Alice OpenClaw informs Alice: “Recommended: Barcelona, £612 after group discount, direct outbound, central hotel, low-walking itinerary, Bob/Maiya constraints satisfied. It won because the travel agent offered the best discount on a city that matches everyone’s preferences. Want me to ask everyone for final approval?”
Judge-facing copy:
- “Not a generic travel chatbot: each traveler has a personal agent with private constraints.”
- “Agents negotiate without centralizing everyone’s raw calendar/budget/preferences.”
- “Travel businesses can participate as agents too — here, a travel agent offers a discount.”

Scenario 4: JetBrains — Sandboxed Developer Agents and Cross-Developer Coordination
Purpose: show local IDE/sandbox agent coordination plus cross-developer delegate effects.
Visible graph nodes:
- Alice IDE Agent
- Sandbox: Repo Inspector
- Sandbox: Test Runner
- Sandbox: Patch Proposer
- Bob IDE Agent
- Optional Alice/Bob humans as graph-only nodes receiving summaries.
Script beats:
1. Alice IDE Agent starts a sandbox for a bugfix. Event type: `sandbox.spawn`.
2. Show permission labels:
   - Repo Inspector: read-only repo access.
   - Test Runner: can run tests, cannot edit files/network.
   - Patch Proposer: can propose diffs, cannot apply without approval.
3. Alice IDE Agent sends `task.request` to Repo Inspector: identify likely source of failing auth callback test.
4. Repo Inspector returns findings.
5. Alice IDE Agent sends `tool.invoke` or `task.request` to Test Runner: run focused test.
6. Test Runner returns failure summary.
7. Patch Proposer suggests a small fix, marked “requires human approval.”
8. Alice IDE Agent asks Bob IDE Agent: “Does this API/auth callback change break your frontend branch?”
9. Bob IDE Agent checks its local branch context and replies with cross-developer impact: safe if field `profile.displayName` remains; settings page breaks if `user.name` removed.
10. Alice IDE Agent summarizes to Alice: “Sandbox found the bug, proposed a patch, and Bob’s delegate flagged one compatibility constraint.”
Judge-facing copy:
- “Agents communicate inside a sandbox with constrained permissions.”
- “Every tool result and proposed patch is visible in the graph.”
- “Cross-developer coordination happens through delegates instead of Slack archaeology.”

Frontend redesign requirements:
- Graph must handle 5-6 nodes but remain readable in half-screen.
- Prefer deterministic layout by scenario over random force layout:
  - humans on far left/right or bottom
  - their delegates near them
  - services/tools/sandboxes grouped on the right or center
  - active edge highlighted strongly
- Large labels and distinct icons/badges.
- Timeline should be concise and legible with most recent/current step emphasized.
- Show message body/caption in a prominent “current event” card.
- Show “why this matters” card for judges.
- Provide keyboard shortcuts if easy: Space = next step, R = reset, 1-4 = scenario.

Testing/verification:
- Run `node --check` for modified JS files.
- Run existing tests if practical: `npm test` or at least targeted relevant tests.
- Start app server with demo mode and verify endpoints:
  - `curl http://localhost:7777/demo/scenarios`
  - `curl -X POST http://localhost:7777/demo/reset`
  - `curl -X POST http://localhost:7777/demo/start -H 'content-type: application/json' -d '{"scenario":"skyscanner"}'`
  - `curl -X POST http://localhost:7777/demo/step`
  - `curl http://localhost:7777/demo/state`
- If possible use browser automation/screenshot or inspect DOM to verify UI renders.

Acceptance criteria:
- Existing app still starts.
- Existing core endpoints are not removed.
- Demo scenario endpoints work.
- UI shows a polished scenario selector, current caption, why-it-matters text, timeline, and readable graph.
- All four scenarios have complete scripted interactions including exact text shown.
- `scripts/demo-tmux.sh` or equivalent exists to run theatrical terminal demo commands.
- Headless/background scripted agents can produce graph events without needing every agent pane visible.
