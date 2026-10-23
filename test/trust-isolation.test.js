// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
// Every test file names a temp trust store (2026-10-22). Before release, the 0.16.0 code ran from a live checkout and the guard started
// anchors and a writer key in the machine's real store; a test that falls back to the default store would do the same on every
// `npm test`. This keeps a new test file from forgetting the line. An isolation run with HOME set to a sentinel and no
// MEMORY_PULSE_TRUST_DIR created no store under the sentinel or the real home (409/409).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL(".", import.meta.url));
test("every test file sets a temp MEMORY_PULSE_TRUST_DIR before anything runs", () => {
  const missing = readdirSync(DIR).filter((f) => f.endsWith(".test.js")).filter((f) => !/process\.env\.MEMORY_PULSE_TRUST_DIR \?\?= .*mkdtempSync/.test(readFileSync(join(DIR, f), "utf8")));
  assert.deepEqual(missing, []);
});
