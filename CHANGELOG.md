# Changelog

This file starts at 0.16.0. Earlier releases are described in their tagged commits.

## 0.19.0 (unreleased)

Three new command families, a stricter guard and a reworked pull-request check. Read "What changes for you" first:
some edits and pull requests that 0.18.0 passed are now stopped.

**After upgrading, run `memory-pulse install-hook` again (or `memory-pulse init`).** The hooks run a pinned copy of the
client, so an upgrade alone leaves them on the old one. `memory-pulse doctor` now fails when a hook runs an older copy
and prints the command that re-pins it.

**What changes for you.**

- A replacement releases a withdrawn value only on the same line. 0.18.0 let `| Pro | $49/mo |` through when `$29`
  stood anywhere else in the edit. Before-and-after text on two lines is now blocked; put both on one line, as a
  comparison. Measured with one real ledger (131 corrections that have a replacement) over 6,204 file checks on
  2026-11-21: 0.18.0 blocked 91 files and this version 100; of the 9 newly blocked none was a true reintroduction
  (3 comparisons split over two lines, 6 uses of a broad phrase). Of 91 ways of writing a value back, 0.18.0 caught 13
  and this version 30.
- A replacement that is part of the old value no longer releases it: with `v2.1` corrected to `v2`, 0.18.0 never
  blocked `v2.1`.
- A rule scoped with `paths` now fires when the editor names the file by its absolute path. Claude Code does, so a
  rule scoped to `docs/` was never enforced there on 0.18.0. Scoped rules you declared will start to apply.
- `sed -i`, `perl -i`, `python -c` and `node -e` commands that write a withdrawn value are blocked, and so is a heredoc
  whose redirect follows its marker (`cat <<'EOF' > file`). A command that removes the value, or only reads, passes.
- The guard's block message has a new first sentence. A script that matches the old text will not match.
- A number that capture overheard by itself ("48") is no longer enforced, including on rows 0.18.0 wrote: it is as
  broad as an ordinary word (48 stands in 10.3% of a 3,000-file sample). A number you record on purpose still binds,
  and so does one with a unit or a symbol (`$49`, `48 tests`, `v2.1`).
- The pull-request Action checks each file under its own path, judges a pull request that changes the rules by the
  base branch's rules as well, runs installed rule packs, and fails when it cannot read the change. Details below.
- `uses: t-crew/memory-pulse@v0` now follows every release. Until this release the tag still served 0.2.2, so a
  workflow on `@v0` receives every change since then at once: `lint` over the governance files is on by default
  (`lint: "false"` turns it off), and the checks described under "The pull-request Action".
- `install-hook --project` also runs team setup: it writes two lines to `.gitattributes` and a merge driver to this
  clone's `.git/config`.
- An unknown hyphenated option to `remember` (`--dry-run`) is refused. It used to be dropped.
- `lint` no longer judges `.memory-pulse/invariants.jsonl`. A rule's own line holds its pattern, so one unscoped
  literal rule blocked that file, and through the Action every pull request.

**Try it, check it, set it up: `demo`, `doctor`, `init`.** `npx memory-pulse demo` records one correction in a temporary
folder and prints the guard's verdict on three edits, in about 0.3 s, with nothing installed and nothing left behind.
`doctor` checks the wiring: each host's hooks, their event and matcher, whether the copy they run exists and is
current, and the guard's answer to a synthetic edit. It exits 1 when a check fails and names the fix. It runs a hook's
program only when that program is this copy of the client, your pinned copy or a plugin under your home folder, with
an argument list and no shell. Any other hook command is shown and counted as not tested, and the last line then says
so instead of "All checks passed". A second editor that is present with no hooks is reported as not set up, not as a
failure. Unless `--offline` is given, `doctor` makes one GET to the engine's address and, through `verify`, writes
this machine's anchor for the ledger. `init` prints its plan (every file it will write, `.gitattributes` and `.git/config`
included), asks once, installs the hooks and runs `doctor`. `install-hook` now sets the hook type and repairs a
matcher that misses a guarded tool.

