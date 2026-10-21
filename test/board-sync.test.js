// `memory-pulse board push | status | sync` (2026-10-21): the agent board travels to the user's hosted project, where the console shows
// what each agent is working on and every message. The hosted side here is a local stand-in for /v1/board; its own rules (board only,
// fast-forward only, the opt-in) are tested in the engine. Here: what the client sends, when it sends it, and that a failed sync never
// fails a post. Written before the commands.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

let server, base, nextStatus = null; const seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      seen.push({ method: req.method, url: req.url, key: req.headers["x-mp-key"], body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (nextStatus) { const s = nextStatus; nextStatus = null; return send(s.code, s.body); }
      if (req.method === "POST") { const cap = JSON.parse(body); return send(200, { status: "fast-forward", appended: 1, rows: cap.lines.length }); }
      if (req.url.startsWith("/v1/board/status")) return send(200, { project: "app", rows: 3, through: 3, updated: "2026-10-21T04:00:00.000Z" });
      return send(404, { error: "no route" });
    });
  });
  await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const KEY = "mp_live_" + "c".repeat(32);
const dir = () => mkdtempSync(join(tmpdir(), "mp-board-sync-"));
const run = (d, args, { key = KEY, api } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: d, env: { ...process.env, MEMORY_PULSE_LEDGER: join(d, "events.jsonl"), MEMORY_PULSE_AGENT: join(d, "agent.jsonl"),
    MEMORY_PULSE_BOARD: join(d, "board.jsonl"), MEMORY_PULSE_API: api ?? base, MEMORY_PULSE_KEY: key } });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
});
const post = (d, title, opts) => run(d, ["board", "post", "--from", "blue", "--to", "science", "--kind", "request", "--title", title], opts);

test("push needs a key, sends the board as a verified board capsule with the key, and names the project when asked", async () => {
  const d = dir();
  assert.equal((await post(d, "first")).code, 0);
  const nokey = await run(d, ["board", "push"], { key: "" });
  assert.equal(nokey.code, 1); assert.match(nokey.all, /MEMORY_PULSE_KEY/);
  const n = seen.length; const r = await run(d, ["board", "push", "--project", "p-1"]);
  assert.equal(r.code, 0, r.all); assert.match(r.out, /board push: fast-forward/);
  const req = seen.at(-1); assert.equal(seen.length, n + 1);
  assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/board?project=p-1"); assert.equal(req.key, KEY);
  const cap = JSON.parse(req.body); assert.equal(cap.schema, "catalyst.rain.state.v1"); assert.equal(cap.scope, "board"); assert.equal(cap.rows, 1);
  assert.deepEqual(cap.lines, readFileSync(join(d, "board.jsonl"), "utf8").split("\n").filter(Boolean));
});

test("sync on remembers the project beside the board; every post then pushes; sync off stops it", async () => {
  const d = dir();
  const on = await run(d, ["board", "sync", "on", "--project", "p-2"]);
  assert.equal(on.code, 0, on.all); assert.match(on.out, /board sync: on/);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "board-sync.json"), "utf8")), { on: true, project: "p-2" });
  const n = seen.length; const p = await post(d, "second");
  assert.equal(p.code, 0, p.all); assert.match(p.all, /synced/);
  assert.equal(seen.length, n + 1); assert.equal(seen.at(-1).url, "/v1/board?project=p-2");
  const r = await run(d, ["board", "reply", "1", "--as", "science", "--body", "on it"]);
  assert.equal(r.code, 0); assert.equal(seen.length, n + 2, "a reply syncs too");
  await run(d, ["board", "ack", "1", "--as", "science"]); assert.equal(seen.length, n + 3, "and an ack");
  assert.equal((await run(d, ["board", "sync", "off"])).code, 0);
  await post(d, "third"); assert.equal(seen.length, n + 3, "off: nothing is sent");
  assert.match((await run(d, ["board", "sync"])).out, /board sync: off/);
});

test("a failed sync never fails the post: refused, unreachable, or no key, the message is written and the agent is told", async () => {
  const d = dir(); await run(d, ["board", "sync", "on", "--project", "p-3"]);
  nextStatus = { code: 409, body: { status: "refused", reason: "the hosted board and this board diverged after row 0" } };
  const a = await post(d, "one"); assert.equal(a.code, 0); assert.match(a.err, /board sync: not pushed .*diverged/);
  const b = await post(d, "two", { api: "http://127.0.0.1:9" }); assert.equal(b.code, 0); assert.match(b.err, /board sync: not pushed/);
  const n = seen.length; const c = await post(d, "three", { key: "" }); assert.equal(c.code, 0); assert.match(c.err, /board sync: .*MEMORY_PULSE_KEY/); assert.equal(seen.length, n);
  assert.equal(readFileSync(join(d, "board.jsonl"), "utf8").split("\n").filter(Boolean).length, 3);
});

test("status reads the hosted board's count; a board that was never synced says so", async () => {
  const d = dir(); await post(d, "x");
  const s = await run(d, ["board", "status", "--project", "p-4"]);
  assert.equal(s.code, 0, s.all); assert.match(s.out, /hosted board: 3 rows through t3/); assert.match(s.out, /local board: 1 row/);
  assert.equal(seen.at(-1).url, "/v1/board/status?project=p-4");
  assert.ok(!existsSync(join(d, "board-sync.json")));
});

test("the MCP board_post tool syncs after it writes, and reports it", async () => {
  const d = dir(); await run(d, ["board", "sync", "on", "--project", "p-5"]);
  const n = seen.length;
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(SERVER)});const out=await m.handleCall("board_post",{from:"blue",to:"all",kind:"note",title:"via mcp"});console.log(JSON.stringify(out));process.exit(0)`],
      { cwd: d, env: { ...process.env, MEMORY_PULSE_LEDGER: join(d, "events.jsonl"), MEMORY_PULSE_AGENT: join(d, "agent.jsonl"), MEMORY_PULSE_BOARD: join(d, "board.jsonl"), MEMORY_PULSE_API: base, MEMORY_PULSE_KEY: KEY } });
    let out = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c)); p.on("close", (code) => resolve({ code, out }));
  });
  const line = r.out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  assert.ok(line, r.out); const o = JSON.parse(line);
  assert.equal(o.written, true); assert.equal(o.synced?.pushed, true);
  assert.equal(seen.length, n + 1); assert.equal(seen.at(-1).url, "/v1/board?project=p-5");
});
