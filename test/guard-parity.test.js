/**
 * The npm guard and the Python client give the same verdict (test/fixtures/guard-parity.json, read by both sides).
 *
 * An independent review (2026-11-21, G-4) ran twelve texts past both over one ledger. They disagreed on four: `$490`,
 * `$49.00`, `tenant` and `v2.10` were blocked by the Python client and passed by the guard, because the Python client matched
 * a withdrawn term as a substring. The guard has matched it as a token since 2026-10-12 (server.mjs tokenAt). The Python
 * client now carries the same token rule, the same release rule (a replacement on the term's own line, outside a longer
 * occurrence of the term; a term that spans lines is judged on the lines it covers) and the same advisory rule.
 * Still not in the Python client: rows a rollback put out of force, and overrides (`guard allow`).
 */
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SERVER = join(HERE, "..", "server.mjs"), PYDIR = join(HERE, "..", "python"), FIXTURE = join(HERE, "fixtures", "guard-parity.json");
const FX = JSON.parse(readFileSync(FIXTURE, "utf8"));

// one ledger, written by the npm client from the fixture's corrections; both sides read it
const cwd = mkdtempSync(join(tmpdir(), "mp-parity-"));
const env = { PATH: process.env.PATH, HOME: join(cwd, "home"), MEMORY_PULSE_MODE: "deliberate", MEMORY_PULSE_TRUST_DIR: join(cwd, "trust"), MEMORY_PULSE_DATA_DIR: join(cwd, "data"), MEMORY_PULSE_API: "http://127.0.0.1:9", NO_COLOR: "1" };
const run = (args, input = "") => spawnSync(process.execPath, [SERVER, ...args], { cwd, env, input, encoding: "utf8" });
const LEDGER = join(cwd, ".memory-pulse", "events.jsonl");
for (const c of FX.corrections) {
  const r = run(["remember", c.cause, c.effect, "--kind", "correction", ...c.withdrawn.flatMap((w) => ["--withdrawn", w]), ...(c.replacement ?? []).flatMap((w) => ["--replacement", w]), ...(c.tags ?? []).flatMap((t) => ["--tags", t])]);
  if (r.status !== 0) throw new Error(`fixture correction ${c.cause} was not recorded: ${r.stderr}${r.stdout}`);
}
const nodeVerdicts = () => FX.cases.map((c) => run(["guard"], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(cwd, "docs", "pricing.md"), content: c.text } })).status === 2);
const pythonVerdicts = () => {
  // the Python side reads the fixture file itself
  const r = spawnSync("python3", ["-I", "-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PYDIR)})
from memory_pulse import Ledger
fx = json.load(open(${JSON.stringify(FIXTURE)}, encoding="utf-8"))
L = Ledger(${JSON.stringify(LEDGER)})
print(json.dumps([L.check(c["text"])["verdict"] == "blocked" for c in fx["cases"]]))
`], { encoding: "utf8", env, cwd });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim());
};
const off = (got) => FX.cases.filter((c, i) => got[i] !== c.blocked).map((c) => `${c.n} ${c.name}: expected ${c.blocked ? "blocked" : "pass"}`);

test("the fixture holds the review's twelve texts, then eight more", () => {
  assert.equal(FX.cases.filter((c) => c.review).length, 12);
  assert.deepEqual(FX.cases.filter((c) => c.review).map((c) => c.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(FX.cases.length, 20);
});
test("the npm guard gives the fixture's verdict on every text", () => { assert.deepEqual(off(nodeVerdicts()), []); });
test("the Python client gives the fixture's verdict on every text", () => { assert.deepEqual(off(pythonVerdicts()), []); });
test("the two agree on every text, the review's twelve included", () => {
  const n = nodeVerdicts(), p = pythonVerdicts();
  assert.deepEqual(FX.cases.filter((_, i) => n[i] !== p[i]).map((c) => `${c.n} ${c.name}`), []);
});
test("the Python client's token rule, term by term, is the guard's", async () => {
  process.env.MEMORY_PULSE_LEDGER = join(mkdtempSync(join(tmpdir(), "mp-parity-fn-")), "events.jsonl");
  const { containsTerm, bareTerm } = await import("../server.mjs");
  const probes = [
    ["$49", "$49"], ["$49/mo", "$49"], ["$490", "$49"], ["$49.00", "$49"], ["$49,5", "$49"], ["$49.", "$49"], ["x$49", "$49"], ["1$49", "$49"],
    ["tenant", "ten"], ["ten", "ten"], ["max_ten", "ten"], ["often", "ten"], ["ten-fold", "ten"], ["embeddings", "embedding"], ["fetching", "fetch"], ["tens", "ten"],
    ["v2.10", "v2.1"], ["v2.1.", "v2.1"], ["v2.1px", "v2.1"], ["1,220", "220"], ["3.1416", "1416"], ["n=14", "14"], ["6144px", "6144"], ["a 6144", "6144"], ["16144", "6144"],
    ["naïveté", "naïve"], ["日本語のten", "ten"], ["𝐀ten", "ten"], ["ten𝐀", "ten"], ["", "ten"], ["ten", ""],
  ];
  const r = spawnSync("python3", ["-I", "-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PYDIR)})
import memory_pulse as m
probes = json.loads(sys.stdin.read())
print(json.dumps([[m._contains_term(t, w), m._bare_term(t + "\\n" + w + "-new", w, [w + "-new"])] for t, w in probes]))
`], { input: JSON.stringify(probes), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const py = JSON.parse(r.stdout.trim());
  probes.forEach(([text, term], i) => {
    assert.equal(py[i][0], containsTerm(text, term), `containsTerm(${JSON.stringify(text)}, ${JSON.stringify(term)})`);
    assert.equal(py[i][1], bareTerm(`${text}\n${term}-new`, term, [`${term}-new`]), `bareTerm over ${JSON.stringify(text)} for ${JSON.stringify(term)}`);
  });
});
