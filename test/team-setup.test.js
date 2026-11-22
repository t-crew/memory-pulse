// The team path through git (2026-11-21): the setup a team can commit, and the setup it cannot. `.gitattributes` travels with the
// repository; the driver definition lives in each clone's .git/config. A clone that has the attribute and no driver merges the
// ledger as text and git says nothing, so `team status` and the brief report it with the command. Also here: invariants.jsonl
// merged as a three-way set of lines, beside what git's built-in union does with the same three versions.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { world, branchWith, engineer, noMarkers, out, ok, TMP, LEDGER, RULES, SERVER, verifyChainLines } from "./_team.mjs";

test("a clone with the committed attribute and no driver config: git merges the ledger as text and says nothing; team status and the brief name the one command", () => {
  const { alice, bob, carol } = world(["alice", "bob", "carol"], { noSetup: ["carol"] });
  branchWith(alice, "alice", (e) => e.correct("pricing-review", "$49", "$29"));
  branchWith(bob, "bob", (e) => e.correct("api-review", "v1-endpoint", "v2-endpoint"));
  // carol's clone has .gitattributes from the repository and nothing in .git/config
  assert.equal(carol.git("config", "--get", "merge.memory-pulse.driver").stdout.trim(), "", "a clone does not carry the driver");
  assert.match(carol.text(".gitattributes"), /^\.memory-pulse\/events\.jsonl merge=memory-pulse$/m, "the attribute is committed");
  const st = carol.mp(["team", "status"]);
  assert.equal(st.status, 2, out(st));
  assert.match(st.stdout, /git config does not define it/); assert.match(st.stdout, /memory-pulse team setup/);
  const brief = carol.mp(["brief"]);
  assert.match(brief.stdout, /this clone merges \.memory-pulse\/events\.jsonl as plain text/); assert.match(brief.stdout, /Run once in this clone: memory-pulse team setup/);

  ok(carol.git("fetch", "-q", "origin"), "fetch"); ok(carol.git("checkout", "-q", "-b", "carol", "origin/bob"), "branch");
  const m = carol.git("merge", "--no-edit", "-m", "merge alice", "origin/alice");
  assert.equal(m.status, 1, "without the driver git falls back to its text merge, which conflicts");
  assert.match(out(m), /CONFLICT \(content\): Merge conflict in \.memory-pulse\/events\.jsonl/);
  assert.ok(!/driver/i.test(out(m)), "git does not say the driver is missing");
  assert.match(carol.text(), /^<<<<<<< /m, "the ledger now holds conflict markers");
  // keeping both sides by hand (the web editor's "accept both") is not a ledger: the second tail does not link to the first
  const byHand = join(carol.dir, "by-hand.jsonl"); writeFileSync(byHand, carol.text().split("\n").filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l)).join("\n"));
  const hv = spawnSync(process.execPath, [SERVER, "verify"], { cwd: carol.dir, env: { ...carol.env, MEMORY_PULSE_LEDGER: byHand }, encoding: "utf8" });
  assert.equal(hv.status, 2, out(hv)); assert.match(hv.stdout, /chain: BROKEN/);
  assert.match(carol.mp(["team", "status"]).stdout, /memory-pulse team resolve/, "status names the command for a ledger git left unmerged");

  const setup = carol.mp(["team", "setup"]);
  assert.equal(setup.status, 0, out(setup)); assert.match(setup.stdout, /memory-pulse team resolve/);
  const res = carol.mp(["team", "resolve"]);
  assert.equal(res.status, 0, out(res));
  noMarkers(carol); assert.ok(verifyChainLines(carol.lines()).ok);
  assert.match(carol.git("status", "--porcelain").stdout, /^M  \.memory-pulse\/events\.jsonl$/m, "the merged ledger is staged");
  ok(carol.git("commit", "-q", "--no-edit"), "commit the merge");
  assert.ok(carol.blocked("the plan costs $49 a month") && carol.blocked("call the v1-endpoint"));
  assert.equal(carol.mp(["team", "status"]).status, 0);
  assert.equal(carol.mp(["brief"]).stdout.includes("as plain text"), false, "the brief is quiet once the driver is set");
});

