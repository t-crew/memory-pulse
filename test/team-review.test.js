// The team path through git, after an outside review of 99824f1 (2026-11-21). Each test is one of the reviewer's reproductions
// (review/scratch/f4) turned into a test: a path that returned success with rows gone, or a state that passed as normal.
//   M-1  team resolve read the three index versions through a pipe buffer: a ledger over 1 MB was cut, and exit was 0.
//   M-2  team resolve rebuilt the file from the index and wrote over a correction recorded while the path was unmerged.
//   M-4  a ledger merged by hand ("kept both") in a clone without the driver was pushed; each puller's guard then moved the second
//        tail aside. It is two chains after one row, not a bad tail: it is named, never moved aside, and team resolve rebuilds it.
//   M-5  every carried row went through one whole-ledger pass; the carry is now one locked pass.
// Writes are a temp file beside the ledger and a rename, with the original untouched on any failure.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { world, branchWith, merge, bulk, chainedRows, noMarkers, out, ok, TMP, verifyChainLines, buildCapsule, mergeCapsule } from "./_team.mjs";

const pull = (e) => e.git("pull", "--no-rebase", "--no-edit");
const count = (e, cause) => e.rows().filter((r) => r.cause === cause).length;

test("M-1: team resolve on ledgers over 1 MB keeps every row of both sides", () => {
  const { alice, carol } = world(["alice", "carol"], { noSetup: ["carol"] });
  bulk(alice, "a", 400, { chars: 3000 }); alice.commit("a: 400 rows"); ok(alice.git("push", "-q", "origin", "main"), "push");
  bulk(carol, "c", 400, { chars: 3000 }); carol.commit("c: 400 rows");
  assert.ok(statSync(carol.file()).size > 1024 * 1024 && statSync(alice.file()).size > 1024 * 1024, "both ledgers are over 1 MiB");
  assert.match(out(pull(carol)), /CONFLICT \(content\): Merge conflict in \.memory-pulse\/events\.jsonl/);
  ok(carol.mp(["team", "setup"]), "team setup");
  const r = carol.mp(["team", "resolve"]);
  assert.equal(r.status, 0, out(r));
  const lines = carol.lines(); let torn = 0; const seen = new Map();
  for (const l of lines) { try { const c = JSON.parse(l).cause; seen.set(c, (seen.get(c) ?? 0) + 1); } catch { torn++; } }
  const missing = []; for (const p of ["a", "c"]) for (let i = 1; i <= 400; i++) if (seen.get(`${p}-finding-${i}`) !== 1) missing.push(`${p}-finding-${i}`);
  assert.deepEqual({ torn, missing: missing.length }, { torn: 0, missing: 0 }, `rows gone or doubled after a resolve that exited 0: ${missing.slice(0, 5).join(", ")}`);
  assert.ok(verifyChainLines(lines).ok);
});

test("M-2: a correction recorded while the path was unmerged is in the resolved ledger, and still binds", () => {
  const { alice, carol } = world(["alice", "carol"], { noSetup: ["carol"] });
  alice.correct("a-one", "aOne(", "aOneNew("); alice.commit("a1"); ok(alice.git("push", "-q", "origin", "main"), "push");
  carol.correct("c-one", "cOne(", "cOneNew("); carol.commit("c1");
  assert.match(out(pull(carol)), /CONFLICT/);
  // a hook, or the engineer, records a correction while the file still holds conflict markers; the writer takes it
  carol.correct("c-two", "eval(", "JSON.parse(");
  assert.ok(carol.blocked("eval(input)"), "the correction binds while the path is unmerged");
  ok(carol.mp(["team", "setup"]), "team setup");
  const r = carol.mp(["team", "resolve"]);
  assert.equal(r.status, 0, out(r));
  assert.equal(count(carol, "c-two"), 1, `the row recorded while unmerged is gone:\n${out(r)}`);
  // two rows: the correction, and the writer's own record that it moved git's last marker line aside before it wrote
  assert.match(out(r), /2 row\(s\) recorded while the path was unmerged are kept/);
  assert.equal(carol.rows().find((x) => x.cause === "c-two").origin.branch, "working-tree");
  assert.ok(carol.blocked("eval(input)") && carol.blocked("aOne(1)") && carol.blocked("cOne(1)"), "all three corrections bind after the resolve");
  noMarkers(carol); assert.ok(verifyChainLines(carol.lines()).ok);
});

