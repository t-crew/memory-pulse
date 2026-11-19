// `memory-pulse prereg` (0.18.0): pre-registered research on the ledger. A builder seals a spec before the work, an evaluator
// verifies the seal first, a verdict settles it. Three slips in one night are why it exists, and each has a test here:
//   1. a time stamp typed from memory into a record: the stamp in a seal row is read from the clock by the code, never passed in;
//   2. a run at sizes the builder's own amendment had reserved for confirmation: a --forbid pattern is blocked by the guard as a
//      shell command while the seal is open (a tripwire against inattention, not a security boundary);
//   3. a constant about a deployed system copied into a sealed spec from a summary (0.5 where the shipped file said 0.25): an
//      --assert is checked against the file that defines the value before anything is written.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const USER_RULE = '{"id":"old-domain","statement":"the old domain was retired","patterns":["example-old.com"],"paths":["docs/"],"severity":"block"}';
const FORBID = "train\\.py .*--n (4096|8192)\\b";

// a scratch project and an explicit environment: no MEMORY_PULSE_LEDGER, so nothing here can reach a real ledger
function project() {
  const base = mkdtempSync(join(tmpdir(), "mp-prereg-")); const dir = join(base, "p");
  for (const d of ["src", "shipped", "deploy", "docs"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "docs", "spec.md"), "# exp-7\nH1: the gain holds at n=2048 with threshold 0.25.\nConfirmation sizes 4096 and 8192 are the evaluator's.\n");
  writeFileSync(join(dir, "src", "run.py"), "import sys\nprint(sys.argv)\n");
  writeFileSync(join(dir, "shipped", "params.py"), "# shipped 2026-11-02\nWINDOW = 64\nTHRESHOLD = 0.25\n");
  writeFileSync(join(dir, "deploy", "config.json"), '{\n  "window": 64,\n  "threshold": 0.25\n}\n');
  writeFileSync(join(dir, "verdict.md"), "# verdict\nKEEP: 3 of 3 confirmation seeds above the bar.\n");
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env, input, encoding: "utf8" });
  const ledger = join(dir, ".memory-pulse", "events.jsonl"), invariants = join(dir, ".memory-pulse", "invariants.jsonl");
  const rows = () => (existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const guard = (tool_name, tool_input) => run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
  const seal = (extra = []) => run(["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--file", "src/run.py", "--assert", "shipped/params.py::THRESHOLD = 0.25", "--forbid", FORBID, ...extra]);
  return { base, dir, run, ledger, invariants, rows, guard, bash: (command) => guard("Bash", { command }), seal };
}
const out = (r) => `${r.stdout}${r.stderr}`;

test("an assertion that fails writes nothing, exits 1, names the assertion and shows what the file does say", () => {
  const p = project();
  const r = p.run(["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--assert", "deploy/config.json::\"window\": 64", "--assert", "shipped/params.py::THRESHOLD = 0.5", "--forbid", FORBID]);
  assert.equal(r.status, 1, out(r));
  assert.match(r.stderr, /1 of 2 assertion\(s\) failed; nothing was written/);
  assert.match(r.stderr, /assert FAILED: shipped\/params\.py does not contain "THRESHOLD = 0\.5"/);
  assert.match(r.stderr, /shipped\/params\.py:3: THRESHOLD = 0\.25/, "the line that defines the value, with its number: the real value is on the screen");
  assert.ok(!/config\.json/.test(r.stderr), "an assertion that holds is not listed among the failures");
  assert.ok(!existsSync(p.ledger), "no ledger row"); assert.ok(!existsSync(p.invariants), "no forbid rule");
  // a key before ":" is looked up the same way; a file that is not there fails; a malformed assertion is a usage error
  const j = p.run(["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--assert", 'deploy/config.json::"threshold": 0.5']);
  assert.equal(j.status, 1); assert.match(j.stderr, /deploy\/config\.json:3:\s+"threshold": 0\.25/);
  const gone = p.run(["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--assert", "shipped/absent.py::THRESHOLD = 0.25"]);
  assert.equal(gone.status, 1); assert.match(gone.stderr, /assert FAILED: shipped\/absent\.py does not exist/);
  const nokey = p.run(["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--assert", "shipped/params.py::GAIN = 3"]);
  assert.equal(nokey.status, 1); assert.match(nokey.stderr, /no line of shipped\/params\.py contains "GAIN"/);
  const bad = p.run(["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--assert", "shipped/params.py"]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /--assert takes '<path>::<text>'/);
  assert.ok(!existsSync(p.ledger)); assert.ok(!existsSync(p.invariants));
});

