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

// ---- F3: an assertion is a statement about a value. It holds when a line of code states it whole, not on a prefix of the real
// value and not on a value that only a comment mentions.

const CFG = ["LIMIT = 500", "RATE = 0.25  # was RATE = 0.5", "NAME = 'a::b'", 'color = "#fff"', 'URL = "http://example.com/a"  // the old host is gone', "// MAXN = 9", "# OLD = 1", '  "window": 64,', "threshold_ms=250"].join("\n") + "\n";

test("F3: an assertion holds on a whole value in a line of code: a prefix of the value, a value in a comment and a part of a name do not hold", () => {
  const p = project(); p.w("cfg.py", CFG);
  const seal = (id, ...texts) => p.run(["prereg", "seal", id, "--spec", "spec.md", ...texts.flatMap((t) => ["--assert", `cfg.py::${t}`])]);
  // the review's two, then the neighbours of each
  for (const [text, shows] of [
    ["LIMIT = 50", /cfg\.py:1: LIMIT = 500/],                    // a prefix of 500
    ["RATE = 0.5", /cfg\.py:2: RATE = 0\.25 {2}# was RATE = 0\.5/],  // only the comment says 0.5
    ["RATE = 0.2", /cfg\.py:2: RATE = 0\.25/],                    // a prefix of 0.25
    ["RATE = 0", /cfg\.py:2: RATE = 0\.25/],                      // the value goes on after a dot
    ["IMIT = 500", null],                                         // the name goes on before it
    ["ATE = 0.25", null],
    ["MAXN = 9", /cfg\.py:6: \/\/ MAXN = 9/],                     // a line that is a comment
    ["OLD = 1", /cfg\.py:7: # OLD = 1/],
    ["threshold_ms=25", /cfg\.py:9: threshold_ms=250/],
  ]) {
    const r = seal("a1", text);
    assert.equal(r.status, 1, `${text}: ${out(r)}`);
    assert.match(r.stderr, /1 of 1 assertion\(s\) failed; nothing was written/, text);
    assert.ok(r.stderr.includes(`assert FAILED: cfg.py does not contain "${text}" as a whole value outside a comment`), `${text}: ${r.stderr}`);
    if (shows) assert.match(r.stderr, shows, `${text}: the line with the real value is on the screen`);
  }
  assert.ok(!existsSync(p.ledger), "nothing was written by any of them");
  // each of these is stated whole by a line of code
  const holds = ["LIMIT = 500", "RATE = 0.25", "NAME = 'a::b'", 'color = "#fff"', 'URL = "http://example.com/a"', '"window": 64', "threshold_ms=250", "500"];
  const ok = seal("a2", ...holds);
  assert.equal(ok.status, 0, out(ok));
  // the output shows where: path:line and the line as the file has it
  assert.ok(ok.stdout.includes("  assert  cfg.py :: LIMIT = 500  (holds)  cfg.py:1: LIMIT = 500\n"), ok.stdout);
  assert.ok(ok.stdout.includes("  assert  cfg.py :: RATE = 0.25  (holds)  cfg.py:2: RATE = 0.25  # was RATE = 0.5\n"), ok.stdout);
  assert.ok(ok.stdout.includes('  assert  cfg.py :: "window": 64  (holds)  cfg.py:8:   "window": 64,\n'), ok.stdout);
  // and the row keeps the line number
  const m = p.rows()[0].prereg;
  assert.deepEqual(m.asserts.map((a) => [a.text, a.line]), [["LIMIT = 500", 1], ["RATE = 0.25", 2], ["NAME = 'a::b'", 3], ['color = "#fff"', 4], ['URL = "http://example.com/a"', 5], ['"window": 64', 8], ["threshold_ms=250", 9], ["500", 1]]);
  assert.deepEqual(m.asserts[0], { path: "cfg.py", text: "LIMIT = 500", sha256: sha(join(p.dir, "cfg.py")), line: 1 });
});

test("F3: text that is empty, blank, without a letter or digit, or more than one line is refused before anything is checked", () => {
  const p = project(); p.w("cfg.py", CFG);
  for (const text of ["", " ", "\t ", "=", "---", " = ", "A = 1\nB = 2"]) {
    const r = p.run(["prereg", "seal", "a1", "--spec", "spec.md", "--assert", `cfg.py::${text}`]);
    assert.equal(r.status, 1, `${JSON.stringify(text)}: ${out(r)}`);
    assert.match(r.stderr, /--assert takes '<path>::<text>'/, JSON.stringify(text)); assert.match(r.stderr, /nothing was written/);
    assert.ok(!/assertion\(s\) failed/.test(r.stderr), "refused as written, not checked against the file");
  }
  assert.match(p.run(["prereg", "seal", "a1", "--spec", "spec.md", "--assert", "cfg.py::="]).stderr, /the text needs a letter or a digit/);
  assert.match(p.run(["prereg", "seal", "a1", "--spec", "spec.md", "--assert", "cfg.py::A = 1\nB = 2"]).stderr, /the text is one line/);
  assert.ok(!existsSync(p.ledger));
});

test("F3: prereg verify re-checks an assertion by the same rule", () => {
  const p = project(); p.w("cfg.py", CFG);
  assert.equal(p.run(["prereg", "seal", "a1", "--spec", "spec.md", "--assert", "cfg.py::RATE = 0.25", "--assert", "cfg.py::LIMIT = 500"]).status, 0);
  const before = p.run(["prereg", "verify", "a1"]);
  assert.match(before.stdout, /assert holds {12}cfg\.py :: RATE = 0\.25/); assert.match(before.stdout, /assert holds {12}cfg\.py :: LIMIT = 500/);
  // the value moves; the old one survives as a prefix and in a comment
  p.w("cfg.py", CFG.replace("LIMIT = 500", "LIMIT = 5000").replace("RATE = 0.25  # was RATE = 0.5", "RATE = 0.3  # was RATE = 0.25"));
  const after = p.run(["prereg", "verify", "a1"]);
  assert.match(after.stdout, /assert NO LONGER HOLDS {2}cfg\.py :: RATE = 0\.25/, after.stdout); assert.match(after.stdout, /assert NO LONGER HOLDS {2}cfg\.py :: LIMIT = 500/, after.stdout);
  assert.deepEqual(JSON.parse(p.run(["prereg", "verify", "a1", "--json"]).stdout).asserts.map((a) => a.holds), [false, false]);
});

test("F3: an assertion's text and a file's line pass the secret scrubber before they are printed or stored", () => {
  const p = project(); const KEY = "sk-live-abcdefghijklmnop1234", WRONG = "sk-live-zzzzzzzzzzzzzzzz0000";
  p.w("cfg.py", `API_KEY = "${KEY}"\nLIMIT = 500\n`);
  const bad = p.run(["prereg", "seal", "sec", "--spec", "spec.md", "--assert", `cfg.py::API_KEY = "${WRONG}"`]);
  assert.equal(bad.status, 1, out(bad));
  assert.ok(!out(bad).includes("abcdefghijklmnop") && !out(bad).includes("zzzzzzzz"), `a refusal prints neither the file's secret nor the asserted one: ${out(bad)}`);
  assert.match(bad.stderr, /cfg\.py:1: API_KEY = \[secret\]/);
  const ok = p.run(["prereg", "seal", "sec", "--spec", "spec.md", "--assert", `cfg.py::API_KEY = "${KEY}"`, "--assert", "cfg.py::LIMIT = 500"]);
  assert.equal(ok.status, 0, out(ok));
  assert.ok(!out(ok).includes("abcdefghijklmnop"), out(ok));
  assert.ok(!readFileSync(p.ledger, "utf8").includes("abcdefghijklmnop"), "the row does not hold the secret");
  assert.match(ok.stdout, /assert {2}cfg\.py :: API_KEY = \[secret\] {2}\(holds\) {2}cfg\.py:1: API_KEY = \[secret\]/);
  assert.match(ok.stdout, /kept scrubbed/, "the builder is told the row does not record the value");
  const a = p.rows()[0].prereg.asserts;
  assert.deepEqual(a[0], { path: "cfg.py", text: "API_KEY = [secret]", sha256: sha(join(p.dir, "cfg.py")), line: 1, scrubbed: true });
  assert.equal(a[1].scrubbed, undefined, "an assertion the scrubber leaves alone is kept as written");
  // verify: while the file is as it was sealed, the assertion holds; once it changed, a scrubbed value cannot be compared, and verify says so
  const same = p.run(["prereg", "verify", "sec"]);
  assert.match(same.stdout, /assert holds {12}cfg\.py :: API_KEY = \[secret\]/, same.stdout); assert.ok(!out(same).includes("abcdefghijklmnop"));
  p.w("cfg.py", `API_KEY = "sk-live-another0000000000key"\nLIMIT = 500\n`);
  const moved = p.run(["prereg", "verify", "sec"]);
  assert.match(moved.stdout, /assert NOT COMPARED {5}cfg\.py :: API_KEY = \[secret\]/, moved.stdout); assert.match(moved.stdout, /assert holds {12}cfg\.py :: LIMIT = 500/);
  assert.deepEqual(JSON.parse(p.run(["prereg", "verify", "sec", "--json"]).stdout).asserts.map((x) => x.holds), [null, true]);
  p.w("cfg.py", "LIMIT = 500\n");
  assert.match(p.run(["prereg", "verify", "sec"]).stdout, /assert NO LONGER HOLDS {2}cfg\.py :: API_KEY = \[secret\]/, "the name is gone: that much can be told");
});

// ---- F4: a seal is a row this tool wrote. The ledger's own row chain says which rows those are; a line typed into the file is not one.

const byHand = (p, row) => appendFileSync(p.ledger, JSON.stringify(row) + "\n");

test("F4: a seal row written into the ledger file by hand is not a seal: list shows it NOT ON THE CHAIN, verify exits 2 naming the row, settle refuses it", () => {
  const p = project(); p.w("spec.md", "# rewritten after the run\n");
  assert.equal(p.run(["remember", "base", "row one"]).status, 0);
  byHand(p, { t: 2, cause: "prereg late", effect: "sealed", kind: "event", tags: ["prereg", "prereg:late", "prereg-seal"],
    prereg: { id: "late", op: "seal", at: "2026-01-01T00:00:00Z", ms: 1767225600000, dir: p.dir, spec: { path: "spec.md", sha256: sha(join(p.dir, "spec.md")), bytes: 1 }, files: [], asserts: [], forbid: [] } });
  const before = readFileSync(p.ledger, "utf8");
  const l = p.run(["prereg", "list"]);
  assert.equal(l.status, 0, out(l));
  assert.match(l.stdout, /^ {2}late {2}NOT ON THE CHAIN {2}row 2 \(line 2\)/m, l.stdout); assert.match(l.stdout, /not written by this tool/);
  assert.ok(!/late {2}open/.test(l.stdout), "it is not listed as an open seal");
  assert.match(l.stdout, /^prereg: no seals on this ledger; 1 row\(s\) that carry a prereg field are not seals$/m);
  assert.deepEqual(JSON.parse(p.run(["prereg", "list", "--json"]).stdout), [{ id: "late", row: 2, line: 2, at: null, status: "not-on-chain", verdict: null, settled_row: null, settled_at: null }]);
  const v = p.run(["prereg", "verify", "late"]);
  assert.equal(v.status, 2, out(v));
  assert.match(v.stderr, /row 2 \(line 2\) carries a prereg manifest for "late" but is NOT ON THE CHAIN/); assert.match(v.stderr, /not written by this tool/);
  assert.ok(!/unchanged|sealed at row/.test(out(v)), `nothing is vouched for: ${out(v)}`);
  const vj = p.run(["prereg", "verify", "late", "--json"]);
  assert.equal(vj.status, 2); assert.equal(JSON.parse(vj.stdout).ok, false); assert.equal(JSON.parse(vj.stdout).status, "not-on-chain"); assert.equal(JSON.parse(vj.stdout).row, 2);
  const s = p.run(["prereg", "settle", "late", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(s.status, 1, out(s)); assert.match(s.stderr, /row 2 \(line 2\) carries a prereg manifest for "late" but is NOT ON THE CHAIN/); assert.match(s.stderr, /Nothing was written/);
  assert.equal(readFileSync(p.ledger, "utf8"), before, "list, verify and a refused settle leave the ledger byte for byte");
  // its stamp is not a time `ran --since` takes
  const r = p.run(["ran", "x", "--since", "2"]);
  assert.equal(r.status, 1, out(r)); assert.match(r.stderr, /row 2 carries a prereg field but is not a row this tool wrote/);
  // a hand-written row that claims a hash is no better: the walk stops at it
  const q = project(); assert.equal(q.run(["remember", "base", "row one"]).status, 0);
  byHand(q, { t: 2, cause: "prereg late", effect: "sealed", kind: "event", prev: q.rows()[0].hash, hash: "0".repeat(64),
    prereg: { id: "late", op: "seal", at: "2026-01-01T00:00:00Z", dir: q.dir, spec: { path: "spec.md", sha256: sha(join(q.dir, "spec.md")) }, files: [], asserts: [], forbid: [] } });
  assert.equal(q.run(["prereg", "verify", "late"]).status, 2);
  assert.match(q.run(["prereg", "list"]).stdout, /late {2}NOT ON THE CHAIN {2}row 2/);
});

test("F4: a real seal row edited in place (its stamp moved back) falls off the chain, and verify stops vouching for it", () => {
  const p = project();
  assert.equal(p.run(["prereg", "seal", "exp-7", "--spec", "spec.md"]).status, 0);
  assert.equal(p.run(["prereg", "verify", "exp-7"]).status, 0);
  const at = p.rows()[0].prereg.at;
  writeFileSync(p.ledger, readFileSync(p.ledger, "utf8").replace(`"at":"${at}"`, '"at":"2026-01-01T00:00:00Z"'));
  const v = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(v.status, 2, out(v)); assert.match(v.stderr, /row 1 \(line 1\) carries a prereg manifest for "exp-7" but is NOT ON THE CHAIN/);
  assert.match(p.run(["prereg", "list"]).stdout, /exp-7 {2}NOT ON THE CHAIN {2}row 1/);
});

test("F4: a row with a prereg field but no usable manifest is reported as not a seal: never `undefined`, never a TypeError", async () => {
  const p = project();
  assert.equal(p.run(["remember", "base", "row one"]).status, 0);
  byHand(p, { t: 2, cause: "prereg bare", effect: "sealed", kind: "event", prereg: { id: "bare", op: "seal" } });
  byHand(p, { t: 3, cause: "prereg x", effect: "sealed", kind: "event", prereg: true });
  byHand(p, { t: 4, cause: "prereg y", effect: "sealed", kind: "event", prereg: { op: "seal", at: "2026-01-01T00:00:00Z" } });
  byHand(p, { cause: "prereg z", effect: "settled KEEP", kind: "event", prereg: { id: "bare", op: "settle" } });
  const l = p.run(["prereg", "list"]);
  assert.equal(l.status, 0, out(l)); assert.ok(!/undefined|TypeError/.test(out(l)), out(l));
  assert.match(l.stdout, /^ {2}bare {2}NOT ON THE CHAIN {2}row 2 \(line 2\)/m); assert.match(l.stdout, /^ {2}\(no id\) {2}NOT ON THE CHAIN {2}row 3 \(line 3\)/m);
  assert.match(l.stdout, /^ {2}\(no id\) {2}NOT ON THE CHAIN {2}row 4 \(line 4\)/m); assert.match(l.stdout, /^ {2}bare {2}NOT ON THE CHAIN {2}row \? \(line 5\)/m);
  assert.match(l.stdout, /4 row\(s\) that carry a prereg field are not seals/);
  for (const args of [["prereg", "verify", "bare"], ["prereg", "verify", "bare", "--json"]]) {
    const v = p.run(args);
    assert.equal(v.status, 2, out(v)); assert.ok(!/undefined|TypeError/.test(out(v)), out(v));
  }
  assert.match(p.run(["prereg", "verify", "bare"]).stderr, /row 2 \(line 2\) carries a prereg manifest for "bare" but is NOT ON THE CHAIN/);
  const s = p.run(["prereg", "settle", "bare", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(s.status, 1, out(s)); assert.ok(!/TypeError/.test(out(s)));
  // the same holds for a row that is on the chain but whose manifest is not one this tool writes (only the writer's own function can make one)
  const { chainAppend } = await import("../server.mjs");
  const q = project(); mkdirSync(dirname(q.ledger), { recursive: true });
  chainAppend(q.ledger, { cause: "prereg bare", effect: "sealed", kind: "event", prereg: { id: "bare", op: "seal" } });
  const ql = q.run(["prereg", "list"]);
  assert.match(ql.stdout, /^ {2}bare {2}UNUSABLE MANIFEST {2}row 1 \(line 1\)/m, out(ql)); assert.ok(!/undefined|TypeError/.test(out(ql)));
  const qv = q.run(["prereg", "verify", "bare"]);
  assert.equal(qv.status, 2, out(qv)); assert.match(qv.stderr, /row 1 \(line 1\) carries a prereg field for "bare" that is not a manifest this tool writes/); assert.match(qv.stderr, /not written by this tool/);
});

test("F4: prereg verify ends with what its answer rests on, and README and SKILL state the limit", () => {
  const p = project();
  assert.equal(p.run(["remember", "base", "row one"]).status, 0);
  assert.equal(p.run(["prereg", "seal", "exp-7", "--spec", "spec.md"]).status, 0);
  const v = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(v.status, 0, out(v));
  assert.equal(v.stdout.trimEnd().split("\n").at(-1), "rests on: the ledger's row chain (row 2 is on it). memory-pulse verify checks the chain, the engine's seal and this machine's anchor.");
  assert.match(JSON.parse(p.run(["prereg", "verify", "exp-7", "--json"]).stdout).rests_on, /row chain/);
  // a stray row for the same id beside the real seal is named, and the real seal still answers
  byHand(p, { t: 3, cause: "prereg exp-7", effect: "settled KEEP", kind: "event", prereg: { id: "exp-7", op: "settle", at: "2026-01-01T00:00:00Z", verdict: "KEEP", file: { path: "verdict.md", sha256: sha(join(p.dir, "verdict.md")) }, seal: 2 } });
  const w = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(w.status, 0, out(w)); assert.match(w.stdout, /\(open\)/, "a settle row typed by hand settles nothing");
  assert.match(w.stdout, /row 3 \(line 3\) also carries a prereg field for this id and is NOT ON THE CHAIN/);
  const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\s+/g, " ");
  for (const [name, text] of [["README", read("README.md")], ["SKILL", read("skills", "memory-pulse", "SKILL.md")]]) {
    assert.match(text, /a seal is as trustworthy as the ledger's row chain/i, `${name} states the limit`);
    assert.ok(text.includes("NOT ON THE CHAIN"), `${name} names what list prints for a row this tool did not write`);
  }
});
