// An overheard bare number is not enforced. Second review, 2026-11-22 (N-G2): a number that capture recorded by itself ("48")
// bound like any term, and 48 stands in 10.3% of a 3,000-file sample, the same fault as the ordinary word (merge, 6.1%) that
// 0.17.1 stopped enforcing. A number a person records on purpose still binds, and a number with a unit or a symbol ($49, v2.1,
// 48 tests) is specific.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSpecificTerm } from "../lib/specific.mjs";
import { advisoryTerm } from "../lib/advisory.mjs";
import { localCheck } from "../server.mjs";

test("a bare number is not specific; a number with a unit, a symbol or a word is", () => {
  for (const t of ["48", "6144", "0.030", "6,144", "1.5"]) assert.equal(isSpecificTerm(t), false, t);
  for (const t of ["$49", "v2.1", "48 tests", "3/11", "n=14", "49%", "us-east-1", "0.18.0"]) assert.equal(isSpecificTerm(t), true, t);
});

test("an ambient row's bare number is advisory; a person's is not", () => {
  assert.equal(advisoryTerm({ tags: ["ambient"] }, "48"), true);
  assert.equal(advisoryTerm({ cause: "user-correction-48" }, "48"), true, "a cached row is known by the cause capture writes");
  assert.equal(advisoryTerm({ tags: [] , cause: "counted-again" }, "48"), false);
  assert.equal(advisoryTerm({ tags: ["ambient"] }, "$49"), false);
});

test("the guard's check passes an edit holding a number capture overheard, and blocks one a person withdrew", () => {
  const overheard = [{ t: 1, cause: "user-correction-48", effect: "48-withdrawn-for-52", kind: "correction", tags: ["ambient", "is-not"], withdrawn: ["48"], replacement: ["52"] }];
  assert.notEqual(localCheck(overheard, { text: "The suite has 48 cases." }, [], { blockOnly: true }).verdict, "blocked");
  const deliberate = [{ t: 1, cause: "suite-counted", effect: "count-corrected", kind: "correction", withdrawn: ["48"], replacement: ["52"] }];
  assert.equal(localCheck(deliberate, { text: "The suite has 48 cases." }, [], { blockOnly: true }).verdict, "blocked");
});
