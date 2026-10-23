// Fixes from the independent review of board sync (2026-10-21), each written as a failing test first:
//  2  a board capsule never carries the project ledger's seal or invariants (they sit in the same folder), so sync keeps working
//  4  a 200 whose body is not a push result is not "synced"
//  5  after a full push, a write sends only the rows after the hosted head (/v1/board/append); a moved head falls back to a full push
//  7  lib/board.mjs imported on its own still pushes
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER, ROOT } from "./_helpers.mjs";

let server, base, mode = null; const seen = []; let hosted = [];
before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const head = () => { const r = JSON.parse(hosted.at(-1)); return { t: r.t, hash: r.hash }; };
      if (mode === "html") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>sign in to the wifi</html>"); }
      if (req.method === "POST" && req.url.startsWith("/v1/board/append")) {
        const b = JSON.parse(body);
        if (mode === "moved" || !hosted.length || b.after?.hash !== head().hash) { mode = null; return send(409, { status: "refused", need: "full", hosted: hosted.length ? head() : null, reason: "the hosted board moved; send the whole board" }); }
        hosted.push(...b.lines); return send(200, { status: "appended", appended: b.lines.length, rows: hosted.length, head: head().hash });
      }
      if (req.method === "POST" && req.url.startsWith("/v1/board")) {
        const cap = JSON.parse(body); const had = hosted.length; hosted = [...cap.lines];
        return send(200, { status: had ? "fast-forward" : "installed", appended: hosted.length - had, rows: hosted.length, head: head().hash });
      }
      return send(404, { error: "no route" });
    });
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const KEY = "mp_live_" + "d".repeat(32);
const env = (d) => ({ ...process.env, MEMORY_PULSE_LEDGER: join(d, ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(d, "agent.jsonl"),
  MEMORY_PULSE_BOARD: join(d, ".memory-pulse", "board.jsonl"), MEMORY_PULSE_API: base, MEMORY_PULSE_KEY: KEY });
const dir = () => { const d = mkdtempSync(join(tmpdir(), "mp-board-fix-")); mkdirSync(join(d, ".memory-pulse")); hosted = []; return d; };
const run = (d, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: d, env: env(d) });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
});
const post = (d, title) => run(d, ["board", "post", "--from", "blue", "--to", "science", "--kind", "note", "--title", title]);

test("2: a board beside a sealed project ledger and its invariants pushes with no seal and no invariants", async () => {
  const d = dir();
  writeFileSync(join(d, ".memory-pulse", "seal.rain"), JSON.stringify({ head: "ab".repeat(384), through: 1, events: 1 }) + "\n");
  writeFileSync(join(d, ".memory-pulse", "invariants.jsonl"), JSON.stringify({ id: "receipt-wording", rule: "say receipt", t: 1 }) + "\n");
  assert.equal((await post(d, "one")).code, 0); assert.equal((await post(d, "two")).code, 0);
  const r = await run(d, ["board", "push", "--project", "p-1"]);
  assert.equal(r.code, 0, r.all);
  const cap = JSON.parse(seen.filter((s) => s.url.startsWith("/v1/board?")).at(-1).body);
  assert.equal(cap.scope, "board"); assert.equal(cap.seal, null); assert.deepEqual(cap.invariants, []);
});

test("4: a 200 that is not a push result is not reported as synced", async () => {
  const d = dir(); await run(d, ["board", "sync", "on", "--project", "p-2"]);
  mode = "html"; const p = await post(d, "behind a portal"); mode = null;
  assert.equal(p.code, 0); assert.doesNotMatch(p.all, /synced/); assert.match(p.err, /board sync: not pushed/);
});

test("5: after the first full push, each write sends only its new rows; a moved head falls back to a full push", async () => {
  const d = dir(); await run(d, ["board", "sync", "on", "--project", "p-3"]);
  const n = seen.length;
  await post(d, "first");                                         // nothing known about the hosted head yet: the whole board
  assert.match(seen.at(-1).url, /^\/v1\/board\?project=p-3$/);
  const p2 = await post(d, "second"); assert.match(p2.out, /synced/);
  const a = seen.at(-1); assert.match(a.url, /^\/v1\/board\/append\?project=p-3$/);
  const body = JSON.parse(a.body); assert.equal(body.lines.length, 1); assert.equal(body.after.t, 1);
  await run(d, ["board", "ack", "1", "--as", "science"]); assert.equal(JSON.parse(seen.at(-1).body).lines.length, 1);
  mode = "moved"; const p4 = await post(d, "fourth");
  assert.equal(p4.code, 0); assert.match(p4.out, /synced/);
  assert.deepEqual(seen.slice(n).map((s) => s.url.replace(/\?.*/, "")), ["/v1/board", "/v1/board/append", "/v1/board/append", "/v1/board/append", "/v1/board"]);
  assert.deepEqual(hosted, readFileSync(join(d, ".memory-pulse", "board.jsonl"), "utf8").split("\n").filter(Boolean));
});

test("7: lib/board.mjs imported on its own still pushes", async () => {
  const d = dir(); await post(d, "x"); const n = seen.length;
  const r = await new Promise((resolve) => {
    const code = `const B=await import(${JSON.stringify(join(ROOT, "lib", "board.mjs"))});const r=await B.pushBoard(process.env.MEMORY_PULSE_BOARD,{project:"p-7"});console.log(JSON.stringify(r))`;
    const p = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: d, env: env(d) });
    let out = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c)); p.on("close", () => resolve(out));
  });
  const o = JSON.parse(r.trim().split("\n").filter((l) => l.startsWith("{")).at(-1));
  assert.equal(o.pushed, true, r); assert.equal(seen.length, n + 1);
});
