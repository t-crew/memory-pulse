# memory-pulse

Causal project memory for coding agents — built for the thing MCP memory
servers usually get wrong: **the cost of having it installed.**

All four tools together cost **~2.5 KB (≈670 tokens) of definitions**
(cert_c71bba29493a). A test in this repo fails if they ever exceed 4 KB. Compare that to what a typical
MCP setup already burns before you type your first prompt — independent
measurements put 5–10 installed servers at [50–67k tokens of tool definitions](https://getunblocked.com/blog/mcp-token-budget-autopsy/),
a third of a 200k context window.

## What it does

Your agent's session ends and everything it learned dies with it. memory-pulse
gives it a ledger of **cause → effect** events in a local file, and four tools:

| tool | what it does | runs |
|---|---|---|
| `remember` | record a finding (or a **correction**) | locally, offline |
| `pulse` | re-enter the project: a ranked brief instead of re-reading history | hosted engine |
| `recall` | what caused X? what did X cause? when was the link strongest? | hosted engine |
| `execute` | run JS against memory in a sandbox; only the return value enters context | hosted engine |

Two design decisions do the heavy lifting:

**Corrections come first, always.** An event recorded with
`kind: "correction"` outranks everything at every brief size and never decays.
The failure this prevents: your agent confidently quotes the benchmark number
you withdrew three sessions ago.

**Silence beats a wrong answer.** Recall is gated by a measured noise floor.
When the answer isn't there, you get nothing — not a plausible guess.

## Install

**Claude Code** (plugin — includes the MCP server):

```
/plugin marketplace add t-crew/memory-pulse
/plugin install memory-pulse@memory-pulse
```

or as a plain MCP server:

```
claude mcp add memory-pulse -- npx -y memory-pulse
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.memory-pulse]
command = "npx"
args = ["-y", "memory-pulse"]
```

**Cursor / any MCP client** — stdio server, command `npx -y memory-pulse`.

Then just tell your agent to remember things, and start sessions with "pulse
the memory". It figures the rest out from the tool descriptions.

## What runs where (the privacy contract)

- Your ledger is a **local file**: `.memory-pulse/events.jsonl` in your
  project. Commit it, grep it, delete it — it's yours.
- `remember` writes to it directly and **works offline**.
- Read operations send the ledger's events to the hosted engine over TLS,
  which computes the answer and forgets the request. **The service keeps no
  database of your memory** — state arrives in the request and leaves in the
  response.
- This client is the entire client: ~300 lines, zero dependencies, read it in
  one sitting.

## Pricing

- **Free** — ledgers up to 500 events, 200 reads/day. No account, no key.
- **Pro ($19/mo)** — ledgers to 20,000 events, unlimited reads. One env var:
  `MEMORY_PULSE_KEY`.

Local writes are free forever either way.

## Measured, on our own ledger

We run memory-pulse on the 767-event, 1.08 MB ledger of the project that
builds it. On that corpus (pinned run cert_c71bba29493a):

- A cross-referencing question answered through `execute` returned **124
  chars** against the 1,080,983-char full dump — the intermediates never
  entered context.
- Re-entry briefs at the smallest tier run **~99% smaller** than reading the
  ledger in.
- On our recall benchmark (351 distinct causes), the noise-floor gate returned
  **zero wrong top answers** — when it couldn't clear the floor, it returned
  nothing instead.

Your ratios scale with ledger size — a ledger ten events old has nothing to
compress. The methodology lives in the engine's benchmark suite and the
numbers above are from pinned run cert_c71bba29493a, not a projection.

## FAQ

**Why is the engine hosted?** The ranking engine is the part that took the
research. The tradeoff we chose: local ledger + thin auditable client +
hosted engine, over shipping a weaker local ranker. If the engine being remote
is a dealbreaker, `MEMORY_PULSE_API` points the client anywhere.

**What about team memory?** Commit `.memory-pulse/` to the repo. Your
teammates' agents pulse the same ledger. (Shared hosted ledgers are on the
roadmap.)

**License?** Client: MIT. Engine: proprietary, hosted.

MIT © Travis Crew
