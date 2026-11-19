// Review of 0.18.0 (2026-11-19): what an independent reviewer found in `prereg`, the rules on shell commands and `ran`, one test
// per finding. Each test states the behaviour the finding asked for; the numbers F1..F9 are the review's own.
//   F1  a forbid pattern could lock a session out of its own shell: the way out always works, a pattern that matches an
//       everyday command is refused at seal time, a seal's rule applies in the seal's project, and a rule with no open seal
//       is not enforced
//   F2  a seal row made `check` say VERIFIED on the word "sealed"
//   F3  an assertion held on a prefix of the real value and on a value inside a comment
//   F4  `prereg verify` vouched for a seal row written into the ledger file by hand
//   F5  a slow pattern, F6 two seals of one id at once, F8 what the documents say, F9 two small ones
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, chmodSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SERVER, ROOT } from "./_helpers.mjs";
import { localCheck } from "../server.mjs";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const out = (r) => `${r.stdout}${r.stderr}`;

// a scratch project and an explicit environment: no MEMORY_PULSE_LEDGER unless a test names one, so nothing here can reach a real ledger
function project() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mp-review-"))); const dir = join(base, "p"); mkdirSync(dir);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const run = (args, input = "", opts = {}) => spawnSync(process.execPath, [SERVER, ...args], { cwd: opts.cwd ?? dir, env: { ...env, ...(opts.env ?? {}) }, input, encoding: "utf8", timeout: opts.timeout ?? 60000 });
  const w = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  w("spec.md", "# spec\n"); w("verdict.md", "KEEP\n");
  const ledger = join(dir, ".memory-pulse", "events.jsonl"), invariants = join(dir, ".memory-pulse", "invariants.jsonl");
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  // one tool call as the host sends it before the fact; `payload` adds fields beside the tool call (cwd)
  const guard = (tool_name, tool_input, opts = {}) => run(["guard", ...(opts.args ?? [])], JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, ...(opts.payload ?? {}) }), opts);
  return { base, dir, env, run, w, ledger, invariants, rows, guard, bash: (command, opts) => guard("Bash", { command }, opts) };
}

// ---- F2: a seal row is a record of a seal, never evidence about a sentence

const WAX = "The envelope was sealed with wax.";

test("F2a: a prereg row is never evidence: check --ci on a sentence with the word sealed stays NO_EVIDENCE, and so does lint", () => {
  const empty = project(), p = project();
  assert.equal(p.run(["prereg", "seal", "exp-7", "--spec", "spec.md"]).status, 0);
  assert.equal(p.rows().length, 1, "the ledger holds the seal row and nothing else");
  const before = empty.run(["check", "--ci", "--text", WAX]);
  assert.equal(before.status, 1); assert.match(before.stdout, /^memory-pulse check: NO_EVIDENCE/);
  const row = p.rows()[0];
  for (const text of [WAX, "Our road crew sealed the driveway on Tuesday.", "see the prereg exp-7 notes", `quoting the row itself: ${row.cause} ${row.effect}`]) {
    const r = p.run(["check", "--ci", "--text", text]);
    assert.match(r.stdout, /^memory-pulse check: NO_EVIDENCE \(not a pass/, `${text}\n${out(r)}`); assert.equal(r.status, 1, text);
    assert.equal(localCheck(p.rows(), { kind: "edit", text }).verdict, "no_evidence", `the library form: ${text}`);
  }
  for (const kind of ["publish", "command", "custom"]) assert.equal(p.run(["check", "--ci", "--kind", kind, "--text", WAX]).status, 1, `--kind ${kind}`);
  // the settle row is no more evidence than the seal row
  assert.equal(p.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md"]).status, 0);
  const s = p.run(["check", "--ci", "--text", "the dispute was settled KEEP it quiet"]);
  assert.equal(s.status, 1, out(s)); assert.match(s.stdout, /NO_EVIDENCE/);
  // lint reads a governance file the same way
  for (const x of [empty, p]) x.w("CLAUDE.md", "# Rules\nThe deal is sealed. Ship on Fridays.\n");
  const le = JSON.parse(empty.run(["lint", "--ci", "--json"]).stdout), lp = JSON.parse(p.run(["lint", "--ci", "--json"]).stdout);
  assert.equal(le.rows.find((r) => r.file === "CLAUDE.md").verdict, "no_evidence");
  assert.equal(lp.rows.find((r) => r.file === "CLAUDE.md").verdict, "no_evidence", "a ledger of prereg rows says nothing about this file");
  assert.equal(lp.summary.verified, 0);
});

test("F2a pin: an ordinary row still bears on a text that contains its effect (unchanged since 0.17.2)", () => {
  const p = project();
  assert.equal(p.run(["remember", "courier bag", "sealed"]).status, 0);
  const r = p.run(["check", "--ci", "--text", WAX]);
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /^memory-pulse check: VERIFIED/);
});

test("F2b: the rows' effects are not bare words: sealed <12 hex of the spec's sha256>, settled <VERDICT> <12 hex of the verdict file's sha256>", () => {
  const p = project();
  assert.equal(p.run(["prereg", "seal", "exp-7", "--spec", "spec.md"]).status, 0);
  const s = p.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(s.status, 0, out(s));
  const [seal, settle] = p.rows();
  assert.equal(seal.effect, `sealed ${sha(join(p.dir, "spec.md")).slice(0, 12)}`);
  assert.equal(settle.effect, `settled KEEP ${sha(join(p.dir, "verdict.md")).slice(0, 12)}`);
  // what a person reads is the verdict, as before
  assert.match(s.stdout, /^prereg exp-7: settled KEEP at row 2 \(seal row 1\)$/m);
  assert.match(p.run(["prereg", "verify", "exp-7"]).stdout, /^prereg exp-7: sealed at row 1, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(settled KEEP at row 2\)$/m);
  const again = p.run(["prereg", "settle", "exp-7", "--verdict", "KILL", "--file", "verdict.md"]);
  assert.equal(again.status, 1); assert.match(again.stderr, /it was settled KEEP at row 2\. Nothing was written/);
  assert.match(p.run(["prereg", "list"]).stdout, /^ {2}exp-7 {2}settled KEEP {2}row 1 /m);
});
