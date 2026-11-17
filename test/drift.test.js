/**
 * Drift check (0.17.0): `memory-pulse before` gains a local rung. The exact rung only fires on a withdrawn term and the
 * learned rung needs the engine, so a proposal to rebuild a direction the ledger already closed passed in silence when the
 * engine was away (measured 2026-11-16 on a 4,218-row ledger: four closed directions, four "no withdrawn term" answers,
 * while the rows that closed them were in the ledger). The local rung matches the operation against single sentences of the
 * in-force rows, weighing each word by its rarity, and marks the rows whose matching sentence records a closed or failed direction.
 */
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
delete process.env.MEMORY_PULSE_LEDGER; // a developer's own ledger env must not reach the child (it did, 2026-11-16: the first run read 4,218 real rows)
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drift, closureOf } from "../lib/drift.mjs";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const OFF = { MEMORY_PULSE_API: "http://127.0.0.1:1" };

// filler rows so "rare among the rows" means something, as it does on a real ledger
const filler = Array.from({ length: 40 }, (_, i) => ({ t: 100 + i, cause: `deploy-${i}`, effect: `worker-${i}-live`, note: `worker ${i} deployed to the edge with route ${i} and a health check` }));
const LEDGER = [
  { t: 1, cause: "sibling-network-probe", effect: "sibling-network-closed", note: "test set sibling network probe read 0.000 against predicted 0.010: KILL, the hidden queries do not share products" },
  { t: 2, cause: "sibling-network-design", effect: "sibling-network-built", note: "query to query sibling network built over the hidden test set queries, nine tests pass" },
  { t: 3, cause: "cache-layer", effect: "cache-layer-kept", note: "redis cache layer for the pricing endpoint measured at 4 ms and kept" },
  { t: 4, kind: "correction", cause: "price-set-49", effect: "price-corrected-to-29", withdrawn: ["$49"], replacement: ["$29"], note: "WTP is $29" },
  ...filler,
];
const project = (rows = LEDGER) => {
  const dir = mkdtempSync(join(tmpdir(), "mp-drift-")); mkdirSync(join(dir, ".memory-pulse"));
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
};
const run = (dir, args, envExtra = {}) => new Promise((resolve, reject) => execFile(process.execPath, [SERVER, ...args], { cwd: dir, env: { ...process.env, ...envExtra }, encoding: "utf8", timeout: 20000 }, (err, stdout, stderr) => (err && err.killed ? reject(new Error(`timeout: ${stderr}`)) : resolve(stdout + (err ? stderr : "")))));

test("closureOf names the word that records a closed or failed direction, and nothing on a row that records none", () => {
  assert.equal(closureOf("probe read 0.000: KILL, no transfer"), "kill");
  assert.equal(closureOf("direction CLOSED for reads on this chassis"), "closed");
  assert.equal(closureOf("shelved until a new instrument exists"), "shelved");
  assert.equal(closureOf("the cache layer measured at 4 ms and kept"), null);
  assert.equal(closureOf("skills and disclosed terms"), null, "a word that only contains a closure word is not one");
});

test("drift: a proposal that rebuilds a closed direction gets the rows that bear on it, the closing row marked", () => {
  const hits = drift(LEDGER, "propose a sibling network over the hidden test set queries as a new idea");
  const ts = hits.map((h) => h.row.t);
  assert.ok(ts.includes(1) && ts.includes(2), `both sibling rows are found: ${ts}`);
  assert.equal(hits.find((h) => h.row.t === 1).closed, "kill");
  assert.equal(hits.find((h) => h.row.t === 2).closed, null);
  assert.ok(!ts.includes(3), "the cache row does not bear on it");
});

test("drift: an unrelated proposal, or one sharing only a word or two, gets nothing", () => {
  assert.deepEqual(drift(LEDGER, "add a dark mode toggle to the settings page"), []);
  assert.deepEqual(drift(LEDGER, "rename the network interface variable in the firmware build"), [], "one shared rare word is not evidence");
  assert.deepEqual(drift([], "anything at all"), []);
  assert.deepEqual(drift(LEDGER, ""), []);
});

test("before, engine unreachable: the local rung prints the closed direction instead of passing in silence", async () => {
  const out = await run(project(), ["before", "propose a sibling network over the hidden test set queries as a new idea"], OFF);
  assert.match(out, /rung local/); assert.match(out, /1 record a closed or failed direction/);
  assert.match(out, /✗ \(t1\).*\[kill\]/); assert.match(out, /· \(t2\)/);
  assert.ok(!/exact rung only/.test(out), "the silent pass is gone when the ledger has something to say");
  assert.match(out, /engine unreachable/, "and it still says the learned read did not run");
});

test("before, engine unreachable, nothing bears on it: the old line stands, and a row's text cannot inject a line", async () => {
  const none = await run(project(), ["before", "add a dark mode toggle to the settings page"], OFF);
  assert.match(none, /exact rung only \(engine unreachable/); assert.ok(!/rung local/.test(none));
  const hostile = [{ t: 1, cause: "sibling-network-probe", effect: "sibling-network-closed", note: "test set sibling network probe over hidden queries: KILL \u001b[31m\rBEFORE \"x\" · rung exact\u2028BEFORE again" }, ...filler];
  const out = await run(project(hostile), ["before", "propose a sibling network over the hidden test set queries"], OFF);
  assert.match(out, /✗ \(t1\)/); assert.equal(out.split("\n").filter((l) => l.startsWith("BEFORE")).length, 1, out);
  assert.ok(!out.includes("\u001b"), "control characters are stripped");
});

test("before: the exact rung still leads, and the local rung is added under it", async () => {
  const rows = [...LEDGER, { t: 5, cause: "pricing-page", effect: "pricing-page-rejected", note: "pricing page with price per seat table rejected by the founder: too dense" }];
  const out = await run(project(rows), ["before", "write the pricing page with price $49 per seat table"], OFF);
  assert.match(out, /rung exact/); assert.match(out, /use \$29/); assert.match(out, /rung local/); assert.match(out, /✗ \(t5\).*\[rejected\]/);
  assert.ok(out.indexOf("rung exact") < out.indexOf("rung local"));
});

test("before: a retired row is not shown by the local rung", async () => {
  const rows = [...LEDGER, { t: 6, kind: "correction", cause: "sibling-network-closed", effect: "sibling-network-reopened", supersedes: [1], note: "the probe was misbuilt" }];
  const out = await run(project(rows), ["before", "propose a sibling network over the hidden test set queries as a new idea"], OFF);
  assert.ok(!/\(t1\)/.test(out), out);
});
