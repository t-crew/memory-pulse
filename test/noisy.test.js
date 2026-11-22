/**
 * `report` and the brief's AT RISK block name a noisy rule (lib/specific.mjs).
 *
 * A correction is noisy when the guard blocked it NOISY_MIN_BLOCKS times or more, in NOISY_MIN_DIRS distinct directories
 * or more, and its term is one ordinary word (isSpecificTerm says no). On one real ledger the two noisiest rows were such
 * words: 85 blocks in 62 directories and 16 blocks in 14. The label gives the two ways out on one line: retire the row
 * with `remember ... --supersedes <t>`, or scope the term with `guard allow`.
 */
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
for (const k of ["MEMORY_PULSE_LEDGER", "MEMORY_PULSE_PROJECT", "MEMORY_PULSE_KEY", "MEMORY_PULSE_BOARD"]) delete process.env[k];
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atRiskLines } from "../server.mjs";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const specific = () => import("../lib/specific.mjs");
const LEDGER = [
  { t: 1, kind: "correction", cause: "naming-review", effect: "users-withdrawn-for-customers", withdrawn: ["users"], replacement: ["customers"] },
  { t: 2, kind: "correction", cause: "pricing-review", effect: "49-withdrawn-for-29", withdrawn: ["$49"], replacement: ["$29"] },
  { t: 3, kind: "correction", cause: "user-correction-merge", effect: "merge-withdrawn", withdrawn: ["merge"], tags: ["ambient", "prohibit-no-x"] },
  { t: 4, kind: "correction", cause: "wording-review", effect: "simply-withdrawn", withdrawn: ["simply"] },
];
const hit = (t, term, file, i = 0) => ({ at: `2026-11-2${i % 2}T10:0${i % 10}:00.000Z`, file, hits: [{ term, t }], invariants: [] });
const spread = (t, term, n, dirs) => Array.from({ length: n }, (_, i) => hit(t, term, `/repo/dir${i % dirs}/file${i}.md`, i));

test("the thresholds are named constants", async () => {
  const { NOISY_MIN_BLOCKS, NOISY_MIN_DIRS } = await specific();
  assert.equal(NOISY_MIN_BLOCKS, 5); assert.equal(NOISY_MIN_DIRS, 3);
});

test("NOISY_MIN_BLOCKS: one ordinary word blocked 4 times is not noisy, 5 times is", async () => {
  const { isNoisy, NOISY_MIN_BLOCKS, NOISY_MIN_DIRS } = await specific();
  assert.equal(isNoisy({ term: "users", blocks: NOISY_MIN_BLOCKS - 1, dirs: NOISY_MIN_DIRS + 4 }), false);
  assert.equal(isNoisy({ term: "users", blocks: NOISY_MIN_BLOCKS, dirs: NOISY_MIN_DIRS + 4 }), true);
});

test("NOISY_MIN_DIRS: one ordinary word blocked in 2 directories is not noisy, in 3 it is", async () => {
  const { isNoisy, NOISY_MIN_BLOCKS, NOISY_MIN_DIRS } = await specific();
  assert.equal(isNoisy({ term: "users", blocks: NOISY_MIN_BLOCKS + 20, dirs: NOISY_MIN_DIRS - 1 }), false, "many blocks in one place is a correction doing its work");
  assert.equal(isNoisy({ term: "users", blocks: NOISY_MIN_BLOCKS + 20, dirs: NOISY_MIN_DIRS }), true);
});

test("a specific term is never noisy, however often and however widely it is blocked", async () => {
  const { isNoisy } = await specific();
  for (const term of ["$49", "two words", "us-east-1", "v2.1"]) assert.equal(isNoisy({ term, blocks: 500, dirs: 90 }), false, term);
  for (const term of ["JSON", "useEffect"]) assert.equal(isNoisy({ term, blocks: 500, dirs: 90 }), true, `${term} is one word of letters only, whatever its capitals`);
});

test("blockStats counts blocks and distinct directories per correction from the violation records", async () => {
  const { blockStats } = await specific();
  const s = blockStats([...spread(1, "users", 7, 4), ...spread(2, "$49", 3, 1), { at: "x", file: "", hits: [{ term: "users", t: 1 }] }, { at: "x" }, null]);
  assert.equal(s.get(1).blocks, 8); assert.equal(s.get(1).dirs, 5, "a block with no file counts as one more place"); assert.equal(s.get(1).term, "users");
  assert.equal(s.get(2).blocks, 3); assert.equal(s.get(2).dirs, 1);
});

