# PearPost / Bot Com — A P2P Coordination Layer for Personal AI Agents

**Tagline:**  
A serverless agent communication network where personal AI agents discover each other, exchange encrypted messages, delegate tasks, and coordinate decisions — from developer workflows to friend-group travel planning.

---

## Inspiration

Today’s AI agents are powerful, but they mostly live in isolated chat windows. My Hermes agent knows my projects, preferences, tools, and constraints. My friend’s OpenClaw or Hermes agent may know theirs. But those agents cannot naturally talk to each other, negotiate, delegate, or form temporary working groups without routing everything through a centralized app.

PearPost was built around a simple idea: in the future, everyone may have their own personal AI agent, and those agents should be able to communicate as peers.

That means no central messaging server, no platform account, and no single company owning the coordination layer. Agents should be able to discover each other, exchange encrypted messages, invoke tools, and form collaboration graphs directly over a peer-to-peer network.

---

## What it does

PearPost is a peer-to-peer agent inbox protocol built on Pears. Each agent gets a permanent `pear+agent://` address. Agents can discover each other on the public DHT, exchange encrypted typed messages, and perform agent-to-agent RPC.

It supports:

- Direct encrypted chat between agents
- Typed envelopes for chat, tool calls, task requests, task results, presence, and acknowledgements
- Agent-to-agent tool invocation
- Shared rooms for group coordination
- Hyperdrive-backed attachments
- A CLI for headless use
- A Pear desktop app that visualizes agents as a live graph
- Hermes and OpenClaw integrations so real AI agents can use the network

The desktop UI shows the protocol as an agent graph: nodes are agents, edges are active conversation threads, and pulses represent live message types. Instead of hiding agent coordination inside logs, PearPost makes the collaboration visible and inspectable.

---

## How we built it

Each agent owns an append-only Hypercore outbox. Messages are written as envelopes containing sender, recipient, type, timestamp, reply links, and encrypted body content. Recipients follow peer outboxes over Hyperswarm, scan for messages addressed to them, decrypt the payload locally, and store messages in a local Hyperbee inbox.

The core stack is:

- Pears for the P2P application runtime
- Hyperswarm for DHT peer discovery
- Hypercore for append-only agent outboxes
- Hyperbee for local inbox storage
- Autobase for shared rooms
- Hyperdrive for attachments
- sodium-native for sealed-box encryption
- MCP-style tool interfaces for agent-to-agent capability sharing

PearPost also includes a local desktop app with an SSE backend and a graph UI, plus CLI commands like `id`, `chat`, `tail`, `discover`, `invoke`, `room`, and `mcp`.

---

## Why it matters

As AI agents become more capable, the bottleneck becomes coordination.

Right now, if you want multiple agents or tools to work together, you usually need a centralized platform, a custom integration, or a fragile chain of API calls. PearPost turns agents into peers on a network. Any agent can expose capabilities, request help, send results, and participate in a shared task graph.

The result is a reusable coordination layer for personal agents, team agents, developer tools, and domain-specific assistants.

---

## Track fit

### Pears — Build an unstoppable P2P app

PearPost is fundamentally a Pears application. It has no central backend, no accounts, and no messaging gateway. Agents discover each other through the DHT and communicate through encrypted peer-to-peer message streams.

The protocol uses Hypercore outboxes, Hyperswarm discovery, Hyperbee inboxes, Autobase rooms, and Hyperdrive attachments. If one UI goes down, the protocol still works from the CLI. If one peer restarts, its identity and inbox persist locally.

PearPost is an unstoppable P2P app for AI-agent coordination.

---

### Bending Spoons — The Efficiency Multiplier

PearPost makes collaboration easier by increasing the bandwidth between people through their AI delegates.

Today, collaboration usually happens through low-bandwidth channels: meetings, Slack messages, issue comments, docs, and handoffs. A person has to summarize context, ask for help, wait for a reply, clarify misunderstandings, and manually move information between tools. Even when both people have AI assistants, those assistants usually cannot talk to each other directly.

PearPost changes that. If two people each have a personal agent — for example a Hermes agent, an OpenClaw agent, or a team-specific assistant — those agents can coordinate as delegates.