test("a passing seal writes exactly one row through the writer, the chain still verifies, and the row carries the manifest", () => {
  const p = project();
  assert.equal(p.run(["remember", "exp-7-planned", "spec-drafted", "--note", "a row before the seal"]).status, 0);
  const before = Math.floor(Date.now() / 1000) * 1000; const r = p.seal(["--note", "pilot at n=2048 only"]); const after = Date.now();
  assert.equal(r.status, 0, out(r));
  const rows = p.rows(); assert.equal(rows.length, 2, "exactly one row was added");
  const row = rows[1];
  assert.equal(row.t, 2); assert.equal(row.cause, "prereg exp-7"); assert.equal(row.effect, "sealed");
  for (const tag of ["prereg", "prereg:exp-7", "prereg-seal"]) assert.ok(row.tags.includes(tag), `tag ${tag}`);
  assert.equal(typeof row.hash, "string"); assert.equal(row.prev, rows[0].hash, "chained onto the row before it");
  const m = row.prereg;
  assert.equal(m.id, "exp-7"); assert.equal(m.op, "seal");
  assert.deepEqual(m.spec, { path: "docs/spec.md", sha256: sha(join(p.dir, "docs", "spec.md")), bytes: readFileSync(join(p.dir, "docs", "spec.md")).length });
  assert.deepEqual(m.files, [{ path: "src/run.py", sha256: sha(join(p.dir, "src", "run.py")), bytes: readFileSync(join(p.dir, "src", "run.py")).length }]);
  assert.deepEqual(m.asserts, [{ path: "shipped/params.py", text: "THRESHOLD = 0.25", sha256: sha(join(p.dir, "shipped", "params.py")) }]);
  assert.deepEqual(m.forbid, [`/${FORBID}/`]);
  // the stamp is the machine clock at the write, to the second
  assert.match(m.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Date.parse(m.at) >= before && Date.parse(m.at) <= after, `${m.at} is within the test's own clock ${new Date(before).toISOString()} .. ${new Date(after).toISOString()}`);
  assert.match(row.note, /pilot at n=2048 only/); assert.ok(row.note.includes(m.at), "the note a brief prints carries the same stamp");
  // what is printed: the row, the stamp line to paste, the manifest with whole hashes
  assert.match(r.stdout, /^prereg exp-7: sealed at row 2$/m);
  const stamp = /^stamp: (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC) · (\S+) \(paste this\)$/m.exec(r.stdout);
  assert.ok(stamp, r.stdout); assert.equal(stamp[2], m.at); assert.equal(stamp[1], `${m.at.slice(0, 10)} ${m.at.slice(11, 16)} UTC`);
  assert.ok(r.stdout.includes(`spec    docs/spec.md  sha256 ${m.spec.sha256}`), r.stdout);
  assert.ok(r.stdout.includes(`file    src/run.py  sha256 ${m.files[0].sha256}`), r.stdout);
  assert.match(r.stdout, /assert {2}shipped\/params\.py :: THRESHOLD = 0\.25 {2}\(holds\)/);
  assert.ok(r.stdout.includes(`forbid  /${FORBID}/`), r.stdout);
  assert.match(r.stdout, /tripwire against inattention, not a security boundary/);
  assert.match(r.stdout, /memory-pulse prereg verify exp-7/);
  const v = p.run(["verify"]);
  assert.equal(v.status, 0, out(v)); assert.match(v.stdout, /chain: OK — 2 chained row\(s\)/);
});

