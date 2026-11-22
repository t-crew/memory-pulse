// The team path through git (2026-11-21): the merges the driver stops or refuses, and what a machine is told when no driver runs.
// A conflict that leaves two contradicting corrections binding stops the merge with both rows named and the merged ledger in place
// (a correction the other side already superseded is not one); a side that no longer holds the common ancestor's rows is refused
// with ours untouched; a fast-forward runs no driver, and verify says what the machine's anchor and seal make of the rows it got.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { world, branchWith, merge, noMarkers, engineer, files, out, ok, TMP, LEDGER, verifyChainLines, setHeadHex } from "./_team.mjs";

test("a correction that supersedes a shared one merges clean: nothing is left to decide, and the superseded row stops binding", () => {
  const { alice, bob } = world();
  // the shared ledger withdraws eu-west-9 for eu-west-1 at t2; alice revises that correction properly, bob records something else
  branchWith(alice, "alice", (e) => e.remember("region-move", "region-is-central", "--kind", "correction", "--note", "the region moved again", "--withdrawn", "eu-west-9", "--withdrawn", "eu-west-1", "--replacement", "eu-central-1", "--supersedes", "2"));
  branchWith(bob, "bob", (e) => e.correct("api-review", "v1-endpoint", "v2-endpoint"));
  const m = merge(bob, "origin/alice");
  assert.equal(m.status, 0, `a superseded correction is settled, not a conflict:\n${out(m)}`);
  const carried = bob.rows().find((r) => r.cause === "region-move");
  assert.deepEqual(carried.supersedes, [2], "supersedes still names the shared row");
  assert.equal(bob.rows().find((r) => r.cause === "state-merged").state.conflicts.length, 1, "state merge's own note keeps what it saw");
  assert.ok(bob.blocked("deploy to eu-west-1") && !bob.blocked("moved from eu-west-1 to eu-central-1"));
  assert.equal(bob.mp(["verify"]).status, 0);
});

test("a real conflict stops the merge: both rows are named with the command that settles it, and the ledger left behind verifies", () => {
  const { alice, bob } = world();
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  branchWith(bob, "bob", (e) => e.correct("pricing-call", "$49", "$39"));
  const m = merge(bob, "origin/alice");
  assert.notEqual(m.status, 0, `two corrections withdraw "$49" with different replacements: the merge must stop\n${out(m)}`);
  assert.match(out(m), /conflict: "\$49" is withdrawn at t3 \(ours\) and at t4 \(carried from origin\/alice t3\) with different replacements/);
  assert.match(out(m), /memory-pulse remember .*--supersedes 3 --supersedes 4/);
  assert.match(out(m), /git add \.memory-pulse\/events\.jsonl/);
  assert.match(bob.git("status", "--porcelain").stdout, /^UU \.memory-pulse\/events\.jsonl$/m, "git keeps the path unmerged until a person decides");
  noMarkers(bob);
  assert.ok(verifyChainLines(bob.lines()).ok, "what is left in the working tree is a ledger that verifies");
  assert.ok(bob.rows().some((r) => r.cause === "pricing-review") && bob.rows().some((r) => r.cause === "pricing-call"), "both corrections are on the record; neither was dropped");
  // the decision is a row, then git is told the path is settled
  bob.remember("pricing-settled", "price-is-29", "--kind", "correction", "--note", "29 stands", "--withdrawn", "$49", "--withdrawn", "$39", "--replacement", "$29", "--supersedes", "3", "--supersedes", "4");
  ok(bob.git("add", LEDGER), "git add"); ok(bob.git("commit", "-q", "--no-edit"), "commit the merge");
  assert.equal(bob.mp(["verify"]).status, 0);
  assert.ok(bob.blocked("the plan costs $39 a month") && !bob.blocked("was $49, now $29"));
});

