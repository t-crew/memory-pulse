// `memory-pulse ran '<regex>'` (0.18.0): the recorded shell commands that match a pattern, with time and session, so an evaluator
// can check whether a forbidden configuration was run after a seal. It reads what the capture hook already records (one observation
// per tool call in .memory-pulse/episodes/<session>.jsonl: the command's first 200 characters, secrets scrubbed, a leading
// `cd <dir> &&` dropped, the time, the outcome) and changes nothing about what capture stores. The episodes here are written by
// the real capture hook, not by hand.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const PATTERN = "train\\.py .*--n (4096|8192)\\b";

// a scratch project and an explicit environment: no MEMORY_PULSE_LEDGER, so nothing here can reach a real ledger
function project() {
  const base = mkdtempSync(join(tmpdir(), "mp-ran-")); const dir = join(base, "p"); mkdirSync(dir);
  writeFileSync(join(dir, "spec.md"), "# exp-7\nconfirmation sizes are the evaluator's\n");
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env, input, encoding: "utf8" });
  let n = 0;
  // one tool call as Claude Code reports it after the fact; `error` makes it a failure
  const ranCommand = (session, command, error) => { const r = run(["capture"], JSON.stringify({ session_id: session, cwd: dir, hook_event_name: error ? "PostToolUseFailure" : "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: `call-${++n}`,
    ...(error ? { error } : { tool_response: { stdout: "", stderr: "", exit_code: 0 } }) })); assert.equal(r.status, 0, r.stderr); };
  return { dir, run, ranCommand, ledger: join(dir, ".memory-pulse", "events.jsonl") };
}
const out = (r) => `${r.stdout}${r.stderr}`;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("ran lists the recorded commands that match, each with its time and session, and marks an evaluator's", () => {
  const p = project();
  p.ranCommand("sess-A", "python train.py --n 1024");
  p.ranCommand("sess-A", "cd runs && python train.py --seed 3 --n 4096");
  p.ranCommand("sess-A", "npm test");
  p.ranCommand("sess-B", "MEMORY_PULSE_ROLE=evaluator python train.py --n 8192", "Exit code 1\nTraceback: boom");
  const j = JSON.parse(p.run(["ran", PATTERN, "--json"]).stdout);
  assert.equal(j.pattern, `/${PATTERN}/`); assert.equal(j.since, null);
  assert.deepEqual(j.searched, { sessions: 2, commands: 4 });
  assert.deepEqual(j.matches.map((m) => [m.session, m.cmd, m.ok, m.exit, m.evaluator]), [
    ["sess-A", "python train.py --seed 3 --n 4096", true, 0, false],
    ["sess-B", "MEMORY_PULSE_ROLE=evaluator python train.py --n 8192", false, 1, true],
  ]);
  for (const m of j.matches) { assert.match(m.at, ISO_MS); assert.ok(Math.abs(Date.parse(m.at) - Date.now()) < 30_000); }
  assert.ok(j.matches[0].at <= j.matches[1].at, "oldest first");
  const r = p.run(["ran", PATTERN]);
  assert.equal(r.status, 0, out(r));
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines[0], `ran /${PATTERN}/: 2 of 4 recorded command(s) match, in 2 of 2 session(s)`);
  assert.equal(lines[1], `  ${j.matches[0].at}  session sess-A  ok  python train.py --seed 3 --n 4096`);
  assert.equal(lines[2], `  ${j.matches[1].at}  session sess-B  exit 1  MEMORY_PULSE_ROLE=evaluator python train.py --n 8192  [evaluator]`);
  assert.match(lines[3], /what the capture hook recorded on this machine/); assert.match(lines[3], /first 200 characters/);
  assert.ok(!existsSync(p.ledger), "ran reads the episodes; it writes no row");
});

