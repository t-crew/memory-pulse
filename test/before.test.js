/**
 * `memory-pulse before` and the AT RISK block — the loop closed on the client side. The exact rung is local and
 * needs no engine; the learned rung posts the ledger AND the guard's block records to /v1/before; the brief
 * counts blocks per correction from the local violations file and says where they happened.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
process.env.MEMORY_PULSE_MODE = "deliberate"; process.env.MEMORY_PULSE_AGENT = "/nonexistent/agent/events.jsonl";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";

const SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "..", "server.mjs");
const seen = [];
let respond = () => ({ status: 200, body: { rung: "none", reason: "nothing resonates above the floor", hits: [], atRisk: [], learned: { events: 0, vocab: 0, registers: 0 } } });
const fake = createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => { let data = Buffer.concat(chunks); if (req.headers["content-encoding"] === "gzip") data = gunzipSync(data); const body = data.length ? JSON.parse(data.toString("utf8")) : null; seen.push({ route: req.url, body }); const r = respond(req.url, body); res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body)); });
});
before(async () => { await new Promise((ok, no) => { fake.once("error", no); fake.listen(0, "127.0.0.1", ok); }); process.env.MEMORY_PULSE_API = `http://127.0.0.1:${fake.address().port}`; });
after(() => fake.close());

const LEDGER = [
  { t: 1, cause: "wtp-survey", effect: "price-set-49", note: "pro plan price set at $49 per seat" },
  { t: 2, kind: "correction", cause: "price-set-49", effect: "price-corrected-to-29", withdrawn: ["$49"], replacement: ["$29"], note: "WTP is $29" },
  { t: 3, kind: "correction", cause: "deploy-us-east", effect: "region-corrected-eu-west", withdrawn: ["us-east-1"], replacement: ["eu-west-2"], note: "residency" },
];
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-before-")); mkdirSync(join(dir, ".memory-pulse"));
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), LEDGER.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
};
// ASYNC on purpose: execFileSync blocks this process's event loop, and the fake engine lives in this process —
// a synchronous spawn that calls the engine deadlocks until the child's timeout (test-harness-traps, re-learned 2026-09-04).
const run = (dir, args, envExtra = {}) => new Promise((resolve, reject) => execFile(process.execPath, [SERVER, ...args], { cwd: dir, env: { ...process.env, ...envExtra }, encoding: "utf8", timeout: 20000 }, (err, stdout, stderr) => (err && err.killed ? reject(new Error(`timeout: ${stderr}`)) : resolve(stdout + (err ? stderr : "")))));

test("before: the exact rung is local — a withdrawn term in the operation names the correction and the replacement", async () => {
  const dir = project();
  const out = await run(dir, ["before", "write pricing.md with price $49 per seat"]);
  assert.match(out, /rung exact/); assert.match(out, /t2\) price-set-49 -> price-corrected-to-29/); assert.match(out, /use \$29/);
  assert.ok(!/t3\)/.test(out), "the region correction is not named");
});

test("before: the learned rung posts events, operation, path and the block records to /v1/before and prints the hits with their why", async () => {
  const dir = project();
  writeFileSync(join(dir, ".memory-pulse", "violations.jsonl"), [
    JSON.stringify({ at: "2026-09-04T09:00:00.000Z", file: "docs/release/changelog.md", hits: [{ term: "$49", t: 2 }], invariants: [] }),
    JSON.stringify({ at: "2026-09-04T10:00:00.000Z", file: "docs/release/notes.md", hits: [{ term: "$49", t: 2 }], invariants: [] }),
  ].join("\n") + "\n");
  seen.length = 0;
  respond = () => ({ status: 200, body: { rung: "associative", hits: [{ t: 2, cause: "price-set-49", effect: "price-corrected-to-29", withdrawn: ["$49"], replacement: ["$29"], score: 0.41, snr: 4.2, why: "4.2σ over 2 registers, 3 contexts, 2 blocks", blocks: 2, overrides: 0, paths: [["docs/release", 2]] }], atRisk: [{ t: 2, withdrawn: ["$49"], blocks: 2 }], learned: { events: 3, vocab: 20, registers: 2 } } });
  const out = await run(dir, ["before", "edit the changelog", "--path", "docs/release/changelog.md"]);
  const call = seen.find((s) => s.route === "/v1/before");
  assert.ok(call, "posted to /v1/before");
  assert.equal(call.body.operation, "edit the changelog"); assert.equal(call.body.path, "docs/release/changelog.md");
  assert.equal(call.body.events.length, 3); assert.equal(call.body.blocks.length, 2); assert.equal(call.body.blocks[0].hits[0].term, "$49");
  assert.match(out, /rung associative/); assert.match(out, /4\.2σ/); assert.match(out, /bit under docs\/release ×2/); assert.match(out, /AT RISK: t2 "\$49" bit 2×/);
});

test("before: no evidence is printed as exactly that, and an unreachable engine leaves the exact rung standing", async () => {
  const dir = project();
  respond = () => ({ status: 200, body: { rung: "none", reason: "nothing resonates above the floor (best price-set-49 at 1.1σ, need 3)", hits: [], atRisk: [], learned: { events: 3, vocab: 20, registers: 2 } } });
  const none = await run(dir, ["before", "refactor the websocket backoff"]);
  assert.match(none, /no evidence — nothing resonates above the floor/);
  const offline = await run(dir, ["before", "refactor the websocket backoff"], { MEMORY_PULSE_API: "http://127.0.0.1:1" });
  assert.match(offline, /exact rung only \(engine unreachable/);
});

test("the offline brief carries an AT RISK block from the local violation records: counts, where, the replacement, overrides", async () => {
  const dir = project();
  writeFileSync(join(dir, ".memory-pulse", "events.jsonl"), [...LEDGER, { t: 4, kind: "override", cause: "guard-allow", effect: "override:$49", override: { term: "$49", path: "docs/history", reason: "history quotes the old price" } }].map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, ".memory-pulse", "violations.jsonl"), [
    JSON.stringify({ at: "2026-09-04T09:00:00.000Z", file: "docs/release/changelog.md", hits: [{ term: "$49", t: 2 }], invariants: [] }),
    JSON.stringify({ at: "2026-09-04T10:00:00.000Z", file: "docs/release/notes.md", hits: [{ term: "$49", t: 2 }], invariants: [] }),
    JSON.stringify({ at: "2026-09-04T11:00:00.000Z", file: "src/config.ts", hits: [{ term: "$49", t: 2 }], invariants: [] }),
    JSON.stringify({ at: "2026-09-04T11:00:00.000Z", file: "infra/region.tf", hits: [{ term: "us-east-1", t: 3 }], invariants: [] }),
  ].join("\n") + "\n");
  const out = await run(dir, ["brief", "--offline"]);
  assert.match(out, /AT RISK \(1\)/, out);
  assert.match(out, /t2 "\$49" blocked 3× \(docs\/release ×2, src ×1\) → use \$29 · 1 override\(s\)/);
  assert.ok(!/us-east-1" blocked/.test(out), "a single block is not at risk");
});
