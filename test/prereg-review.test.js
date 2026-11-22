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
  // the line is the same wherever the seal's row falls, so the guide's section 17 reads true run alone (row 1) and in the guide's own run (row 11)
  assert.equal(v.stdout.trimEnd().split("\n").at(-1), "rests on: the ledger's row chain, which holds this seal row. memory-pulse verify checks the chain, the engine's seal and this machine's anchor.");
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

// ---- F1: a forbid pattern must never lock a session out of its own shell.

const SETTLE = (id) => `memory-pulse prereg settle ${id} --verdict KEEP --file VERDICT.md`;

test("F1b: a forbid that matches an everyday command, the seal's own way out or the empty command is refused at seal time: exit 1, the command named, nothing written", () => {
  const p = project();
  const seal = (id, ...forbid) => p.run(["prereg", "seal", id, "--spec", "spec.md", ...forbid.flatMap((f) => ["--forbid", f])]);
  for (const [id, pattern, named] of [
    ["lock", ".", `"${SETTLE("lock")}"`],                 // every command, the way out first among them
    ["exp-7", "exp-7", `"${SETTLE("exp-7")}"`],           // the seal's own id
    ["lock", "memory-pulse", `"${SETTLE("lock")}"`],      // this tool
    ["lock", "prereg (verify|list)", '"memory-pulse prereg verify lock"'],
    ["lock", "prereg list$", '"memory-pulse prereg list"'],
    ["lock", "^ls", '"ls"'], ["lock", "^pwd$", '"pwd"'], ["lock", "^cd ", '"cd /tmp"'], ["lock", "git", '"git status"'], ["lock", "README", '"cat README.md"'],
    ["lock", "^echo", '"echo ok"'], ["lock", "^node\\b", '"node --version"'], ["lock", "python3?", '"python3 --version"'],
    ["lock", "^$", "the empty command"], ["lock", "(train)?", `"${SETTLE("lock")}"`],
  ]) {
    const r = seal(id, pattern);
    assert.equal(r.status, 1, `--forbid '${pattern}': ${out(r)}`);
    assert.ok(r.stderr.includes(`--forbid '${pattern}' matches ${named}`), `--forbid '${pattern}' names ${named}: ${r.stderr}`);
    assert.match(r.stderr, /A forbid names the evaluator's command, not every command/); assert.match(r.stderr, /[Nn]othing was written/);
    assert.equal(r.stdout, "");
  }
  // one pattern that is fine does not carry one that is not
  assert.equal(seal("lock", "train\\.py .*--n 4096", ".").status, 1);
  assert.ok(!existsSync(p.ledger), "no row"); assert.ok(!existsSync(p.invariants), "no rule");
  // a pattern that names a run is taken as before
  const ok = seal("lock", "train\\.py .*--n (4096|8192)\\b", "--confirm\\b", "run_eval\\.sh");
  assert.equal(ok.status, 0, out(ok)); assert.equal(readFileSync(p.invariants, "utf8").trim().split("\n").length, 3);
  // the review's lockout, start to finish: the seal that caused it no longer exists, so the shell is never taken
  const q = project();
  assert.equal(q.run(["prereg", "seal", "lock", "--spec", "spec.md", "--forbid", "."]).status, 1);
  for (const c of ["ls", SETTLE("lock"), "memory-pulse prereg list", "memory-pulse prereg verify lock"]) assert.equal(q.bash(c).status, 0, c);
});

// ---- F5: the guard runs a forbid pattern before every shell command, so a pattern that cannot finish on a short command is refused

test("F5: a forbid pattern too slow to run before every command is refused at seal time, and nothing is written", () => {
  const p = project();
  for (const pattern of ["(a+)+$", "(x| |x )+!"]) {
    const t0 = Date.now();
    const r = p.run(["prereg", "seal", "slow", "--spec", "spec.md", "--forbid", pattern], "", { timeout: 30000 });
    const took = Date.now() - t0;
    assert.equal(r.status, 1, `--forbid '${pattern}' (${took} ms): ${out(r)}`);
    assert.ok(r.stderr.includes(`--forbid '${pattern}' is too slow to run before every command`), r.stderr); assert.match(r.stderr, /Nothing was written/);
    assert.ok(took < 5000, `the refusal itself is quick: ${took} ms`);
  }
  assert.ok(!existsSync(p.ledger), "no row"); assert.ok(!existsSync(p.invariants), "no rule");
  // so the review's command never meets the pattern: 28 characters, which took the guard 44 s
  const g0 = Date.now(); assert.equal(p.bash("a".repeat(27) + "!").status, 0); assert.ok(Date.now() - g0 < 5000);
  // patterns that name a run are not slow, flags and all (a pattern may begin with dashes)
  const ok = p.run(["prereg", "seal", "fine", "--spec", "spec.md", "--forbid", "train\\.py .*--n (4096|8192)\\b", "--forbid", "--confirm\\b", "--forbid", "(?:bash|sh) run_[a-z]+\\.sh"]);
  assert.equal(ok.status, 0, out(ok)); assert.equal(p.rows()[0].prereg.forbid.length, 3);
});

// A seal's rule as an earlier build could have declared it (or as a hand could edit it): the pattern matches every command.
// The seal is real and open; only the pattern is swapped, since `prereg seal` now refuses such a pattern itself.
function sealedWith(pattern, id = "lock") {
  const p = project();
  const s = p.run(["prereg", "seal", id, "--spec", "spec.md", "--forbid", "train\\.py .*--n 4096"]); assert.equal(s.status, 0, out(s));
  const rule = JSON.parse(readFileSync(p.invariants, "utf8").trim()); rule.patterns = [pattern];
  writeFileSync(p.invariants, JSON.stringify(rule) + "\n");
  return p;
}

test("F1a: the way out always works: a seal's rule never blocks one invocation of prereg settle, prereg verify, prereg list, verify or now", () => {
  const p = sealedWith("/./"); mkdirSync(join(p.dir, "sub dir"));
  assert.equal(p.bash("ls").status, 2, "the rule is live: it blocks an everyday command");
  for (const cmd of [
    "memory-pulse prereg settle lock --verdict KEEP --file verdict.md",
    "npx memory-pulse prereg settle lock --verdict KEEP --file verdict.md",
    "npx -y memory-pulse@0.18.0 prereg verify lock",
    "npx --yes memory-pulse prereg verify lock --json",
    "memory-pulse prereg list", "  memory-pulse prereg list --json  ",
    "memory-pulse verify", "memory-pulse now", "memory-pulse now --json",
    "node server.mjs prereg settle lock --verdict KEEP --file verdict.md",
    `node ${SERVER} prereg list`, `node "${SERVER}" prereg verify lock`,
    `cd ${p.dir} && memory-pulse prereg settle lock --verdict KEEP --file verdict.md`,
    'cd "sub dir" && memory-pulse prereg list',
  ]) {
    const r = p.bash(cmd);
    assert.equal(r.status, 0, `${cmd}: ${out(r)}`);
    assert.match(r.stderr, /prereg lock .*allowed, because a seal's rule never blocks the way out/, `the pass is said: ${cmd}`);
  }
  // a compound line gets no such pass, and neither does any other command of this tool
  for (const cmd of [
    "memory-pulse prereg list; python train.py --n 4096",
    "memory-pulse prereg list && ls",
    "memory-pulse now || ls",
    "memory-pulse prereg list | sh",
    "memory-pulse prereg list & python train.py --n 4096",
    "memory-pulse prereg verify `python train.py --n 4096`",
    "memory-pulse prereg verify $(python train.py --n 4096)",
    "memory-pulse prereg list\npython train.py --n 4096",
    "memory-pulse prereg list > out.txt",
    "cd sub && cd dir && memory-pulse now",
    "ls && memory-pulse now",
    "memory-pulse prereg seal other --spec spec.md",
    "memory-pulse remember a b", 'memory-pulse guard allow "." "locked out"',
    "memory-pulse-other prereg list", "node other.mjs prereg list", "node notserver.mjs now", "echo memory-pulse prereg list",
    "memory-pulse prereg", "memory-pulse nowhere", "rm .memory-pulse/invariants.jsonl",
  ]) assert.equal(p.bash(cmd).status, 2, `no pass for: ${cmd}`);
  // check --kind command judges by the same rule, and Cursor's Shell gets the same answer
  assert.equal(p.run(["check", "--kind", "command", "--text", "memory-pulse prereg settle lock --verdict KEEP --file verdict.md"]).status, 0);
  assert.equal(p.run(["check", "--kind", "command", "--text", "memory-pulse prereg list; ls"]).status, 2);
  const cursor = (command) => JSON.parse(p.run(["guard", "--host", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command } })).stdout).permission;
  assert.equal(cursor("memory-pulse prereg settle lock --verdict KEEP --file verdict.md"), "allow"); assert.equal(cursor("ls"), "deny");
  // a rule someone declared by hand has no such pass
  appendFileSync(p.invariants, JSON.stringify({ id: "hand", on: "command", statement: "by hand", patterns: ["/prereg list/"], severity: "block" }) + "\n");
  const h = p.bash("memory-pulse prereg list"); assert.equal(h.status, 2, out(h)); assert.match(h.stderr, /invariant hand/);
  // and the way out, taken for real, ends the block
  const s = p.run(["prereg", "settle", "lock", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(s.status, 0, out(s)); assert.equal(p.bash("ls").status, 0);
});

test("F1c: a seal's rule applies in the seal's project: where the command would run there or names it, and nowhere else", () => {
  const p = project(); const other = join(p.base, "other"), near = join(p.base, "p2"); mkdirSync(other); mkdirSync(near); mkdirSync(join(p.dir, "sub"));
  assert.equal(p.run(["prereg", "seal", "exp-7", "--spec", "spec.md", "--forbid", "train\\.py .*--n 4096"]).status, 0);
  appendFileSync(p.invariants, JSON.stringify({ id: "no-prod", on: "command", statement: "prod deploys are by hand", patterns: ["/deploy --prod/"], severity: "block" }) + "\n");
  assert.equal(p.rows()[0].prereg.dir, "~/p", "the row already records where the seal was made");
  const RUN = "python train.py --n 4096";
  const shared = { env: { MEMORY_PULSE_LEDGER: p.ledger } };                 // one ledger for every project, as some estates run it
  const from = (cwd, command, payload = {}) => p.bash(command, { ...shared, cwd, payload }).status;
  // in the project, and below it
  assert.equal(from(p.dir, RUN), 2);
  assert.equal(from(p.dir, `cd runs && ${RUN}`), 2, "a directory below the project, made or not");
  assert.equal(from(join(p.dir, "sub"), RUN), 2);
  assert.equal(from(p.dir, `cd ../p && ${RUN}`), 2);
  assert.equal(from(p.dir, `cd "$SOMEWHERE" && ${RUN}`), 2, "a cd whose target the text does not give leaves the session's directory standing");
  // another project that shares the ledger: the rule is not matched there
  assert.equal(from(other, RUN), 0, "the review's case: a seal in one project blocked a command in another");
  assert.equal(from(other, "ls"), 0);
  assert.equal(from(p.dir, `cd ${other} && ${RUN}`), 0, "a leading cd out of the project");
  assert.equal(from(p.dir, `cd .. && ${RUN}`), 0);
  assert.equal(from(near, RUN), 0, "a directory whose name only begins like the project's");
  // unless the command leads back into the project, or names it
  assert.equal(from(other, `cd ${p.dir} && ${RUN}`), 2);
  assert.equal(from(other, `cd ${p.dir}/sub && ${RUN}`), 2);
  assert.equal(from(other, `cd ~/p && ${RUN}`), 2);
  assert.equal(from(other, `cd $HOME/p && ${RUN}`), 2);
  assert.equal(from(other, `cd ${join(tmpdir(), p.base.split("/").pop(), "p")} && ${RUN}`), 2, "the same directory by another name (a linked temp folder)");
  assert.equal(from(other, `python ${p.dir}/train.py --n 4096`), 2, "the project's path in the command");
  assert.equal(from(other, "python ~/p/train.py --n 4096"), 2, "its ~ spelling");
  assert.equal(from(other, `python ${near}/train.py --n 4096`), 0, "p2 is not p");
  assert.equal(from(other, "python ~/p2/train.py --n 4096"), 0);
  // the hook's own cwd is what counts, before the directory the guard process happens to run in
  assert.equal(from(p.dir, RUN, { cwd: other }), 0); assert.equal(from(other, RUN, { cwd: p.dir }), 2); assert.equal(from(other, `cd sub && ${RUN}`, { cwd: p.dir }), 2);
  // a rule declared by hand is not scoped: it has no seal and no project
  assert.equal(from(other, "./deploy --prod"), 2); assert.equal(from(p.dir, "./deploy --prod"), 2);
  // check --kind command judges by the same rule, from the directory it is run in; Cursor names the workspace
  assert.equal(p.run(["check", "--kind", "command", "--text", RUN], "", { ...shared, cwd: other }).status, 0);
  assert.equal(p.run(["check", "--kind", "command", "--text", RUN], "", { ...shared, cwd: p.dir }).status, 2);
  const cursor = (root) => JSON.parse(p.run(["guard", "--host", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: RUN }, workspace_roots: [root] }), { ...shared, cwd: other }).stdout).permission;
  assert.equal(cursor(other), "allow"); assert.equal(cursor(p.dir), "deny");
});

