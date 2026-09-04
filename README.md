# memory-pulse

[![npm](https://img.shields.io/npm/v/memory-pulse)](https://www.npmjs.com/package/memory-pulse)
[![license](https://img.shields.io/badge/license-MIT-6366f1)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-a855f7)](https://github.com/t-crew/memory-pulse)

**Site:** [pulse.strategic-innovations.ai](https://pulse.strategic-innovations.ai/) — try the guard in the browser · [compare with Mem0, Zep, Letta and CLAUDE.md](https://pulse.strategic-innovations.ai/compare)

**Corrections your agent can't forget, or write back.** Causal project memory
for Claude Code, Codex and any MCP client: a local ledger in your repo,
corrections first in every session, and a guard that blocks the edit that
writes a withdrawn value back — citing the ledger line that retired it.
~670 tokens of tool definitions; the hosted engine keeps no database of your
memory.

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

One repo, two plugin hosts, any MCP client. Pick the row for your agent.

**Claude Code — plugin** (skill + MCP tools + the two hooks, from this repo):

```
/plugin marketplace add t-crew/memory-pulse
/plugin install memory-pulse@memory-pulse
```

`claude plugin details memory-pulse` shows what you pay: ~120 tokens always-on
(the skill's description), the four tool schemas resolved at runtime, hooks
free. The hooks run the plugin's own `server.mjs`, so what enforces your
corrections is exactly the version you installed.

**Codex CLI — plugin** (same files; Codex reads `.codex-plugin/plugin.json`):

```
codex plugin marketplace add t-crew/memory-pulse
codex plugin add memory-pulse@memory-pulse
```

Then, inside Codex, run `/hooks` and trust the two `memory-pulse` entries.
Codex runs no hook it has not shown you, and installing a plugin does not
trust its hooks — that is Codex's rule and a good one.

**Any MCP client, one line** (Claude Code and Codex shown; Cursor and the rest
take the same stdio command):

```
claude mcp add memory-pulse -- npx -y memory-pulse
codex  mcp add memory-pulse -- npx -y memory-pulse
```

**Make re-entry automatic without the plugin** — a SessionStart hook that runs
the brief before your first prompt and a PreToolUse guard on edits
(idempotent; merges into the file, never clobbers it; silent in projects
that have no ledger):

```
npx memory-pulse install-hook            # Claude Code: ~/.claude/settings.json
npx memory-pulse install-hook --codex    # Codex:       ~/.codex/hooks.json (then /hooks to trust)
```

Add `--project` to either and the hooks are written into the repo
(`.claude/settings.json` / `.codex/hooks.json`) — commit that and every clone
is re-entered and guarded without anyone installing anything.

Then tell your agent to remember things. Record a withdrawn number with
`kind: "correction"` and it will outrank the history that contained it — at
every brief size, in every session.

**Enforce corrections, don't just surface them.** Showing an agent a
correction is measurably not enough — agents re-violate corrections they were
just shown. The PreToolUse guard sees every `Edit`/`Write` (Claude Code) and
every `apply_patch` (Codex — one patch may touch several files; each is
checked under its own path): an edit that writes back a withdrawn value is
**blocked**, and the agent is told which ledger line retired it and when. A
comparison that names the replacement ("was $49, now $29") passes; only a bare
reintroduction is blocked. A shell heredoc is not an edit tool and is not
guarded — `check --ci` on the PR is the layer that catches it. Record
corrections with the exact terms:

```
remember({ cause: "pricing-shipped", effect: "price-corrected", kind: "correction",
           note: "measured willingness to pay is $29", withdrawn: ["$49"], replacement: ["$29"] })
```

### Commands

```
npx memory-pulse brief          # the re-entry brief (what the SessionStart hook prints)
npx memory-pulse brief --budget 1500   # size it to the tokens you can spare; the richest tier that fits, corrections first and whole
npx memory-pulse guard          # PreToolUse hook: blocks edits that reintroduce withdrawn terms
                                # (a later correction can `supersedes: [t]` an earlier one — only the latest binds)
npx memory-pulse check --ci     # Memory CI: one of three verdicts for a change, from files you own
npx memory-pulse verify         # row chain + last engine seal; exit 2 if either fails
npx memory-pulse brief --offline  # local render when the engine is unreachable
npx memory-pulse install-hook --ambient  # also record prompts shaped like corrections
npx memory-pulse lint [--ci]    # dry run: do CLAUDE.md / AGENTS.md / .claude/rules still state a value the ledger retired?
npx memory-pulse guard allow "<term>" --path <prefix> "<reason>"   # record a false block as an override
npx memory-pulse report         # correction re-violation scoreboard, computed locally
npx memory-pulse bench          # instant measured metrics on YOUR ledger
npx memory-pulse stats          # your telemetry capsule, signature verified by the engine
npx memory-pulse badge          # README badge markdown from your own signed numbers
npx memory-pulse install-hook   # installs both hooks (idempotent); --codex targets Codex; --project commits them to the repo
```

The plugin also ships a **skill** (`skills/memory-pulse/SKILL.md`) that teaches
the agent when to pulse, how to record corrections with withdrawn terms, and
to respect the guard.

## What the brief tells you before it tells you anything

Every brief opens with one line of provenance, because a session must be
able to tell whether its memory loaded whole, truncated, or not at all:

```
memory-pulse: loaded 852 events from .memory-pulse/events.jsonl · sha256 1a2b3c4d5e6f · 2 binding corrections (10 withdrawn terms) · 1 superseded · ⚠ 1 malformed line skipped: 544 · memory key resumed (+3 new) · tier brief, 5,153 chars
```

Every CORRECTIONS line cites its ledger record (`… -> effect (t824) — note`),
so a correction is evidence the agent can point at, not an assertion it has
to trust. `recall` and the guard name the same `t`.

## Lint: the rules a session loads, checked against the ledger

Governance files drift. A `CLAUDE.md` written in June still says the price
is $49 after the ledger retired it in August, and every new session loads the
stale rule with full confidence. `lint` runs the guard's check over the files
a session will read — `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`,
`.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`,
`.codex/AGENTS.md`, or paths you pass — and gives each the three verdicts:

```
$ npx memory-pulse lint
memory-pulse: loaded 2 events from .memory-pulse/events.jsonl · sha256 8e401a39f323 · 1 binding correction (1 withdrawn term)
  BLOCKED     CLAUDE.md
             • "$49" was withdrawn at ledger t2: price-49-launched -> price-corrected-to-29 — use $29
  verified    AGENTS.md
  no evidence .claude/rules/style.md
lint: 3 file(s) — 1 blocked, 1 verified, 1 no evidence — a rule your ledger retired is still being loaded into sessions
```

Exit 2 on any blocked file; `--ci` also exits 1 when it found nothing to
check (never green on nothing); `--json` for machines. It also tells you
which corrections carry no `withdrawn` terms — those surface in the brief but
nothing can enforce them.

## Tamper evidence: the ledger cannot be edited quietly

A memory that can be rewritten is not a ledger. Since 0.3.1 three things hold, each with its own job:

- **Row chain.** Every row `remember` writes carries `prev` (the previous chained row's hash) and `hash` (SHA-256 of its own canonical JSON). Rows that existed before the chain are never rewritten — the first chained row seals them with a digest. An edit in place, a removed row, a reordered row or an unchained row after the chain started fails `verifyChain()`, and a failed chain blocks every `check`, `guard` and `lint` verdict: a memory whose own history is in question cannot vouch for anything.
- **Set head.** The engine also commits to the ledger as an order-free fold (a multiplicative group mod a 3072-bit prime, the MuHash construction Bitcoin Core uses for its UTXO set). Shards from several agents fold to the same head in any order, and removing a row is the group inverse — so the *state* stays exact while the *history* stays append-only. The literal XOR fold was measured forgeable (a linear system hides an edit in 10 ms at 300 rows) and is not used for this.
- **Seal.** Every read call returns a seal signed by the engine — row count, watermark, the set head over every row's full content, the chain head. The client keeps it in `seal.rain` beside the ledger and presents it on the next call. Locally, rows up to the sealed watermark must still fold to the sealed head before the ledger is trusted; at the engine, the signature and the fold are re-checked and an edit below the watermark is reported as drift and blocks. A process with write access can rewrite the file and even the chain; it cannot produce the engine's signature, and it cannot make edited rows fold to the sealed head.

Nothing is stored server-side for any of this; the seal travels in the payload like the telemetry capsule and the memory key.

## Survives compaction, works offline, captures corrections, speaks Python

Four things added on 2026-09-03, each deterministic (no model in the loop):

- **Compaction handoff.** `install-hook` now adds a PreCompact hook. Before Claude Code compacts, `memory-pulse handoff` reads the transcript and records what the session was doing as facts: the last asks, the files edited, the last error, the assistant's last state. The next session start prints it first, online or offline. An instruction-like message is dropped from the note, never recorded.
- **Offline brief.** When the engine is unreachable (air-gapped, dead network, outage) the session no longer starts empty: `brief` prints a local render — every binding correction with its withdrawn and replacement terms, the last handoff, the recent rows — labelled as a local render with no salience ranking. `brief --offline` forces it. Guard, check, lint and verify never needed the network.
- **Ambient correction capture (opt-in).** `install-hook --ambient` adds a UserPromptSubmit hook. A prompt shaped like a correction — `the price is $29 not $49`, `change 0.3.1 to 0.3.2`, `500 events -> 924 events` — is recorded as a correction carrying both terms, so the guard enforces it from the next edit on. A prompt that does not yield both terms is left alone. Silent unless `--verbose`.
- **Python client.** `python/memory_pulse.py` is a single stdlib-only file with the same ledger format, the same hash chain and the same guard rule. A LangChain or CrewAI agent and a Claude Code session can share one ledger and verify each other's rows; the test suite writes rows from Python and verifies them in Node, and back.

## Agent mode: a persistent agent identity that grows (opt-in)

The default is deliberate: memory lives in the repo, capture is explicit. Agent mode is a separate mode for the other thing people ask for — an agent that is the *same agent* tomorrow, in every project and every tool, and that grows.

```
npx memory-pulse mode agent
npx memory-pulse identity "Blue, research agent for Travis; innovate, don't debate"
```

What that turns on:

- **An agent ledger** at `~/.memory-pulse/agent/events.jsonl`: the agent's own, shared by every project and every tool that speaks MCP. Same format, same hash chain, same seal.
- **A self block, first in every brief**, online or offline: who the agent is (pinned), the standing rules and preferences it has learned, the lessons it carries, and a fingerprint — the chain head and the engine's seal — so the agent can state which memory it is running on and prove it was not swapped or edited overnight.
- **Growth, after every turn.** A Stop hook records, deterministically, a stated decision (to the project), a user preference or a stated lesson (to the agent), and any correction shaped like one. Capped at four rows a turn, tagged `ambient`, never pinned, never from instruction-like text. Identity itself is only ever set by you or superseded by a correction.
- **Corrections that follow the agent.** A correction on the agent ledger blocks the same edit in any project.

`npx memory-pulse mode deliberate` turns the hooks off again and leaves the ledgers in place. `remember` takes `scope: "agent"` from any tool.

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

One version, four readers: `package.json` (npm), `server.json` (MCP registry),
`.claude-plugin/plugin.json` (Claude Code) and `.codex-plugin/plugin.json`
(Codex) must all say the same thing. `npm version` bumps only the first;
`test/manifests.test.js` fails until the other three follow, and the release
workflow refuses to publish anything while they disagree.
