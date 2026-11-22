// The first-run commands (demo, init, doctor) are named where a new reader looks first: the top of help's command list, the
// README's Install section before the routes, the top of docs/INSTALL.md and section 1 of the guide. The same pass corrects
// what the docs said about the hook command: since 0.16.1 a user-scope install-hook writes node on a pinned copy, and only a
// --project hook still runs through npx. Each timing in the docs says which of the two it measured.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fixture, ROOT } from "./_firstrun.mjs";
import { BANNED } from "./_helpers.mjs";

const README = readFileSync(join(ROOT, "README.md"), "utf8");
const INSTALL = readFileSync(join(ROOT, "docs", "INSTALL.md"), "utf8");
const GUIDE = readFileSync(join(ROOT, "docs", "GUIDE.md"), "utf8");

test("help lists demo, init and doctor first, with their flags and doctor's exit code", () => {
  const out = fixture().run(["help"]).out;
  const cmds = out.slice(out.indexOf("\nCommands\n")).split("\n").filter((l) => /^  [a-z]/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(cmds.slice(0, 4), ["demo", "init", "doctor", "serve"], "the first three commands a new reader sees");
  assert.match(out, /^  demo \[--withdrawn <old>\] \[--replacement <new>\] \[--text "<edit>"\] \[--json\]/m);
  assert.match(out, /^  init \[--yes\] \[--dry-run\] \[--project\] \[--offline\]/m);
  assert.match(out, /^  doctor \[--json\] \[--offline\]/m);
  assert.match(out.slice(out.indexOf("Exit codes:")), /doctor/, "the exit-code line names doctor");
});

test("README Install names the three commands before the routes and says which release brings them", () => {
  const install = README.slice(README.indexOf("## Install"), README.indexOf("### What each host runs"));
  const routes = install.indexOf("**One line, any shell.**");
  for (const c of ["demo", "init", "doctor"]) {
    const i = install.search(new RegExp(`^npx -y memory-pulse ${c}\\b`, "m"));
    assert.ok(i > 0 && i < routes, `"npx -y memory-pulse ${c}" is in Install before the routes`);
  }
  assert.ok(install.indexOf("npx -y memory-pulse demo") < install.indexOf("npx -y memory-pulse init") && install.indexOf("npx -y memory-pulse init") < install.indexOf("npx -y memory-pulse doctor"), "in the order a reader runs them");
  assert.match(install, /`demo`, `init` and `doctor` arrive in the release after \d+\.\d+\.\d+/);
});

test("README, INSTALL and GUIDE say what install-hook writes today: node on a pinned copy, npx only with --project", () => {
  for (const [name, doc] of [["README", README], ["GUIDE", GUIDE]]) {
    assert.ok(!/The hook command `install-hook` writes is `npx -y memory-pulse guard`/.test(doc), `${name} no longer says install-hook writes npx`);
    assert.ok(!doc.includes("`npx -y memory-pulse guard`, the command `install-hook` writes"), `${name} no longer says install-hook writes npx`);
    assert.ok(!doc.includes("edit the hook command to\n`memory-pulse guard`") && !doc.includes("edit the hook command to `memory-pulse guard`"), `${name} no longer tells the reader to edit the hook by hand`);
    assert.match(doc, /`node "<data dir>\/<version>\/server\.mjs" guard`/, `${name} shows the pinned form`);
    assert.match(doc, /`install-hook --project`[^.]*`npx -y memory-pulse guard`/, `${name} says --project keeps npx`);
    // each timing names its path and its date
    assert.match(doc, /pinned[^.]*\b\d\d ms\b[^.]*2026-11-21/, `${name} gives the pinned copy's time with its date`);
    assert.match(doc, /npx[^.]*0\.99 s warm and 1\.4 s cold[^.]*2026-10-16/, `${name} keeps the npx measurement with its date`);
  }
  assert.match(INSTALL, /`--project`[^.]*npx[^.]*about a second/, "INSTALL says a --project hook runs through npx and what that costs");
});

test("docs/INSTALL.md opens with the three commands before any host section", () => {
  const top = INSTALL.slice(0, INSTALL.indexOf("## Claude Code"));
  for (const c of ["demo", "init", "doctor"]) assert.match(top, new RegExp(`^npx -y memory-pulse@\\d+\\.\\d+\\.\\d+ ${c}\\b`, "m"), `${c} is at the top of INSTALL.md`);
  assert.match(top, /installs nothing/);
  assert.match(INSTALL.slice(INSTALL.indexOf("## Check that it works")), /`doctor`/, "the check section names doctor");
});

test("the guide's section 1 runs demo as an executed block and names init and doctor", () => {
  const s1 = GUIDE.slice(GUIDE.indexOf("## 1. Install"), GUIDE.indexOf("## 2. "));
  assert.match(s1, /```sh run\nnpx -y memory-pulse@\d+\.\d+\.\d+ demo\n```\n```text expect\n[\s\S]*?memory-pulse guard: blocked\.[\s\S]*?```/, "demo is a `sh run` block, so test/guide.test.js runs it");
  assert.match(s1, /memory-pulse@\d+\.\d+\.\d+ init\b/); assert.match(s1, /memory-pulse@\d+\.\d+\.\d+ doctor\b/);
  assert.ok(s1.indexOf("memory-pulse@") < s1.indexOf("Six routes"), "before the routes");
});

test("what the three commands print follows the copy rules: no exclamation marks, no banned words, no em dash of their own", () => {
  const f = fixture(); mkdirSync(join(f.home, ".claude"));
  const own = [f.run(["doctor"]).out, f.run(["init", "--dry-run"]).out, f.run(["init", "--yes"]).out,
    // demo quotes the guard's message line for line behind a bar; those lines are the guard's, the rest are demo's
    f.run(["demo"]).out.split("\n").filter((l) => !/^\s*\| /.test(l)).join("\n")].join("\n");
  assert.ok(own.length > 800, "the commands printed something");
  assert.equal(own.indexOf("—"), -1, `em dash near: ${own.slice(Math.max(0, own.indexOf("—") - 80), own.indexOf("—") + 40)}`);
  assert.doesNotMatch(own, /!(\s|$)/m);
  const hit = BANNED.exec(own); assert.equal(hit, null, `banned word "${hit?.[0]}"`);
  assert.doesNotMatch(own, /\b(simply|just|easily|seamless|powerful|robust|blazing|effortless)\b/i);
});