test("team resolve writes a temp file beside the ledger and renames it; when that cannot be done it refuses and the file is untouched", () => {
  const { alice, carol } = world(["alice", "carol"], { noSetup: ["carol"] });
  alice.correct("a-one", "aOne(", "aOneNew("); alice.commit("a1"); ok(alice.git("push", "-q", "origin", "main"), "push");
  carol.correct("c-one", "cOne(", "cOneNew("); carol.commit("c1");
  assert.match(out(pull(carol)), /CONFLICT/);
  ok(carol.mp(["team", "setup"]), "team setup");
  const before = carol.text(), dir = carol.file(".memory-pulse"), ino = statSync(carol.file()).ino;
  chmodSync(dir, 0o555);
  let refused; try { refused = carol.mp(["team", "resolve"]); } finally { chmodSync(dir, 0o755); }
  assert.notEqual(refused.status, 0, out(refused));
  assert.equal(carol.text(), before, "a resolve that could not write left the file exactly as it was");
  const r = carol.mp(["team", "resolve"]);
  assert.equal(r.status, 0, out(r));
  assert.notEqual(statSync(carol.file()).ino, ino, "the ledger was replaced by a rename, never written in place");
  assert.deepEqual(readdirSync(dir).filter((f) => /\.tmp$/.test(f)), [], "no temp file is left beside it");
  assert.ok(verifyChainLines(carol.lines()).ok);
});

test("M-4: a ledger merged by hand and pushed is named for what it is, nothing is moved aside, and team resolve rebuilds it", () => {
  const { alice, bob, carol } = world(["alice", "bob", "carol"], { noSetup: ["carol"] });
  alice.correct("a-one", "aOne(", "aOneNew("); alice.commit("a1"); ok(alice.git("push", "-q", "origin", "main"), "push");
  carol.correct("c-one", "cOne(", "cOneNew("); carol.commit("c1");
  assert.match(out(pull(carol)), /CONFLICT/);
  // "accept both changes": the marker lines go, both tails stay, and it is committed and pushed
  writeFileSync(carol.file(), carol.text().split("\n").filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join("\n"));
  carol.commit("merge main (kept both)"); ok(carol.git("push", "-q", "origin", "main"), "push the hand merge");

  // bob has the driver and no rows of his own: the pull is a fast-forward, and no driver runs
  ok(bob.git("pull", "-q"), "bob pulls");
  assert.ok(bob.blocked("cOne(1)") && bob.blocked("aOne(1)"), "both corrections still bind: the second tail is not moved aside");
  assert.equal(existsSync(bob.file(".memory-pulse/events.jsonl.quarantine")), false, "nothing was quarantined");
  assert.equal(count(bob, "ledger-tail-quarantined"), 0);
  const v = bob.mp(["verify"]);
  assert.equal(v.status, 2, out(v));
  assert.match(v.stdout, /merged by hand/); assert.match(v.stdout, /memory-pulse team resolve/);
  assert.ok(!/repair --quarantine-tail/.test(v.stdout), "verify does not name the command that removes the other side's rows");
  const g = bob.mp(["guard"], JSON.stringify({ tool_name: "Write", tool_input: { file_path: "/tmp/x.md", content: "nothing withdrawn here" } }));
  assert.match(out(g), /merged by hand/); assert.match(out(g), /memory-pulse team resolve/);
  const st = bob.mp(["team", "status"]);
  assert.equal(st.status, 2, out(st)); assert.match(st.stdout, /merged by hand/);
  const r = bob.mp(["team", "resolve"]);
  assert.equal(r.status, 0, out(r));
  assert.ok(verifyChainLines(bob.lines()).ok, "the rebuilt ledger verifies");
  assert.equal(count(bob, "a-one"), 1); assert.equal(count(bob, "c-one"), 1);
  assert.ok(bob.blocked("cOne(1)") && bob.blocked("aOne(1)"));
  assert.equal(bob.mp(["team", "status"]).status, 0);

  // alice has the driver and one new row: her pull merges the hand-merged ledger by the driver's rule and says so
  alice.remember("a-two", "use-a2", "--note", "alice went on"); alice.commit("a2");
  const p = pull(alice);
  assert.equal(p.status, 0, out(p)); assert.match(out(p), /merged by hand/);
  assert.ok(verifyChainLines(alice.lines()).ok);
  for (const c of ["a-one", "c-one", "a-two"]) assert.equal(count(alice, c), 1, `${c} once`);
  assert.ok(alice.blocked("cOne(1)") && alice.blocked("aOne(1)"));
});

