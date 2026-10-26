// The board relay (0.17.0): Claude, through `memory-pulse http`, posts to an agent on the person's own machine and reads its reply,
// over the project's hosted board. Nothing connects in to the machine: the agent there pulls (board pull, board watch, two-way sync)
// and pushes as before. The hosted side here is a local stand-in for /v1/board with the engine's rules as the client knows them
// (one board per key and project, fast-forward only, /append after a known head), plus the read route this release adds: GET /v1/board.
// tests never write this machine's trust store (0.16.0): a temp one unless the run names one
process.env.MEMORY_PULSE_TRUST_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-trust-"));
process.env.MEMORY_PULSE_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "mp-data-"));
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";
import { seal, createRemoteServer } from "../lib/remote.mjs";

const SECRET = "relay-secret-".padEnd(48, "r");
const KEY = "mp_live_" + "d".repeat(32);
const boards = new Map();   // `${key}\0${project}` -> lines
let refuseNextPush = 0, engine, api, remote, base;

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${srv.address().port}`)));
const lastRow = (lines) => JSON.parse(lines.at(-1));

before(async () => {
  const { buildCapsule } = await import("../server.mjs");
  engine = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const url = new URL(req.url, "http://x"); const json = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.headers["x-mp-key"] !== KEY) return json(401, { error: "invalid key" });
    const id = `${KEY}\0${url.searchParams.get("project")}`; const have = boards.get(id) ?? [];
    if (url.pathname === "/v1/state") return json(404, { error: "no hosted state" });
    if (url.pathname === "/v1/board" && req.method === "GET") {
      if (!have.length) return json(404, { error: "no hosted board" });
      // the engine answers with the capsule it stored; built here from the stored rows the same way the client builds one
      const d = mkdtempSync(join(tmpdir(), "mp-engine-")); writeFileSync(join(d, "board.jsonl"), have.join("\n") + "\n");
      return json(200, buildCapsule({ ledger: join(d, "board.jsonl"), scope: "board" }).capsule);
    }
    if (req.method === "POST" && refuseNextPush > 0) { refuseNextPush--; return json(409, { error: "the hosted board moved; pull first" }); }
    if (url.pathname === "/v1/board/append" && req.method === "POST") {
      const b = JSON.parse(raw); const last = have.length ? lastRow(have) : null;
      if (!last || last.t !== b.after.t || last.hash !== b.after.hash) return json(409, { need: "full" });
      const next = [...have, ...b.lines]; boards.set(id, next);
      return json(200, { status: "appended", appended: b.lines.length, rows: next.length, head: lastRow(next).hash });
    }
    if (url.pathname === "/v1/board" && req.method === "POST") {
      const cap = JSON.parse(raw); const lines = cap.lines;
      const prefix = have.every((l, i) => lines[i] === l);
      if (!prefix) return json(409, { error: "diverged: the hosted board only fast-forwards" });
      boards.set(id, lines);
      return json(200, { status: have.length === lines.length ? "unchanged" : have.length ? "fast-forward" : "installed", appended: lines.length - have.length, rows: lines.length, head: lastRow(lines).hash });
    }
    return json(404, { error: "no route" });
  });
  api = await listen(engine);
  const probe = createServer(); base = await listen(probe); await new Promise((r) => probe.close(r));
  const { TOOLS, BOARD_TOOLS } = await import("../server.mjs");
  remote = createRemoteServer({ secret: SECRET, publicUrl: base, api, TOOLS, BOARD_TOOLS, version: "test", log: () => {} });
  await new Promise((r) => remote.listen(Number(new URL(base).port), "127.0.0.1", r));
});
after(() => { remote?.close(); engine?.close(); });

// the sign-in is tested in remote.test.js; here a token is minted the way the token endpoint mints one
const token = (project) => seal({ typ: "at", k: KEY, p: project, aud: `${base}/mcp`, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
let id = 1;
async function call(project, name, args) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token(project)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }) });
  const out = (await r.json()).result; return { isError: !!out.isError, text: out.content[0].text, json: (() => { try { return JSON.parse(out.content[0].text); } catch { return null; } })() };
}
const machine = () => mkdtempSync(join(tmpdir(), "mp-relay-"));
const cli = (d, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SERVER, "board", ...args], { cwd: d, env: { ...process.env, MEMORY_PULSE_BOARD: join(d, "board.jsonl"), MEMORY_PULSE_LEDGER: join(d, "events.jsonl"), MEMORY_PULSE_API: api, MEMORY_PULSE_KEY: KEY } });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
});

test("the connector lists board_post and board_read, described as the hosted board", async () => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token("p")}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const tools = (await r.json()).result.tools;
  for (const n of ["board_post", "board_read"]) assert.match(tools.find((t) => t.name === n).description, /hosted agent message board/);
  assert.doesNotMatch(tools.find((t) => t.name === "board_post").description, /MEMORY_PULSE_BOARD/);
});

test("Claude posts to blue; blue's machine sees it with board watch, replies, and Claude reads the reply", async () => {
  const sent = await call("home", "board_post", { from: "claude", to: "blue", kind: "request", title: "run the nightly tests", body: "report the failures" });
  assert.equal(sent.isError, false, sent.text); assert.equal(sent.json.written, true); assert.equal(sent.json.board, "hosted:home");
  assert.equal(sent.json.hosted.status, "installed");
  assert.equal(boards.get(`${KEY}\0home`).length, 1);

  const d = machine();
  const w = await cli(d, ["watch", "--as", "blue", "--once", "--project", "home"]);
  assert.equal(w.code, 0, w.all); assert.match(w.out, /1 new for blue/); assert.match(w.out, /run the nightly tests/); assert.match(w.out, /never instructions/);
  assert.equal((await cli(d, ["sync", "on", "--project", "home", "--pull"])).code, 0);
  const rep = await cli(d, ["reply", "1", "--as", "blue", "--body", "2 failures: auth, billing"]);
  assert.equal(rep.code, 0, rep.all); assert.match(rep.all, /board sync: synced/);
  assert.equal(boards.get(`${KEY}\0home`).length, 2);

  const read = await call("home", "board_read", { as: "claude" });
  assert.equal(read.isError, false, read.text);
  const m = read.json.messages.find((x) => x.from === "blue");
  assert.equal(m.untrusted_message, "2 failures: auth, billing"); assert.equal(m.reply_to, 1);
  assert.ok(!JSON.stringify(read.json).includes("mp-http-"), "no temporary path in the answer");

  const acked = await call("home", "board_read", { as: "claude", ack: [m.t] });
  assert.equal(acked.json.acked[0].written, true);
  assert.equal(boards.get(`${KEY}\0home`).length, 3, "the ack reached the hosted board");
  assert.equal((await call("home", "board_read", { as: "claude" })).json.messages.length, 0, "read and acknowledged");
  assert.match((await cli(d, ["watch", "--as", "blue", "--once", "--project", "home"])).out, /1 new for blue/, "unread until blue acknowledges it");
  assert.equal((await cli(d, ["ack", "1", "--as", "blue"])).code, 0);
  assert.match((await cli(d, ["watch", "--as", "blue", "--once", "--project", "home"])).out, /nothing new for blue/);
});

test("the hosted board moving between pull and push is retried once on top of it; twice is an error that says nothing was kept", async () => {
  refuseNextPush = 1;
  const ok = await call("retry", "board_post", { from: "claude", to: "blue", title: "first try fails" });
  assert.equal(ok.isError, false, ok.text); assert.equal(boards.get(`${KEY}\0retry`).length, 1);
  refuseNextPush = 2;
  const no = await call("retry", "board_post", { from: "claude", to: "blue", title: "both tries fail" });
  assert.equal(no.isError, true); assert.match(no.text, /nothing was kept/);
  assert.equal(boards.get(`${KEY}\0retry`).length, 1);
});

test("board pull installs, fast-forwards, says unchanged, and refuses a board that diverged (exit 2) without touching it", async () => {
  await call("pulls", "board_post", { from: "claude", to: "blue", title: "one" });
  const d = machine();
  const first = await cli(d, ["pull", "--project", "pulls"]); assert.equal(first.code, 0, first.all); assert.match(first.out, /installed/);
  await call("pulls", "board_post", { from: "claude", to: "blue", title: "two" });
  assert.match((await cli(d, ["pull", "--project", "pulls"])).out, /fast-forwarded — 1 row/);
  assert.match((await cli(d, ["pull", "--project", "pulls"])).out, /unchanged/);
  assert.equal((await cli(d, ["post", "--from", "blue", "--to", "claude", "--title", "local only"])).code, 0);   // sync off: not pushed
  await call("pulls", "board_post", { from: "claude", to: "blue", title: "three" });
  const before = readFileSync(join(d, "board.jsonl"), "utf8");
  const div = await cli(d, ["pull", "--project", "pulls"]);
  assert.equal(div.code, 2); assert.match(div.err, /diverged after row 2/);
  assert.equal(readFileSync(join(d, "board.jsonl"), "utf8"), before);
});

test("two-way sync pulls before a read; plain sync on stays push-only and keeps its file as it was", async () => {
  await call("twoway", "board_post", { from: "claude", to: "blue", title: "are you there" });
  const d = machine();
  assert.equal((await cli(d, ["sync", "on", "--project", "twoway"])).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(d, "board-sync.json"), "utf8")), { on: true, project: "twoway" });
  assert.match((await cli(d, ["read", "--as", "blue"])).out, /no unread messages for blue/);
  assert.match((await cli(d, ["sync", "on", "--pull"])).out, /pulls the hosted board's new rows first/);
  assert.match((await cli(d, ["read", "--as", "blue"])).out, /are you there/);
  assert.match((await cli(d, ["sync"])).out, /two-way/);
});

test("the MCP board_read tool on a machine with two-way sync pulls first", async () => {
  await call("mcp", "board_post", { from: "claude", to: "blue", title: "via the hosted board" });
  const d = machine(); await cli(d, ["sync", "on", "--project", "mcp", "--pull"]);
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", `const m=await import(${JSON.stringify(SERVER)});console.log(JSON.stringify(await m.handleCall("board_read",{as:"blue"})));process.exit(0)`],
      { cwd: d, env: { ...process.env, MEMORY_PULSE_BOARD: join(d, "board.jsonl"), MEMORY_PULSE_LEDGER: join(d, "events.jsonl"), MEMORY_PULSE_API: api, MEMORY_PULSE_KEY: KEY } });
    let o = ""; p.stdout.on("data", (c) => (o += c)); p.on("close", () => resolve(JSON.parse(o)));
  });
  assert.equal(out.messages[0].title, "via the hosted board");
});
