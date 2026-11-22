// The team path through git, after an outside review of 99824f1 (2026-11-21), finding M-3: a rollback on one side was left "at
// source" by the merge, and in git the merged file replaces the branch's ledger, so the rollback was on no tip and the guard's verdict
// flipped. These are the reviewer's four cases (review/scratch/f4/s02-rollback.sh) with the guard's verdict read on both sides before
// and after, and the same reading for a supersedes row and an override row, which did carry.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, branchWith, merge, noMarkers, findings, out, ok, verifyChainLines, contentHeadHex } from "./_team.mjs";

// the shared ledger (test/_team.mjs): t1 an event, t2 a correction that withdraws eu-west-9 for eu-west-1
const WEST9 = "deploy to eu-west-9";
const rollback = (e, to, why) => ok(e.mp(["state", "rollback", "--to", String(to), why]), `${e.name} state rollback`);
const sound = (e) => { noMarkers(e); assert.ok(verifyChainLines(e.lines()).ok, `${e.name}'s ledger verifies`); };

test("M-3a: git pull --rebase keeps a rollback of a shared correction: the value passes after the pull as it did before, here and for the next puller", () => {
  const { alice, bob } = world();
  alice.remember("ci-runner", "use-ubuntu-24", "--note", "the runner image moved"); alice.commit("A row"); ok(alice.git("push", "-q", "origin", "main"), "push");
  assert.ok(bob.blocked(WEST9), "before the rollback the shared correction binds");
  rollback(bob, 1, "the region correction was recorded by mistake"); bob.commit("B rolls back the shared correction");
  assert.equal(bob.blocked(WEST9), false, "after the rollback it does not");
  const r = bob.git("pull", "--rebase");
  assert.equal(r.status, 0, out(r)); sound(bob);
  assert.equal(bob.blocked(WEST9), false, `the rollback is gone after pull --rebase:\n${out(r)}`);
  assert.equal(bob.rows().filter((x) => x.cause === "ci-runner" && !x.origin).length, 1, "ours (main) is kept as it was");
  assert.ok(findings(bob.rows()).includes("ci-runner -> use-ubuntu-24"), "the other side's row recorded after the fork is still in force");
  ok(bob.git("push", "-q", "origin", "main"), "push"); ok(alice.git("pull", "-q"), "alice pulls");
  assert.equal(alice.blocked(WEST9), false, "and the next puller reads the same verdict");
});

test("M-3b: git merge carries the other side's rollback: the merging side and the branch that rolled back read the same verdict", () => {
  const { alice, bob } = world();
  branchWith(bob, "featB", (e) => { rollback(e, 1, "the region correction was recorded by mistake"); e.remember("tabs", "use-two-spaces", "--note", "the formatter setting"); });
  assert.equal(bob.blocked(WEST9), false);
  alice.remember("ci-runner", "use-ubuntu-24", "--note", "the runner image moved"); alice.commit("A row");
  assert.ok(alice.blocked(WEST9), "before the merge alice still blocks it");
  const before = alice.text();
  const m = merge(alice, "origin/featB");
  assert.equal(m.status, 0, out(m)); sound(alice);
  assert.ok(alice.text().startsWith(before), "ours byte for byte");
  assert.equal(alice.blocked(WEST9), false, `the rollback did not carry:\n${out(m)}`);
  assert.match(out(m), /rolled back/);
  assert.deepEqual(findings(alice.rows()).filter((f) => !f.startsWith("state-rollback")), ["ci-runner -> use-ubuntu-24", "pricing-shipped -> price-set", "tabs -> use-two-spaces"], "what is in force: the row before the rollback's target, alice's new row and bob's, and not the correction the rollback removed");
  assert.equal(alice.mp(["verify"]).status, 0);
  ok(alice.git("push", "-q", "origin", "main"), "push"); ok(bob.git("checkout", "-q", "main"), "main"); ok(bob.git("pull", "-q"), "bob pulls");
  assert.equal(bob.blocked(WEST9), false);
});

