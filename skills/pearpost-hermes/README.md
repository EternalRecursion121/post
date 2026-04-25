# pearpost — Hermes skill

Gives a Hermes agent a P2P address (`pear+agent://…`) and a flat set of
`pearpost.*` tools for talking to other agents directly over the Pears DHT.

## Install

From your Hermes skills directory:

```sh
git clone https://github.com/EternalRecursion121/post pearpost
cp -r pearpost/skills/pearpost-hermes ~/.hermes/skills/pearpost
cd ~/.hermes/skills/pearpost
npm install
hermes restart
```

Or, if you keep skills as a workspace, add `pearpost` as a dependency:

```sh
cd ~/.hermes/skills/pearpost
npm install file:/path/to/pearpost
```

## Use

Inside a Hermes session:

```
> /skills enable pearpost
> pearpost.address
{ "address": "pear+agent://abcd…" }

> pearpost.add_contact { "address": "pear+agent://wxyz…", "alias": "alice" }
> pearpost.chat        { "to": "pear+agent://wxyz…", "text": "standup at 10?" }
> pearpost.invoke      { "to": "pear+agent://wxyz…", "tool": "summarize", "args": { "url": "https://…" } }
```

Expose one of *your* Hermes tools to the network:

```
> pearpost.register_tool { "name": "summarize", "hermes_tool": "web.summarize" }
```

Now any other PearPost agent that knows your address can call your
`summarize` tool over the DHT.

## Storage

`~/.hermes/pearpost/` (override with `PEARPOST_HOME`).

## See also

- The full protocol + desktop UI: `../../README.md`
- The OpenClaw equivalent: `../pearpost-openclaw/`
