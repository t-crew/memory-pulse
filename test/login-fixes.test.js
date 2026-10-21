// memory-pulse login, review fixes (2026-10-21), each a failing test first:
//  1  login proves the key it is replacing (sha256 of the saved key), so the console can name it and nobody else can revoke it
//  2  the saved key is sent only to the engine it came from, and a refused saved key falls back to the free tier instead of failing
//  7  the client opens and prints only an https link on its own engine, with control characters stripped
//  9  a 5xx while polling is retried, not fatal
// 12  login keeps a configured board project, says what it turned on, and warns when MEMORY_PULSE_KEY will override the new key
// 13  the key file is written whole (no temp file left) and readable only by the user, even over an older looser file
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER } from "./_helpers.mjs";

const K1 = "mp_live_" + "c3".repeat(16), K2 = "mp_live_" + "d4".repeat(16);
const servers = [];
async function standIn(behave) {
  const st = { seen: [], polls: 0, ...behave };
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      st.seen.push({ method: req.method, url: req.url, key: req.headers["x-mp-key"], body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/v1/auth/device") { st.polls = 0; return send(200, { device_code: "e".repeat(64), user_code: st.userCode ?? "BCDF-GHJK", verification_uri: `${st.base}/app`, verification_uri_complete: st.link ?? `${st.base}/app?device=BCDF-GHJK`, expires_in: 600, interval: 1 }); }
      if (req.url === "/v1/auth/device/token") {
        st.polls++;
        if (st.flaky && st.polls === 1) return send(502, { error: "bad gateway" });
        if (st.polls < 2) return send(400, { error: "authorization_pending", interval: 1 });
        return send(200, { key: st.key ?? K1, prefix: (st.key ?? K1).slice(0, 16) + "…", project: { id: "p-1", name: "casmi-board" }, hosted: true });
      }
      if (req.url.startsWith("/v1/before")) return req.headers["x-mp-key"] ? send(401, { error: "this key was revoked in the console" }) : send(200, {});
      if (req.url.startsWith("/v1/board")) { const cap = JSON.parse(body); const last = cap.lines ? JSON.parse(cap.lines.at(-1)) : {}; return send(200, { status: "installed", appended: 1, rows: 1, head: last.hash }); }
      return send(404, { error: "no route" });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r)); st.base = `http://127.0.0.1:${srv.address().port}`; servers.push(srv); return st;
}
after(() => servers.forEach((s) => s.close()));

const home = () => { const h = mkdtempSync(join(tmpdir(), "mp-login-fix-")); mkdirSync(join(h, "work", ".memory-pulse"), { recursive: true }); return h; };
const run = (h, api, args, extra = {}) => new Promise((resolve) => {
  const env = { ...process.env, HOME: h, MEMORY_PULSE_API: api, MEMORY_PULSE_LEDGER: join(h, "work", ".memory-pulse", "events.jsonl"), MEMORY_PULSE_AGENT: join(h, "agent.jsonl") };
  delete env.MEMORY_PULSE_KEY; delete env.MEMORY_PULSE_BOARD; Object.assign(env, extra);
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: join(h, "work"), env });
  let out = "", err = ""; p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c)); p.on("close", (code) => resolve({ code, out, err, all: out + err }));
});

test("1: a second login proves the key it replaces", async () => {
  const a = await standIn({}); const h = home();
  assert.equal((await run(h, a.base, ["login", "--no-open", "--no-sync"])).code, 0);
  a.key = K2; assert.equal((await run(h, a.base, ["login", "--no-open", "--no-sync"])).code, 0);
  const starts = a.seen.filter((s) => s.url === "/v1/auth/device").map((s) => JSON.parse(s.body));
  assert.equal(starts[0].replaces, undefined); assert.equal(starts[1].replaces, createHash("sha256").update(K1).digest("hex"));
});

test("2: the saved key goes only to the engine it came from; a refused saved key falls back to the free tier", async () => {
  const a = await standIn({}), b = await standIn({}); const h = home();
  assert.equal((await run(h, a.base, ["login", "--no-open", "--no-sync"])).code, 0);
  await run(h, b.base, ["board", "post", "--from", "x", "--to", "all", "--title", "t"]);
  const p = await run(h, b.base, ["board", "push"]);
  assert.equal(p.code, 1); assert.equal(b.seen.filter((s) => s.key).length, 0, "engine B never saw the key");
  const r = await run(h, a.base, ["before", "rename the column"]);
  const calls = a.seen.filter((s) => s.url.startsWith("/v1/before"));
  assert.equal(calls.length, 2, r.all); assert.equal(calls[0].key, K1); assert.equal(calls[1].key, undefined);
  assert.match(r.err, /saved login key was refused/); assert.equal(r.code, 0, r.all);
});

test("7: the client opens and prints only an https link on its own engine, with control characters stripped", async () => {
  const a = await standIn({ link: "file:///System/Applications/Calculator.app", userCode: "BCDF-\u001b[2JGHJK" }); const h = home();
  const r = await run(h, a.base, ["login", "--no-sync"], { CI: "" });
  assert.equal(r.code, 0, r.all); assert.ok(!r.all.includes("\u001b"), "no escape characters reach the terminal");
  assert.match(r.all, /not opening/); assert.ok(!r.out.includes("file:///"), "the foreign link is not shown as the one to open");
});

test("9: a 5xx while polling is retried", async () => {
  const a = await standIn({ flaky: true }); const h = home();
  const r = await run(h, a.base, ["login", "--no-open", "--no-sync"]);
  assert.equal(r.code, 0, r.all); assert.ok(existsSync(join(h, ".config", "memory-pulse", "key")));
});

test("12: login keeps a configured board project, says what it turned on, and warns when MEMORY_PULSE_KEY wins", async () => {
  const a = await standIn({}); const h = home();
  await run(h, a.base, ["board", "post", "--from", "x", "--to", "all", "--title", "t"]);
  await run(h, a.base, ["board", "sync", "on", "--project", "keep-me"]);
  const r = await run(h, a.base, ["login", "--no-open"], { MEMORY_PULSE_KEY: K2 });
  assert.equal(r.code, 0, r.all);
  assert.equal(JSON.parse(readFileSync(join(h, "work", ".memory-pulse", "board-sync.json"), "utf8")).project, "keep-me");
  assert.match(r.out, /board sync off/); assert.match(r.err, /MEMORY_PULSE_KEY is set/);
});

test("13: the key file is written whole and readable only by the user, even over an older looser file", async () => {
  const a = await standIn({}); const h = home();
  const dir = join(h, ".config", "memory-pulse"); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "key"), "old\n"); chmodSync(join(dir, "key"), 0o644);
  assert.equal((await run(h, a.base, ["login", "--no-open", "--no-sync"])).code, 0);
  assert.equal(statSync(join(dir, "key")).mode & 0o777, 0o600); assert.equal(readFileSync(join(dir, "key"), "utf8").trim(), K1);
  assert.deepEqual(readdirSync(dir).sort(), ["key", "login.json"], "no temp file left behind");
});