test("M-3c: a rollback that puts a withdrawn value back under the guard carries: the merge does not let the value through", () => {
  const { alice, bob } = world();
  alice.remember("region-again", "west-9-is-fine", "--kind", "correction", "--note", "recorded in error", "--withdrawn", "eu-west-1", "--replacement", "eu-west-9", "--supersedes", "2");
  alice.commit("a wrong supersede"); ok(alice.git("push", "-q", "origin", "main"), "push"); ok(bob.git("pull", "-q"), "bob pulls");
  assert.equal(bob.blocked(WEST9), false, "the wrong row retired the correction");
  branchWith(bob, "fixB", (e) => { rollback(e, 2, "t3 was wrong, eu-west-9 stays withdrawn"); e.remember("note-b", "something-b", "--note", "bob went on"); });
  assert.ok(bob.blocked(WEST9), "bob's rollback puts the correction back in force");
  alice.remember("ci-runner", "use-ubuntu-24", "--note", "the runner image moved"); alice.commit("A row");
  assert.equal(alice.blocked(WEST9), false);
  const m = merge(alice, "origin/fixB");
  assert.equal(m.status, 0, out(m)); sound(alice);
  assert.ok(alice.blocked(WEST9), `the merged ledger lets a withdrawn value through:\n${out(m)}`);
  assert.ok(findings(alice.rows()).includes("ci-runner -> use-ubuntu-24") && findings(alice.rows()).includes("note-b -> something-b"));
  assert.equal(alice.mp(["verify"]).status, 0);
});

test("M-3j: the verdict does not depend on who merges: one side recorded a correction and rolled it back, the other recorded the same one", () => {
  const { alice, bob } = world();
  const x = (e) => e.correct("lib-x", "oldLib(", "newLib(", "the old entry point is gone");
  branchWith(alice, "fa", (e) => { x(e); rollback(e, 2, "undo"); });
  branchWith(bob, "fb", (e) => x(e));
  assert.equal(alice.blocked("oldLib(1)"), false); assert.ok(bob.blocked("oldLib(1)"));
  const ma = merge(alice, "origin/fb"), mb = merge(bob, "origin/fa");
  assert.equal(ma.status, 0, out(ma)); assert.equal(mb.status, 0, out(mb)); sound(alice); sound(bob);
  assert.equal(alice.blocked("oldLib(1)"), bob.blocked("oldLib(1)"), `alice merged bob:\n${out(ma)}\nbob merged alice:\n${out(mb)}`);
  assert.ok(bob.blocked("oldLib(1)"), "the correction one side still holds stays in force");
  assert.equal(contentHeadHex(alice.rows()), contentHeadHex(bob.rows()), "the same findings in force either way");
});

test("a supersedes row and an override row carry with their effect: the same verdicts on both sides, before and after, in both directions", () => {
  const { alice, bob } = world();
  // alice revises the shared correction properly; bob records that the old region may stay in the history page
  branchWith(alice, "alice", (e) => e.remember("region-move", "region-is-central", "--kind", "correction", "--note", "the region moved again", "--withdrawn", "eu-west-9", "--withdrawn", "eu-west-1", "--replacement", "eu-central-1", "--supersedes", "2"));
  branchWith(bob, "bob", (e) => ok(e.mp(["guard", "allow", "eu-west-9", "--path", "docs/history/", "the history page names the old region"]), "guard allow"));
  const HIST = "docs/history/regions.md";
  assert.ok(alice.blocked("deploy to eu-west-1") && alice.blocked(WEST9, HIST), "alice before: her revision binds, and no override is here");
  assert.ok(bob.blocked(WEST9) && !bob.blocked(WEST9, HIST) && !bob.blocked("deploy to eu-west-1"), "bob before: the override passes the history page, and no revision is here");
  const mb = merge(bob, "origin/alice"), ma = merge(alice, "origin/bob");
  assert.equal(mb.status, 0, out(mb)); assert.equal(ma.status, 0, out(ma)); sound(alice); sound(bob);
  for (const e of [alice, bob]) {
    assert.ok(e.blocked("deploy to eu-west-1"), `${e.name}: the revision binds`);
    assert.ok(e.blocked(WEST9), `${e.name}: the old region is still withdrawn`);
    assert.equal(e.blocked(WEST9, HIST), false, `${e.name}: the override still passes the history page`);
    assert.equal(e.blocked("moved from eu-west-1 to eu-central-1"), false, `${e.name}: naming the replacement passes`);
  }
  assert.equal(contentHeadHex(alice.rows()), contentHeadHex(bob.rows()));
});
