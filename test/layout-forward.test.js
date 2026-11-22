// A client that meets a ledger layout it cannot read says so, everywhere, and never enforces nothing in silence.
// 0.19.0 reads one layout, the chain in events.jsonl. A later release may store the ledger differently and will mark it with
// .memory-pulse/layout.json. A project that has moved, opened by an engineer still on this client, would otherwise look like a
// project with no corrections: the guard would pass every edit without a word. Added 2026-11-22 before 0.19.0 shipped (red first).
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
function project(layout) {
  const dir = mkdtempSync(join(tmpdir(), "mp-layout-")), home = mkdtempSync(join(tmpdir(), "mp-layout-home-"));
  mkdirSync(join(dir, ".memory-pulse"));
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), JSON.stringify({ t: 1, cause: "pricing-shipped", effect: "price-corrected", kind: "correction", withdrawn: ["$49"], replacement: ["$29"] }) + "\n");
  if (layout !== undefined) writeFileSync(join(dir, ".memory-pulse", "layout.json"), typeof layout === "string" ? layout : JSON.stringify(layout));
  const env = { ...process.env, HOME: home, MEMORY_PULSE_TRUST_DIR: join(home, "trust"), MEMORY_PULSE_DATA_DIR: join(home, "data") };
  for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_KEY", "MP_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_BOARD", "NODE_TEST_CONTEXT"]) delete env[k];
  const run = (args, input) => spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env, encoding: "utf8", input });
  const edit = (content) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(dir, "pricing.md"), content } });
  return { dir, run, edit };
}
const SET = { layout: "set", version: 1 };
const SAYS = /cannot read this project's ledger/;

test("the guard says on every edit that it cannot read the ledger, to the person and to the agent, and does not block", () => {
  const p = project(SET);
  const r = p.run(["guard"], p.edit("Pro is $49 a month.\n"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, SAYS); assert.match(r.stderr, /layout "set"/); assert.match(r.stderr, /Nothing in it is being enforced/);
  assert.match(r.stderr, /npm i -g memory-pulse@latest/);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, SAYS, "the agent is told too");
});

test("check fails, and check --json gives the verdict unreadable, so a pull request cannot pass on a ledger this client cannot read", () => {
  const p = project(SET);
  const plain = p.run(["check", "--ci", "--text", "Pro is $29 a month."]);
  assert.notEqual(plain.status, 0); assert.match(plain.stdout + plain.stderr, SAYS);
  const j = p.run(["check", "--ci", "--json", "--text", "Pro is $29 a month."]);
  assert.notEqual(j.status, 0);
  const out = JSON.parse(j.stdout);
  assert.equal(out.verdict, "unreadable"); assert.match(out.reasons[0], SAYS);
  assert.notEqual(p.run(["lint", "--ci"]).status, 0, "lint --ci fails the same way");
});

test("the brief opens with it, and doctor fails with the upgrade as the fix", () => {
  const p = project(SET);
  const brief = p.run(["brief", "--offline"]);
  assert.match(brief.stdout.split("\n")[0], SAYS);
  const d = JSON.parse(p.run(["doctor", "--json", "--offline"]).stdout);
  const k = d.checks.find((c) => c.id === "layout");
  assert.ok(k, JSON.stringify(d.checks.map((c) => c.id)));
  assert.equal(k.status, "fail"); assert.match(k.fix, /npm i -g memory-pulse@latest/);
});

test("with no marker, or the layout this client reads, nothing changes", () => {
  for (const layout of [undefined, { layout: "chain", version: 1 }]) {
    const p = project(layout);
    const blocked = p.run(["guard"], p.edit("Pro is $49 a month.\n"));
    assert.equal(blocked.status, 2, `${JSON.stringify(layout)}: ${blocked.stderr}`);
    assert.doesNotMatch(blocked.stderr, SAYS);
    assert.equal(p.run(["check", "--ci", "--text", "Pro is $29 a month."]).status, 0);
  }
});

test("a marker that is not JSON is treated as a layout this client cannot read, not as absent", () => {
  const p = project("not json at all");
  const r = p.run(["guard"], p.edit("Pro is $49 a month.\n"));
  assert.equal(r.status, 0); assert.match(r.stderr, SAYS);
});
