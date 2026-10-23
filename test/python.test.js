// Cross-language chain: rows written by the Python client verify in Node and vice versa (byte-identical hashes).
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test } from "node:test";
import assert from "node:assert/strict";
// tests never inherit the machine's agent mode or agent ledger
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PY = new URL("../python/memory_pulse.py", import.meta.url).pathname;
const py = (...args) => execFileSync("python3", [PY, ...args], { encoding: "utf8" });

test("python writes, node verifies; node writes, python verifies; both hash the same row identically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpy-")); const ledger = join(dir, "events.jsonl");
  writeFileSync(ledger, JSON.stringify({ t: 1, cause: "legacy", effect: "row", note: "no hash" }) + "\n");
  py("append", ledger, "py-cause", "py-effect", "written by python");
  py("append", ledger, "py-cause-2", "py-effect-2");
  process.env.MEMORY_PULSE_LEDGER = ledger;
  const { verifyChain, appendEvent, rowHash } = await import("../server.mjs?py=" + Date.now());
  let v = verifyChain(); assert.equal(v.ok, true, JSON.stringify(v)); assert.equal(v.legacy, 1); assert.equal(v.chained, 2);
  appendEvent({ cause: "node-cause", effect: "node-effect", note: "written by node" });
  const pv = JSON.parse(py("verify", ledger)); assert.equal(pv.ok, true, JSON.stringify(pv)); assert.equal(pv.chained, 3);
  const rows = readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const r of rows.slice(1)) assert.equal(rowHash(r), r.hash);
  // tamper the python row: both sides fail closed
  writeFileSync(ledger, readFileSync(ledger, "utf8").replace("written by python", "REWRITTEN"));
  assert.equal(verifyChain().ok, false);
  let code = 0; try { py("verify", ledger); } catch (e) { code = e.status; } assert.equal(code, 2);
});

test("python local check enforces a correction the same way the guard does", () => {
  const dir = mkdtempSync(join(tmpdir(), "mpy2-")); const ledger = join(dir, "events.jsonl");
  const out = execFileSync("python3", ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PY.replace(/\/memory_pulse\.py$/, ""))})
from memory_pulse import Ledger
L = Ledger(${JSON.stringify(ledger)})
L.append("pricing-corrected", "price-is-29", kind="correction", withdrawn=["$49"], replacement=["$29"])
print(json.dumps([L.check("the price is $49")["verdict"], L.check("was $49, now $29")["verdict"], L.check("nothing relevant")["verdict"]]))
`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out.trim()), ["blocked", "verified", "no_evidence"]);
});

// The decode-time guard ships beside the Python client. Its suite is stdlib
// only and loads no model, so it runs here in milliseconds. Gate on the
// summary line, never on a filter pipeline: an empty run must not pass.
test("python span guard: decode-time enforcement, tested without a model", () => {
  const root = new URL("..", import.meta.url).pathname;
  const r = spawnSync("python3", ["-m", "unittest", "python/test_span_guard.py"], { cwd: root, encoding: "utf8" });
  const summary = (r.stderr + r.stdout);
  const ran = summary.match(/^Ran (\d+) tests?/m);
  assert.ok(ran && Number(ran[1]) >= 14, `expected the span guard suite to run, got: ${summary.slice(-400)}`);
  assert.match(summary, /^OK$/m, summary.slice(-600));
  assert.equal(r.status, 0);
});

test("python appends take the same ledger lock as node: a live lock is waited for, then refused, never written past", () => {
  const dir = mkdtempSync(join(tmpdir(), "mpy-lock-")); const ledger = join(dir, "events.jsonl"); writeFileSync(ledger, "");
  writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const held = spawnSync("python3", [PY, "append", ledger, "c", "e"], { encoding: "utf8", env: { ...process.env, MEMORY_PULSE_LOCK_TIMEOUT_MS: "300" } });
  assert.notEqual(held.status, 0); assert.match(held.stdout + held.stderr, /locked/);
  assert.equal(readFileSync(ledger, "utf8"), "", "nothing written past a live lock");
  writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: 999999, at: new Date(0).toISOString() }));
  py("append", ledger, "c", "e");
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 1, "a lock left by a dead process is broken");
  assert.equal(JSON.parse(py("verify", ledger)).ok, true);
});
