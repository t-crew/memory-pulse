// Cross-language chain: rows written by the Python client verify in Node and vice versa (byte-identical hashes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
