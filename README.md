# memory-pulse

[![npm](https://img.shields.io/npm/v/memory-pulse)](https://www.npmjs.com/package/memory-pulse)
[![license](https://img.shields.io/badge/license-MIT-6366f1)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-a855f7)](https://github.com/t-crew/memory-pulse)

**Site:** [pulse.strategic-innovations.ai](https://pulse.strategic-innovations.ai/), where the guard runs in the browser. [Compare with Mem0, Zep, Letta and CLAUDE.md](https://pulse.strategic-innovations.ai/compare). **Guide:** [docs/GUIDE.md](docs/GUIDE.md), the day-to-day protocol with runnable examples.

**Corrections that outlive the session.**

Your agent acknowledged the correction, then wrote the old value back next
session. memory-pulse records it once, puts it at the top of every session,
and blocks the edit that reintroduces it, quoting the line that retired it.
For Claude Code, Codex, Cursor, any MCP client and GitHub Actions. The record
is a file in your own repository.

Most memory tools stop at showing the correction to the model. The guard is
the part that acts on it.

The four tool definitions come to 3,406 chars, 3.3 KB, about 900 tokens at
3.8 chars per token, measured 2026-09-09. `test/client.test.js` fails the
build past 4,000 chars or 60 tokens either side of 900. Independent
measurements put a typical five to ten server MCP setup at
[50-67k tokens of tool definitions](https://getunblocked.com/blog/mcp-token-budget-autopsy/)
before your first prompt, roughly a third of a 200k context window.

## What it does

A session ends and everything it learned goes with it. memory-pulse keeps a
ledger of **cause -> effect** events in a local file, and gives the agent four
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

Six routes. Pick the row for your agent. Node 18 or newer (`package.json`
engines); the test suite runs on 22 and 24.

`remember` and `help` from the shell arrive in 0.5.9. npm served 0.5.8 on
2026-09-09, where both exit 1 with `unknown command`. Once 0.5.9 is published,
run `npx -y memory-pulse@0.5.9` until your npx cache catches up; before that,
run `node server.mjs` from a checkout. Four more things in this README are
0.5.9 behaviour and differ on 0.5.8: `guard --verbose` names non-JSON stdin
on stderr (0.5.8 prints nothing), `handoff` with no transcript writes nothing
and says `handoff skipped (no transcript)` (0.5.8 records a row that reads
`asked: n/a | files: none`), `remember` reports `boundFromEffect` when it read
the terms out of the effect slug, and a replacement term under 2 characters is
dropped like a withdrawn one. 0.5.8's `install-hook --codex` also says
`trust the two memory-pulse entries` while writing three hooks: trust all
three.

**One line, any shell.** Installs the Claude Code hooks, the Codex hooks when
`codex` is on PATH, and registers the MCP server. It prints its plan first,
runs nothing as root, and downloads nothing itself (npx caches the package
under `~/.npm`). Append `-s -- --dry-run` after `bash` to see the commands
without running them, or `-s -- --project` to write the hooks and the Claude
Code MCP registration into the current repository. `codex mcp add` has no
project scope; it writes `~/.codex/config.toml` on each machine under either
flag.

```
curl -fsSL https://pulse.strategic-innovations.ai/install.sh | bash
```

**Claude Code, as a plugin.** Skill, MCP tools and two hooks (SessionStart
brief, PreToolUse guard) from this repo, typed inside Claude Code:

```
/plugin marketplace add t-crew/memory-pulse
/plugin install memory-pulse@memory-pulse
```

`claude plugin details memory-pulse` shows what you pay. About 120 tokens are
always on, which is the skill's description (Claude Code, 2026-09-01). The
four tool schemas resolve at runtime and the hooks are free. The hooks run
the plugin's own `server.mjs`, so what enforces your corrections is the
version you installed. The plugin does not carry the PreCompact handoff; to
add it, put this entry under `hooks.PreCompact` in `~/.claude/settings.json`:

```json
{ "hooks": [{ "type": "command", "command": "npx -y memory-pulse handoff" }] }
```

**Codex CLI, as a plugin.** Same files, read from `.codex-plugin/plugin.json`:

```
codex plugin marketplace add t-crew/memory-pulse
codex plugin add memory-pulse@memory-pulse
```

Then, inside Codex, run `/hooks` and trust the two `memory-pulse` entries.
Codex runs no hook it has not shown you, and installing a plugin does not
trust its hooks. That is Codex's rule and a good one.

**npm, global install.** `install-hook` writes three hooks into
`~/.claude/settings.json`: SessionStart brief, PreToolUse guard and PreCompact
handoff. `--codex` targets `~/.codex/hooks.json` instead, `--project` writes
them into the repository, and `--ambient` adds the UserPromptSubmit observer.

```
npm i -g memory-pulse
memory-pulse install-hook
```

**Claude Code or Codex without the plugin.** Register the stdio server, then
add the hooks:

```
claude mcp add memory-pulse -- npx -y memory-pulse
codex  mcp add memory-pulse -- npx -y memory-pulse
npx memory-pulse install-hook            # Claude Code: ~/.claude/settings.json
npx memory-pulse install-hook --codex    # Codex:       ~/.codex/hooks.json (then /hooks to trust each entry)
```

`claude mcp add` without a scope registers the server for the current
directory; `-s user` registers it once for every project. `codex mcp add` has
no scope flag and writes `~/.codex/config.toml` (codex-cli 0.153.2,
2026-09-09). Add `--project` to
`install-hook` and the hooks are written into the repo, at
`.claude/settings.json` or `.codex/hooks.json`. Commit that and every clone is
re-entered and guarded with nothing for anyone to install. A Codex clone still
trusts the entries once via `/hooks`, and a scripted `codex exec` needs that
trust in place beforehand.

**Cursor and other stdio clients.** Register `command: npx` with the args
below in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user). Hooks
do not run in Cursor, so the brief and the guard are not available there;
enforce in CI with `check --ci` and lint `.cursorrules` with `lint`. Written
from Cursor's documented shape, not yet verified in Cursor on 2026-09-09.

```json
{ "mcpServers": { "memory-pulse": { "command": "npx", "args": ["-y", "memory-pulse"], "env": { "MEMORY_PULSE_KEY": "" } } } }
```

A rule file at `.cursor/rules/memory-pulse.mdc` tells the agent to call
`pulse` before answering about prior work; the guide has the text.

**From source.** One file, zero dependencies:

```
git clone https://github.com/t-crew/memory-pulse.git
cd memory-pulse && node server.mjs brief --offline
```

The second command prints the corrections in this repository's own committed
ledger, so you see the output format before installing anything.

### What each host runs

Read from `server.mjs` and `hooks/hooks.json`, 2026-09-09.

| | Claude Code plugin | Codex plugin | `install-hook` | Cursor, other MCP clients |
|---|---|---|---|---|
| four tools | yes | yes | with `claude mcp add` or `codex mcp add` | yes |
| brief at session start | yes | after `/hooks` trust | yes | no |
| guard before an edit | `Edit\|Write\|MultiEdit\|apply_patch\|Bash` | `apply_patch` measured, after trust; `Bash` is in the matcher, unmeasured in Codex (2026-09-09) | `Edit\|Write\|MultiEdit\|Bash` (Claude Code), `Edit\|Write\|apply_patch` (Codex) | no; `check --ci` in CI |
| handoff before compaction | no | no | yes | no |
| ambient capture | `mode agent` | no | `--ambient` or `mode agent` | no |
| CLI and GitHub Action | everywhere | everywhere | everywhere | everywhere |

### First run

The hooks stay silent in a project that has no ledger: `brief` prints nothing
and exits 0. The first `remember` creates `.memory-pulse/events.jsonl`, from a
tool call or from the shell:

```
npx -y memory-pulse@0.5.9 remember pricing-shipped price-corrected --kind correction --withdrawn '$49' --replacement '$29' --note 'measured willingness to pay is $29'
# before 0.5.9 is on npm, the same command from a checkout:
git clone https://github.com/t-crew/memory-pulse.git && node memory-pulse/server.mjs remember pricing-shipped price-corrected --kind correction --withdrawn '$49' --replacement '$29' --note 'measured willingness to pay is $29'
```

The hook command `install-hook` writes is `npx -y memory-pulse guard`, and npx
resolves the package on every call: 0.95 s warm and 4.4 s cold per edit on an
M1 Pro on 2026-09-09, against 60 ms for `node server.mjs guard` on the same
ledger the same day, which is the path the plugin runs. If the cost matters,
install the plugin, or install globally and edit the hook command to
`memory-pulse guard`.

### Where the key goes

`export MEMORY_PULSE_KEY=mp_live_...` in the shell that starts Claude Code or
Codex; the plugins and the hooks read the shell environment. On `claude mcp
add`, pass `--env MEMORY_PULSE_KEY=...`. In Cursor, the `env` block above. Do
not also run `claude mcp add` on a plugin install, or you get two servers.

## Corrections are enforced, not only surfaced

Showing an agent a correction is not enough. TRACE
([arXiv 2606.13174](https://arxiv.org/abs/2606.13174)) measured agents
re-violating more than half of the corrections they had been shown, with a
memory tool installed. The PreToolUse guard sees every `Edit`, `Write` and
`MultiEdit` in Claude Code, plus a `Bash` command whose write is literal in
the command string (a heredoc, a redirect or a `tee`, read with nothing
executed), and every `apply_patch` in Codex, where one patch may touch several
files and each is checked under its own path. An edit that writes back a
withdrawn value is **blocked**, and the agent is told which ledger line retired
it and when. An edit that names the replacement beside the old value passes,
because "was $49, now $29" is a comparison. Only a bare reintroduction is
blocked. A shell command whose write cannot be read from the string returns
nothing, so it is a miss rather than a false block, and `check --ci` on the
pull request catches it.

Record corrections with the exact terms:

```
remember({ cause: "pricing-shipped", effect: "price-corrected", kind: "correction",
           note: "measured willingness to pay is $29", withdrawn: ["$49"], replacement: ["$29"] })
```

The rules that decide whether the guard can act on a correction:

- **Matching is a case-sensitive substring with no word boundary.** `$49`
  blocks `$490`; `n=14` does not block `N=14`. Record every spelling you have
  seen, one term each, and choose terms that are not a prefix of a value you
  still use. `before` matches case-insensitively, and it advises rather than
  blocks.
- **A replacement anywhere in the edit releases every term of that
  correction.** Make replacements as specific as withdrawn terms: `$29`, not
  `29`. Terms under 2 characters are dropped and the result says
  `enforceable: false`.
- **Pass the terms yourself.** When a correction declares no withdrawn term
  and its effect reads `X-corrected-to-Y` (or `-withdrawn-for-`,
  `-superseded-by-`, `-replaced-by-`), the terms are read out of the slug:
  `price-corrected-to-29` binds the word `price`. The result then carries
  `boundFromEffect` so you can see it happened.
- **A wrong correction is fixed with a new one carrying `supersedes: [t]`.**
  That retires every term of the earlier row, so re-declare what you keep.
  `guard allow` is different: it records an override for one path prefix
  where the old value is legitimate, and the correction keeps binding
  elsewhere.
- **A note that reads like an instruction is refused**, including any
  angle-bracket tag. Write "the script tag" rather than the tag itself.

Test the guard by hand with the payload Claude Code sends before a Write
(Edit carries `new_string`, MultiEdit `edits[].new_string`, Bash `command`):

```
printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"docs/pricing.md","content":"The price is $49."}}' | npx memory-pulse guard; echo "exit $?"
```

Exit 2 with the ledger line means the guard is live. Stdin that is not hook
JSON is allowed through silently; `guard --verbose` says so on stderr, which
is how you tell a miswired hook from "no evidence".

### Commands

```
npx memory-pulse help           # every command and environment variable; also --help, -h
npx memory-pulse serve          # the MCP server on stdio (the default with no command)
npx memory-pulse brief          # the re-entry brief (what the SessionStart hook prints)
npx memory-pulse brief --budget 2000   # the richest tier that fits 2000 tokens, corrections first and whole
npx memory-pulse brief --offline  # local render when the engine is unreachable (automatic on any engine error)
npx memory-pulse remember <cause> <effect> [--kind correction] [--withdrawn T]... [--replacement T]... [--supersedes N] [--note "..."] [--tags a] [--pinned] [--scope agent]
npx memory-pulse before "<what you are about to do>"   # which corrections bear on the change; exact rung local, learned rung from the engine
npx memory-pulse guard          # PreToolUse hook: blocks edits that reintroduce withdrawn terms (exit 2); --verbose names a non-JSON stdin
npx memory-pulse guard allow "<term>" --path <prefix> "<reason>"   # record a false block as an override
npx memory-pulse check --ci     # Memory CI: one of three verdicts for a change, from files you own
npx memory-pulse verify         # row chain + last engine seal; exit 2 if either fails; --json for machines
npx memory-pulse seal accept "<why>"   # a stale seal over rows that verify: record the decision, set the old seal aside; refused on a broken chain
npx memory-pulse lint [--ci]    # do CLAUDE.md / AGENTS.md / .claude/rules still state a value the ledger retired?
npx memory-pulse report         # correction re-violation scoreboard, computed locally
npx memory-pulse bench          # instant measured metrics on YOUR ledger
npx memory-pulse stats          # your telemetry capsule, signature verified by the engine
npx memory-pulse badge          # README badge markdown from your own signed numbers
npx memory-pulse install-hook   # three hooks (idempotent); --codex targets Codex; --project commits them; --ambient adds the observer
npx memory-pulse mode [agent|deliberate]   # show or set the mode
npx memory-pulse identity "<name>, <role>; <stance>"   # pin the agent's self on the agent ledger
npx memory-pulse handoff        # PreCompact hook: record what the session was doing, from the transcript on stdin
npx memory-pulse ambient        # Stop hook (agent mode): decision, preference, lesson or correction from the last turn
npx memory-pulse observe        # UserPromptSubmit hook: a prompt shaped like a correction is recorded with both terms
```

Undo: `/plugin uninstall memory-pulse` inside Claude Code; delete the
`memory-pulse` entries under `hooks` in `~/.claude/settings.json` or
`~/.codex/hooks.json`; `claude mcp remove memory-pulse`; delete
`.memory-pulse/` in a repository; delete `~/.memory-pulse/agent/`. Each step
leaves the ledgers in place except the last two.

The plugin also ships a **skill** at `skills/memory-pulse/SKILL.md` that
teaches the agent when to pulse, how to record corrections with withdrawn
terms, and how to respect the guard. The npm tarball ships `server.mjs`,
`python/`, this file and the licence; the skill, the hooks and the Action live
in the repository.

## What the brief tells you before it tells you anything

Every engine-backed brief opens with one line of provenance, so a session can
tell whether its memory loaded whole, truncated, or not at all:

```
memory-pulse: loaded 852 events from .memory-pulse/events.jsonl · sha256 1a2b3c4d5e6f · 2 binding corrections (10 withdrawn terms) · 1 superseded · ⚠ 1 malformed line skipped: 544 · memory key resumed (+3 new) · tier brief, 5,153 chars
```

The local render (`brief --offline`, or the engine unreachable) opens with
`memory-pulse: engine unreachable — local render from N events` and carries no
sha256 and no binding count; `lint` prints the provenance line offline.

Every CORRECTIONS line cites its ledger record as `… -> effect (t12) — note`,
so a correction is evidence the agent can point at. `recall` and the guard
name the same `t`. The engine's brief cites each correction with its note and
prints no withdrawn terms, and it lists superseded rows; the offline render
prints `withdrawn: a, b → replacement` and filters superseded rows.

Tiers, from the engine's `src/disclose.js` and `src/tokens.js` read
2026-09-09: index 1,800 chars, brief 6,000, notes 20,000, full 120,000. With
`--budget N` the richest tier whose ceiling fits N tokens at 3.8 chars each is
chosen, so brief needs 1,579 tokens, notes 5,264 and full 31,579; `--budget
1500` gives the index tier. `MEMORY_PULSE_BRIEF_BUDGET` and
`MEMORY_PULSE_BRIEF_TIER` set the same for the hook. The brief costs context:
5,153 chars, about 1,350 tokens, on the 852-event ledger above, 2026-09-01.

An `AT RISK` block appears after the guard has blocked the same correction
twice; `before "<what you are about to do>"` names the corrections that bear
on a change before you make it.

## Lint: the rules a session loads, checked against the ledger

Governance files drift. A `CLAUDE.md` written in June still says the price is
$49 after the ledger retired it in August, and every new session loads the
stale rule with full confidence. `lint` runs the guard's check over the files
a session will read and gives each of them one of the three verdicts. It
covers `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/rules/`,
`.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`,
`.codex/AGENTS.md`, `.memory-pulse/invariants.jsonl`, and any paths you pass:

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

**Never edit a row by hand.** A hand edit breaks the row chain and blocks every
edit until the file is restored from a copy you trust; `verify` names the first
broken row. A stale seal is a different case: the rows verify, but the engine's
last seal no longer matches them, because something rewrote and re-chained the
ledger or the engine sealed a different view. `memory-pulse seal accept "<why>"`
records that decision as a ledger row, sets the old seal aside beside the ledger,
and the next engine call issues a fresh one. Neither case is fixed by deleting
the ledger, and the guard's message never suggests it.

**What to commit.** `events.jsonl` and `invariants.jsonl`. Keep `seal.rain`,
`seal.resume.json`, `telemetry.rain`, `memory.rain` and `violations.jsonl` out
of git; this repository's `.gitignore` carries that list, and nothing writes a
`.gitignore` for you below 500 events. The ledger is read from the directory
the agent started in, so start at the repository root or set
`MEMORY_PULSE_LEDGER`.

## Survives compaction, works offline, captures corrections, speaks Python

Four things added on 2026-09-03, each deterministic (no model in the loop):

- **Compaction handoff.** `install-hook` adds a PreCompact hook (the plugin's `hooks.json` does not; see Install). Before Claude Code compacts, `memory-pulse handoff` reads the transcript and records what the session was doing as facts: the last asks, the files edited, the last error, and the assistant's last state. The next session start prints it first, online or offline. An instruction-like message is dropped from the note and never recorded; a call with no transcript writes nothing.
- **Offline brief.** When the engine is unreachable, whether air-gapped, on a dead network or during an outage, the session no longer starts empty. `brief` prints a local render carrying every binding correction with its withdrawn and replacement terms, the last handoff and the recent rows, labelled as a local render with no ranking applied. `brief --offline` forces it. Guard, check, lint and verify never needed the network. The MCP `pulse` tool returns an error instead, so a client with no hook starts empty when the engine is down.
- **Ambient correction capture, opt-in.** `install-hook --ambient` adds a UserPromptSubmit hook. A prompt shaped like a correction, such as `the price is $29 not $49`, `change 0.3.1 to 0.3.2` or `500 events -> 924 events`, is recorded as a correction carrying both terms, so the guard enforces it from the next edit on. A prompt that does not yield both terms is left alone. Silent unless `--verbose`.
- **Python client.** `python/memory_pulse.py` is a single stdlib-only file with the same ledger format, the same hash chain and the same guard rule. A LangChain or CrewAI agent and a Claude Code session can share one ledger and verify each other's rows. The test suite writes rows from Python and verifies them in Node, and back.
- **Decode-time guard for local models.** `python/span_guard.py` applies the same rule one layer down. The token that would complete a withdrawn value is masked while the model decodes, so the value cannot be generated, and the replacement's next token is offered in its place. It reads the ledger under the rules `check` uses, so a superseded correction is not enforced and a broken chain refuses to build. Stdlib only, and its suite runs without a model. Measured with mlx-lm on TinyLlama-1.1B and Qwen2.5-1.5B on 2026-09-03, the same prompt whose plain decode wrote the withdrawn price wrote the corrected one under the guard, and the sentence around it stayed intact. It blocks the spellings it was given, including the written variants you record, and a paraphrase nobody enumerated gets through.

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
- **A self block, first in every brief**, online or offline. It carries who the agent is as a pinned line, the standing rules and preferences it has learned (rows tagged `rule` and `preference`), the ten newest lessons (tagged `lesson`), and a fingerprint made of the chain head and the engine's seal, so the agent can state which memory it is running on and show it was not swapped or edited overnight.
- **Growth, after every turn.** Two user-scope hooks in `~/.claude/settings.json` (Claude Code only, today). The Stop hook deterministically records a stated decision to the project ledger, a user preference or stated lesson to the agent ledger, and any correction shaped like one. It is capped at four rows a turn, tagged `ambient`, never pinned, and never taken from instruction-like text. Identity itself is only ever set by you or superseded by a correction.
- **Corrections that follow the agent.** A correction on the agent ledger blocks the same edit in any project, in either mode, for as long as the file exists.

`npx memory-pulse mode deliberate` turns the hooks off again and leaves the ledgers in place. `remember` takes `scope: "agent"` from any tool and `--scope agent` from the shell, in either mode. The rule of thumb: off for one repository; on when one agent spans repositories and tools and you accept up to four rows per turn, with the decision rows landing in the project ledger you commit.

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

## Environment

| variable | default | effect |
|---|---|---|
| `MEMORY_PULSE_API` | `https://pulse.strategic-innovations.ai` | engine base URL; point it at another engine |
| `MEMORY_PULSE_KEY` | unset | licence key, sent as `x-mp-key`; the free tier without it |
| `MEMORY_PULSE_LEDGER` | `./.memory-pulse/events.jsonl` | project ledger path; every sidecar lives beside it |
| `MEMORY_PULSE_AGENT` | `$HOME/.memory-pulse/agent/events.jsonl` | agent ledger path |
| `MEMORY_PULSE_PROJECT` | basename of the current directory | project name sent with every engine call |
| `MEMORY_PULSE_MEMORY_KEY` | on | `off` disables the signed memory key (requested at 500 or more events) |
| `MEMORY_PULSE_MODE` | from `~/.memory-pulse/agent/config.json`, else `deliberate` | `agent` or `deliberate` for one invocation |
| `MEMORY_PULSE_SETTINGS_DIR` | unset | directory that receives `settings.json` or `hooks.json` for `install-hook` and `mode`; the tests use it |
| `MEMORY_PULSE_BRIEF_BUDGET` | unset | default for `brief --budget`, in tokens |
| `MEMORY_PULSE_BRIEF_TIER` | `brief` | tier for `brief` when no budget is given: `index`, `brief`, `notes`, `full` |
| `NO_COLOR`, `TERM` | unset | colour in the guard's block message only on a TTY with `NO_COLOR` unset and `TERM` not `dumb` |
| `HOME` | the shell's | root for the agent ledger, `~/.claude/settings.json` and `~/.codex/hooks.json` |

## Pricing

- **Free.** Ledgers up to 500 events, 200 engine reads per IP address per day
  (`worker/api.js`, read 2026-09-09). A session start is one read; past the
  limit the brief falls back to the offline render and says why. No account,
  no key.
- **Pro, $19/mo.** Ledgers to 20,000 events, unlimited reads, signed check
  receipts. One environment variable, `MEMORY_PULSE_KEY`.
- **Enterprise, $79/mo.** Ledgers to 250,000 events, ten revocable seat keys on
  one subscription, ledger receipts through `/v1/certify` that anyone verifies
  keyless at `/v1/verify`, 14-day refund.

| receipt | what it covers | tier |
|---|---|---|
| check receipt (`check --receipt`) | one verdict over one change, engine-signed | Pro, Enterprise |
| ledger receipt (`/v1/certify`) | a whole ledger's set head and chain head | Enterprise |
| free | the engine returns a hint instead of a receipt | Free |

Local writes are free on every tier.

## Measured, on our own ledger

Measured on the ledger of the project that builds memory-pulse, a 767-event
file of 1.08 MB, measured 2026-09-01:

- A cross-referencing question answered through `execute` returned **124
  chars** against the 1,080,983-char full dump. The intermediates never
  entered context.
- Re-entry briefs at the smallest tier run **~99% smaller** than reading the
  ledger in.
- On our recall benchmark of 351 distinct causes, the noise-floor gate returned
  **zero wrong top answers**. When it could not clear the floor it returned
  nothing.

The ratios depend on ledger size, and a ten-event ledger has nothing to
compress. The methodology lives in the engine's benchmark suite.

## FAQ

**Why is the engine hosted?** The ranking engine is the part that took the
research. We chose a local ledger, a thin auditable client and a hosted engine
over shipping a weaker local ranker. If a remote engine is a dealbreaker,
`MEMORY_PULSE_API` points the client anywhere.

**What about team memory?** Commit `.memory-pulse/` to the repo and your
teammates' agents pulse the same ledger. Rows chain on `t` and `prev`, so two
branches that both append conflict on merge: never keep both sides, re-record
the losing rows with `remember`, and run `verify`. Shared hosted ledgers are
on the roadmap.

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
npx memory-pulse check --receipt --text "…"        # engine-signed receipt, keyless verify at /v1/verify (Pro, Enterprise)
```

**Invariants** are declared, never inferred. They live one per line in
`.memory-pulse/invariants.jsonl`, shaped like
`{"id":"receipt-wording","statement":"say tamper-evident",
"patterns":["/\\bproof\\b/i"],"paths":["site/"],"severity":"block"}`.
A pattern written `/…/flags` is a regular expression and anything else is a
verbatim substring. `paths` scopes the rule to path prefixes, so a rule about
public wording does not fire on a test fixture. `severity: "warn"` reports
without blocking.

**Overrides** are the false-block signal. `guard allow "$49" --path docs/history
"historical table"` records an `override` event scoped to that path prefix.
The hit passes there and nowhere else, and both `report` and the signed capsule
count it. The guard never guesses, and only explicit withdrawn terms and
declared invariants can block. Measured on our own 852-event ledger with the
guard-eval bench in the engine repo on 2026-09-01: precision 1.0, zero false
blocks over 871 negatives including 694 real notes, and p95 of 1.7 ms per
in-process check at 1k events.

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
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22 }
      - uses: t-crew/memory-pulse@v0
        id: memory
        with:
          ledger: .memory-pulse/events.jsonl   # default
          lint: "true"                         # also lint CLAUDE.md, AGENTS.md, .cursorrules and the rest
          api-key: ${{ secrets.MEMORY_PULSE_KEY }}
      - run: echo "${{ steps.memory.outputs.verdict }} / ${{ steps.memory.outputs.conclusion }}"
```

It checks the **added lines** of the pull request. `blocked` fails the check,
and the sticky comment cites the ledger line that retired each value.
`verified` succeeds with "N memories checked, M corrections enforced", where M
is the ledger-wide count of binding corrections. `no_evidence` is a
**neutral** conclusion with an explanation, so an empty evidence set is never
reported as a pass. The comment is one per pull request and updated in place.
This repository runs it on itself, which is why `.memory-pulse/events.jsonl`
is committed, and the first pull request it blocked is the demo.

Details that bite:

- `fetch-depth: 0` is required; without it the diff falls back to the working
  tree, the job log says `could not compute the diff ... checking the working
  tree instead`, and the comment reports no evidence on an empty diff.
- `base` is a bare branch name (`main`), defaulting to the pull request's base.
- The added lines are checked under the path `pull-request`, so path-scoped
  overrides and path-scoped invariants do not fire in CI. Record an override
  without `--path` on the pull-request branch when a historical value is
  legitimate.
- Two status items appear, the job and a check-run named `memory-pulse`.
  Require the check-run in branch protection.
- Forks get log-only verdicts: no token, no comment.
- `lint` runs by default and blocks on a stale `CLAUDE.md`; `lint: "false"`
  turns it off.
- `api-key` is exported to the CLI, but the Action does not request a receipt
  today. For a signed receipt run `npx memory-pulse check --ci --diff
  origin/main --receipt` as a separate step with `MEMORY_PULSE_KEY` set.

## Releasing

```bash
scripts/release.sh 0.5.9
```

The script gates on `fail 0` from the test suite, bumps the four version
files together, opens and merges the release pull request, tags, and deploys
the engine. The tag triggers `.github/workflows/release.yml`, which runs the
tests and publishes to npm and the MCP registry using GitHub's OIDC identity.
There are no tokens in the repo and no one-time passwords. npm attaches
provenance automatically, so anyone can verify the package was built from
this repo.

One version has four readers: `package.json` for npm, `server.json` for the
MCP registry, `.claude-plugin/plugin.json` for Claude Code and
`.codex-plugin/plugin.json` for Codex. All four must agree.
`test/manifests.test.js` fails until they do, and the release workflow refuses
to publish while they disagree.
