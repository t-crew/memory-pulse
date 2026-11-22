// A replacement that is part of the withdrawn value must not release it. Found 2026-11-21 while building `demo`: with "v2.1" corrected
// to "v2" (or "$49" to "$4"), every line that wrote the old value back also "contained" the new one, so the guard never blocked.
// The rule: a replacement releases the term on a line only where it stands outside a longer occurrence of the term.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bareTerm } from "../lib/release.mjs";
import { localCheck } from "../server.mjs";

test("a replacement inside the withdrawn value does not release it", () => {
  assert.equal(bareTerm("The client uses v2.1 of the API.", "v2.1", ["v2"]), true, "v2 inside v2.1 is not the replacement being used");
  assert.equal(bareTerm("Pro plan: $49 a month", "$49", ["$4"]), true);
  assert.equal(bareTerm("retries: 10", "10", ["1"]), true);
});

test("a comparison still passes when the replacement also stands on its own on the line", () => {
  assert.equal(bareTerm("Moved from v2.1 to v2 in March.", "v2.1", ["v2"]), false);
  assert.equal(bareTerm("was $49, now $4", "$49", ["$4"]), false);
});

test("a replacement that contains the withdrawn value still releases it", () => {
  // "fetch" corrected to "fetchWithAuth": a line that calls fetchWithAuth is the correction being followed
  assert.equal(bareTerm("const r = await fetchWithAuth(url);", "fetch", ["fetchWithAuth"]), false);
  assert.equal(bareTerm("const r = await fetch(url);", "fetch", ["fetchWithAuth"]), true);
});

test("the guard's check blocks v2.1 written back when the correction is v2.1 to v2, and passes v2", () => {
  const events = [{ t: 1, cause: "api-moved", effect: "version-corrected", kind: "correction", withdrawn: ["v2.1"], replacement: ["v2"] }];
  assert.equal(localCheck(events, { text: "The client uses v2.1 of the API." }, [], { blockOnly: true }).verdict, "blocked");
  assert.notEqual(localCheck(events, { text: "The client uses v2 of the API." }, [], { blockOnly: true }).verdict, "blocked");
  assert.notEqual(localCheck(events, { text: "Moved from v2.1 to v2 in March." }, [], { blockOnly: true }).verdict, "blocked");
});

test("the Python client's check follows the same rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-substr-py-")); const PYDIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "python");
  const r = spawnSync("python3", ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PYDIR)})
from memory_pulse import Ledger
L = Ledger(${JSON.stringify(join(dir, "events.jsonl"))})
L.append("api-moved", "version-corrected", kind="correction", withdrawn=["v2.1"], replacement=["v2"])
print(json.dumps([L.check("The client uses v2.1 of the API.")["verdict"], L.check("Moved from v2.1 to v2 in March.")["verdict"], L.check("The client uses v2 of the API.")["verdict"]]))
`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [back, comparison, replaced] = JSON.parse(r.stdout.trim());
  assert.equal(back, "blocked"); assert.notEqual(comparison, "blocked"); assert.notEqual(replaced, "blocked");
});
