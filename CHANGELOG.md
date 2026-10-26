# Changelog

This file starts at 0.16.0. Earlier releases are described in their tagged commits.

## Unreleased

**memory-pulse as a remote MCP server.** `memory-pulse http` serves the four
tools over MCP's Streamable HTTP transport, so a client that only takes a URL
(a claude.ai custom connector, Claude on the web or phone) can use the same
memory. Sign-in is OAuth 2.1 with PKCE and dynamic client registration; the
person types their project key once, and it is kept only inside tokens the
server encrypts. Memory is the project's hosted ledger (`state push` and
`state pull`). Each call runs in its own child process with that person's key
and a temporary folder, so two people's calls never share anything. The stdio
server is unchanged. docs/REMOTE.md says how to run it and add it to Claude.

## 0.16.1 (23 October 2026)

**Hooks no longer cost a second each.** A clean-machine test of 0.16.0 timed
the hooks that `install-hook`, `mode soul` and the one-line installer write.
They ran through `npx`, which took 0.98 to 1.54 seconds per call. The guard
itself takes 0.06 seconds. With a hook before and after every tool call, that
was about two seconds added to each one. Hooks now run `node` on a copy of this
release kept in `~/.local/share/memory-pulse` (or `MEMORY_PULSE_DATA_DIR`).
Measured after the change: 0.06 to 0.07 seconds.

Run `npx -y memory-pulse@0.16.1 install-hook` (or `mode soul` again) to upgrade.
It rewrites the old hooks in place and keeps every hook that is not ours. The
Claude Code plugin always ran `node` directly, so plugin users have nothing to do.
`install-hook --project` still writes `npx`, because a committed file has to run
on every clone.

**Smaller fixes from the same test.** The install page names the right desktop
extension file. `--help` prints the board's description under the board. And
`verify` says how many rows were added since the anchor started, in plain words.

## 0.16.0 (release candidate, 22 October 2026)

On 22 October 2026 an outside test attacked memory-pulse 0.15.1, using its
own code on test ledgers, and found four ways past its checks. We ran the same
test against this release. The counts below are attacks caught out of attacks
tried, on a 1,024-row ledger.

**A folder swapped for a link to an older copy is refused too.** A pre-release
review found that replacing the ledger's folder with a link to an older copy
started a fresh check instead of failing it. The check now follows the path
you use, so the swap reads as the rollback it is.

**The way out is never blocked.** When a ledger is in question, the warning
tells you to run `memory-pulse anchor accept "<why>"`. The guard used to
refuse that command if your reason contained words like `cp` or `->`. It now
lets the command through as long as nothing is chained to it.

**An earlier copy of the ledger put back is refused.** Put back an older copy,
seal included, and 0.15.1 accepted it every time (0 of 2). Each machine now
keeps an anchor for each ledger: how many rows it last saw and a digest of
exactly those rows, kept outside the ledger's folder. `verify` fails on any
ledger that no longer begins with those rows, and the guard blocks writes to
the ledger until the newer copy is restored or `memory-pulse anchor accept
"<why>"` records the decision. Caught: 2 of 2.

**A line planted at the end of the file is moved aside, not sealed in.**
0.15.1 called such a line "unsealed", and the next write sealed it into the
chain (0 of 12). Now the next write, or the guard, moves it aside and records
the move, as it already did for a damaged tail. Caught: 12 of 12, before and
after a write.

**An edit to rows written since the last engine call is caught.** 0.15.1's
seal covered rows only up to the last engine call, and re-chaining the file
needs no key (0 of 8). Every row the writer appends now carries a mark made
with a key that stays on your machine, and the anchor covers each row as it
is written. Caught: 8 of 8. A rewrite of older rows that is re-chained to
look consistent is now caught on the machine itself (128 of 128), not only by
the engine on its next call.

**The instruction check reads a note the way a person sees it.** Invisible
characters, letters borrowed from the Cyrillic or Greek alphabets, fullwidth
and mathematical letters, hidden tag characters and base64 no longer hide an
instruction. Of the test's four disguised instructions, 0.15.1 caught none and
0.16.0 catches two: the one split by invisible characters and the one in
base64. A paraphrase and a translation still pass; the check is a list of
patterns, not a reader. It flagged none of 10,000 ordinary notes, none of 8
notes chosen to look suspicious, and changed no verdict on the 2,222 rows of
the ledgers on our own machine.

**The engine's seal no longer waits on a thread pool under Node.** When the
engine's seal code ran under Node 26.5 it stalled three times in one test, and
a stalled call kept the process from exiting. Under Node it now hashes on the
calling thread: 0 calls to the thread pool where there were 16,389 for one
seal and one check of 2,048 rows, and a check takes 69 ms instead of 177 ms.
On Cloudflare Workers nothing changes. The output is byte for byte the same.

### What this release does not do

- A row written through memory-pulse itself carries a valid mark, whatever it
  says. Stopping a planted instruction there is the instruction check's job
  (0 of 12 such rows are caught by the integrity checks, as before).
- A planted row that someone chains into the file by hand looks exactly like
  a row from another machine or from an older memory-pulse. By default it is
  named by `verify` and accepted. `verify --strict`, or
  `MEMORY_PULSE_STRICT_WRITER=1`, refuses it (12 of 12); use that where one
  writer is all there is.
- A process running as you can rewrite both the ledger and the anchor. The
  engine's signature still catches an edit below the seal's watermark on its
  next call, but a whole earlier state put back with its seal and its anchor
  passes. Catching that needs a record kept where that process cannot write,
  and this release does not keep one.

### Upgrading

- The first time 0.16.0 sees a ledger, it trusts what is there and starts the
  anchor from it. Nothing is rewritten.
- New rows carry a `mac` field inside the hashed row, so 0.15.1 and older
  still verify the chain.
- An older memory-pulse still installed on the machine keeps working. Its rows
  are named by `verify` and accepted, and the guard says nothing about them.
- The anchor and the key live in `~/.local/state/memory-pulse/`
  (`$XDG_STATE_HOME/memory-pulse` when that is set). `MEMORY_PULSE_TRUST_DIR`
  moves them; keep them outside every ledger folder.
- New: `memory-pulse anchor` and `memory-pulse anchor accept "<why>"`,
  `verify --strict`, `MEMORY_PULSE_TRUST_DIR`, `MEMORY_PULSE_STRICT_WRITER`.

### What it costs

Measured on 22 October 2026 on an M1 Pro with Node 26.5, while other
measuring runs loaded the machine. On a 1,024-row ledger written by this
release, a write takes 9 ms and the anchor and mark check under 1 ms. On a
copy of our largest ledger (2,100 rows, 2.8 MB, written by older versions) a
write takes about 65 ms instead of 41 ms, because each write reads and hashes
the whole file to confirm the anchor; the check the guard runs on each tool
call takes 69 ms instead of 68 ms.
