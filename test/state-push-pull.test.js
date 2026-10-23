// `memory-pulse state push | pull` (2026-10-16): .rain state transfer to and from a hosted project ledger. The hosted side is a
// local stand-in for /v1/state that keeps the last pushed capsule and answers it on pull; the engine's own merge is tested in the
// engine. Here: the request the client sends, and what it does with each answer. Written before the commands.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

let server, base, hosted = null, nextStatus = null; const seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-mp-key"], body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (nextStatus) { const s = nextStatus; nextStatus = null; return send(s.code, s.body); }
      if (req.method === "POST") { const cap = JSON.parse(body); const had = hosted; hosted = cap; return send(200, { status: had ? "fast-forward" : "installed", appended: cap.lines.length - (had?.lines.length ?? 0), rows: cap.lines.length }); }
      if (!hosted) return send(404, { error: "nothing is hosted for this project yet; push first" });
      return send(200, hosted);
    });
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const dir = () => mkdtempSync(join(tmpdir(), "mp-sync-"));
const run = (d, args, key = "mp_live_" + "b".repeat(32)) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: d, env: { ...process.env, MEMORY_PULSE_LEDGER: join(d, "events.jsonl"), MEMORY_PULSE_AGENT: join(d, "agent.jsonl"), MEMORY_PULSE_API: base, MEMORY_PULSE_KEY: key ?? "", DO_NOT_TRACK: "1", NO_COLOR: "1", HOME: d } });
  let out = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c)); p.on("close", (code) => resolve({ code, out }));
});

test("push needs a key, sends the ledger as a verified capsule with the key, and reports what the hosted side did", async () => {
  const d = dir();
  assert.equal((await run(d, ["remember", "a", "b", "--note", "first"])).code, 0);
  const nokey = await run(d, ["state", "push"], "");
  assert.equal(nokey.code, 1); assert.match(nokey.out, /MEMORY_PULSE_KEY/);
  const r = await run(d, ["state", "push"]);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /state push: installed/);
  const req = seen.at(-1);
  assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/state"); assert.equal(req.key, "mp_live_" + "b".repeat(32));
  const cap = JSON.parse(req.body); assert.equal(cap.schema, "catalyst.rain.state.v1"); assert.equal(cap.rows, 1);
  const p = await run(d, ["state", "push", "--project", "p-123"]);
  assert.equal(p.code, 0); assert.equal(seen.at(-1).url, "/v1/state?project=p-123");
});

test("pull installs into an empty ledger, merges into a diverged one, and verifies what it got first", async () => {
  const src = dir();
  await run(src, ["remember", "shared", "x", "--note", "on both"]);
  hosted = null; await run(src, ["state", "push"]);
  const fresh = dir();
  const a = await run(fresh, ["state", "pull"]);
  assert.equal(a.code, 0, a.out); assert.match(a.out, /state pull: installed/);
  const other = dir();
  await run(other, ["remember", "local-only", "y", "--note", "only here"]);
  const b = await run(other, ["state", "pull"]);
  assert.equal(b.code, 0, b.out); assert.match(b.out, /state pull: merged 1 row/);
  assert.ok(readFileSync(join(other, "events.jsonl"), "utf8").includes('"cause":"shared"'));
  hosted = { ...hosted, lines: hosted.lines.map((l) => l.replace("on both", "on BOTH")) };
  const bad = await run(dir(), ["state", "pull"]);
  assert.equal(bad.code, 2); assert.match(bad.out, /refused/);
});

test("a refusal from the hosted side is shown with its reason and a non-zero exit", async () => {
  const d = dir(); await run(d, ["remember", "a", "b"]);
  nextStatus = { code: 409, body: { error: "hosted memory is off for this project; turn it on in the console" } };
  const r = await run(d, ["state", "push"]);
  assert.equal(r.code, 1); assert.match(r.out, /409/); assert.match(r.out, /turn it on in the console/);
  nextStatus = { code: 404, body: { error: "nothing is hosted for this project yet; push first" } };
  const p = await run(dir(), ["state", "pull"]);
  assert.equal(p.code, 1); assert.match(p.out, /push first/);
});