test("one side replaces a value the other side withdraws: the crossing is named and the merge stops", () => {
  const { alice, bob } = world();
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  branchWith(bob, "bob", (e) => e.correct("pricing-call", "$29", "$49"));
  const m = merge(bob, "origin/alice");
  assert.notEqual(m.status, 0, out(m));
  assert.match(out(m), /conflict: t3 \(ours\) replaces "\$29" with "\$49" and t4 \(carried from origin\/alice t3\) withdraws "\$49"/);
  assert.match(out(m), /--supersedes 3 --supersedes 4/);
  noMarkers(bob); assert.ok(verifyChainLines(bob.lines()).ok);
});

test("history rewritten on one side is refused with the reason, ours is left as it was, and the way on is named", () => {
  const f = files("rewritten");
  for (const [cause, effect] of [["a", "one"], ["b", "two"], ["c", "three"]]) f.write("base.jsonl", cause, effect, "--note", `${cause} happened`);
  copyFileSync(f.at("base.jsonl"), f.at("ours.jsonl")); f.write("ours.jsonl", "ours-new", "four", "--note", "ours went on");
  // theirs dropped the ancestor's last row and wrote on: its own chain verifies, the ancestor's row t=3 is gone
  writeFileSync(f.at("theirs.jsonl"), f.read("base.jsonl").split("\n").slice(0, 2).join("\n") + "\n"); f.write("theirs.jsonl", "theirs-new", "other", "--note", "theirs went on");
  assert.ok(verifyChainLines(f.read("theirs.jsonl").split("\n")).ok, "the rewritten side verifies on its own");
  const before = f.read("ours.jsonl");
  const r = f.driver("base.jsonl", "ours.jsonl", "theirs.jsonl", LEDGER);
  assert.equal(r.status, 2, out(r));
  assert.match(r.stderr, /refused, nothing merged: theirs no longer holds row t=3 of the common ancestor/);
  assert.match(r.stderr, /history was rewritten/);
  assert.match(r.stderr, /git add \.memory-pulse\/events\.jsonl/); assert.match(r.stderr, /memory-pulse team resolve --no-ancestor/);
  assert.equal(f.read("ours.jsonl"), before, "ours is untouched");
  // a side whose own chain is broken is refused too
  writeFileSync(f.at("broken.jsonl"), f.read("base.jsonl").replace("b happened", "b never happened"));
  const b = f.driver("base.jsonl", "ours.jsonl", "broken.jsonl", LEDGER);
  assert.equal(b.status, 2, out(b)); assert.match(b.stderr, /refused, nothing merged: theirs/); assert.match(b.stderr, /row chain/);
  assert.equal(f.read("ours.jsonl"), before);
  const u = f.driver("base.jsonl");
  assert.equal(u.status, 2); assert.match(u.stderr, /usage: memory-pulse merge-driver <base> <ours> <theirs> \[<path>\]/);
});

