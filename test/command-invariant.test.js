// Command invariants (0.18.0). A declared invariant (.memory-pulse/invariants.jsonl) was matched against an edit's text and scoped
// by path prefixes. A line with "on": "command" is matched against a shell command instead: when the guard handles a Bash / shell
// tool call, and by `check --kind command`. It is never matched against a file edit, and `paths` is ignored for it. An invariant
// without "on" behaves exactly as it did, and the first five tests pin that (they pass on 0.17.2 unchanged).
// The reason: an agent ran its own experiment at sizes its own amendment had reserved for confirmation, and nothing stopped it.
// A prereg's forbid invariant (owner: {prereg, row}) names the prereg in its block and has one exemption, a command line that
// starts with MEMORY_PULSE_ROLE=evaluator. It is a tripwire against inattention, not a security boundary. It is enforced while
// its seal is open on the ledger (review of 0.18.0, test/prereg-review.test.js F1d), so the tests of it seal for real.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";
import { localCheck, editSlice } from "../server.mjs";

const INVARIANTS = [
  // as they were before 0.18.0: matched against an edit's text, scoped by path prefixes
  { id: "old-domain", statement: "the old domain was retired", patterns: ["example-old.com"], severity: "block" },
  { id: "docs-only", statement: "not in the docs", patterns: ["FORBIDDEN-IN-DOCS"], paths: ["docs/"] },
  // new: matched against a shell command
  { id: "no-big-n", on: "command", statement: "n above 2048 is reserved for the confirmation run", patterns: ["/--n (4096|8192)\\b/"], severity: "block" },
  { id: "cmd-with-paths", on: "command", statement: "the build folder is kept", patterns: ["rm -rf build"], paths: ["docs/"] },
  { id: "cmd-warn", on: "command", statement: "slow on this machine", patterns: ["--all-shards"], severity: "warn" },
  // a prereg's forbid invariant, as `prereg seal --forbid` declares it
  { id: "prereg:exp-7:forbid-1", on: "command", statement: "sealed by prereg exp-7 at row 1: this command is the evaluator's; hand it to an evaluator, or settle the prereg", patterns: ["/train\\.py .*--confirm\\b/"], severity: "block", owner: { prereg: "exp-7", row: 1 }, cite: [1] },
];

