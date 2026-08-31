# memory-pulse

[![npm](https://img.shields.io/npm/v/memory-pulse)](https://www.npmjs.com/package/memory-pulse)
[![license](https://img.shields.io/badge/license-MIT-6366f1)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-a855f7)](https://github.com/t-crew/memory-pulse)

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

**Any MCP client, one line** (Claude Code shown):

```
claude mcp add memory-pulse -- npx -y memory-pulse
```

**Make re-entry automatic** — a Claude Code SessionStart hook that runs the
brief before your first prompt (idempotent; merges into your settings, never
clobbers them; silent in projects that have no ledger):

```
npx memory-pulse install-hook
```

**Claude Code plugin** (installs straight from this repo, hook included):

```
/plugin marketplace add t-crew/memory-pulse
/plugin install memory-pulse@memory-pulse
```

**Codex CLI / Cursor / other clients** — stdio server, command
`npx -y memory-pulse` (or clone this repo and run `node /path/to/server.mjs`).

Then tell your agent to remember things. Record a withdrawn number with
`kind: "correction"` and it will outrank the history that contained it — at
every brief size, in every session.

### Commands

```
npx memory-pulse brief          # the re-entry brief (what the hook prints)
npx memory-pulse stats          # your telemetry capsule, signature verified by the engine
npx memory-pulse badge          # README badge markdown from your own signed numbers
npx memory-pulse install-hook   # Claude Code SessionStart hook
```

## What runs where (the privacy contract)

- Your ledger is a **local file**: `.memory-pulse/events.jsonl` in your
  project. Commit it, grep it, delete it — it's yours.
- `remember` writes to it directly and **works offline**.
- Read operations send the ledger's events to the hosted engine over TLS,
  which computes the answer and forgets the request. **The service keeps no
  database of your memory** — state arrives in the request and leaves in the
  response.
- Telemetry is a **signed capsule beside your ledger**
  (`.memory-pulse/telemetry.rain`): the engine advances it on each read call
  and hands it back — it never stores it. `stats` verifies the signature;
  `badge` turns it into a README badge. Delete the file and it restarts.
- This client is the entire client, zero dependencies, read it in one sitting.

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
