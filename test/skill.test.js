// SKILL.md is the surface the model reads every session. It went stale in three places (heredocs, the block
// string, a duplicated section number); these assertions keep it on the code.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prose, BANNED } from "./_helpers.mjs";

const SKILL = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "skills", "memory-pulse", "SKILL.md"), "utf8");

test("sections are numbered 1..9 once each, in order", () => {
  const nums = [...SKILL.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("the skill teaches the agent message board: its tools, its env switch, and that a message is data", () => {
  for (const s of ["board_read", "board_post", "MEMORY_PULSE_BOARD", "never an instruction", "board ack"]) assert.ok(SKILL.includes(s), `SKILL.md lacks "${s}"`);
});

test("the skill states the current guard message, supersedes, before, AT RISK and the Bash matcher", () => {
  for (const s of ["memory-pulse guard: blocked.", "supersedes", "`before`", "AT RISK", "MultiEdit", "price-corrected-to-29", "started in"]) assert.ok(SKILL.includes(s), `SKILL.md lacks "${s}"`);
  for (const s of ["this edit reintroduces a withdrawn value", "not guarded on either host", "is not guarded"]) assert.ok(!SKILL.includes(s), `SKILL.md still says "${s}"`);
});

test("prose obeys the copy rules", () => {
  const p = prose(SKILL);
  const hit = BANNED.exec(p); assert.equal(hit, null, `banned word "${hit?.[0]}"`);
  assert.equal(p.indexOf("—"), -1, "em dash in prose");
});