test("the stamp cannot be supplied by the caller: no option carries one, and the public writer does not carry the manifest", () => {
  const p = project();
  for (const extra of [["--at", "2020-01-01T00:00:00Z"], ["--stamp", "2020-01-01T00:00:00Z"], ["--time=2020-01-01T00:00:00Z"]]) {
    const r = p.seal(extra);
    assert.equal(r.status, 1, `${extra.join(" ")}: ${out(r)}`); assert.match(r.stderr, /unknown option/); assert.match(r.stderr, /usage: memory-pulse prereg seal/);
  }
  assert.ok(!existsSync(p.ledger), "a refused option writes nothing");
  // `append` is the one way for another tool to write a row. It refuses the manifest field, so a stamp cannot come in that way;
  // a row that only says "sealed" in words is a row like any other and is never taken for a seal
  const forged = { cause: "prereg exp-7", effect: "sealed", tags: ["prereg", "prereg:exp-7", "prereg-seal"], prereg: { id: "exp-7", op: "seal", at: "2020-01-01T00:00:00Z", spec: { path: "docs/spec.md", sha256: "0".repeat(64) }, files: [], asserts: [], forbid: [] } };
  const a = p.run(["append", "--json", JSON.stringify(forged)]);
  assert.equal(a.status, 1, out(a)); assert.equal(JSON.parse(a.stdout).written, false); assert.match(JSON.parse(a.stdout).reason, /written by memory-pulse prereg/);
  assert.ok(!existsSync(p.ledger));
  const { prereg: _manifest, ...words } = forged;
  assert.equal(p.run(["append", "--json", JSON.stringify(words)]).status, 0);
  assert.deepEqual(JSON.parse(p.run(["prereg", "list", "--json"]).stdout), []);
  assert.equal(p.run(["prereg", "verify", "exp-7"]).status, 1, "nothing is sealed under that id");
  const r = p.seal(); assert.equal(r.status, 0, out(r));
  assert.ok(Math.abs(Date.parse(p.rows()[1].prereg.at) - Date.now()) < 5000);
});

test("prereg verify: unchanged per file and exit 0; after a sealed file is edited, exit 2 and the file is named with both hashes", () => {
  const p = project();
  assert.equal(p.seal().status, 0);
  const specSha = sha(join(p.dir, "docs", "spec.md")), runSha = sha(join(p.dir, "src", "run.py"));
  const ok = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(ok.status, 0, out(ok));
  assert.match(ok.stdout, /^prereg exp-7: sealed at row 1, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(open\)$/m);
  assert.ok(ok.stdout.includes(`unchanged  docs/spec.md  sha256 ${specSha}`), ok.stdout);
  assert.ok(ok.stdout.includes(`unchanged  src/run.py  sha256 ${runSha}`), ok.stdout);
  assert.match(ok.stdout, /assert holds {12}shipped\/params\.py :: THRESHOLD = 0\.25/);
  assert.match(ok.stdout, /^verify: all 2 sealed file\(s\) unchanged$/m);
  // the builder edits the spec after sealing it
  writeFileSync(join(p.dir, "docs", "spec.md"), readFileSync(join(p.dir, "docs", "spec.md"), "utf8").replace("0.25", "0.5"));
  const bad = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(bad.status, 2, out(bad));
  assert.ok(bad.stdout.includes(`CHANGED    docs/spec.md  sealed ${specSha}  now ${sha(join(p.dir, "docs", "spec.md"))}`), bad.stdout);
  assert.ok(bad.stdout.includes(`unchanged  src/run.py  sha256 ${runSha}`));
  assert.match(bad.stdout, /^verify: 1 of 2 sealed file\(s\) changed or missing$/m);
  const j = JSON.parse(p.run(["prereg", "verify", "exp-7", "--json"]).stdout);
  assert.equal(j.ok, false); assert.equal(j.id, "exp-7"); assert.equal(j.row, 1); assert.equal(j.status, "open");
  assert.deepEqual(j.files.map((f) => [f.path, f.status]), [["docs/spec.md", "changed"], ["src/run.py", "unchanged"]]);
  assert.equal(j.files[0].sealed, specSha); assert.equal(j.files[0].now, sha(join(p.dir, "docs", "spec.md")));
  assert.equal(p.run(["prereg", "verify", "exp-7", "--json"]).status, 2);
  // a sealed file that is gone is not "unchanged"
  rmSync(join(p.dir, "src", "run.py"));
  const gone = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(gone.status, 2); assert.ok(gone.stdout.includes(`MISSING    src/run.py  sealed ${runSha}`), gone.stdout);
  assert.match(gone.stdout, /^verify: 2 of 2 sealed file\(s\) changed or missing$/m);
  // an id nothing was sealed under is a refusal, not a pass
  const none = p.run(["prereg", "verify", "exp-8"]);
  assert.equal(none.status, 1); assert.match(none.stderr, /no seal for "exp-8"/);
  assert.equal(p.rows().length, 1, "verify writes nothing");
});