test("the refusal through git: the path stays unmerged with ours in the working tree; team resolve repeats it, and --no-ancestor carries the rows", () => {
  const dir = mkdtempSync(join(TMP, "refuse-")), e = engineer("hal", dir);
  ok(e.git("init", "-q", "-b", "main"), "init");
  for (const [cause, effect] of [["a", "one"], ["b", "two"], ["c", "three"]]) e.remember(cause, effect, "--note", `${cause} happened`);
  e.mp(["team", "setup"]); e.commit("base");
  ok(e.git("checkout", "-q", "-b", "theirs"), "theirs");
  writeFileSync(e.file(), e.text().split("\n").slice(0, 2).join("\n") + "\n"); e.remember("theirs-new", "other", "--note", "theirs went on"); e.commit("theirs: dropped a row and went on");
  ok(e.git("checkout", "-q", "-b", "ours", "main"), "ours"); e.remember("ours-new", "four", "--note", "ours went on"); e.commit("ours: went on");
  const before = e.text();
  const m = e.git("merge", "--no-edit", "-m", "merge theirs", "theirs");
  assert.notEqual(m.status, 0, out(m));
  assert.match(out(m), /refused, nothing merged: theirs no longer holds row t=3 of the common ancestor/);
  assert.match(e.git("status", "--porcelain").stdout, /^UU \.memory-pulse\/events\.jsonl$/m);
  assert.equal(e.text(), before, "the working tree holds ours, unchanged");
  const again = e.mp(["team", "resolve"]);
  assert.equal(again.status, 2, out(again)); assert.match(out(again), /history was rewritten/);
  const forced = e.mp(["team", "resolve", "--no-ancestor"]);
  assert.equal(forced.status, 0, out(forced));
  assert.ok(e.text().startsWith(before)); assert.ok(verifyChainLines(e.lines()).ok);
  assert.equal(e.rows().filter((r) => r.cause === "theirs-new").length, 1, "the other side's row is carried");
  assert.equal(e.rows().filter((r) => r.cause === "c").length, 1, "and the row it dropped is still here");
  assert.match(e.git("status", "--porcelain").stdout, /^M  \.memory-pulse\/events\.jsonl$/m);
  // a ledger that is already merged in the working tree is not merged over
  const twice = e.mp(["team", "resolve"]);
  assert.equal(twice.status, 0, out(twice)); assert.match(out(twice), /nothing to resolve/);
});

test("a fast-forward runs no driver: a teammate's new rows are named as written elsewhere and accepted; rows of one's own that come back re-appended need the accept step verify names", () => {
  const { alice, bob, carol } = world(["alice", "bob", "carol"]);
  assert.equal(carol.mp(["verify"]).status, 0, "carol's anchor starts at the shared rows");
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  branchWith(bob, "bob", (e) => e.correct("api-review", "v1-endpoint", "v2-endpoint"));
  // carol recorded nothing: alice's row arrives by fast-forward, as alice's writer wrote it
  const cf = merge(carol, "origin/alice");
  assert.equal(cf.status, 0, out(cf)); assert.match(out(cf), /Fast-forward/);
  const cv = carol.mp(["verify"]);
  assert.equal(cv.status, 0, out(cv)); assert.match(cv.stdout, /anchor: OK/);
  assert.match(cv.stdout, /writer marks: 1 row\(s\) since this machine's anchor started carry no mark from this machine's writer/); assert.match(cv.stdout, /accepted/);
  assert.equal(carol.mp(["verify", "--strict"]).status, 2, "--strict refuses a row another machine wrote");
  assert.ok(carol.blocked("the plan costs $49 a month"), "and the correction binds on carol's machine");

  writeFileSync(alice.file(".memory-pulse/seal.rain"), JSON.stringify({ head: setHeadHex(alice.rows()), through: 3, events: 3 }));
  ok(merge(bob, "origin/alice"), "bob merges alice"); ok(bob.git("push", "-q", "origin", "bob"), "push");
  const ff = merge(alice, "origin/bob");
  assert.equal(ff.status, 0, out(ff)); assert.match(out(ff), /Fast-forward/);
  assert.equal(alice.text(), bob.text(), "alice now holds bob's file: his rows first, hers re-appended");
  const v = alice.mp(["verify"]);
  assert.equal(v.status, 2, out(v));
  assert.match(v.stdout, /chain: OK/); assert.match(v.stdout, /seal: MISMATCH/); assert.match(v.stdout, /anchor: ROLLED BACK/); assert.match(v.stdout, /memory-pulse anchor accept "<why>"/);
  ok(alice.mp(["anchor", "accept", "fast-forwarded onto bob's merge of my branch"]), "anchor accept");
  ok(alice.mp(["seal", "accept", "fast-forwarded onto bob's merge of my branch"]), "seal accept");
  assert.equal(alice.mp(["verify"]).status, 0);
  assert.ok(alice.blocked("the plan costs $49 a month") && alice.blocked("call the v1-endpoint"));
});