**Rule packs.** A pack is a file of sourced rules for one stack: `pack list`, `show`, `add`, `remove`, `check`,
`rule` and `verify`. Eight packs and 61 rules ship: Python standard library, Pydantic v2, FastAPI, Next.js App
Router, Cloudflare Workers, Stripe, Supabase auth and retired model identifiers. Each rule carries the vendor's page
and the date it was read. `pack add` installs every rule as a warning the agent is shown; a rule blocks only when you
turn it on (`pack add <name> --block`, or `pack rule <pack>/<rule> block`), and the eight rules marked safe to block
skip comments, strings and Markdown. Measured over 35 public repositories and 110 near-miss snippets: 0 blocked as
installed, 2 with every block turned on. The skipping also hides a real use that sits inside a string or beside one on
the same line: in one test 16 of 29 such uses were not flagged. `pack check` previews a pack against your tree. A pack file that does not
load is reported on every guard run and fails `check --ci`. A `paths` entry with a `*` in `invariants.jsonl` is now a
glob, and one that starts with `!` takes paths out of scope. A hand-declared `warn` rule is still silent in the guard, as before.

**Teams: a merge driver for the committed ledger.** `team setup` (also run by `install-hook --project`) makes git merge
`.memory-pulse/events.jsonl` and `invariants.jsonl` through `memory-pulse merge-driver`. Both sides' rows are kept,
carried through the writer so the chain verifies; rollback, superseding and override rows keep their effect in every
shape tested but three rare ones (see Known limits); two
corrections that contradict each other stop the merge with the rows and the settling command named. `team` reports a
clone that has the attribute and no driver, and a ledger that was merged by hand; `team resolve` rebuilds it without
dropping a row. 5,000 rows a side merge in about 5 s. Limits: GitHub's merge button runs no merge driver, so merge or
rebase locally and push; a pre-registration's forbid rule applies only in the clone that sealed it.

**The pull-request Action.**

- Each changed file is checked under its own path, so `paths` scopes and `guard allow --path` apply as they do in the
  editor. Files are checked eight at a time: about 13 s for 300 changed files and about 90 s for 1,000, measured on a loaded
  machine. The ledger, the
  declared rules and the installed packs (and everything under a folder named `.memory-pulse`) are the rules, not
  content: a pull request that only records a correction or declares a rule no longer fails its own check. A file that
  merely sits beside a ledger kept elsewhere is content and is checked; folders named `packs` and `rows` beside the
  ledger are read as rules.
- A pull request that changes any of those rule files is judged by the rules on the base branch as well as its own,
  and the stricter verdict stands. Superseding a correction, recording an override, turning a pack rule off, or moving
  or deleting the ledger in the same change that breaks the rule no longer passes. The comment names the files.
  `rules: head` opts out.
- An added line that begins with `++` is read. It used to be taken for a file header and skipped.
- When the change cannot be read (no base in the checkout, no shared history) the job fails and says so. It used to
  check an empty diff and report no evidence. The base is fetched only when missing, and a full clone stays full.
- Installed rule packs run file by file; a block fails the check and a warning is listed.
- With `api-key` set the Action requests a signed receipt and the comment names it. The input did nothing before. The
  verdict is always the one computed on the runner.

**Capture.** A prohibition of one ordinary word heard in a prompt ("no merge") is recorded as heard and not enforced,
with the command that enforces it on purpose. 0.17.1 had stopped the guard blocking on such a word; the row was still
written as if it were enforceable. On one real ledger, 125 of 166 term blocks between 1 September and 20 November 2026
had come from seven such rows. A deliberate `remember --withdrawn <word>` still binds and returns a caution. A
scheduled prompt found in the transcript is not captured. `adopt` reads "Never use Postgres 14; use Postgres 16." as
a correction from one to the other. `report` and the brief label a correction that was blocked 5 or more times across
3 or more folders on a non-specific term as noisy, with the two ways out.

