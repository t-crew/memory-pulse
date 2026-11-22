// The team path through git (2026-11-21). A project's corrections live in .memory-pulse/events.jsonl, committed, so a clone carries
// them. Two engineers who each record a row on their own branch used to get a git conflict on that file, and the documented way out
// was to re-enter the losing rows by hand. With `memory-pulse team setup` in each clone, git calls
// `memory-pulse merge-driver %O %A %B %P`, which keeps ours byte for byte and re-appends the other side's rows through the writer, by
// the rules of `state merge` (each finding once, origin recorded). These are the merges that go through: both directions, a rebase,
// a row both sides recorded, a second merge from the same branch. test/_team.mjs holds the throwaway repositories.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { world, branchWith, merge, noMarkers, findings, engineer, out, ok, TMP, BARE_PATH, LEDGER, verifyChainLines, contentHeadHex, setHeadHex } from "./_team.mjs";

test("two clones each record a correction; a git merge keeps both: the ledger verifies, both bind in the guard, and the other direction holds the same rows in force", () => {
  const { alice, bob } = world();
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  branchWith(bob, "bob", (e) => e.correct("api-review", "v1-endpoint", "v2-endpoint"));
  // an engine seal over bob's ledger as it stands (the engine is not reachable from a test; the local check is the fold)
  const before = bob.text(), sealed = bob.rows();
  writeFileSync(bob.file(".memory-pulse/seal.rain"), JSON.stringify({ head: setHeadHex(sealed), through: 3, events: 3 }));

  const m = merge(bob, "origin/alice");
  assert.equal(m.status, 0, `git merge must not conflict on the ledger:\n${out(m)}`);
  assert.match(out(m), /carried 1 row\(s\) from origin\/alice/);
  noMarkers(bob);
  assert.ok(bob.text().startsWith(before), "ours is kept byte for byte and the other side's rows come after it");
  const rows = bob.rows();
  assert.ok(verifyChainLines(bob.lines()).ok, "the merged ledger's row chain verifies");
  const carried = rows.find((r) => r.cause === "pricing-review");
  assert.deepEqual({ branch: carried.origin.branch, t: carried.origin.t }, { branch: "origin/alice", t: 3 }, "a carried row records where it came from, as state merge records it");
  assert.equal(carried.t, 4); assert.ok(typeof carried.mac === "string" && typeof carried.hash === "string", "t, prev and hash are the writer's");
  const mrow = rows.find((r) => r.cause === "state-merged");
  assert.ok(mrow && mrow.tags.includes("merge") && mrow.state.carried === 1, "the merge itself is a row");
  assert.equal(bob.git("status", "--porcelain").stdout.trim(), "", "the merge committed and the tree is clean");

  const v = bob.mp(["verify"]);
  assert.equal(v.status, 0, `verify after a merge:\n${out(v)}`);
  assert.match(v.stdout, /chain: OK/); assert.match(v.stdout, /seal: OK/);
  assert.match(v.stdout, /anchor: OK/); assert.match(v.stdout, /writer marks: OK/);
  assert.ok(bob.blocked("the plan costs $49 a month"), "alice's correction binds on bob's machine");
  assert.ok(bob.blocked("call the v1-endpoint"), "bob's own correction still binds");
  assert.ok(bob.blocked("deploy to eu-west-9"), "the shared correction still binds");

  // the other direction: alice merges bob's branch as it stood before his merge
  const m2 = merge(alice, "origin/bob");
  assert.equal(m2.status, 0, out(m2)); noMarkers(alice);
  assert.equal(alice.mp(["verify"]).status, 0);
  assert.ok(alice.blocked("the plan costs $49 a month") && alice.blocked("call the v1-endpoint"));
  assert.deepEqual(findings(alice.rows()), findings(bob.rows()), "the same findings are in force whichever side merged");
  assert.equal(contentHeadHex(alice.rows()), contentHeadHex(bob.rows()), "and they fold to the same order-free head");
  assert.notEqual(alice.text(), bob.text(), "the files differ: each keeps its own rows first");
});

