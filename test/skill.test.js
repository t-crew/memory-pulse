// SKILL.md is the surface the model reads every session. It went stale in three places (heredocs, the block
// string, a duplicated section number); these assertions keep it on the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prose, BANNED } from "./_helpers.mjs";

const SKILL = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "skills", "memory-pulse", "SKILL.md"), "utf8");

test("sections are numbered 1..8 once each, in order", () => {
  const nums = [...SKILL.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8]);
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
