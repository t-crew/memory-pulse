# memory-pulse

[![npm](https://img.shields.io/npm/v/memory-pulse)](https://www.npmjs.com/package/memory-pulse)
[![license](https://img.shields.io/badge/license-MIT-6366f1)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-a855f7)](https://github.com/t-crew/memory-pulse)

**Site:** [pulse.strategic-innovations.ai](https://pulse.strategic-innovations.ai/), where the guard runs in the browser. [Compare with Mem0, Zep, Letta and CLAUDE.md](https://pulse.strategic-innovations.ai/compare).

**Corrections that outlive the session.**

Your agent acknowledged the correction, then wrote the old value back next
session. memory-pulse records it once, puts it at the top of every session,
and blocks the edit that reintroduces it, quoting the line that retired it.
For Claude Code, Codex, Cursor, any MCP client and GitHub Actions. The record
is a file in your own repository.

Most memory tools stop at showing the correction to the model. The guard is
the part that acts on it.

All four tool definitions come to **~2.5 KB, about 670 tokens**
(cert_c71bba29493a), and a test in this repo fails the build if they ever
exceed 4 KB. Independent measurements put a typical five to ten server MCP
setup at [50-67k tokens of tool definitions](https://getunblocked.com/blog/mcp-token-budget-autopsy/)
before your first prompt, roughly a third of a 200k context window.

## What it does

A session ends and everything it learned goes with it. memory-pulse keeps a
ledger of **cause → effect** events in a local file, and gives the agent four
tools over it:

| tool | what it does | runs |
|---|---|---|
| `remember` | record a finding (or a **correction**) | locally, offline |
| `pulse` | re-enter the project on a ranked brief, sized to a budget you set | hosted engine |
| `recall` | what caused X? what did X cause? when was the link strongest? | hosted engine |
| `execute` | run JS against memory in a sandbox, where only the return value enters context | hosted engine |

Two design decisions do the heavy lifting.

**Corrections come first, always.** An event recorded with
`kind: "correction"` outranks everything at every brief size and never decays.
The failure this prevents is your agent confidently quoting the benchmark
number you withdrew three sessions ago.

**A weak answer returns nothing.** When recall cannot clear its confidence
floor it returns an empty result, and the brief says so.

## Install

One repo, two plugin hosts, any MCP client. Pick the row for your agent.

**Claude Code, as a plugin.** Skill, MCP tools and the two hooks, from this repo:

```
/plugin marketplace add t-crew/memory-pulse
/plugin install memory-pulse@memory-pulse
```

`claude plugin details memory-pulse` shows what you pay. About 120 tokens are
always on, which is the skill's description. The four tool schemas resolve at
runtime and the hooks are free. The hooks run the plugin's own `server.mjs`,
so what enforces your corrections is the version you installed.

**Codex CLI, as a plugin.** Same files, read from `.codex-plugin/plugin.json`:

```
codex plugin marketplace add t-crew/memory-pulse
codex plugin add memory-pulse@memory-pulse
```

Then, inside Codex, run `/hooks` and trust the two `memory-pulse` entries.
Codex runs no hook it has not shown you, and installing a plugin does not
trust its hooks. That is Codex's rule and a good one.

**Any MCP client, in one line.** Claude Code and Codex are shown, and Cursor
and the rest take the same stdio command:

```
claude mcp add memory-pulse -- npx -y memory-pulse
codex  mcp add memory-pulse -- npx -y memory-pulse
```

**Automatic re-entry without the plugin.** A SessionStart hook runs the brief
before your first prompt and a PreToolUse guard checks edits. Both are
idempotent, both merge into the settings file without clobbering it, and both
stay silent in a project that has no ledger.

```
npx memory-pulse install-hook            # Claude Code: ~/.claude/settings.json
npx memory-pulse install-hook --codex    # Codex:       ~/.codex/hooks.json (then /hooks to trust)
```

Add `--project` to either and the hooks are written into the repo, at
`.claude/settings.json` or `.codex/hooks.json`. Commit that and every clone is
re-entered and guarded with nothing for anyone to install.

A withdrawn number recorded with `kind: "correction"` outranks the history
that contained it, at every brief size and in every session.

**Corrections are enforced, not only surfaced.** Showing an agent a correction
is measurably not enough, because agents re-violate corrections they were just
shown. The PreToolUse guard sees every `Edit` and `Write` in Claude Code and
every `apply_patch` in Codex, where one patch may touch several files and each
is checked under its own path. An edit that writes back a withdrawn value is
**blocked**, and the agent is told which ledger line retired it and when. An
edit that names the replacement beside the old value passes, because "was $49,
now $29" is a comparison. Only a bare reintroduction is blocked. A shell
heredoc is not an edit tool and is not guarded, so `check --ci` on the pull
request is the layer that catches that case. Record corrections with the exact
terms:

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

The plugin also ships a **skill** at `skills/memory-pulse/SKILL.md` that
teaches the agent when to pulse, how to record corrections with withdrawn
terms, and how to respect the guard.

## What the brief tells you before it tells you anything

Every brief opens with one line of provenance, so a session can tell whether
its memory loaded whole, truncated, or not at all:

```
memory-pulse: loaded 852 events from .memory-pulse/events.jsonl · sha256 1a2b3c4d5e6f · 2 binding corrections (10 withdrawn terms) · 1 superseded · ⚠ 1 malformed line skipped: 544 · memory key resumed (+3 new) · tier brief, 5,153 chars
```

Every CORRECTIONS line cites its ledger record as `… -> effect (t824) — note`,
so a correction is evidence the agent can point at. `recall` and the guard name the same `t`.

## Lint: the rules a session loads, checked against the ledger

Governance files drift. A `CLAUDE.md` written in June still says the price is
$49 after the ledger retired it in August, and every new session loads the
stale rule with full confidence. `lint` runs the guard's check over the files
a session will read and gives each of them one of the three verdicts. It
covers `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`, `.cursorrules`,
`.cursor/rules/`, `.github/copilot-instructions.md`, `.codex/AGENTS.md`, and
any paths you pass:

```
$ npx memory-pulse lint
memory-pulse: loaded 2 events from .memory-pulse/events.jsonl · sha256 8e401a39f323 · 1 binding correction (1 withdrawn term)
  BLOCKED     CLAUDE.md
             • "$49" was withdrawn at ledger t2: price-49-launched -> price-corrected-to-29 — use $29
  verified    AGENTS.md
  no evidence .claude/rules/style.md
lint: 3 file(s) — 1 blocked, 1 verified, 1 no evidence — a rule your ledger retired is still being loaded into sessions
```

Exit 2 on any blocked file. Under `--ci` it also exits 1 when it found nothing
to check, so an empty run is never reported as a pass. `--json` is there for
machines. It also names the corrections that carry no `withdrawn` terms, which
surface in the brief but which nothing can enforce.

## Tamper evidence: the ledger cannot be edited quietly

Since 0.3.1 three mechanisms hold, each with its own job:

- **Row chain.** Every row `remember` writes carries `prev`, the previous chained row's hash, and `hash`, the SHA-256 of its own canonical JSON. Rows that existed before the chain are never rewritten, and the first chained row seals them with a digest. An edit in place, a removed row, a reordered row or an unchained row after the chain started all fail `verifyChain()`. A failed chain blocks every `check`, `guard` and `lint` verdict, because a memory whose own history is in question cannot vouch for anything.
- **Set head.** The engine also commits to the ledger as an order-free fold, a multiplicative group mod a 3072-bit prime, which is the MuHash construction Bitcoin Core uses for its UTXO set. Shards from several agents fold to the same head in any order, and removing a row is the group inverse, so the *state* stays exact while the *history* stays append-only. A literal XOR fold was measured forgeable, since a linear system hides an edit in 10 ms at 300 rows, and it is not used here.
- **Seal.** Every read call returns a seal signed by the engine, carrying the row count, the watermark, the set head over every row's full content, and the chain head. The client keeps it in `seal.rain` beside the ledger and presents it on the next call. Locally, rows up to the sealed watermark must fold to the sealed head before the ledger is trusted. At the engine the signature and the fold are re-checked, and an edit below the watermark is reported as drift and blocks. A process with write access can rewrite the file and even the chain. It cannot produce the engine's signature, and it cannot make edited rows fold to the sealed head.

Nothing is stored server-side for any of this. The seal travels in the payload, the same way the telemetry capsule and the memory key do.

## Survives compaction, works offline, captures corrections, speaks Python

Four things added on 2026-09-03, each deterministic (no model in the loop):

- **Compaction handoff.** `install-hook` adds a PreCompact hook. Before Claude Code compacts, `memory-pulse handoff` reads the transcript and records what the session was doing as facts: the last asks, the files edited, the last error, and the assistant's last state. The next session start prints it first, online or offline. An instruction-like message is dropped from the note and never recorded.
- **Offline brief.** When the engine is unreachable, whether air-gapped, on a dead network or during an outage, the session no longer starts empty. `brief` prints a local render carrying every binding correction with its withdrawn and replacement terms, the last handoff and the recent rows, labelled as a local render with no ranking applied. `brief --offline` forces it. Guard, check, lint and verify never needed the network.
- **Ambient correction capture, opt-in.** `install-hook --ambient` adds a UserPromptSubmit hook. A prompt shaped like a correction, such as `the price is $29 not $49`, `change 0.3.1 to 0.3.2` or `500 events -> 924 events`, is recorded as a correction carrying both terms, so the guard enforces it from the next edit on. A prompt that does not yield both terms is left alone. Silent unless `--verbose`.
- **Python client.** `python/memory_pulse.py` is a single stdlib-only file with the same ledger format, the same hash chain and the same guard rule. A LangChain or CrewAI agent and a Claude Code session can share one ledger and verify each other's rows. The test suite writes rows from Python and verifies them in Node, and back.
- **Decode-time guard for local models.** `python/span_guard.py` applies the same rule one layer down. The token that would complete a withdrawn value is masked while the model decodes, so the value cannot be generated, and the replacement's next token is offered in its place. It reads the ledger under the rules `check` uses, so a superseded correction is not enforced and a broken chain refuses to build. Stdlib only, and its suite runs without a model. Measured with mlx-lm on TinyLlama-1.1B and Qwen2.5-1.5B, the same prompt whose plain decode wrote the withdrawn price wrote the corrected one under the guard, and the sentence around it stayed intact. It blocks the spellings it was given, including the written variants you record, and a paraphrase nobody enumerated gets through.

  ```python
  from memory_pulse import Ledger
  from span_guard import SpanGuard
  guard = SpanGuard.from_ledger(tok, Ledger(".memory-pulse/events.jsonl"))
  # mlx-lm: generate_step(..., logits_processors=[guard.logits_processor(mx, np)])
  ```

## Agent mode: a persistent agent identity that grows (opt-in)

The default is deliberate. Memory lives in the repo and capture is explicit. Agent mode covers the other thing people ask for, which is an agent that is the *same agent* tomorrow, in every project and every tool, and that grows.

```
npx memory-pulse mode agent
npx memory-pulse identity "Blue, research agent for Travis; innovate, don't debate"
```

What that turns on:

- **An agent ledger** at `~/.memory-pulse/agent/events.jsonl`, belonging to the agent and shared by every project and every tool that speaks MCP. Same format, same hash chain, same seal.
- **A self block, first in every brief**, online or offline. It carries who the agent is as a pinned line, the standing rules and preferences it has learned, the lessons it carries, and a fingerprint made of the chain head and the engine's seal, so the agent can state which memory it is running on and show it was not swapped or edited overnight.
- **Growth, after every turn.** A Stop hook deterministically records a stated decision to the project ledger, a user preference or stated lesson to the agent ledger, and any correction shaped like one. It is capped at four rows a turn, tagged `ambient`, never pinned, and never taken from instruction-like text. Identity itself is only ever set by you or superseded by a correction.
- **Corrections that follow the agent.** A correction on the agent ledger blocks the same edit in any project.

`npx memory-pulse mode deliberate` turns the hooks off again and leaves the ledgers in place. `remember` takes `scope: "agent"` from any tool.

## What runs where (the privacy contract)

- Your ledger is a **local file** at `.memory-pulse/events.jsonl` in your
  project. You can commit it, grep it or delete it.
- `remember` writes to it directly and **works offline**.
- Read operations send the ledger's events to the hosted engine over TLS,
  which computes the answer and forgets the request. **The service keeps no
  database of your memory.** State arrives in the request and leaves in the
  response.
- Telemetry is a **signed capsule beside your ledger** at
  `.memory-pulse/telemetry.rain`. The engine advances it on each read call and
  hands it back without ever storing it. `stats` verifies the signature and
  `badge` turns it into a README badge. Delete the file and it restarts.
- **State persistence, no database.** After a read the engine hands back a
  signed **memory key** (`.memory-pulse/memory.rain`, git-ignored). The next
  read presents it and the engine resumes from it, ingesting only the events
  recorded since. The answer is byte-identical to a full rebuild. Any mismatch,
  whether edited history, a stepped ledger size or a bad signature, falls back
  to a rebuild and says why. Lose the file and you lose nothing but one
  rebuild. `MEMORY_PULSE_MEMORY_KEY=off` disables it.
- **Memory integrity.** A note that reads like an instruction, such as "ignore
  previous instructions", "run this command" or a fake system tag, is refused
  by `remember`. One already sitting in a ledger is quarantined at read time
  and reported, so memory never reaches your agent's context as an order. The
  signed capsule also raises a **drift alert** when a ledger loses corrections,
  shrinks, or its usage shape jumps, and the brief footer shows it. Both checks
  are deterministic lists you can read.
- This client is the entire client: one file, zero dependencies, readable in one sitting.

## Pricing

- **Free.** Ledgers up to 500 events, 200 reads a day. No account, no key.
- **Pro, $19/mo.** Ledgers to 20,000 events, unlimited reads. One environment
  variable, `MEMORY_PULSE_KEY`.

Local writes are free on either tier.

## Measured, on our own ledger

Measured on the ledger of the project that builds memory-pulse, a 767-event
file of 1.08 MB, pinned as run cert_c71bba29493a:

- A cross-referencing question answered through `execute` returned **124
  chars** against the 1,080,983-char full dump. The intermediates never
  entered context.
- Re-entry briefs at the smallest tier run **~99% smaller** than reading the
  ledger in.
- On our recall benchmark of 351 distinct causes, the noise-floor gate returned
  **zero wrong top answers**. When it could not clear the floor it returned
  nothing.

The ratios depend on ledger size, and a ten-event ledger has nothing to
compress. The methodology lives in the engine's benchmark suite, and the
numbers above come from that pinned run.

## FAQ

**Why is the engine hosted?** The ranking engine is the part that took the
research. We chose a local ledger, a thin auditable client and a hosted engine
over shipping a weaker local ranker. If a remote engine is a dealbreaker,
`MEMORY_PULSE_API` points the client anywhere.

**What about team memory?** Commit `.memory-pulse/` to the repo and your
teammates' agents pulse the same ledger. Shared hosted ledgers are on the
roadmap.

**License?** Client: MIT. Engine: proprietary, hosted.

MIT © Travis Crew

## Memory CI: three verdicts, including an explicit empty one

`memory-pulse check` gives a change one of three verdicts, computed locally
from your ledger and your declared invariants:

- **blocked.** The text writes back a value a correction withdrew, and the
  verdict names the ledger line that retired it and what to use instead. Also
  fires when the text trips a declared invariant. Exit 2.
- **verified.** Recorded events bear on the text and none is contradicted.
  Exit 0.
- **no evidence.** The ledger has nothing to say, reported as exactly that and
  never as a pass. Exit 1 under `--ci`. The hook stays silent on this verdict,
  because a hook that comments on every edit livelocks the agent, and CI is
  where it is loud.

```
npx memory-pulse check --ci --diff origin/main      # added lines of the branch
npx memory-pulse check --ci --file docs/pricing.md
echo "price is $49" | npx memory-pulse check --ci
npx memory-pulse check --receipt --text "…"        # engine-signed receipt, keyless verify at /v1/verify
```

**Invariants** are declared, never inferred. They live one per line in
`.memory-pulse/invariants.jsonl`, shaped like
`{"id":"receipt-wording","statement":"say tamper-evident",
"patterns":["/\\bproof\\b/i"],"paths":["site/"],"severity":"block"}`.
A pattern written `/…/flags` is a regular expression and anything else is a
verbatim substring. `paths` scopes the rule to path prefixes, so a rule about
public wording does not fire on a proofs file. `severity: "warn"` reports
without blocking.

**Overrides** are the false-block signal. `guard allow "$49" --path docs/history
"historical table"` records an `override` event scoped to that path prefix.
The hit passes there and nowhere else, and both `report` and the signed capsule
count it. The guard never guesses, and only explicit withdrawn terms and
declared invariants can block. Measured on our own 852-event ledger, with the
bench in the engine repo: precision 1.0, zero false blocks over 871 negatives
including 694 real notes, and p95 of 1.7 ms at 1k events.

## PR status check with `uses: t-crew/memory-pulse@v0`

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

It checks the **added lines** of the pull request. `blocked` fails the check,
and the sticky comment cites the ledger line that retired each value.
`verified` succeeds with "N memories checked, M corrections enforced".
`no_evidence` is a **neutral** conclusion with an explanation, so an empty
evidence set is never reported as a pass. The comment is one per pull request
and updated in place. Nothing leaves the runner unless you pass `api-key` for
signed receipts. This repository runs it on itself, which is why
`.memory-pulse/events.jsonl` is committed, and the first pull request it
blocked is the demo.

## Releasing

```bash
npm version patch && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which runs the tests and
publishes to npm and the MCP registry using GitHub's OIDC identity. There are
no tokens in the repo and no one-time passwords. npm attaches provenance
automatically, so anyone can verify the package was built from this repo.

One version has four readers: `package.json` for npm, `server.json` for the
MCP registry, `.claude-plugin/plugin.json` for Claude Code and
`.codex-plugin/plugin.json` for Codex. All four must agree. `npm version`
bumps only the first, `test/manifests.test.js` fails until the other three
follow, and the release workflow refuses to publish while they disagree.