test("git rebase runs the driver for every replayed commit; the result begins with the other branch, and the two accept commands it names clear verify", () => {
  const { alice, bob } = world();
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  ok(bob.git("checkout", "-q", "-b", "bob"), "branch");
  bob.correct("api-review", "v1-endpoint", "v2-endpoint"); bob.commit("bob: first");
  bob.remember("ci-flake", "retry-added", "--note", "the integration job retries once"); bob.commit("bob: second");
  writeFileSync(bob.file(".memory-pulse/seal.rain"), JSON.stringify({ head: setHeadHex(bob.rows()), through: 4, events: 4 }));
  ok(bob.git("fetch", "-q", "origin"), "fetch");
  const theirs = bob.git("show", `origin/alice:${LEDGER}`).stdout;

  const r = bob.git("rebase", "origin/alice");
  assert.equal(r.status, 0, `git rebase must not stop on the ledger (two commits replayed):\n${out(r)}`);
  noMarkers(bob);
  assert.ok(bob.text().startsWith(theirs), "in a rebase ours is the branch rebased onto: its ledger is kept byte for byte");
  assert.ok(verifyChainLines(bob.lines()).ok);
  const rows = bob.rows();
  for (const cause of ["pricing-review", "api-review", "ci-flake"]) assert.equal(rows.filter((x) => x.cause === cause).length, 1, `${cause} lands once`);
  assert.equal(rows.find((x) => x.cause === "api-review").origin.branch, "bob", "a replayed row names the branch that was rebased");
  // the ledger no longer begins with what this machine last saw, and the rows under the seal's watermark are other rows: both are said
  assert.match(out(r), /memory-pulse anchor accept "/); assert.match(out(r), /memory-pulse seal accept "/);
  assert.match(out(r), /the rows this machine last saw at this path are the other side's \(in a rebase, ours is the branch you rebase onto\)/);
  const v = bob.mp(["verify"]);
  assert.equal(v.status, 2, out(v)); assert.match(v.stdout, /chain: OK/); assert.match(v.stdout, /anchor: ROLLED BACK/); assert.match(v.stdout, /seal: MISMATCH/);
  ok(bob.mp(["anchor", "accept", "rebased onto origin/alice by the git merge driver"]), "anchor accept");
  ok(bob.mp(["seal", "accept", "rebased onto origin/alice by the git merge driver"]), "seal accept");
  const v2 = bob.mp(["verify"]);
  assert.equal(v2.status, 0, out(v2));
  assert.ok(bob.blocked("the plan costs $49 a month") && bob.blocked("call the v1-endpoint"));
});

test("a row recorded identically on both sides lands once", () => {
  const { alice, bob } = world();
  const same = (e) => e.remember("ci-flake", "retry-added", "--note", "the integration job retries once");
  branchWith(alice, "alice", (e) => { same(e); e.correct("pricing-review", "$49", "$29"); });
  branchWith(bob, "bob", (e) => { same(e); e.remember("docs-updated", "readme-names-v2", "--note", "the readme names the v2 endpoint"); });
  // the merge runs with a PATH that has no node on it: the driver definition names node by absolute path
  const m = merge(bob, "origin/alice", { PATH: BARE_PATH });
  assert.equal(m.status, 0, out(m)); noMarkers(bob);
  const rows = bob.rows();
  assert.equal(rows.filter((r) => r.cause === "ci-flake").length, 1, "the identical row is not carried a second time");
  assert.equal(rows.filter((r) => r.cause === "pricing-review").length, 1);
  assert.match(rows.find((r) => r.cause === "state-merged").note, /1 duplicate\(s\) skipped/);
  assert.equal(bob.mp(["verify"]).status, 0);
});

test("a second merge from the same branch carries only what is new (the common ancestor is no longer a prefix of ours)", () => {
  const { alice, bob } = world();
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  branchWith(bob, "bob", (e) => e.correct("api-review", "v1-endpoint", "v2-endpoint"));
  ok(merge(bob, "origin/alice"), "first merge");
  alice.remember("docs-updated", "readme-names-29", "--note", "the readme carries the new price"); alice.commit("alice: more"); ok(alice.git("push", "-q", "origin", "alice"), "push");
  const m = merge(bob, "origin/alice");
  assert.equal(m.status, 0, `the second merge must not be refused:\n${out(m)}`);
  const rows = bob.rows();
  for (const cause of ["pricing-review", "api-review", "docs-updated"]) assert.equal(rows.filter((x) => x.cause === cause).length, 1, `${cause} lands once`);
  assert.equal(bob.mp(["verify"]).status, 0);
  // and back: alice has gone on, and takes bob's merged branch, whose ledger holds her earlier rows re-appended
  ok(bob.git("push", "-q", "origin", "bob"), "push");
  alice.remember("ops-note", "pager-rotated", "--note", "the pager rotation moved to mondays"); alice.commit("alice: on");
  const mine = alice.text();
  const back = merge(alice, "origin/bob");
  assert.equal(back.status, 0, out(back));
  assert.ok(alice.text().startsWith(mine));
  for (const cause of ["pricing-review", "api-review", "docs-updated", "ops-note"]) assert.equal(alice.rows().filter((x) => x.cause === cause).length, 1, `${cause} lands once on the way back`);
  assert.equal(alice.rows().filter((x) => x.cause === "state-merged").length, 1, "the other side's merge rows stay with the other side");
  assert.equal(alice.mp(["verify"]).status, 0);
});

test("a criss-cross merge (two common ancestors) runs the driver once: git's internal merge of the ancestors does not go through it", () => {
  const dir = mkdtempSync(join(TMP, "criss-")), e = engineer("ida", dir);
  ok(e.git("init", "-q", "-b", "main"), "init");
  e.remember("x", "one", "--note", "x happened"); e.mp(["team", "setup"]); e.commit("base");
  const on = (branch, from, cause) => { ok(e.git("checkout", "-q", "-b", branch, from), branch); e.remember(cause, "added", "--note", `${cause} went on`); e.commit(branch); };
  on("a", "main", "a-row"); on("b", "main", "b-row");
  ok(e.git("checkout", "-q", "-b", "a2", "a"), "a2"); ok(e.git("merge", "-q", "--no-edit", "-m", "a2", "b"), "a2 = a + b");
  ok(e.git("checkout", "-q", "-b", "b2", "b"), "b2"); ok(e.git("merge", "-q", "--no-edit", "-m", "b2", "a"), "b2 = b + a");
  assert.equal(e.git("merge-base", "--all", "a2", "b2").stdout.trim().split("\n").length, 2, "two common ancestors");
  ok(e.git("checkout", "-q", "a2"), "a2"); e.remember("a-more", "added", "--note", "a went further"); e.commit("a-more");
  ok(e.git("checkout", "-q", "b2"), "b2"); e.remember("b-more", "added", "--note", "b went further"); e.commit("b-more");
  ok(e.git("checkout", "-q", "a2"), "back to a2");
  const before = e.text();
  const m = e.git("merge", "--no-edit", "-m", "criss-cross", "b2");
  assert.equal(m.status, 0, out(m));
  assert.equal(out(m).split("\n").filter((l) => l.startsWith("memory-pulse merge-driver:")).length, 1, `one driver run, one line:\n${out(m)}`);
  assert.match(out(m), /carried 1 row\(s\) from b2 as t6\.\.t6; 2 duplicate\(s\) skipped/);
  assert.ok(e.text().startsWith(before)); assert.ok(verifyChainLines(e.lines()).ok);
  assert.deepEqual(e.rows().map((r) => r.cause), ["x", "a-row", "b-row", "state-merged", "a-more", "b-more", "state-merged"]);
  assert.equal(e.git("config", "--local", "--get", "merge.memory-pulse.recursive").stdout.trim(), "binary");
  // one machine, another branch pair: its anchor follows the ledger path, last saw a2's ledger, and matches neither side of this merge
  ok(e.git("checkout", "-q", "-b", "a3", "a"), "a3");
  const n = e.git("merge", "--no-edit", "-m", "a3", "b");
  assert.equal(n.status, 0, out(n));
  assert.match(out(n), /this machine last saw another branch's ledger at this path, so its anchor matched neither side before the merge/);
  assert.match(out(n), /memory-pulse anchor accept "/);
});