test("noisyLine: the label and both ways out on one line", async () => {
  const { noisyLine } = await specific();
  const line = noisyLine({ t: 7, term: "users", blocks: 12, dirs: 6 });
  assert.equal(line, 'noisy: "users" (t7) is one ordinary word, blocked 12 times in 6 directories. Retire it: memory-pulse remember <cause> <effect> --kind correction --supersedes 7. Or scope it: memory-pulse guard allow "users" --path <prefix> "<reason>"');
  assert.ok(!line.includes("\n")); assert.ok(!/—/.test(line));
  assert.equal(noisyLine({ t: 7, term: "users", blocks: 4, dirs: 6 }), "");
  assert.equal(noisyLine({ t: 7, term: "$49", blocks: 40, dirs: 6 }), "");
  assert.match(noisyLine({ t: 3, term: "merge", blocks: 85, dirs: 62, advisory: true }), /^noisy: "merge" \(t3\) is one ordinary word, blocked 85 times in 62 directories \(advisory now: ambient capture wrote it, so the guard no longer blocks it\)\. Retire it: /);
});

const project = (blocks, ledger = LEDGER) => {
  const cwd = mkdtempSync(join(tmpdir(), "mp-noisy-")); mkdirSync(join(cwd, ".memory-pulse"));
  writeFileSync(join(cwd, ".memory-pulse", "events.jsonl"), ledger.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(cwd, ".memory-pulse", "violations.jsonl"), blocks.map((b) => JSON.stringify(b)).join("\n") + "\n");
  const env = { ...process.env, MEMORY_PULSE_API: "http://127.0.0.1:9", MEMORY_PULSE_SETTINGS_DIR: join(cwd, "settings"), NO_COLOR: "1" };
  return (args) => spawnSync(process.execPath, [SERVER, ...args], { cwd, env, encoding: "utf8" });
};

test("report: a word blocked 6 times in 3 directories is labelled noisy; a value blocked as often, and a word blocked in one place, are not", () => {
  const run = project([...spread(1, "users", 6, 3), ...spread(2, "$49", 9, 5), ...spread(4, "simply", 8, 1)]);
  const r = run(["report"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /edits blocked by the guard: 23/);
  const noisy = r.stdout.split("\n").filter((l) => /noisy/.test(l));
  assert.deepEqual(noisy, ['  noisy: "users" (t1) is one ordinary word, blocked 6 times in 3 directories. Retire it: memory-pulse remember <cause> <effect> --kind correction --supersedes 1. Or scope it: memory-pulse guard allow "users" --path <prefix> "<reason>"']);
});

test("report: a noisy correction outside the top five is still named; a superseded one is not", () => {
  const many = [];
  const ledger = [...LEDGER];
  for (let t = 5; t <= 10; t++) { ledger.push({ t, kind: "correction", cause: `c${t}`, effect: `e${t}`, withdrawn: [`value-${t}`] }); many.push(...spread(t, `value-${t}`, 20, 2)); }
  ledger.push({ t: 11, kind: "correction", cause: "wording-fixed", effect: "simply-narrowed", withdrawn: ["simply put"], supersedes: [4] });
  const run = project([...many, ...spread(1, "users", 5, 3), ...spread(4, "simply", 9, 9)], ledger);
  const noisy = run(["report"]).stdout.split("\n").filter((l) => /noisy/.test(l));
  assert.equal(noisy.length, 1, noisy.join("\n")); assert.match(noisy[0], /"users" \(t1\).*blocked 5 times in 3 directories/);
});

test("the brief's AT RISK block carries the same label under the noisy row, and not under a specific one", () => {
  const blocks = [...spread(1, "users", 6, 3), ...spread(2, "$49", 9, 5)];
  const text = atRiskLines(LEDGER, { blocks, now: Date.parse("2026-11-21T12:00:00Z") });
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /! t1 "users" blocked 6×/.test(l));
  assert.ok(i > 0, text);
  assert.equal(lines[i + 1], '    noisy: "users" (t1) is one ordinary word, blocked 6 times in 3 directories. Retire it: memory-pulse remember <cause> <effect> --kind correction --supersedes 1. Or scope it: memory-pulse guard allow "users" --path <prefix> "<reason>"');
  assert.equal(lines.filter((l) => /noisy/.test(l)).length, 1, "the value blocked 9 times in 5 directories is a correction doing its work");
  // an ambient word the guard stopped blocking in 0.17.1 keeps its old records: the label says it no longer blocks
  const old = atRiskLines(LEDGER, { blocks: spread(3, "merge", 12, 6), now: Date.parse("2026-11-21T12:00:00Z") });
  assert.match(old, /noisy: "merge" \(t3\) is one ordinary word, blocked 12 times in 6 directories \(advisory now: /);
});

test("the offline brief prints the label where it renders AT RISK", () => {
  const run = project(spread(1, "users", 6, 3));
  const r = run(["brief", "--offline"]);
  assert.match(r.stdout, /AT RISK \(1\)/, r.stdout + r.stderr);
  assert.match(r.stdout, /noisy: "users" \(t1\) is one ordinary word, blocked 6 times in 3 directories\. Retire it: .*--supersedes 1\. Or scope it: memory-pulse guard allow "users" --path <prefix> "<reason>"/);
});
