# Install memory-pulse

Pick the agent you use. Each route installs the same thing: a ledger file in your project that keeps every correction, four tools your agent calls, and, where the host runs hooks, a brief at session start and a guard before each edit. Node 18 or newer. The free tier needs no key and no account.

## Claude Code

Typed inside Claude Code:

```
/plugin marketplace add t-crew/memory-pulse
/plugin install memory-pulse@memory-pulse
```

The plugin brings the skill, the four tools, the session-start brief, the prompt slice, the guard, and capture: each tool call is recorded locally, with no model and no network, and a check that failed and then passed becomes a fix. About 120 tokens are always on (the skill's description); `claude plugin details memory-pulse` shows the figure on your install. To also record what a session was doing before Claude Code compacts it, add the handoff hook under `hooks.PreCompact` in `~/.claude/settings.json`:

```json
{ "hooks": [{ "type": "command", "command": "npx -y memory-pulse handoff" }] }
```

## Codex CLI

```
codex plugin marketplace add t-crew/memory-pulse
codex plugin add memory-pulse@memory-pulse
```

Then run `/hooks` inside Codex and trust the three `memory-pulse` entries (session start, prompt and guard). Codex runs no hook you have not trusted, and installing a plugin does not trust its hooks.

## Claude Desktop

Download `memory-pulse-0.8.0.mcpb` from the [latest release](https://github.com/t-crew/memory-pulse/releases/latest) and open it. Claude Desktop asks for three settings:

| Setting | What to put |
|---|---|
| Memory folder | Where the ledger lives. The default is `~/.memory-pulse`; pick a project's `.memory-pulse` folder to share memory with Claude Code in that project. |
| Licence key | Leave blank for the free tier. |
| Agent message board file | Leave blank, or name a board file shared with other agents to add `board_post` and `board_read`. |

Claude Desktop runs no hooks, so there is no session-start brief and no guard there: the agent reads and records memory through the tools. The extension is built and validated with the official MCPB tool and its server was run from the unpacked extension on 2026-10-16; it has not yet been tested inside Claude Desktop itself.

## Cursor and other MCP clients

Register the stdio server. For Cursor, put this in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user):

```json
{ "mcpServers": { "memory-pulse": { "command": "npx", "args": ["-y", "memory-pulse"] } } }
```

Any client that starts a stdio MCP server takes the same command and arguments. Hooks do not run in these clients, so enforce corrections in CI with the GitHub Action below, and run `npx -y memory-pulse@0.14.4 lint` over `.cursorrules` and the other rule files. The Cursor entry follows Cursor's documented format and has not yet been verified inside Cursor.

## Claude Code or Codex without the plugin

```
claude mcp add memory-pulse -- npx -y memory-pulse
codex  mcp add memory-pulse -- npx -y memory-pulse
npx -y memory-pulse@0.14.4 install-hook
npx -y memory-pulse@0.14.4 install-hook --codex
```

`install-hook` writes the hooks into `~/.claude/settings.json`, or `~/.codex/hooks.json` with `--codex`. Add `--project` to write them into the repository instead; commit that and every clone is re-entered and guarded with nothing to install.

## One line, any shell

```
curl -fsSL https://pulse.strategic-innovations.ai/install.sh | bash
```

It installs the Claude Code hooks, the Codex hooks when `codex` is on your PATH, and registers the MCP server. It prints its plan first and runs nothing as root. Add `-s -- --dry-run` after `bash` to see the commands without running them.

## Python agents

The Python client is one file with no dependencies. It reads and writes the same ledger and the same board as the npm client, so a LangChain, CrewAI or hand-written agent and a Claude Code session share one memory and check each other's rows.

```
curl -fsSLO https://raw.githubusercontent.com/t-crew/memory-pulse/main/python/memory_pulse.py
python3 memory_pulse.py verify .memory-pulse/events.jsonl
```

In code: `Ledger(".memory-pulse/events.jsonl")` gives `append`, `verify`, `check` and `brief`.

## Pull requests: the GitHub Action

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
```

A pull request that writes back a value your ledger retired fails the check, and one comment cites the ledger line that retired it. An empty evidence set is reported as neutral, never as a pass.

## Check that it works

From the project folder:

```
npx -y memory-pulse@0.14.4 remember pricing-shipped price-corrected --kind correction --withdrawn '$49' --replacement '$29' --note 'measured willingness to pay is $29'
npx -y memory-pulse@0.14.4 check --text 'the plan costs $49 a month'
npx -y memory-pulse@0.14.4 verify
```

The first command creates `.memory-pulse/events.jsonl` and records the correction. The second answers `BLOCKED` and names the row that retired `$49`. The third walks the chain and answers `chain: OK`.

## What each host runs

| | Claude Code plugin | Codex plugin | Claude Desktop | Cursor, other MCP clients |
|---|---|---|---|---|
| the four tools | yes | yes | yes | yes |
| brief at session start | yes | after `/hooks` trust | no | no |
| guard before an edit | yes | after `/hooks` trust | no | no; use the GitHub Action |
| message board tools | with `MEMORY_PULSE_BOARD` set | with `MEMORY_PULSE_BOARD` set | with a board file set | with `MEMORY_PULSE_BOARD` set |
| CLI and GitHub Action | everywhere | everywhere | everywhere | everywhere |

## Next

The guide walks through every command with the output it prints: recording corrections, the guard, the brief, agent mode, teams and CI, agent state, and the message board for several agents.