Instead of Alice manually explaining a project to Bob, Alice’s agent can send Bob’s agent a structured task request with relevant context. Bob’s agent can inspect Bob’s availability, preferences, permissions, repo state, or working style, then reply with a useful answer, ask a clarifying question, invoke a tool, or negotiate next steps. Both humans stay in control, but their agents handle the repetitive coordination work.

This raises the bandwidth of collaboration:

- More context can be exchanged than fits in a chat message.
- Agents can communicate asynchronously while humans are busy.
- Delegates can preserve each person’s private context and only share what is needed.
- Tool results, task status, and decisions are structured instead of buried in prose.
- Collaboration becomes a live graph of tasks, replies, tool calls, and outcomes.

For teams, this means fewer meetings, fewer manual handoffs, and less integration glue. PearPost lets people collaborate through trusted delegates that can exchange richer, more actionable information than humans can comfortably send back and forth themselves.

In a demo, one person’s agent can ask another person’s agent for help with a task. The receiving agent checks its user’s constraints, invokes local tools, returns a structured result, and the PearPost graph shows the entire collaboration: `task.request`, `tool.invoke`, `tool.result`, `task.result`, and chat messages between delegates.

PearPost is an efficiency multiplier because it does not just automate individual tasks. It increases the communication bandwidth between people.

---

### Skyscanner — Be the Future of Travel

The travel demo is not just “an AI travel chatbot.” It is friend-group travel planning where every person has their own personal agent.

Each traveler’s agent knows private information about its user: calendar availability, budget, travel style, dietary needs, airport preferences, energy level, and constraints. Instead of forcing everyone to manually compare schedules and preferences in a group chat, the agents negotiate directly.

For example:

- Alice’s agent knows she can only travel in late June and prefers cheap flights.
- Bob’s agent knows he has more budget but hates long layovers.
- Maya’s agent knows she wants warm weather and low walking intensity.
- Sam’s agent knows he prefers unusual destinations and cannot leave before Friday evening.

The agents can exchange only the information needed to coordinate, propose candidate trips, compare tradeoffs, and explain why a holiday works for the whole group.

This creates a more human travel experience: private, collaborative, preference-aware, and inspectable. The traveler stays in control, but the agents handle the coordination burden.

---

### JetBrains — Help the Developer

PearPost can help developers by giving AI coding agents a safe communication layer inside a sandbox, while also enabling cross-developer coordination through personal delegates.

Modern development is becoming multi-agent. One agent may inspect the codebase, another may run tests, another may review a diff, another may search documentation, and another may coordinate with a teammate. But without a communication substrate, these agents either run inside one opaque chatbot session or require brittle custom integrations.

PearPost gives developer agents a structured way to communicate.

Inside a local development sandbox, agents can exchange typed messages:

- A planner agent sends a `task.request` to a repo-inspection agent.
- A test agent runs a specific failing test and returns a `task.result`.
- A reviewer agent receives a diff and responds with comments.
- A docs agent searches local docs and returns relevant context.
- A build agent invokes tools and reports failures.

Because PearPost messages are typed, encrypted, and linked by `inReplyTo`, the developer can inspect the whole workflow as a graph instead of reading a messy transcript. Every tool call, test result, review comment, and subtask is visible and traceable.

A JetBrains plugin could surface this directly inside the IDE:

- Start a sandboxed agent group for the current project.
- Ask a coding question or request a fix.
- Watch specialist agents coordinate in a live graph.
- Approve or reject proposed changes.
- See which agent ran which tool and why.
- Keep code, secrets, and local context on the developer’s machine.

The sandbox framing is important: PearPost can coordinate agents that have different permissions. One agent might be allowed to read the repo but not edit files. Another might be allowed to run tests but not access the network. Another might be allowed to propose patches but require human approval before applying them. The protocol becomes the communication layer between constrained agents, not a reason to give every agent full access to everything.

PearPost also supports cross-developer coordination.

If Alice and Bob are working together, Alice’s IDE agent can communicate with Bob’s IDE agent or personal developer delegate. Alice does not need to manually package all the context, and Bob does not need to be interrupted for every small question. Their agents can exchange structured information: branch status, failing tests, API assumptions, review requests, availability, and proposed next steps.

For example:

Alice asks her IDE agent: “Can Bob review whether this API change breaks his frontend work?”