test("ran --since takes a time, in either form `now` prints, and lists only what ran at or after it", () => {
  const p = project();
  p.ranCommand("sess-A", "python train.py --n 4096");
  p.ranCommand("sess-A", "python train.py --n 8192");
  const all = JSON.parse(p.run(["ran", PATTERN, "--json"]).stdout).matches;
  assert.equal(all.length, 2); assert.ok(all[0].at < all[1].at, "two captures are two instants");
  const later = JSON.parse(p.run(["ran", PATTERN, "--since", all[1].at, "--json"]).stdout);
  assert.equal(later.since, all[1].at); assert.deepEqual(later.matches.map((m) => m.cmd), ["python train.py --n 8192"]);
  assert.equal(JSON.parse(p.run(["ran", PATTERN, "--since", "2020-01-01 00:00 UTC", "--json"]).stdout).matches.length, 2);
  assert.equal(JSON.parse(p.run(["ran", PATTERN, "--since", "2020-01-01T00:00:00Z", "--json"]).stdout).since, "2020-01-01T00:00:00.000Z");
  const none = p.run(["ran", PATTERN, "--since", "2999-01-01 00:00 UTC"]);
  assert.equal(none.status, 0); assert.match(none.stdout, /: 0 of 2 recorded command\(s\) match, in 0 of 1 session\(s\), since 2999-01-01T00:00:00\.000Z/);
  assert.match(none.stdout, /what the capture hook recorded on this machine/, "no match is never said to mean nothing ran");
  const bad = p.run(["ran", PATTERN, "--since", "last tuesday"]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /--since takes a row number or a time/);
});

test("ran --since takes a prereg row: what ran after the seal, to the millisecond the seal was written", () => {
  const p = project();
  p.ranCommand("sess-A", "python train.py --n 4096");
  assert.equal(p.run(["remember", "exp-7-planned", "spec-drafted"]).status, 0);
  const s = p.run(["prereg", "seal", "exp-7", "--spec", "spec.md", "--forbid", PATTERN]); assert.equal(s.status, 0, out(s));
  p.ranCommand("sess-B", "MEMORY_PULSE_ROLE=evaluator python train.py --n 4096");
  const sealAt = JSON.parse(readFileSync(p.ledger, "utf8").trim().split("\n")[1]).prereg.at;
  const r = p.run(["ran", PATTERN, "--since", "2"]);
  assert.equal(r.status, 0, out(r));
  assert.match(r.stdout, new RegExp(`: 1 of 2 recorded command\\(s\\) match, in 1 of 2 session\\(s\\), since row 2 \\(prereg exp-7 sealed, ${sealAt}\\)`));
  assert.match(r.stdout, /session sess-B {2}ok {2}MEMORY_PULSE_ROLE=evaluator python train\.py --n 4096 {2}\[evaluator\]/); assert.ok(!/sess-A/.test(r.stdout));
  // a row that records no clock reading cannot be a time
  const plain = p.run(["ran", PATTERN, "--since", "1"]);
  assert.equal(plain.status, 1); assert.match(plain.stderr, /row 1 carries no stamp/); assert.match(plain.stderr, /memory-pulse now/);
  const absent = p.run(["ran", PATTERN, "--since", "99"]);
  assert.equal(absent.status, 1); assert.match(absent.stderr, /no row 99/);
});

test("ran says so when there is no capture record, and refuses a pattern that is not a regular expression", () => {
  const p = project();
  const r = p.run(["ran", PATTERN]);
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /no capture record beside this ledger/); assert.match(r.stdout, /says nothing about what ran/);
  assert.deepEqual(JSON.parse(p.run(["ran", PATTERN, "--json"]).stdout), { pattern: `/${PATTERN}/`, since: null, searched: { sessions: 0, commands: 0 }, matches: [] });
  for (const [args, re] of [[["ran"], /usage: memory-pulse ran/], [["ran", "train(.py"], /'train\(\.py' is not a regular expression/], [["ran", PATTERN, "--until", "x"], /unknown option --until/], [["ran", PATTERN, "extra"], /usage: memory-pulse ran/]]) {
    const x = p.run(args); assert.equal(x.status, 1, `${args.join(" ")}: ${out(x)}`); assert.match(x.stderr, re);
  }
});

test("the limit is stated and pinned: capture keeps a command's first 200 characters, so a match past them is not found", () => {
  const p = project();
  p.ranCommand("sess-A", `python train.py ${"--tag x ".repeat(40)}--n 4096`);
  p.ranCommand("sess-A", "API_TOKEN=abc123def456 python train.py --n 4096");
  const j = JSON.parse(p.run(["ran", PATTERN, "--json"]).stdout);
  assert.deepEqual(j.searched, { sessions: 1, commands: 2 });
  assert.deepEqual(j.matches.map((m) => m.cmd), ["API_TOKEN=[secret] python train.py --n 4096"], "the long command's size sits past the 200th character; the secret was never stored");
});