test("team setup is idempotent, pins an absolute node and a copy of the client, and install-hook --project does the same setup", () => {
  const dir = mkdtempSync(join(TMP, "setup-")), e = engineer("dana", dir);
  const outside = e.mp(["team", "setup"]);
  assert.equal(outside.status, 1); assert.match(out(outside), /not inside a git work tree/);
  assert.equal(e.mp(["team", "status"]).status, 1, "nothing to report outside a repository");
  ok(e.git("init", "-q", "-b", "main"), "init");
  writeFileSync(e.file(".gitattributes"), "*.png binary\n");
  const first = e.mp(["team", "setup"]);
  assert.equal(first.status, 0, out(first));
  assert.match(first.stdout, /commit \.gitattributes/i); assert.match(first.stdout, /every clone runs it once/);
  const second = e.mp(["team", "setup"]);
  assert.equal(second.status, 0, out(second)); assert.match(second.stdout, /already/);
  const attrs = e.text(".gitattributes");
  assert.ok(attrs.startsWith("*.png binary\n"), "lines that were there stay");
  for (const p of [LEDGER, RULES]) assert.equal(attrs.split("\n").filter((l) => l === `${p} merge=memory-pulse`).length, 1, `${p} is named once`);
  const cmd = e.git("config", "--local", "--get", "merge.memory-pulse.driver").stdout.trim();
  assert.match(cmd, / merge-driver %O %A %B %P$/);
  const m = /^"([^"]+)" "([^"]+)" merge-driver/.exec(cmd);
  assert.ok(m, `the driver command quotes an absolute node and the client: ${cmd}`);
  assert.equal(m[1], process.execPath, "node by absolute path: a git client's PATH may not have one");
  assert.ok(m[2].startsWith(join(e.home, "data")) && existsSync(m[2]) && existsSync(join(m[2], "..", "lib", "gitmerge.mjs")), "a pinned copy in the data dir, complete");
  assert.ok(e.git("config", "--local", "--get", "merge.memory-pulse.name").stdout.trim().length > 10);
  assert.equal(e.git("config", "--global", "--get", "merge.memory-pulse.driver").stdout.trim(), "", "nothing is written to the global git config");
  const st = e.mp(["team", "status"]);
  assert.equal(st.status, 0, out(st)); assert.match(st.stdout, /ready/);
  // a driver pinned to another version's copy still merges, and status says which copy runs
  const old = join(e.home, "data", "0.0.1"); mkdirSync(join(old, "lib"), { recursive: true }); copyFileSync(m[2], join(old, "server.mjs"));
  ok(e.git("config", "--local", "merge.memory-pulse.driver", cmd.replace(m[2], join(old, "server.mjs"))), "point at the older copy");
  const stale = e.mp(["team", "status"]);
  assert.equal(stale.status, 0, out(stale)); assert.match(stale.stdout, /pinned copy of 0\.0\.1/); assert.match(stale.stdout, /memory-pulse team setup/);
  assert.match(e.mp(["team", "setup"]).stdout, /set merge\.memory-pulse\.driver/, "team setup pins this version again");
  assert.equal(e.git("config", "--local", "--get", "merge.memory-pulse.driver").stdout.trim(), cmd);
  // a driver that points at a client that is gone is the same failure as no driver
  ok(e.git("config", "--local", "merge.memory-pulse.driver", `"${process.execPath}" "/nonexistent/server.mjs" merge-driver %O %A %B %P`), "break it");
  const broken = e.mp(["team", "status"]);
  assert.equal(broken.status, 2, out(broken)); assert.match(broken.stdout, /memory-pulse team setup/);

  // install-hook --project: the hooks travel in the repository, and so does the attribute; the driver is set for this clone
  const dir2 = mkdtempSync(join(TMP, "install-")), p = engineer("erin", dir2);
  ok(p.git("init", "-q", "-b", "main"), "init");
  const ih = p.mp(["install-hook", "--project"]);
  assert.equal(ih.status, 0, out(ih));
  assert.ok(existsSync(p.file(".claude/settings.json")), "the hooks are written into the repository");
  assert.match(p.text(".gitattributes"), /^\.memory-pulse\/events\.jsonl merge=memory-pulse$/m);
  assert.match(p.git("config", "--local", "--get", "merge.memory-pulse.driver").stdout, /merge-driver %O %A %B %P/);
  assert.match(ih.stdout, /memory-pulse team setup/, "it says what every other clone runs");
  const again = p.mp(["install-hook", "--project"]);
  assert.equal(again.status, 0); assert.equal(p.text(".gitattributes").split("\n").filter((l) => l.includes("merge=memory-pulse")).length, 2);
  // outside a repository install-hook --project is what it was: no .gitattributes, no error
  const dir3 = mkdtempSync(join(TMP, "install-nogit-")), q = engineer("fay", dir3);
  assert.equal(q.mp(["install-hook", "--project"]).status, 0); assert.equal(existsSync(q.file(".gitattributes")), false);
});