test("F1d: a seal's rule with no open seal on this ledger is not enforced: the guard says so once, list shows it as an orphan rule, settle removes it", () => {
  const USER = '{"id":"old-domain","statement":"the old domain was retired","patterns":["example-old.com"],"severity":"block"}';
  const orphan = (n, pattern) => JSON.stringify({ id: `prereg:orphan:forbid-${n}`, on: "command", statement: "s", patterns: [pattern], severity: "block", owner: { prereg: "orphan", row: 9 }, cite: [9] });
  const setup = () => { const p = project(); mkdirSync(dirname(p.invariants), { recursive: true }); writeFileSync(p.invariants, [USER, orphan(1, "/./"), orphan(2, "/^ls/")].join("\n") + "\n"); return p; };
  const p = setup();
  // the guard: not enforced, said once however many of the seal's rules match
  const g = p.bash("ls");
  assert.equal(g.status, 0, out(g));
  assert.equal((g.stderr.match(/not enforced/g) ?? []).length, 1, g.stderr);
  assert.match(g.stderr, /no open seal for "orphan" on this ledger/); assert.match(g.stderr, /orphan rule/); assert.match(g.stderr, /memory-pulse prereg settle orphan removes/);
  assert.ok(!existsSync(join(p.dir, ".memory-pulse", "violations.jsonl")), "nothing was blocked, so nothing is recorded as blocked");
  const c = p.run(["check", "--kind", "command", "--text", "ls"]);
  assert.equal(c.status, 0, out(c)); assert.match(c.stdout, /not enforced: no open seal for "orphan"/);
  // list shows it
  const l = p.run(["prereg", "list"]);
  assert.match(l.stdout, /^prereg: no seals on this ledger; 2 orphan rule\(s\)$/m, l.stdout);
  assert.match(l.stdout, /^ {2}orphan {2}ORPHAN RULE {2}prereg:orphan:forbid-1 {2}\/\.\/ {2}no open seal for this id on this ledger, so the guard does not enforce it; memory-pulse prereg settle orphan removes it$/m, l.stdout);
  assert.match(l.stdout, /^ {2}orphan {2}ORPHAN RULE {2}prereg:orphan:forbid-2 {2}\/\^ls\/ /m);
  assert.deepEqual(JSON.parse(p.run(["prereg", "list", "--json"]).stdout).map((x) => [x.id, x.status, x.rule, x.patterns]), [["orphan", "orphan-rule", "prereg:orphan:forbid-1", ["/./"]], ["orphan", "orphan-rule", "prereg:orphan:forbid-2", ["/^ls/"]]]);
  // settle removes it and says so; no row is written, and every other line of the file stays byte for byte
  const s = p.run(["prereg", "settle", "orphan"]);
  assert.equal(s.status, 0, out(s));
  assert.match(s.stdout, /^prereg orphan: no open seal on this ledger; no row was written$/m); assert.match(s.stdout, /^ {2}removed {2}\/\.\/ {2}orphan rule/m); assert.match(s.stdout, /^ {2}removed {2}\/\^ls\/ {2}orphan rule/m);
  assert.ok(!existsSync(p.ledger), "no row"); assert.equal(readFileSync(p.invariants, "utf8"), USER + "\n");
  const after = p.bash("ls"); assert.equal(after.status, 0); assert.equal(after.stderr, "", "nothing left to say");
  // with nothing to remove it is the refusal it was
  const again = p.run(["prereg", "settle", "orphan", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(again.status, 1); assert.match(again.stderr, /no open seal for "orphan"/);
  assert.equal(p.run(["prereg", "settle", "orphan"]).status, 1);
  // the spelling the old block named works the same
  const q = setup(); const sq = q.run(["prereg", "settle", "orphan", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(sq.status, 0, out(sq)); assert.match(sq.stdout, /no row was written/); assert.ok(!existsSync(q.ledger)); assert.equal(q.bash("ls").stderr, "");
  // a rule left behind by a seal that was settled is an orphan too, and so is the rule of a seal row that is not on the chain
  const r = project();
  assert.equal(r.run(["prereg", "seal", "exp-7", "--spec", "spec.md", "--forbid", "train\\.py .*--n 4096"]).status, 0);
  const line = readFileSync(r.invariants, "utf8");
  assert.equal(r.bash("python train.py --n 4096").status, 2, "enforced while the seal is open");
  assert.equal(r.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md"]).status, 0);
  writeFileSync(r.invariants, line);
  const left = r.bash("python train.py --n 4096");
  assert.equal(left.status, 0, out(left)); assert.match(left.stderr, /not enforced: no open seal for "exp-7"/);
  const rs = r.run(["prereg", "settle", "exp-7"]);
  assert.equal(rs.status, 0, out(rs)); assert.match(rs.stdout, /^prereg exp-7: no open seal on this ledger \(it was settled KEEP at row 2\); no row was written$/m);
  assert.ok(!existsSync(r.invariants), "the file held only that rule"); assert.equal(r.rows().length, 2);
});

// ---- F6: two seals of one id started at the same moment

test("F6: of several seals of one id started together, exactly one is written; the rest are refused as already open", async () => {
  const start = (p, pattern) => new Promise((done) => {
    const c = spawn(process.execPath, [SERVER, "prereg", "seal", "race", "--spec", "spec.md", "--forbid", pattern], { cwd: p.dir, env: p.env });
    let text = ""; c.stdout.on("data", (d) => { text += d; }); c.stderr.on("data", (d) => { text += d; }); c.on("close", (code) => done({ code, text, pattern }));
  });
  for (let round = 0; round < 6; round++) {
    const p = project();
    const all = await Promise.all(["run_one\\.sh", "run_two\\.sh", "run_three\\.sh", "run_four\\.sh"].map((pattern) => start(p, pattern)));
    const won = all.filter((x) => x.code === 0), lost = all.filter((x) => x.code !== 0);
    assert.equal(won.length, 1, `round ${round + 1}: ${all.map((x) => `${x.pattern} -> ${x.code}`).join(", ")}\n${all.map((x) => x.text).join("---\n")}`);
    for (const x of lost) { assert.equal(x.code, 1); assert.match(x.text, /"race" already has an open seal \(row 1/, x.text); assert.match(x.text, /Nothing was written/); }
    const seals = p.rows().filter((r) => r.prereg?.op === "seal");
    assert.equal(seals.length, 1, "one seal row"); assert.deepEqual(seals[0].prereg.forbid, [`/${won[0].pattern}/`]);
    const rules = readFileSync(p.invariants, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rules.map((r) => [r.owner.prereg, r.owner.row, r.patterns[0]]), [["race", 1, `/${won[0].pattern}/`]], "and only its rule");
    assert.match(p.run(["prereg", "list"]).stdout, /^prereg: 1 seal\(s\), 1 open$/m);
    assert.equal(p.run(["verify"]).status, 0, "the chain holds");
  }
});

// ---- F8: what the documents and the messages say

const changelog = () => { const t = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"); const i = t.indexOf("## 0.18.0 (19 November 2026)"); return t.slice(i, t.indexOf("\n## ", i + 5)).replace(/\s+/g, " "); };

test("F8: the changelog, help and the seal's own output name the hosts the forbid rule fires on; the changelog names what does not carry a seal", () => {
  const p = project();
  const s = p.run(["prereg", "seal", "exp-7", "--spec", "spec.md", "--forbid", "train\\.py .*--n 4096"]);
  assert.equal(s.status, 0, out(s));
  const helpLine = p.run(["help"]).stdout.split("\n").find((l) => /pre-registered research:/.test(l)) ?? "";
  for (const [name, text] of [["the seal's output", s.stdout], ["help", helpLine], ["the changelog", changelog()]]) {
    assert.match(text, /Claude Code's `?Bash`?/, `${name} names Claude Code's Bash`);
    assert.match(text, /Cursor's `?Shell`?/, `${name} names Cursor's Shell`);
    assert.match(text, /not enforced on Codex/, `${name} says Codex is not covered`);
  }
  assert.ok(!/Claude Code|Cursor|Codex/.test(p.run(["prereg", "seal", "exp-8", "--spec", "spec.md"]).stdout), "a seal with no forbid has no rule to speak of");
  // limits the changelog owes its reader
  assert.match(changelog(), /`state merge` does not carry/); assert.match(changelog(), /`repair --adopt-quarantine` does not carry/);
});

const HAND = [
  { id: "old-domain", statement: "the old domain was retired", patterns: ["example-old.com"], severity: "block" },
  { id: "no-prod", on: "command", statement: "prod deploys are by hand", patterns: ["/deploy --prod/"], severity: "block" },
];
function handRules() {
  const p = project(); mkdirSync(dirname(p.invariants), { recursive: true }); writeFileSync(p.invariants, HAND.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(p.run(["remember", "price", "corrected to $29", "--kind", "correction", "--withdrawn", "$49", "--replacement", "$29"]).status, 0);
  return p;
}

test("F8: Cursor's deny for a shell command says a command was blocked, and for a file edit an edit", () => {
  const p = handRules();
  const cursor = (tool_name, tool_input) => JSON.parse(p.run(["guard", "--host", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", tool_name, tool_input })).stdout);
  const cmd = cursor("Shell", { command: "./deploy --prod" });
  assert.equal(cmd.permission, "deny"); assert.match(cmd.agent_message, /^memory-pulse guard blocked this command\.\n/); assert.ok(!/this edit/.test(cmd.agent_message));
  const heredoc = cursor("Shell", { command: "cat > notes.md <<'EOF'\nsee example-old.com\nEOF" });
  assert.equal(heredoc.permission, "deny"); assert.match(heredoc.agent_message, /^memory-pulse guard blocked this command\.\n/, "a shell call is a command, whatever it writes");
  const edit = cursor("Write", { path: "notes.md", contents: "see example-old.com" });
  assert.equal(edit.permission, "deny"); assert.match(edit.agent_message, /^memory-pulse guard blocked this edit\.\n/);
});

test("F8: a block caused only by an invariant or a rule on commands does not offer guard allow; a withdrawn value still does", () => {
  const p = handRules();
  const inv = p.guard("Write", { file_path: "notes.md", content: "see example-old.com" });
  assert.equal(inv.status, 2, out(inv)); assert.match(inv.stderr, /invariant old-domain/);
  assert.ok(!/guard allow/.test(inv.stderr), `an override is for a withdrawn value; this block has none: ${inv.stderr}`);
  assert.match(inv.stderr, /a declared invariant \(\.memory-pulse\/invariants\.jsonl\), not a withdrawn value, so an override does not apply/);
  const both = p.bash("./deploy --prod && cat > notes.md <<'EOF'\nsee example-old.com\nEOF");
  assert.equal(both.status, 2); assert.match(both.stderr, /invariant old-domain/); assert.match(both.stderr, /invariant no-prod/);
  assert.ok(!/guard allow/.test(both.stderr), both.stderr);
  const cursor = JSON.parse(p.run(["guard", "--host", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Write", tool_input: { path: "notes.md", contents: "see example-old.com" } })).stdout);
  assert.ok(!/guard allow/.test(cursor.agent_message), cursor.agent_message);
  // a withdrawn value is what an override answers, alone or beside an invariant
  const term = p.guard("Write", { file_path: "notes.md", content: "the price is $49" });
  assert.equal(term.status, 2); assert.match(term.stderr, /memory-pulse guard allow "<term>"/);
  const mixed = p.guard("Write", { file_path: "notes.md", content: "the price is $49, see example-old.com" });
  assert.equal(mixed.status, 2); assert.match(mixed.stderr, /memory-pulse guard allow "<term>"/);
});

// ---- F9: two small ones

test("F9: settle rewrites invariants.jsonl with the mode the file had", { skip: process.platform === "win32" }, () => {
  const USER = '{"id":"old-domain","statement":"the old domain was retired","patterns":["example-old.com"],"severity":"block"}';
  const mode = (f) => (statSync(f).mode & 0o777).toString(8);
  const p = project(); mkdirSync(dirname(p.invariants), { recursive: true }); writeFileSync(p.invariants, USER + "\n"); chmodSync(p.invariants, 0o600);
  assert.equal(p.run(["prereg", "seal", "exp-7", "--spec", "spec.md", "--forbid", "train\\.py .*--n 4096"]).status, 0);
  assert.equal(mode(p.invariants), "600", "the seal appends to the file as it is");
  assert.equal(p.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md"]).status, 0);
  assert.equal(readFileSync(p.invariants, "utf8"), USER + "\n"); assert.equal(mode(p.invariants), "600", "private before the settle, private after it");
  // the same when what settle removes is an orphan rule
  appendFileSync(p.invariants, JSON.stringify({ id: "prereg:gone:forbid-1", on: "command", statement: "s", patterns: ["/zz/"], severity: "block", owner: { prereg: "gone", row: 9 } }) + "\n");
  assert.equal(p.run(["prereg", "settle", "gone"]).status, 0);
  assert.equal(readFileSync(p.invariants, "utf8"), USER + "\n"); assert.equal(mode(p.invariants), "600");
});

test("F9: ran --since refuses a negative number, and any number that is not a row", () => {
  const p = project();
  for (const args of [["--since", "-1"], ["--since=-1"], ["--since", "-20261119"], ["--since", "1.5"], ["--since", "+3"]]) {
    const r = p.run(["ran", "train", ...args]);
    assert.equal(r.status, 1, `${args.join(" ")}: ${out(r)}`); assert.match(r.stderr, /--since takes a row number or a time/, args.join(" "));
  }
  assert.equal(p.run(["ran", "train", "--since", "2026-11-19T02:15:07Z"]).status, 0, "a time is still a time");
});