test("M-5: carrying many rows is one pass over the ledger, not one pass per row", () => {
  const dir = mkdtempSync(join(TMP, "carry-")); mkdirSync(join(dir, "o")); mkdirSync(join(dir, "t"));
  const base = chainedRows("", "base", 2000).join("\n") + "\n", ours = join(dir, "o", "events.jsonl"), theirs = join(dir, "t", "events.jsonl");
  writeFileSync(ours, base + chainedRows(base, "o", 1200, { every: 5 }).join("\n") + "\n"); writeFileSync(theirs, base + chainedRows(base, "t", 1200, { every: 5 }).join("\n") + "\n");
  const cap = buildCapsule({ ledger: theirs, scope: "project", branch: "t" }).capsule, before = readFileSync(ours);
  const env = process.env.MEMORY_PULSE_LEDGER; process.env.MEMORY_PULSE_LEDGER = ours;
  let r, cpu;
  try { const c0 = process.cpuUsage(); r = mergeCapsule(cap, { scope: "project" }); const c = process.cpuUsage(c0); cpu = (c.user + c.system) / 1e6; }
  finally { if (env === undefined) delete process.env.MEMORY_PULSE_LEDGER; else process.env.MEMORY_PULSE_LEDGER = env; }
  assert.equal(r.status, "merged"); assert.equal(r.carried.length, 1200);
  const after = readFileSync(ours);
  assert.ok(after.subarray(0, before.length).equals(before), "ours byte for byte");
  const lines = after.toString("utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2000 + 1200 + 1200 + 1); assert.ok(verifyChainLines(lines).ok);
  // processor time, which load on the machine does not stretch: with one pass per carried row this took 22.3 s here (2026-11-21)
  assert.ok(cpu < 6, `carrying 1,200 rows onto a 3,200-row ledger took ${cpu.toFixed(1)} s of processor time`);
});

test("a finding the other side tagged state is carried: only a row that holds a resume, merge or rollback record stays with its branch", () => {
  const { alice, bob } = world();
  // the organized memory's project-state section is rows tagged state or decision; the merge used to read the tag as bookkeeping
  branchWith(alice, "alice", (e) => e.remember("deploy-target", "is-cloudflare", "--note", "the project deploys to workers", "--tags", "state"));
  branchWith(bob, "bob", (e) => e.remember("tabs", "use-two-spaces", "--note", "the formatter setting"));
  const m = merge(bob, "origin/alice");
  assert.equal(m.status, 0, out(m));
  assert.equal(count(bob, "deploy-target"), 1, `a row of the other side is on neither tip after the merge:\n${out(m)}`);
  assert.ok(verifyChainLines(bob.lines()).ok);
});