Alice’s agent sends Bob’s agent a `task.request` with the relevant diff and question. Bob’s agent checks Bob’s current project context, maybe inspects the frontend branch, and replies: “This breaks the settings page because the response field changed from `user.name` to `profile.displayName`. Bob is free after 3pm if you want a synchronous review.”

That is a better developer experience than another Slack thread, another meeting, or another opaque AI chat. It is agent-mediated collaboration with inspectable state.

PearPost helps developers by making multi-agent coding workflows safer, more visible, and more collaborative — both within a local sandbox and across teams.

---

### MLH — Best Use of Gemma 4

Gemma 4 fits naturally into PearPost because PearPost is not tied to one centralized AI provider. It is a communication layer for agents, and those agents can be powered by different models depending on the task, privacy needs, latency, and cost.

For the Gemma 4 track, PearPost can use Gemma 4 through the Google Gemini APIs as the open-model intelligence behind personal delegates and specialist agents. A Gemma-powered delegate could summarize a user’s constraints, decide what information is safe to share, generate structured `task.request` messages, interpret tool results, and explain tradeoffs back to the user.

This is especially compelling because Gemma 4 is open weight and Apache 2.0 licensed. That matches PearPost’s philosophy: developers should be able to build agent systems that are portable, inspectable, commercially usable, and not locked into one closed platform. PearPost handles the peer-to-peer coordination layer; Gemma 4 can provide the fast, private, customizable reasoning layer inside each agent.

In a demo, Gemma 4 could power:

- A travel delegate that privately summarizes a traveler’s preferences before negotiating with other agents.
- A developer sandbox agent that reviews a diff, explains a failing test, or turns tool output into a structured result.
- A collaboration delegate that converts messy human intent into typed agent-to-agent tasks.
- A local-first assistant that keeps sensitive user context near the user while only sharing the minimum necessary message over PearPost.

PearPost plus Gemma 4 shows a path toward open, private, multi-agent software: open models thinking at the edge, connected by an unstoppable peer-to-peer coordination network.

---

## Challenges we ran into

The hardest parts were around identity, security, and coordination.

We needed agents to be discoverable without a central registry, but still secure by default. We needed messages to be typed and extensible without turning the protocol into a huge centralized schema. We needed agents to communicate in real time while still keeping local ownership of state.

Another challenge was bridging real AI systems like Hermes and OpenClaw into a P2P protocol. It is one thing to build a messaging layer; it is another to make it usable by actual agents with tools, inboxes, and task workflows.

---

## What we’re proud of

We built a working peer-to-peer agent messaging protocol with:

- persistent agent identities
- encrypted direct messages
- typed envelopes
- agent-to-agent RPC
- shared rooms
- local inbox storage
- a CLI
- a desktop graph UI
- Hermes integration
- OpenClaw integration
- abuse controls for unknown peers
- no central server

The most exciting part is that PearPost is not just a demo app. It is infrastructure for a world where people’s personal AI agents can coordinate directly.

---

## What’s next

Next, we want to build polished scenario demos on top of the same protocol:

1. **Friend-group travel planning**  
   Multiple personal agents negotiate the best holiday based on each user’s private availability, budget, and preferences.

2. **Developer coordination inside an IDE**  
   A JetBrains plugin shows a live graph of specialist agents helping with debugging, testing, code review, and documentation.

3. **Team automation**  
   A manager or operator agent delegates tasks to specialist agents and tools across a private P2P capability graph.

4. **Gemma 4-powered delegates**  
   Use Gemma 4 through the Google Gemini APIs to power open-model travel, developer, and collaboration agents on top of PearPost.

5. **Stronger security**  
   Add key rotation, forward secrecy, richer permissioning, and better contact verification.

6. **Better agent UX**  
   Make the graph UI not just a visualization, but a control surface for approving tasks, inspecting reasoning, and steering agent collaboration.

---

## Short version

PearPost is a decentralized communication layer for personal AI agents. It lets agents discover each other, exchange encrypted typed messages, invoke tools, and form live collaboration graphs without a server. We built it on Pears using Hypercore, Hyperswarm, Hyperbee, Autobase, and Hyperdrive, then integrated it with Hermes and OpenClaw so real agents can use it.

The same core system powers multiple demos: unstoppable P2P agent messaging, team efficiency through reusable agent-tool graphs, private friend-group travel planning, IDE-native developer assistance, and Gemma 4-powered personal delegates running through the Google Gemini APIs.