**Python client.** `check` follows the same token, line and advisory rules as the Node client; the two agree on a
shared fixture of twenty texts. It still does not read rollbacks or overrides.

**Output through a pipe arrives whole.** A command prints and then exits. On macOS, when another program captured
that output (every host runs a hook this way, and so does an agent's shell tool), everything past the first 8,192 bytes
was dropped on Node 18 and 20, and everything past 65,536 bytes on Node 22 to 26. `help` is 18 KB.
`scaffold --section corrections` passes 8 KB at about 85 corrections, so an agent on Node 20 read a list of corrections
that stopped in the middle with nothing to say so. Every command that prints and exits now waits for each write, and
the stdio server sends its last answers before it exits (a scripted session of 60 requests got 34 answers back).
Measured after the change on macOS with Node 18, 20, 22, 24 and 26: 2 MB arrives whole, the exit status is the same,
and a reader that closes early ends the command at once. Linux, a terminal and a file were never affected. Found by
running the suite on macOS with Node 20 before release; not run on Windows.

**The base branch's rules are read on a macOS runner.** A pull request that changes `.memory-pulse/` is also judged by
the rules on its base branch, which the Action unpacks with `git archive` and `tar`. Through a pipe, macOS `tar` stopped
reading at the archive's end marker, and on Node 20 the rest of the write failed, so the job stopped before any verdict.
The archive now goes through a file. Linux was not affected.

**Tests and releases.** `npm test` runs through `scripts/test.mjs`, which clears the caller's ledger, project, board
and key variables: the suite used to write test rows into whatever ledger the shell named. `scripts/release.sh` moves
the major tag, skips it for a pre-release, stops when the version it would tag is not the one asked for, can leave the
engine undeployed (`RELEASE_SKIP_WORKER=1`), and runs the IP gate in strict mode.

**A ledger this client cannot read is never passed in silence.** A later release may keep the ledger in another layout
and will mark it with `.memory-pulse/layout.json`. When this client meets a marker it does not know, the guard says so
on every edit (to you and to the agent), the brief opens with it, `doctor` fails with the upgrade command, and `check`,
`lint` and the pull-request Action fail. With no marker nothing changes.

**Known limits.** Cursor's hooks are written by `install-hook --cursor` and have not been run inside Cursor. The guard
does not catch a paraphrase, `sed` text supplied on following lines, or an inline script that writes a variable. A
project's own function named like a removed API can trip a pack rule you have set to block. A pack pattern that
exceeds its time budget is skipped and reported, not blocked, and bundled packs run without the budget. In the team
merge, three rare shapes are wrong: after a rollback of a rollback the verdict can depend on who merges; a row
recorded while the ledger was unmerged is kept without its `--supersedes`; and after the driver refuses a cherry-pick
and one row is recorded, `team resolve --no-ancestor` says there is nothing to resolve. With the ledger at the
repository root, the project's own `packs/` and `rows/` folders are not checked on a pull request and a `layout.json`
of its own fails it; keep the ledger in `.memory-pulse/`. A rule file that is a symlink is not covered by the
base-branch pass. The suite has run on macOS only; the new
`test` workflow runs it on Linux for the first time on the release pull request.

## 0.18.0 (19 November 2026)

**Pre-registered research gets a command for each of three slips.** An agent
doing pre-registered work (a builder writes a spec, seals it and builds; a
separate evaluator judges) made three mistakes in one night. It typed time
stamps from memory into records: "00:3x UTC" when the clock said 00:15, and a
seal time quoted wrongly. It ran its own experiment at sizes its own amendment
had reserved for confirmation, and nothing stopped the run or recorded it. It
copied a constant about a deployed system into a sealed spec from a summary:
0.5, where the run logs and the shipped file said 0.25.

`memory-pulse now` prints the machine clock as the two stamps a record uses.
A stamp is pasted from it, never typed.

`memory-pulse prereg seal <id> --spec <file>` seals a spec. Every
`--assert '<path>::<text>'` is checked first, against the file that defines
the value. A line of the file must state the text whole: a trailing `#` or
`//` comment is set aside, and the text may not have a letter, a digit, an
underscore or a dot directly before or after it, so a prefix of the real value
and a value that only a comment mentions do not hold. If no line states it,
the seal prints the line that does carry the name, exits 1 and writes nothing;
if one does, the seal prints the file, the line number and the line. The text
and the lines shown pass the secret scrubber before they are printed or kept. A seal that passes writes
one ledger row: the stamp, read from the clock by the code, the sha256 of the
spec and of each `--file`, the assertions and the forbid patterns. No option
takes a stamp. The row reads `prereg <id> -> sealed <first 12 characters of
the spec's sha256>`, and a settle row `settled <WORD> <first 12 characters of
the verdict file's sha256>`: neither effect is a bare word, and `check` and
`lint` never count a prereg row as evidence about a text. An id has one open
seal at a time: the check is made under the ledger's lock together with the
write, so of two seals of one id started at the same moment one is written and
the other is refused.

Each `--forbid '<regex>'` is blocked by the guard as a shell command while the
seal is open. A forbid names the evaluator's command, not every command: at
seal time each pattern is tried on the seal's own `prereg settle`, `prereg
verify` and `prereg list`, on `ls`, `pwd`, `cd /tmp`, `git status`, `cat
README.md`, `echo ok`, `node --version`, `python3 --version` and on the empty
command, and one that matches is refused with that command named, exit 1,
nothing written. The trial runs in a process of its own and is timed: a
pattern still running after 500 ms on those commands and three long ones is
refused as too slow to run before every command. The block names the prereg and its seal row, says the command is
the evaluator's, and says how to proceed. The way out always works: a seal's
rule never blocks a line that is one invocation of `memory-pulse prereg
settle`, `prereg verify`, `prereg list`, `verify` or `now` and nothing more.
A seal's rule applies in the seal's project: it is matched only against a
command that would run in the directory the seal was made in or below it, or
that names that directory, so one ledger shared by several projects carries a
seal's rule into none of the others. A seal's rule with no open seal on the
ledger is an orphan rule: the guard does not enforce it and says so, `prereg
list` shows it, and `prereg settle <id>` removes it without writing a row. A command line that starts with
`MEMORY_PULSE_ROLE=evaluator` passes. This is a tripwire against inattention,
not a security boundary: anyone can type the marker, and a command inside a
script file is not read. A blocked command is recorded in
`.memory-pulse/violations.jsonl`. The rule fires where the guard sees shell
commands: Claude Code's `Bash`, and Cursor's `Shell` as tested against its
documented payload (not yet run inside Cursor itself). The hook `install-hook
--codex` writes does not match Codex's shell tool, so the rule is not enforced
on Codex.

`memory-pulse prereg verify <id>` is the evaluator's first step. It re-hashes
every sealed file and prints unchanged, or CHANGED with both hashes; exit 2
unless every one is unchanged. A seal is as trustworthy as the ledger's row
chain: `prereg list`, `verify` and `settle` count a row as a seal only when
that chain holds it (the walk `memory-pulse verify` makes), a row typed into
the ledger file or edited afterwards is listed as `NOT ON THE CHAIN` and
refused, and `prereg verify` ends by saying what its answer rests on. `memory-pulse prereg settle <id> --verdict
<WORD> --file <verdict-file>` writes one row with the verdict file's sha256,
citing the seal row, and the forbid patterns stop blocking. `memory-pulse
prereg list` shows open and settled seals.

`memory-pulse ran '<regex>' --since <row>` lists the shell commands the
capture hook recorded that match, with time and session, so an evaluator can
check what ran after a seal. It reads what capture already keeps, the first
200 characters of each command, and capture itself is unchanged. No match is
never reported as "nothing ran".

Underneath, a declared invariant can now apply to shell commands. A line of
`.memory-pulse/invariants.jsonl` with `"on": "command"` is matched against the
command of a `Bash` tool call and by `check --kind command`, never against a
file edit, and `paths` does not apply to it. An invariant without `on` behaves
exactly as before. `check --receipt` sends the engine only the invariants that
apply to the kind of action it is asked about.

Limits. A seal is as trustworthy as the ledger's row chain. `state merge` does
not carry a seal's rules: a merged seal row is listed on the other ledger under
its new row number, but `invariants.jsonl` does not travel, so nothing is
blocked there, and a merged settle row's `seal` field still names the row
number it had on its own branch. `repair --adopt-quarantine` does not carry
the manifest: a seal row that was moved aside comes back as an ordinary row,
not as a seal. A forbid pattern is matched against the command line the guard
is shown, so a command inside a script file, or one built from variables, is
not read. An assertion is compared line by line: a value that spans lines
cannot be asserted, and one the secret scrubber changes is kept scrubbed.

## 0.17.2 (17 November 2026)

**An advisory word is no longer what your memory leads with.** 0.17.1 stopped
the guard blocking on a single ordinary word that ambient capture had recorded
by itself. The rest of the client still treated those rows as corrections: the
session brief listed them first, with their old block counts, and any prompt or
edit that merely contained the word had the row injected into the session. On
one real ledger the brief's first two correction lines were two of these words.

Now such a row is listed after every enforced correction, marked
`advisory: not blocked`, without a block count. A prompt or an edit that
contains only the word gets no line about it. Nothing is deleted, phrases and
values are unaffected, and a word you record yourself is enforced and shown as
before.

## 0.17.1 (16 November 2026)

**The guard no longer blocks on a single ordinary word it picked up by
itself.** Ambient capture reads a prompt shaped like "no X" or "X not Y" and
records X as withdrawn. The guard then blocks every edit that contains X. When
X is a phrase or a value, that is the product working. When X is one ordinary
word, it is a false block nearly every time. On one real ledger all nine such
terms were accidents, among them "send", "merge", "just" and "only". "merge"
had blocked 84 edits. "send" blocked every file that called an API method of
that name, and each one needed its own `guard allow`.

From this release a withdrawn term is advisory when both things are true: it
is one word made only of letters, and ambient capture wrote the row. The guard
lets the edit through and `check` says why, with the command that enforces the
word if you do mean it. Nothing else changes. A phrase, a value with a digit
or a symbol in it, and any term you recorded yourself with `remember` block as
they did before. Rows already in your ledger are covered; nothing is rewritten.

The session brief still lists such a row under corrections, with its old block
count. It no longer blocks.

## 0.17.0 (16 November 2026)

**`before` now tells you when the ledger already closed the idea.** Until this
release `before` had two rungs. The exact rung fired only when your words
contained a withdrawn term. The learned rung needed the engine. So with the
engine away, a plan to rebuild something the ledger had already tried and
closed got the answer "no withdrawn term in the operation", and nothing else.
We saw it on a 4,218-row ledger: four proposals to redo closed work, four
silent passes, while the rows that closed them sat in the ledger.

`before` has a third rung now, and it is local. It matches what you describe
against single sentences of the rows in force, weighs each word by how rare it
is in your ledger, and prints the sentences that match. A row whose matching
sentence records an ending (kill, closed, rejected, shelved, withdrawn and the
like) is marked with a cross and the word. It runs with or without the engine
and prints under the exact rung when both fire.

What we measured, on that one ledger, as a spot check and not a benchmark: of
six proposals to redo closed work, five surfaced a row about that work, and
three of those were marked closed. Of six unrelated controls, three printed
nothing, two printed rows on the same subject, and one printed three weak
rows. It reads words, not meaning. Treat a line as a row to go and read, and
an empty answer as "the ledger does not name this", never as proof it is new.
The check took under a second on 4,218 rows.

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
