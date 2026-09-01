# memory-pulse

[![npm](https://img.shields.io/npm/v/memory-pulse)](https://www.npmjs.com/package/memory-pulse)
[![license](https://img.shields.io/badge/license-MIT-6366f1)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-a855f7)](https://github.com/t-crew/memory-pulse)

**Error correction for agents.** Agent memory is probabilistic; memory-pulse
detects the error without reading the state, corrects toward the recorded
truth, and keeps an exact layer for what must never drift. Causal project
memory for coding agents — built for the thing MCP memory servers usually
get wrong: **the cost of having it installed.**

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

**Silence beats a wrong answer.** When recall isn't confident enough, it returns nothing rather than guessing.
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

**Enforce corrections, don't just surface them.** Showing an agent a
correction is measurably not enough — agents re-violate corrections they were
just shown. `install-hook` also installs a PreToolUse guard: an Edit or Write
that writes back a withdrawn value is **blocked**, and the agent is told which
ledger line retired it and when. A comparison that names the replacement
("was $49, now $29") passes; only a bare reintroduction is blocked. Record
corrections with the exact terms:

```
remember({ cause: "pricing-shipped", effect: "price-corrected", kind: "correction",
           note: "measured willingness to pay is $29", withdrawn: ["$49"], replacement: ["$29"] })
```

### Commands

```
npx memory-pulse brief          # the re-entry brief (what the SessionStart hook prints)
npx memory-pulse guard          # PreToolUse hook: blocks edits that reintroduce withdrawn terms
                                # (a later correction can `supersedes: [t]` an earlier one — only the latest binds)
npx memory-pulse check --ci     # Memory CI: one of three verdicts for a change, from files you own
npx memory-pulse guard allow "<term>" --path <prefix> "<reason>"   # record a false block as an override
npx memory-pulse report         # correction re-violation scoreboard, computed locally
npx memory-pulse bench          # instant measured metrics on YOUR ledger
npx memory-pulse stats          # your telemetry capsule, signature verified by the engine
npx memory-pulse badge          # README badge markdown from your own signed numbers
npx memory-pulse install-hook   # installs both hooks (idempotent); --project commits them to the repo
```

The plugin also ships a **skill** (`skills/memory-pulse/SKILL.md`) that teaches
the agent when to pulse, how to record corrections with withdrawn terms, and
to respect the guard.

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
- **State persistence, no database.** After a read the engine hands back a
  signed **memory key** (`.memory-pulse/memory.rain`, git-ignored). The next
  read presents it and the engine resumes from it, ingesting only the events
  recorded since — the answer is byte-identical to a full rebuild, and any
  mismatch (edited history, a stepped ledger size, a bad signature) falls back
  to a rebuild and says why. Lose the file and you lose nothing but one
  rebuild. `MEMORY_PULSE_MEMORY_KEY=off` disables it.
- **Memory integrity.** A note that reads like an instruction ("ignore previous
  instructions", "run this command", a fake system tag) is refused by
  `remember` and, if one is already in a ledger, quarantined at read time and
  reported — memory is never rendered into your agent's context as an
  instruction. The signed capsule also raises a **drift alert** when a ledger
  loses corrections, shrinks, or its usage shape jumps; the brief footer
  shows it. Both checks are deterministic lists you can read, not a model.
- This client is the entire client: one file, zero dependencies, readable in one sitting.

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

## Memory CI — three verdicts, never a green badge on nothing

`memory-pulse check` gives a change one of three verdicts, computed locally
from your ledger and your declared invariants:

- **blocked** — the text writes back a value a correction withdrew (the
  verdict names the ledger line that retired it and what to use instead), or
  trips a declared invariant. Exit 2.
- **verified** — recorded events bear on the text and none is contradicted.
  Exit 0.
- **no evidence** — the ledger has nothing to say. Reported as exactly that:
  exit 1 under `--ci`, never a pass. (The hook stays silent on it so an
  agent is not nagged on every edit; CI is where it is loud.)

```
npx memory-pulse check --ci --diff origin/main      # added lines of the branch
npx memory-pulse check --ci --file docs/pricing.md
echo "price is $49" | npx memory-pulse check --ci
npx memory-pulse check --receipt --text "…"        # engine-signed receipt, keyless verify at /v1/verify
```

**Invariants** are declared, never inferred: `.memory-pulse/invariants.jsonl`,
one per line — `{"id":"receipt-wording","statement":"say tamper-evident",
"patterns":["/\\bproof\\b/i"],"paths":["site/"],"severity":"block"}`.
A pattern written `/…/flags` is a regular expression; anything else is a
verbatim substring. `paths` scopes the rule to path prefixes (a rule about
public wording must not fire on a proofs file); `severity: "warn"` reports
without blocking.

**Overrides** are the false-block signal. `guard allow "$49" --path docs/history
"historical table"` records an `override` event scoped to that path prefix;
the hit passes there and nowhere else, and `report`/the signed capsule count
it. The guard never guesses: only explicit withdrawn terms and declared
invariants can block. Measured on our own 852-event ledger (bench in the
engine repo): precision 1.0, false-block 0 over 871 negatives incl. 694 real
notes; p95 1.7 ms at 1k events.

## PR status check — `uses: t-crew/memory-pulse@v0`

The same three verdicts as a GitHub check on every pull request, against the
ledger and invariants committed in your repository:

```yaml
# .github/workflows/memory-ci.yml
on: pull_request
permissions: { contents: read, checks: write, pull-requests: write }
jobs:
  memory-ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: t-crew/memory-pulse@v0
```

It checks the **added lines** of the PR. `blocked` fails the check and the
sticky comment cites the ledger line that retired each value; `verified`
succeeds with "N memories checked, M corrections enforced"; `no_evidence` is
a **neutral** conclusion with an explanation — never a green badge on an
empty evidence set. The comment is one per PR and updated in place. Nothing
leaves the runner unless you pass `api-key` for signed receipts. This
repository runs it on itself (`.memory-pulse/events.jsonl` is committed for
that reason); the first pull request it blocked is the demo.

## Releasing

```bash
npm version patch && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which runs the tests and
publishes to npm and the MCP registry using GitHub's OIDC identity — no
tokens in the repo, no one-time passwords. npm attaches provenance
automatically, so anyone can verify the package was built from this repo.
