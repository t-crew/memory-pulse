// A rule scoped with `paths` must fire when the editor names the file by its absolute path. Claude Code sends absolute paths, and
// 0.18.0 compared the raw path with the prefix, so a rule scoped to "docs/" never fired in that guard (measured 2026-11-21: exit 0
// on the absolute path, exit 2 on the relative one).
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
function project() {
  const dir = mkdtempSync(join(tmpdir(), "mp-scope-")), home = mkdtempSync(join(tmpdir(), "mp-scope-home-"));
  mkdirSync(join(dir, ".memory-pulse")); mkdirSync(join(dir, "docs")); mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, ".memory-pulse", "invariants.jsonl"), JSON.stringify({ id: "no-foobar", statement: "FOOBAR is not written in docs", patterns: ["FOOBAR"], paths: ["docs/"], severity: "block" }) + "\n");
  const env = { ...process.env, HOME: home, MEMORY_PULSE_TRUST_DIR: join(home, "trust"), MEMORY_PULSE_DATA_DIR: join(home, "data") };
  for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_KEY", "MP_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_BOARD"]) delete env[k];
  const guard = (file_path, content = "FOOBAR here") => spawnSync(process.execPath, [SERVER, "guard"], { cwd: dir, env, encoding: "utf8", input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path, content } }) });
  return { dir, guard };
}

test("a rule scoped to docs/ blocks an edit named by its absolute path under docs/", () => {
  const p = project();
  const r = p.guard(join(p.dir, "docs", "a.md"));
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no-foobar/);
});

test("the same rule still blocks the relative path, and leaves files outside docs/ alone whichever way they are named", () => {
  const p = project();
  assert.equal(p.guard("docs/a.md").status, 2);
  assert.equal(p.guard(join(p.dir, "src", "a.md")).status, 0);
  assert.equal(p.guard("src/a.md").status, 0);
  assert.equal(p.guard(join(p.dir, "src", "docs", "a.md")).status, 0, "docs/ is a prefix of the project-relative path, not a folder name anywhere in it");
  assert.equal(p.guard(join(p.dir, "docs", "a.md"), "nothing to see").status, 0);
});