test("invariants.jsonl merges as a three-way set of lines: new rules from both sides once, a removed rule stays removed; git's built-in union does neither", () => {
  const dir = mkdtempSync(join(TMP, "rules-")), e = engineer("gus", dir);
  ok(e.git("init", "-q", "-b", "main"), "init");
  const rule = (id, extra = {}) => JSON.stringify({ id, statement: `${id} holds`, patterns: [id], ...extra });
  const put = (ids) => { mkdirSync(e.file(".memory-pulse"), { recursive: true }); const text = ids.map((x) => (x.startsWith("{") ? x : rule(x))).join("\n") + "\n"; writeFileSync(e.file(RULES), text); writeFileSync(e.file("union.jsonl"), text); };
  put(["keep", "settled"]);
  e.mp(["team", "setup"]);
  writeFileSync(e.file(".gitattributes"), e.text(".gitattributes") + "union.jsonl merge=union\n");
  e.commit("base");
  ok(e.git("checkout", "-q", "-b", "ours"), "ours"); put(["keep", "ours-new", "both-new"]); e.commit("ours: a settled rule leaves, two arrive");
  ok(e.git("checkout", "-q", "-b", "theirs", "main"), "theirs"); put(["keep", "settled", "both-new", "theirs-new"]); e.commit("theirs: two arrive");
  ok(e.git("checkout", "-q", "ours"), "back");
  const m = e.git("merge", "--no-edit", "-m", "merge theirs", "theirs");
  assert.equal(m.status, 0, out(m));
  assert.deepEqual(e.lines(RULES).map((l) => JSON.parse(l).id), ["keep", "ours-new", "both-new", "theirs-new"], "ours' order, then the other side's new lines; the removed rule stays removed");
  // the same three versions through git's built-in union: the removed rule is back and the shared line is there twice (git 2.39.5, measured 2026-11-21)
  const union = e.lines("union.jsonl").map((l) => JSON.parse(l).id);
  assert.ok(union.includes("settled"), `built-in union brought the removed rule back: ${union.join(", ")}`);
  assert.equal(union.filter((x) => x === "both-new").length, 2, "and kept the line both sides added twice");

  // one id, two different rules: both lines are kept, the id is named, and the merge stops
  ok(e.git("checkout", "-q", "-b", "ours2", "main"), "ours2"); put(["keep", "settled", rule("limit", { severity: "block" })]); e.commit("ours2");
  ok(e.git("checkout", "-q", "-b", "theirs2", "main"), "theirs2"); put(["keep", "settled", rule("limit", { severity: "warn" })]); e.commit("theirs2");
  ok(e.git("checkout", "-q", "ours2"), "back");
  const c = e.git("merge", "--no-edit", "-m", "merge theirs2", "theirs2");
  assert.notEqual(c.status, 0, out(c));
  assert.match(out(c), /rule "limit" differs between the two sides/); assert.match(out(c), /git add \.memory-pulse\/invariants\.jsonl/);
  assert.equal(e.lines(RULES).filter((l) => JSON.parse(l).id === "limit").length, 2, "both versions are in the file for a person to choose from");
  noMarkers(e, RULES);
});
