// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
// Pre-release review of 0.16.0 (2026-10-23), two defects worth fixing before the tag:
//   1. a rollback by swapping the ledger folder for a symlink to an older copy passed verify (the anchor was keyed by the
//      folder's realpath, so the swap started a fresh anchor);
//   2. the guard refused the way out it prints, `MEMORY_PULSE_LEDGER=<path> memory-pulse anchor accept "<why>"`, whenever the
//      reason contained ->, >, cp, rm, mv or install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");

function mk(label) {
  const cwd = mkdtempSync(join(tmpdir(), `mp-review016-${label}-`));
  const ledger = join(cwd, ".memory-pulse", "events.jsonl"), trust = join(cwd, "trust");
  const env = { ...process.env, HOME: join(cwd, "home"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_AGENT: join(cwd, "home", ".memory-pulse", "agent", "events.jsonl"), MEMORY_PULSE_LEDGER: ledger, MEMORY_PULSE_TRUST_DIR: trust, MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_SETTINGS_DIR: join(cwd, "settings"), NO_COLOR: "1" };
  const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" });
  const remember = (cause, effect) => { const r = run(["remember", cause, effect, "--note", `${cause} ${effect}`]); assert.equal(r.status, 0, r.stderr + r.stdout); };
  return { cwd, ledger, run, remember };
}
const bashHook = (command) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, description: "x" } });

function rolledBack(label) {
  const t = mk(label);
  for (let i = 1; i <= 3; i++) t.remember(`c${i}`, `e${i}`);
  const older = join(t.cwd, "elsewhere"); mkdirSync(older); copyFileSync(t.ledger, join(older, "events.jsonl"));
  for (let i = 4; i <= 6; i++) t.remember(`c${i}`, `e${i}`);
  assert.equal(t.run(["verify"]).status, 0);
  return { ...t, older };
}

test("review 1: swapping the ledger folder for a symlink to an older copy is a rollback, not a fresh start", () => {
  const { cwd, run, older } = rolledBack("symlink");
  const dir = join(cwd, ".memory-pulse");
  renameSync(dir, `${dir}.real`); symlinkSync(older, dir);
  const v = run(["verify"]);
  assert.equal(v.status, 2, `verify must fail when the folder now points at an older copy:\n${v.stdout}${v.stderr}`);
  assert.match(v.stdout, /anchor: ROLLED BACK/);
});

test("review 2: the guard lets through the anchor accept it prints, whatever the reason says", () => {
  const { ledger, run, older } = rolledBack("accept");
  copyFileSync(join(older, "events.jsonl"), ledger); // in question: rolled back
  assert.equal(run(["verify"]).status, 2);
  for (const why of ["restored -> trusted", "cp from backup, checked", "rm'd nothing > fine", "mv'd back after install"]) {
    for (const cmd of [`MEMORY_PULSE_LEDGER=${ledger} memory-pulse anchor accept "${why.replace(/'/g, "")}"`, `memory-pulse anchor accept '${why.replace(/'/g, "")}'`]) {
      const g = run(["guard"], bashHook(cmd));
      assert.equal(g.status, 0, `blocked the printed way out: ${cmd}\n${g.stderr}`);
    }
  }
});

test("review 2: anything chained to anchor accept, or a reason that runs a command, is still judged as a write", () => {
  const { ledger, run, older } = rolledBack("chained");
  copyFileSync(join(older, "events.jsonl"), ledger);
  for (const cmd of [
    `MEMORY_PULSE_LEDGER=${ledger} memory-pulse anchor accept "ok" && rm ${ledger}`,
    `memory-pulse anchor accept "ok"; cp /tmp/x ${ledger}`,
    `memory-pulse anchor accept "$(rm ${ledger})"`,
    `memory-pulse anchor accept "\`cp /tmp/x ${ledger}\`"`,
    `memory-pulse anchor accept "ok" > ${ledger}`,
  ]) {
    const g = run(["guard"], bashHook(cmd));
    assert.equal(g.status, 2, `must stay blocked: ${cmd}\n${g.stderr}`);
  }
});