test("prereg verify also says when an asserted value moved, which files beside the spec are newer than the seal, and what the guard blocked", () => {
  const p = project();
  assert.equal(p.seal().status, 0);
  writeFileSync(join(p.dir, "docs", "amendment-1.md"), "run 4096 after all\n");
  const later = new Date(Date.now() + 60_000); utimesSync(join(p.dir, "docs", "amendment-1.md"), later, later);
  writeFileSync(join(p.dir, "shipped", "params.py"), "WINDOW = 64\nTHRESHOLD = 0.3\n");
  assert.equal(p.bash("python train.py --n 4096").status, 2);
  const r = p.run(["prereg", "verify", "exp-7"]);
  assert.equal(r.status, 0, "the exit code is about the sealed files, and they are unchanged");
  assert.match(r.stdout, /assert NO LONGER HOLDS {2}shipped\/params\.py :: THRESHOLD = 0\.25/);
  assert.match(r.stdout, /newer than the seal, not sealed: docs\/amendment-1\.md \(\d{4}-\d{2}-\d{2}T/);
  assert.match(r.stdout, /blocked by the guard under this seal: 1 command\(s\), last \d{4}-\d{2}-\d{2}T\S+: python train\.py --n 4096/);
  const j = JSON.parse(p.run(["prereg", "verify", "exp-7", "--json"]).stdout);
  assert.equal(j.ok, true); assert.deepEqual(j.asserts.map((a) => a.holds), [false]); assert.deepEqual(j.newer.map((n) => n.path), ["docs/amendment-1.md"]); assert.equal(j.blocked.length, 1);
});

test("a --forbid pattern blocks a matching command through the real guard, and not another command, an edit, or the evaluator's command", () => {
  const p = project();
  mkdirSync(join(p.dir, ".memory-pulse"), { recursive: true }); writeFileSync(p.invariants, USER_RULE + "\n");
  assert.equal(p.bash("python train.py --n 4096").status, 0, "before the seal nothing is reserved");
  const s = p.seal(); assert.equal(s.status, 0, out(s));
  const inv = readFileSync(p.invariants, "utf8").trim().split("\n");
  assert.equal(inv[0], USER_RULE, "the rule that was there is untouched");
  assert.deepEqual(JSON.parse(inv[1]), { id: "prereg:exp-7:forbid-1", on: "command", statement: "sealed by prereg exp-7 at row 1: this command is the evaluator's; hand it to an evaluator, or settle the prereg",
    patterns: [`/${FORBID}/`], severity: "block", owner: { prereg: "exp-7", row: 1 }, cite: [1] });
  const b = p.bash("cd runs && python train.py --seed 3 --n 4096");
  assert.equal(b.status, 2, out(b));
  assert.match(b.stderr, /memory-pulse guard: blocked\./); assert.match(b.stderr, /sealed by prereg exp-7 at row 1: this command is the evaluator's/);
  assert.match(b.stderr, /Hand it to an evaluator/); assert.match(b.stderr, /memory-pulse prereg settle exp-7 --verdict/);
  assert.equal(p.bash("python train.py --n 8192").status, 2);
  assert.equal(p.bash("python train.py --n 2048").status, 0, "the size the spec allows");
  assert.equal(p.bash("python eval.py --n 4096").status, 0, "another program");
  assert.equal(p.guard("Write", { file_path: "notes.md", content: "the evaluator will run python train.py --n 4096" }).status, 0, "an edit that mentions the command");
  assert.equal(p.guard("Edit", { file_path: "notes.md", old_string: "a", new_string: "python train.py --n 8192" }).status, 0);
  const e = p.bash("MEMORY_PULSE_ROLE=evaluator python train.py --n 4096");
  assert.equal(e.status, 0, out(e)); assert.match(e.stderr, /prereg exp-7 .*allowed/);
  assert.equal(p.run(["check", "--kind", "command", "--text", "python train.py --n 4096"]).status, 2);
});

test("prereg settle: one row with the verdict file's hash that cites the seal row; the forbid rule stops blocking; the chain verifies", () => {
  const p = project();
  mkdirSync(join(p.dir, ".memory-pulse"), { recursive: true }); writeFileSync(p.invariants, USER_RULE + "\n");
  assert.equal(p.seal().status, 0);
  assert.equal(p.bash("python train.py --n 4096").status, 2);
  const before = Math.floor(Date.now() / 1000) * 1000; const r = p.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md", "--note", "3 of 3 seeds"]); const after = Date.now();
  assert.equal(r.status, 0, out(r));
  const rows = p.rows(); assert.equal(rows.length, 2, "exactly one row was added"); const row = rows[1];
  assert.equal(row.cause, "prereg exp-7"); assert.equal(row.effect, "settled KEEP");
  for (const tag of ["prereg", "prereg:exp-7", "prereg-settle"]) assert.ok(row.tags.includes(tag), `tag ${tag}`);
  assert.equal(row.prereg.op, "settle"); assert.equal(row.prereg.id, "exp-7"); assert.equal(row.prereg.verdict, "KEEP"); assert.equal(row.prereg.seal, 1, "cites the seal row");
  assert.deepEqual(row.prereg.file, { path: "verdict.md", sha256: sha(join(p.dir, "verdict.md")), bytes: readFileSync(join(p.dir, "verdict.md")).length });
  assert.ok(Date.parse(row.prereg.at) >= before && Date.parse(row.prereg.at) <= after);
  assert.match(row.note, /3 of 3 seeds/);
  assert.match(r.stdout, /^prereg exp-7: settled KEEP at row 2 \(seal row 1\)$/m);
  assert.match(r.stdout, /^stamp: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · \S+ \(paste this\)$/m);
  assert.ok(r.stdout.includes(`verdict  verdict.md  sha256 ${sha(join(p.dir, "verdict.md"))}`), r.stdout);
  assert.ok(r.stdout.includes(`retired  /${FORBID}/`), r.stdout);
  // the rule is gone and nothing else in the file moved
  assert.equal(readFileSync(p.invariants, "utf8"), USER_RULE + "\n");
  const g = p.bash("python train.py --n 4096");
  assert.equal(g.status, 0, out(g)); assert.ok(!/blocked/.test(out(g)));
  assert.equal(p.run(["check", "--kind", "command", "--text", "python train.py --n 4096"]).status, 0);
  const v = p.run(["verify"]); assert.equal(v.status, 0, out(v)); assert.match(v.stdout, /chain: OK — 2 chained row\(s\)/);
  // verify still answers for a settled seal
  const pv = p.run(["prereg", "verify", "exp-7"]); assert.equal(pv.status, 0); assert.match(pv.stdout, /\(settled KEEP at row 2\)/);
});

test("prereg settle refuses an id with no open seal, a missing verdict or verdict file, and writes nothing then", () => {
  const p = project();
  const none = p.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(none.status, 1, out(none)); assert.match(none.stderr, /no open seal for "exp-7"/);
  assert.ok(!existsSync(p.ledger));
  assert.equal(p.seal().status, 0);
  for (const args of [["--file", "verdict.md"], ["--verdict", "KEEP"], ["--verdict", "KEEP", "--file", "absent.md"], ["--verdict", "not a word", "--file", "verdict.md"], ["--verdict", "KEEP", "--file", "verdict.md", "--at", "2020-01-01T00:00:00Z"]]) {
    const r = p.run(["prereg", "settle", "exp-7", ...args]); assert.equal(r.status, 1, `${args.join(" ")}: ${out(r)}`);
  }
  assert.equal(p.rows().length, 1); assert.equal(p.bash("python train.py --n 4096").status, 2, "a refused settle retires nothing");
  assert.equal(p.run(["prereg", "settle", "exp-7", "--verdict", "KILL", "--file", "verdict.md"]).status, 0);
  const again = p.run(["prereg", "settle", "exp-7", "--verdict", "KEEP", "--file", "verdict.md"]);
  assert.equal(again.status, 1); assert.match(again.stderr, /no open seal for "exp-7".*settled KILL at row 2/s);
  assert.equal(p.rows().length, 2);
});

test("prereg seal twice on the same id is refused while the first is open; a settled id can be sealed again", () => {
  const p = project();
  assert.equal(p.seal().status, 0);
  const again = p.seal();
  assert.equal(again.status, 1, out(again)); assert.match(again.stderr, /"exp-7" already has an open seal \(row 1/);
  assert.equal(p.rows().length, 1); assert.equal(readFileSync(p.invariants, "utf8").trim().split("\n").length, 1, "and no second rule");
  assert.equal(p.run(["prereg", "settle", "exp-7", "--verdict", "KILL", "--file", "verdict.md"]).status, 0);
  const next = p.seal(); assert.equal(next.status, 0, out(next));
  assert.match(next.stdout, /^prereg exp-7: sealed at row 3$/m);
  assert.equal(JSON.parse(readFileSync(p.invariants, "utf8").trim()).owner.row, 3);
});

test("prereg seal refuses a bad id, a missing spec or file, and a forbid pattern that does not compile, and writes nothing then", () => {
  const p = project();
  for (const [args, re] of [
    [["prereg", "seal", "exp 7", "--spec", "docs/spec.md"], /letters, digits, dot, dash and underscore/],
    [["prereg", "seal", "exp/7", "--spec", "docs/spec.md"], /letters, digits, dot, dash and underscore/],
    [["prereg", "seal", "--spec", "docs/spec.md"], /usage: memory-pulse prereg seal/],
    [["prereg", "seal", "exp-7"], /usage: memory-pulse prereg seal/],
    [["prereg", "seal", "exp-7", "--spec", "docs/absent.md"], /docs\/absent\.md: no such file/],
    [["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--file", "src/absent.py"], /src\/absent\.py: no such file/],
    [["prereg", "seal", "exp-7", "--spec", "docs/spec.md", "--forbid", "train(.py"], /--forbid 'train\(\.py' is not a regular expression/],
    [["prereg", "bogus"], /usage: memory-pulse prereg seal/],
    [["prereg"], /usage: memory-pulse prereg seal/],
  ]) { const r = p.run(args); assert.equal(r.status, 1, `${args.join(" ")}: ${out(r)}`); assert.match(r.stderr, re); }
  assert.ok(!existsSync(p.ledger)); assert.ok(!existsSync(p.invariants));
  // an id of letters, digits, dot, dash and underscore is taken as it is
  const ok = p.run(["prereg", "seal", "Exp_7.b-2", "--spec", "docs/spec.md"]); assert.equal(ok.status, 0, out(ok));
  assert.ok(!existsSync(p.invariants), "no --forbid, no rule");
});

test("prereg list: open and settled seals with id, row, stamp and verdict", () => {
  const p = project();
  assert.match(p.run(["prereg", "list"]).stdout, /no seals on this ledger/);
  assert.equal(p.run(["prereg", "seal", "exp-6", "--spec", "docs/spec.md"]).status, 0);
  assert.equal(p.seal().status, 0);
  assert.equal(p.run(["prereg", "settle", "exp-6", "--verdict", "KILL", "--file", "verdict.md"]).status, 0);
  const rows = p.rows();
  const j = JSON.parse(p.run(["prereg", "list", "--json"]).stdout);
  assert.deepEqual(j, [
    { id: "exp-6", row: 1, at: rows[0].prereg.at, status: "settled", verdict: "KILL", settled_row: 3, settled_at: rows[2].prereg.at },
    { id: "exp-7", row: 2, at: rows[1].prereg.at, status: "open", verdict: null, settled_row: null, settled_at: null },
  ]);
  const t = p.run(["prereg", "list"]); assert.equal(t.status, 0);
  assert.match(t.stdout, /^prereg: 2 seal\(s\), 1 open$/m);
  assert.match(t.stdout, /^ {2}exp-6 {2}settled KILL {2}row 1 {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC {2}settled at row 3, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.match(t.stdout, /^ {2}exp-7 {2}open {2}row 2 {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
});

test("a seal made in one directory verifies from another: paths resolve against the directory the seal was made in", () => {
  const p = project();
  assert.equal(p.seal().status, 0);
  const elsewhere = join(p.base, "elsewhere"); mkdirSync(elsewhere);
  const env = { PATH: process.env.PATH, HOME: p.base, TMPDIR: p.base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(p.base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(p.base, "trust"), MEMORY_PULSE_DATA_DIR: join(p.base, "data"), MEMORY_PULSE_LEDGER: p.ledger };
  const r = spawnSync(process.execPath, [SERVER, "prereg", "verify", "exp-7"], { cwd: elsewhere, env, encoding: "utf8" });
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /^verify: all 2 sealed file\(s\) unchanged$/m);
});

// ---- the public surface: where a reader looks, in plain words
import { ROOT } from "./_helpers.mjs";
const between = (text, from, to) => { const i = text.indexOf(from); assert.ok(i >= 0, `"${from}" is there`); const j = to ? text.indexOf(to, i + from.length) : -1; return text.slice(i, j < 0 ? undefined : j); };

test("help, README, guide, skill and changelog all say the forbid rule is a tripwire against inattention, not a security boundary", () => {
  const p = project();
  const help = p.run(["help"]).stdout;
  const usage = (name) => help.split("\n").find((l) => l.startsWith(`  ${name} `));
  assert.equal(usage("now"), "  now [--json]                        the machine clock as the stamps a record uses (2026-11-19 02:15 UTC and 2026-11-19T02:15:07Z); a record's stamp is pasted from this, never typed");
  assert.equal(usage("prereg"), `  prereg seal <id> --spec <file> [--file <path>]... [--assert '<path>::<text>']... [--forbid '<regex>']... [--note "..."]`);
  assert.equal(usage("ran"), "  ran '<regex>' [--since <row|ISO time>] [--json]");
  for (const l of ["         verify <id> [--json] ", `         settle <id> --verdict <WORD> --file <verdict-file> [--note "..."]`, "         list [--json] "]) assert.ok(help.includes(`\n${l}`), `help carries: ${l}`);
  const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
  const surfaces = {
    help,
    readme: between(read("README.md"), "## Pre-registered research", "\n## "),
    guide: between(read("docs", "GUIDE.md"), "## 17. Pre-registered research", "\n## "),
    skill: between(read("skills", "memory-pulse", "SKILL.md"), "## 10. Pre-registered research", "\n## "),
    changelog: between(read("CHANGELOG.md"), "## 0.18.0 (unreleased)", "\n## "),
  };
  for (const [name, text] of Object.entries(surfaces)) {
    assert.match(text.replace(/\s+/g, " "), /tripwire against inattention, not a security boundary/, `${name} says what the forbid rule is not`);
    assert.ok(text.includes("MEMORY_PULSE_ROLE=evaluator"), `${name} names the one exemption`);
  }
  // each document names every command, and the rule on commands underneath
  const whole = { readme: read("README.md"), guide: read("docs", "GUIDE.md"), changelog: read("CHANGELOG.md") };
  for (const [name, text] of Object.entries(whole)) {
    const flat = text.replace(/\s+/g, " ");
    for (const cmd of ["prereg seal", "prereg verify", "prereg settle", "prereg list", '"on": "command"']) assert.ok(flat.includes(cmd), `${name} names ${cmd}`);
    assert.match(flat, /`(?:memory-pulse )?now`/, `${name} names now`); assert.match(flat, /`(?:memory-pulse )?ran[ `]/, `${name} names ran`);
  }
  // the three slips are the stated reason, with their numbers
  for (const name of ["readme", "guide", "changelog"]) for (const s of ["00:15", "0.25", "reserved for confirmation"]) assert.ok(surfaces[name].replace(/\s+/g, " ").includes(s), `${name} gives the reason: ${s}`);
});

test("what this release adds describes behaviour only: none of the words the public surface does not use", () => {
  const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
  const added = {
    "lib/prereg.mjs": read("lib", "prereg.mjs"),
    "README section": between(read("README.md"), "## Pre-registered research", "\n## "),
    "guide section 17": between(read("docs", "GUIDE.md"), "## 17. Pre-registered research", "\n## "),
    "skill section 10": between(read("skills", "memory-pulse", "SKILL.md"), "## 10. Pre-registered research", "\n## "),
    "changelog 0.18.0": between(read("CHANGELOG.md"), "## 0.18.0 (unreleased)", "\n## "),
    "test/prereg.test.js": read("test", "prereg.test.js").split("// ---- the public surface")[0],
    "test/now.test.js": read("test", "now.test.js"), "test/ran.test.js": read("test", "ran.test.js"), "test/command-invariant.test.js": read("test", "command-invariant.test.js"),
  };
  const WORDS = new RegExp(String.raw`\b(${["hyper" + "vectors?", "hyper" + "dimensional", "H" + "MK", "bi" + "nd(?:s|ing)?", "bun" + "dl(?:e|es|ed|ing)", "reson" + "an(?:ce|t)", "holo" + "graphic"].join("|")})\b`, "i");
  for (const [name, text] of Object.entries(added)) { const hit = WORDS.exec(text); assert.equal(hit, null, `${name}: "${hit?.[0]}" near: ${text.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)}`); }
});