// a scratch project and an explicit environment: no MEMORY_PULSE_LEDGER, so nothing here can reach a real ledger. `sealed`: the
// prereg's rule is declared by a real `prereg seal`, so its seal is open on the ledger; otherwise every line is written as it stands
function project({ sealed = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "mp-cmdinv-")); const dir = join(base, "p"); mkdirSync(join(dir, ".memory-pulse"), { recursive: true });
  writeFileSync(join(dir, ".memory-pulse", "invariants.jsonl"), (sealed ? INVARIANTS.slice(0, 5) : INVARIANTS).map((i) => JSON.stringify(i)).join("\n") + "\n");
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env, input, encoding: "utf8" });
  const guard = (tool_name, tool_input, extra = []) => run(["guard", ...extra], JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
  if (sealed) {
    writeFileSync(join(dir, "spec.md"), "# exp-7\nthe confirmation run is the evaluator's\n");
    const s = run(["prereg", "seal", "exp-7", "--spec", "spec.md", "--forbid", "train\\.py .*--confirm\\b"]); assert.equal(s.status, 0, `${s.stdout}${s.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".memory-pulse", "invariants.jsonl"), "utf8").trim().split("\n").at(-1)), INVARIANTS[5], "the rule in INVARIANTS is the rule a seal declares");
  }
  return { dir, run, guard, bash: (command) => guard("Bash", { command }) };
}
const out = (r) => `${r.stdout}${r.stderr}`;

// ---- pins: an invariant without "on" behaves as it did (green before the change, by design)

test("pin: an invariant without `on` still blocks an edit that matches it, and its path scope still holds", () => {
  const p = project();
  const w = p.guard("Write", { file_path: "src/a.md", content: "see example-old.com" });
  assert.equal(w.status, 2, out(w)); assert.match(w.stderr, /memory-pulse guard: blocked\./); assert.match(w.stderr, /invariant old-domain: the old domain was retired \(matched example-old\.com\)/);
  const e = p.guard("Edit", { file_path: "src/a.md", old_string: "x", new_string: "see example-old.com" });
  assert.equal(e.status, 2, out(e));
  assert.equal(p.guard("Write", { file_path: "docs/x.md", content: "FORBIDDEN-IN-DOCS" }).status, 2, "under its path prefix");
  assert.equal(p.guard("Write", { file_path: "src/x.md", content: "FORBIDDEN-IN-DOCS" }).status, 0, "outside its path prefix");
  assert.equal(p.guard("Write", { file_path: "src/a.md", content: "see example.com" }).status, 0);
});

test("pin: an invariant without `on` is not matched against a plain shell command (it was not before)", () => {
  const p = project();
  const r = p.bash("curl https://example-old.com/x");
  assert.equal(r.status, 0, out(r)); assert.ok(!/blocked/.test(out(r)));
});

test("pin: an invariant without `on` is matched against the text a shell command writes to a file (it was before)", () => {
  const p = project();
  const r = p.bash("cat > docs/a.md <<'EOF'\nsee example-old.com\nEOF");
  assert.equal(r.status, 2, out(r)); assert.match(r.stderr, /invariant old-domain/);
});

test("pin: `check --kind command` matches an invariant without `on` against its text (kind was only a label)", () => {
  const p = project();
  const r = p.run(["check", "--kind", "command", "--text", "curl https://example-old.com/x"]);
  assert.equal(r.status, 2, out(r)); assert.match(r.stdout, /BLOCKED/); assert.match(r.stdout, /invariant old-domain/);
});

test("pin: localCheck over an edit reports only the invariants without `on`, in the shape it had", () => {
  const v = localCheck([], { kind: "edit", text: "see example-old.com", path: "src/a.md" }, INVARIANTS.slice(0, 2));
  assert.equal(v.verdict, "blocked");
  assert.deepEqual(v.invariants, [{ id: "old-domain", severity: "block", pattern: "example-old.com", cite: [], replacement: "" }]);
});

// ---- new: "on": "command"

test("an `on: command` invariant blocks a matching shell command through the guard, and not one that does not match", () => {
  const p = project();
  const r = p.bash("python train.py --n 4096");
  assert.equal(r.status, 2, out(r));
  assert.match(r.stderr, /memory-pulse guard: blocked\./);
  assert.match(r.stderr, /invariant no-big-n: n above 2048 is reserved for the confirmation run \(matched \/--n \(4096\|8192\)\\b\/, a rule on shell commands\)/);
  assert.ok(!/guard allow/.test(r.stderr), "guard allow overrides a withdrawn value, not a rule on commands; the block does not offer it");
  assert.equal(p.bash("python train.py --n 8192 --seed 3").status, 2);
  const ok = p.bash("python train.py --n 1024");
  assert.equal(ok.status, 0, out(ok)); assert.ok(!/blocked/.test(out(ok)));
  assert.equal(p.bash("python train.py --n 40960").status, 0, "the pattern is the author's regex: \\b ends the number");
});

test("an `on: command` invariant is never matched against a file edit", () => {
  const p = project();
  for (const [tool, input] of [
    ["Write", { file_path: "notes/plan.md", content: "the confirmation run is python train.py --n 4096" }],
    ["Edit", { file_path: "notes/plan.md", old_string: "x", new_string: "python train.py --n 8192" }],
    ["MultiEdit", { file_path: "notes/plan.md", edits: [{ old_string: "x", new_string: "python train.py --n 4096" }] }],
    ["apply_patch", { input: "*** Begin Patch\n*** Add File: notes/plan.md\n+python train.py --n 4096\n*** End Patch" }],
  ]) { const r = p.guard(tool, input); assert.equal(r.status, 0, `${tool}: ${out(r)}`); }
});

test("`paths` is ignored for an `on: command` invariant: it blocks the command wherever it runs, and no edit under those paths", () => {
  const p = project();
  assert.equal(p.bash("rm -rf build").status, 2);
  assert.equal(p.bash("cd src && rm -rf build").status, 2);
  assert.equal(p.guard("Write", { file_path: "docs/x.md", content: "then rm -rf build" }).status, 0);
  // and the edit context never carries it: only an invariant on edits, scoped to the file's path, rides along
  const slice = editSlice([], INVARIANTS, { path: "docs/x.md", text: "hello" });
  assert.match(slice, /invariant docs-only/); assert.ok(!/cmd-with-paths/.test(slice), slice);
});

test("a `warn` rule on commands reports in check and never blocks", () => {
  const p = project();
  assert.equal(p.bash("python eval.py --all-shards").status, 0);
  const r = p.run(["check", "--kind", "command", "--text", "python eval.py --all-shards"]);
  assert.equal(r.status, 0, out(r)); assert.match(r.stdout, /warning cmd-warn: slow on this machine \(matched --all-shards, a rule on shell commands\)/);
  assert.equal(p.guard("Write", { file_path: "notes/a.md", content: "use --all-shards" }).status, 0);
  assert.ok(!/cmd-warn/.test(p.run(["check", "--text", "use --all-shards"]).stdout), "and it says nothing about an edit");
});

test("`check --kind command` matches `on: command` invariants; a check of any other kind does not", () => {
  const p = project();
  const c = p.run(["check", "--kind", "command", "--text", "python train.py --n 8192"]);
  assert.equal(c.status, 2, out(c)); assert.match(c.stdout, /memory-pulse check: BLOCKED/); assert.match(c.stdout, /invariant no-big-n/);
  const j = JSON.parse(p.run(["check", "--kind", "command", "--json", "--text", "python train.py --n 8192"]).stdout);
  assert.equal(j.verdict, "blocked"); assert.deepEqual(j.invariants.map((i) => [i.id, i.on]), [["no-big-n", "command"]]);
  const e = p.run(["check", "--text", "python train.py --n 8192"]);
  assert.equal(e.status, 0, out(e)); assert.ok(!/no-big-n/.test(e.stdout), "an edit that mentions the command is not the command");
  assert.equal(p.run(["check", "--kind", "command", "--text", "python train.py --n 64"]).status, 0);
  // the library form agrees
  assert.equal(localCheck([], { kind: "command", text: "python train.py --n 4096" }, INVARIANTS).verdict, "blocked");
  assert.deepEqual(localCheck([], { kind: "edit", text: "python train.py --n 4096", path: "a.md" }, INVARIANTS).invariants, []);
  assert.deepEqual(localCheck([], { kind: "lint", text: "python train.py --n 4096", path: "CLAUDE.md" }, INVARIANTS).invariants, []);
});

test("lint never matches an `on: command` invariant, not even against the file that declares it", () => {
  const p = project();
  writeFileSync(join(p.dir, "CLAUDE.md"), "Docs live at example-old.com. The confirmation run is python train.py --n 4096 --confirm, after rm -rf build.\n");
  const j = JSON.parse(p.run(["lint", "--json"]).stdout);
  assert.deepEqual(j.rows.find((r) => r.file === "CLAUDE.md").invariants, ["old-domain"], "an invariant on edits is matched by lint as before, and only that");
  const hit = j.rows.flatMap((r) => r.invariants);
  for (const id of ["no-big-n", "cmd-with-paths", "cmd-warn", "prereg:exp-7:forbid-1"]) assert.ok(!hit.includes(id), `${id} is a rule on commands`);
});

// ---- a prereg's forbid invariant

test("a prereg's forbid invariant: the block names the prereg and its seal row, says the command is the evaluator's, and how to proceed", () => {
  const p = project({ sealed: true });
  const r = p.bash("python train.py --seed 1 --confirm");
  assert.equal(r.status, 2, out(r));
  assert.match(r.stderr, /memory-pulse guard: blocked\./);
  assert.match(r.stderr, /sealed by prereg exp-7 at row 1/);
  assert.match(r.stderr, /this command is the evaluator's/);
  assert.match(r.stderr, /hand it to an evaluator/i);
  assert.match(r.stderr, /MEMORY_PULSE_ROLE=evaluator/);
  assert.match(r.stderr, /memory-pulse prereg settle exp-7/);
  assert.match(r.stderr, /tripwire against inattention, not a security boundary/);
  const c = p.run(["check", "--kind", "command", "--text", "python train.py --confirm"]);
  assert.equal(c.status, 2, out(c)); assert.match(c.stdout, /sealed by prereg exp-7 at row 1/); assert.match(c.stdout, /memory-pulse prereg settle exp-7/);
});

test("the one exemption: a command line that starts with MEMORY_PULSE_ROLE=evaluator is not blocked by a prereg's forbid invariant", () => {
  const p = project({ sealed: true });
  for (const cmd of [
    "MEMORY_PULSE_ROLE=evaluator python train.py --confirm",
    "SEED=3 MEMORY_PULSE_ROLE=evaluator OUT=runs/c python train.py --confirm",
    "cd runs && MEMORY_PULSE_ROLE=evaluator python train.py --confirm",
    "cd \"my runs\" && cd c && MEMORY_PULSE_ROLE='evaluator' python train.py --confirm",
    "env MEMORY_PULSE_ROLE=evaluator python train.py --confirm",
  ]) { const r = p.bash(cmd); assert.equal(r.status, 0, `${cmd}: ${out(r)}`); assert.match(r.stderr, /prereg exp-7 .*allowed/, "the pass is said, not silent"); }
  for (const cmd of [
    "python train.py --confirm",
    "MEMORY_PULSE_ROLE=builder python train.py --confirm",
    "MEMORY_PULSE_ROLE=evaluators python train.py --confirm",
    "echo MEMORY_PULSE_ROLE=evaluator && python train.py --confirm",
    "python train.py --confirm # MEMORY_PULSE_ROLE=evaluator",
    "NOT_MEMORY_PULSE_ROLE=evaluator python train.py --confirm",
  ]) { const r = p.bash(cmd); assert.equal(r.status, 2, `${cmd}: ${out(r)}`); }
  // only a prereg's invariant has the exemption: a rule someone declared by hand has none
  assert.equal(p.bash("MEMORY_PULSE_ROLE=evaluator python train.py --n 4096").status, 2);
  const c = p.run(["check", "--kind", "command", "--text", "MEMORY_PULSE_ROLE=evaluator python train.py --confirm"]);
  assert.equal(c.status, 0, out(c)); assert.match(c.stdout, /prereg exp-7 .*allowed/);
});

test("a blocked command is recorded beside the ledger: when, which rule, and the command with secrets scrubbed", () => {
  const p = project({ sealed: true });
  assert.equal(p.bash("API_TOKEN=abc123def456 python train.py --confirm").status, 2);
  const rec = readFileSync(join(p.dir, ".memory-pulse", "violations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].invariants, ["prereg:exp-7:forbid-1"]); assert.deepEqual(rec[0].hits, []);
  assert.ok(Math.abs(Date.parse(rec[0].at) - Date.now()) < 10_000);
  assert.match(rec[0].command, /python train\.py --confirm/); assert.ok(!rec[0].command.includes("abc123def456"), rec[0].command);
  assert.equal(p.bash("python train.py --n 16").status, 0);
  assert.equal(readFileSync(join(p.dir, ".memory-pulse", "violations.jsonl"), "utf8").trim().split("\n").length, 1, "an allowed command records nothing");
});

test("a command that writes a file is judged twice: its text as an edit, the command as a command, each named once", () => {
  const p = project();
  const r = p.bash("python train.py --n 4096 && cat > docs/a.md <<'EOF'\nsee example-old.com\nEOF");
  assert.equal(r.status, 2, out(r));
  assert.equal((r.stderr.match(/invariant old-domain/g) ?? []).length, 1); assert.equal((r.stderr.match(/invariant no-big-n/g) ?? []).length, 1);
  assert.match(r.stderr, /docs\/a\.md:/); assert.match(r.stderr, /\(the command\):/);
});

test("Cursor's Shell tool takes the same rule, answered as a permission", () => {
  const p = project();
  const call = (command) => p.run(["guard", "--host", "cursor"], JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command } }));
  const no = JSON.parse(call("python train.py --n 4096").stdout);
  assert.equal(no.permission, "deny"); assert.match(no.agent_message, /invariant no-big-n/);
  assert.deepEqual(JSON.parse(call("python train.py --n 64").stdout), { permission: "allow" });
});

test("no invariants file, or one with no rule on commands: a shell command passes as before", () => {
  const base = mkdtempSync(join(tmpdir(), "mp-cmdinv-none-")); const dir = join(base, "p"); mkdirSync(dir);
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, NO_COLOR: "1", MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_AGENT: join(base, "agent.jsonl"), MEMORY_PULSE_MODE: "deliberate",
    MEMORY_PULSE_TRUST_DIR: join(base, "trust"), MEMORY_PULSE_DATA_DIR: join(base, "data") };
  const r = spawnSync(process.execPath, [SERVER, "guard"], { cwd: dir, env, input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "python train.py --n 4096" } }), encoding: "utf8" });
  assert.equal(r.status, 0, out(r)); assert.equal(r.stderr, "");
  assert.ok(!existsSync(join(dir, ".memory-pulse", "violations.jsonl")));
});

// ---- the engine's check (`check --receipt`) does not know "on": it would match every pattern against any text. It is sent only the
// invariants that apply to the action, so the signed verdict and the local one judge by the same rule. The engine is a fake in this
// process, so the CLI runs async (a synchronous spawn would block the fake's event loop).
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { before, after } from "node:test";
const sent = [];
const fake = createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => { let data = Buffer.concat(chunks); if (req.headers["content-encoding"] === "gzip") data = gunzipSync(data); sent.push({ route: req.url, body: data.length ? JSON.parse(data.toString("utf8")) : null });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ verdict: "no_evidence", reasons: ["fake engine"], evidence: [], corrections: [], invariants: [] })); });
});
before(async () => { await new Promise((ok, no) => { fake.once("error", no); fake.listen(0, "127.0.0.1", ok); }); });
after(() => fake.close());

test("check --receipt sends the engine only the invariants that apply: none on commands for an edit, and not a prereg's for an evaluator's command", async () => {
  const p = project({ sealed: true });
  const env = { PATH: process.env.PATH, HOME: join(p.dir, ".."), TMPDIR: join(p.dir, ".."), NO_COLOR: "1", MEMORY_PULSE_API: `http://127.0.0.1:${fake.address().port}`, MEMORY_PULSE_AGENT: join(p.dir, "..", "agent.jsonl"),
    MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_TRUST_DIR: join(p.dir, "..", "trust"), MEMORY_PULSE_DATA_DIR: join(p.dir, "..", "data") };
  const check = (args) => new Promise((resolve, reject) => execFile(process.execPath, [SERVER, "check", "--receipt", ...args], { cwd: p.dir, env, encoding: "utf8", timeout: 20000 }, (err, stdout, stderr) => (err && err.killed ? reject(new Error(`timeout: ${stderr}`)) : resolve(stdout + stderr))));
  const ids = async (args) => { sent.length = 0; await check(args); const call = sent.find((s) => s.route === "/v1/check"); assert.ok(call, "the engine was asked"); return call.body.invariants.map((i) => i.id); };
  assert.deepEqual(await ids(["--text", "python train.py --n 4096 --confirm"]), ["old-domain", "docs-only"], "an edit: the rules on commands stay home");
  assert.deepEqual(await ids(["--kind", "command", "--text", "python train.py --confirm"]), INVARIANTS.map((i) => i.id), "a command: every rule");
  assert.deepEqual(await ids(["--kind", "command", "--text", "MEMORY_PULSE_ROLE=evaluator python train.py --confirm"]), INVARIANTS.map((i) => i.id).filter((id) => !id.startsWith("prereg:")), "an evaluator's command: not the prereg's rule");
});
